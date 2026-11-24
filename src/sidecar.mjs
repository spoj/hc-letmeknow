import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  DEFAULT_DEBOUNCE_MS,
  capLine,
  capLines,
  classifyHcError,
  decodeExecOpts,
  defaultConfigPath,
  execFileCommand,
  formatInboxPointer,
  formatInlineCandidate,
  inboxDirPath,
  installBinary,
  isAlive,
  isMainModule,
  joinListed,
  killChildCleanly,
  lmkJson,
  loadSavedSessionFp,
  readJsonIfExists,
  resolveSidecarConfig,
  sanitizeSingleLine,
  saveSessionFp,
  spawnCommand,
  stateDir,
  stripEnvVar,
  termStatePath,
  writeFileAtomic,
  writeJsonAtomic,
} from "./core.mjs";

function parseSidecarArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--opts") out.encodedOpts = argv[++i];
    else if (a === "--terminal") out.terminalId = argv[++i];
    else if (a === "--watch-pid") out.watchPid = Number(argv[++i]);
    else if (a === "--err-log") out.errLogPath = argv[++i];
    else if (a === "--keep-ipc") out.keepIpc = true;
  }
  return out;
}

function sendIpcOnce(payload, { keepIpc = false } = {}) {
  if (typeof process.send !== "function") return;
  try {
    process.send(payload);
  } catch {}
  if (!keepIpc) {
    try {
      if (process.connected) process.disconnect();
    } catch {}
  }
}

async function initInboxSeq(fp) {
  const dir = inboxDirPath(fp);
  if (!existsSync(dir)) return 0;
  let max = 0;
  try {
    for (const name of await readdir(dir)) {
      const m = /^(\d+)\.jsonl$/.exec(name);
      if (m) {
        const n = Number(m[1]);
        if (n > max) max = n;
      }
    }
  } catch {}
  return max;
}

export async function runSidecar({ encodedOpts, terminalId, watchPid, errLogPath, keepIpc = false }) {
  if (!encodedOpts || !terminalId) {
    throw new Error("sidecar requires --opts and --terminal");
  }

  const execOpts = decodeExecOpts(encodedOpts);
  const configPath = execOpts.config || defaultConfigPath();
  const fileConfig = readJsonIfExists(configPath);
  const cfg = resolveSidecarConfig(execOpts, fileConfig);

  const debounceMs = Number(process.env.HC_LETMEKNOW_DEBOUNCE_MS) || DEFAULT_DEBOUNCE_MS;
  const pollMs = Number(process.env.HC_LETMEKNOW_POLL_MS) || 1000;
  const retryBaseMs = Number(process.env.HC_LETMEKNOW_RETRY_MS) || 5000;
  const retryMaxMs = Math.max(retryBaseMs, Number(process.env.HC_LETMEKNOW_RETRY_MAX_MS) || 15_000);
  const hcSendTimeoutMs = Number(process.env.HC_LETMEKNOW_SEND_TIMEOUT_MS) || 90_000;

  const childEnv = stripEnvVar(process.env, "LETMEKNOW_SESSION");

  const dir = stateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const statePath = termStatePath(terminalId);

  const stop = new AbortController();
  const warnings = [];
  let listenChild;
  let eventsChild;
  let pollTimer;
  let bootTimer;
  let debounceTimer;
  let retryTimer;
  let reconnectTimer;
  let shuttingDown = false;
  let ipcSent = false;

  let fp = "";
  let bin = "";
  let log = "";
  let attached = false;
  let activeGroups = [];

  let bootReady = false;
  let terminalStatus = null;
  let statusEpoch = 0;
  let deliveredFirst = false;
  let inboxSeq = 0;
  let inboxSeqInitPromise;

  let waiting = [];
  let pendingLines = [];
  let delivering = false;
  let preparedDelivery = null; // { version, count, text }
  let pendingVersion = 0;
  let retryAttempts = 0;
  let reconnectAttempts = 0;

  const emitReadyFile = async payload => {
    if (!cfg.readyFile) return;
    await writeJsonAtomic(cfg.readyFile, payload);
  };

  const writeTermState = async () => {
    if (shuttingDown || !fp) return;
    await writeJsonAtomic(statePath, {
      fp,
      bin,
      log,
      sidecarPid: process.pid,
      groups: activeGroups,
      terminalId,
      warnings,
    });
  };

  const notifyIpc = payload => {
    if (ipcSent) return;
    ipcSent = true;
    sendIpcOnce(payload, { keepIpc: keepIpc && payload?.ok === true });
  };

  const cleanupOwnStateFile = () => {
    try {
      if (!existsSync(statePath)) return;
      const cur = JSON.parse(readFileSync(statePath, "utf8"));
      if (cur?.sidecarPid === process.pid) {
        rmSync(statePath, { force: true });
      }
    } catch {}
  };

  const cleanupErrLog = () => {
    if (!errLogPath) return;
    try {
      if (existsSync(errLogPath)) rmSync(errLogPath, { force: true });
    } catch {}
  };

  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(pollTimer);
    clearTimeout(bootTimer);
    clearTimeout(debounceTimer);
    clearTimeout(retryTimer);
    clearTimeout(reconnectTimer);
    stop.abort();
    await Promise.all([
      killChildCleanly(eventsChild, 1000).catch(() => {}),
      killChildCleanly(listenChild, 2000).catch(() => {}),
    ]);
    cleanupOwnStateFile();
    if (exitCode === 0) cleanupErrLog();
    process.exit(exitCode);
  };

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGHUP", () => void shutdown(0));
  process.on("message", msg => {
    if (msg && msg.type === "shutdown") void shutdown(0);
  });
  if (keepIpc) {
    process.on("disconnect", () => {
      if (!shuttingDown) void shutdown(0);
    });
  }

  const prepareDeliveryPayload = async (lines) => {
    const capped = capLines(lines);
    const firstDelivery = !deliveredFirst;
    if (capped.length === 1) {
      const candidate = formatInlineCandidate(capped[0], {
        prefix: cfg.prefix,
        fp,
        log,
        firstDelivery,
      });
      if (Buffer.byteLength(candidate, "utf8") <= cfg.inlineBytes) {
        return { text: candidate, isInbox: false };
      }
    }
    if (!inboxSeqInitPromise) {
      inboxSeqInitPromise = initInboxSeq(fp).then(n => {
        inboxSeq = n;
      });
    }
    await inboxSeqInitPromise;
    inboxSeq += 1;
    const seqStr = String(inboxSeq).padStart(6, "0");
    const inboxFile = join(inboxDirPath(fp), `${seqStr}.jsonl`);
    const body = `${capped.join("\n")}\n`;
    await writeFileAtomic(inboxFile, body, 0o600);
    const bytes = Buffer.byteLength(body, "utf8");
    const text = formatInboxPointer({
      count: capped.length,
      bytes,
      inboxPath: inboxFile,
      prefix: cfg.prefix,
      fp,
      log,
      firstDelivery,
    });
    return { text, isInbox: true, inboxFile };
  };

  const scheduleRetry = (delayMs) => {
    if (shuttingDown || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void attemptDelivery();
    }, delayMs);
  };

  const clearRetryTimer = () => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const isIdleReady = state => state === "idle" || state === "done";

  const queryTerminal = async () => {
    try {
      const { stdout } = await execFileCommand(cfg.hcBin, ["get", "--json", terminalId], {
        env: childEnv,
        timeout: 10_000,
        windowsHide: true,
      });
      const info = JSON.parse(stdout);
      if (info?.state === "finished") {
        void shutdown(0);
        return { alive: false, status: null };
      }
      return { alive: true, status: info?.status?.state ?? null };
    } catch (err) {
      const kind = classifyHcError(err);
      if (kind === "not_found" || kind === "finished") {
        void shutdown(0);
        return { alive: false, status: null };
      }
      return { alive: true, status: undefined };
    }
  };

  const attemptDelivery = async () => {
    if (shuttingDown || delivering || !bootReady || pendingLines.length === 0) return;
    delivering = true;
    clearRetryTimer();
    const deferRetry = () => {
      retryAttempts += 1;
      const delay = Math.min(retryMaxMs, retryBaseMs * Math.min(retryAttempts, 3));
      scheduleRetry(delay);
    };
    try {
      let useIfIdle = cfg.deliver === "idle";
      if (cfg.deliver === "idle") {
        if (terminalStatus === "working" || terminalStatus === "blocked") {
          deferRetry();
          return;
        }
        if (terminalStatus === "done") {
          const epochBefore = statusEpoch;
          const live = await queryTerminal();
          if (!live.alive || shuttingDown) return;
          if (statusEpoch === epochBefore && live.status !== undefined) {
            terminalStatus = live.status;
          }
          if (terminalStatus === "working" || terminalStatus === "blocked") {
            deferRetry();
            return;
          }
          if (terminalStatus === "done") {
            useIfIdle = false;
          }
        }
      }

      const snapshotLen = pendingLines.length;
      const version = pendingVersion;
      let payload;
      if (preparedDelivery && preparedDelivery.version === version) {
        payload = preparedDelivery;
      } else {
        const built = await prepareDeliveryPayload(pendingLines.slice(0, snapshotLen));
        payload = { version, snapshotLen, text: built.text };
        preparedDelivery = payload;
      }

      const sendArgs = ["send", "--json"];
      if (useIfIdle) {
        sendArgs.push("--if", "idle");
      }
      sendArgs.push("--", terminalId, payload.text);

      try {
        await execFileCommand(cfg.hcBin, sendArgs, {
          env: childEnv,
          timeout: hcSendTimeoutMs,
          windowsHide: true,
        });
        deliveredFirst = true;
        pendingLines.splice(0, payload.snapshotLen);
        pendingVersion += 1;
        preparedDelivery = null;
        retryAttempts = 0;
      } catch (err) {
        if (shuttingDown) return;
        const kind = classifyHcError(err);
        if (kind === "not_found" || kind === "finished") {
          void shutdown(0);
          return;
        }
        if (kind === "status_mismatch" && useIfIdle) {
          const epochBefore = statusEpoch;
          const live = await queryTerminal();
          if (!live.alive || shuttingDown) return;
          if (statusEpoch === epochBefore && live.status !== undefined) {
            terminalStatus = live.status;
          }
          if (terminalStatus === "done") {
            // Re-enter immediately in finally with confirmed "done" status (omitting --if idle).
            return;
          }
        }
        deferRetry();
      }
    } finally {
      delivering = false;
      if (!shuttingDown && bootReady && pendingLines.length > 0 && !retryTimer) {
        void attemptDelivery();
      }
    }
  };

  const flushWaiting = () => {
    debounceTimer = undefined;
    if (!waiting.length) return;
    const lines = waiting;
    waiting = [];
    pendingLines.push(...lines);
    pendingVersion += 1;
    preparedDelivery = null;
    if (bootReady) {
      clearRetryTimer();
      void attemptDelivery();
    }
  };

  const wake = line => {
    waiting.push(capLine(line));
    if (debounceTimer) return;
    debounceTimer = setTimeout(flushWaiting, debounceMs);
  };

  const queueImmediateNotice = notice => {
    pendingLines.push(capLine(sanitizeSingleLine(notice)));
    pendingVersion += 1;
    preparedDelivery = null;
    if (bootReady) {
      clearRetryTimer();
      void attemptDelivery();
    }
  };

  const openBootGate = () => {
    if (bootReady || shuttingDown) return;
    bootReady = true;
    clearTimeout(bootTimer);
    bootTimer = undefined;
    if (pendingLines.length > 0) {
      clearRetryTimer();
      void attemptDelivery();
    }
  };

  const onTerminalStatus = (state) => {
    const prev = terminalStatus;
    terminalStatus = state ?? null;
    statusEpoch += 1;
    if (!bootReady && (terminalStatus === "idle" || terminalStatus === "done" || terminalStatus === "working")) {
      openBootGate();
      return;
    }
    if (!bootReady || pendingLines.length === 0 || delivering) return;
    if (terminalStatus === prev) return;
    if (cfg.deliver === "idle") {
      if (isIdleReady(terminalStatus)) {
        clearRetryTimer();
        void attemptDelivery();
      }
    } else if (terminalStatus !== "blocked") {
      clearRetryTimer();
      void attemptDelivery();
    }
  };

  const checkTerminalAlive = async () => {
    const live = await queryTerminal();
    if (!live.alive) return false;
    if (live.status !== undefined) {
      onTerminalStatus(live.status);
    }
    return true;
  };

  const handleEventLine = (line) => {
    if (shuttingDown || !line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // Initial snapshot or missed snapshot with terminals array
    const snapshotTerminals = Array.isArray(msg.terminals)
      ? msg.terminals
      : Array.isArray(msg?.params?.terminals)
        ? msg.params.terminals
        : null;
    if (snapshotTerminals) {
      const term = snapshotTerminals.find(t => t.address === terminalId) ?? snapshotTerminals[0];
      if (!term) {
        void checkTerminalAlive();
        return;
      }
      if (term.state === "finished") {
        void shutdown(0);
        return;
      }
      if (term.status?.state !== undefined) {
        onTerminalStatus(term.status.state);
      }
      return;
    }

    if (msg.method === "missed") {
      void checkTerminalAlive();
      return;
    }

    if (msg.method === "event" && msg.params) {
      const { type, data } = msg.params;
      if (type === "finished" || type === "removed") {
        void shutdown(0);
        return;
      }
      if (type === "status") {
        const nextState = data?.status?.state ?? null;
        onTerminalStatus(nextState);
        return;
      }
      if (type === "restarted") {
        if (bootReady && pendingLines.length > 0 && !delivering && cfg.deliver === "always") {
          clearRetryTimer();
          void attemptDelivery();
        }
      }
    }
  };

  const startHcEvents = () => {
    if (shuttingDown) return;
    const child = spawnCommand(cfg.hcBin, ["events", "--json", "--terminal", terminalId], {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      windowsHide: true,
    });
    eventsChild = child;
    let stderrBuf = "";
    child.stderr.on("data", chunk => {
      stderrBuf = (stderrBuf + chunk).slice(-2000);
    });
    createInterface({ input: child.stdout }).on("line", line => {
      reconnectAttempts = 0;
      handleEventLine(line);
    });
    const onEnd = (code) => {
      if (shuttingDown || eventsChild !== child) return;
      eventsChild = undefined;
      const errLike = { code, stderr: stderrBuf };
      const kind = classifyHcError(errLike);
      if (kind === "not_found" || kind === "finished") {
        void shutdown(0);
        return;
      }
      void checkTerminalAlive().then(alive => {
        if (!alive || shuttingDown) return;
        reconnectAttempts += 1;
        const delay = Math.min(5000, 500 * reconnectAttempts);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          startHcEvents();
        }, delay);
      });
    };
    child.on("error", () => onEnd(1));
    child.on("exit", code => onEnd(code));
  };

  if (Number.isInteger(watchPid) && watchPid > 0) {
    pollTimer = setInterval(() => {
      if (!isAlive(watchPid)) void shutdown(0);
    }, pollMs);
  }

  try {
    const executable = cfg.letmeknowBin || (await installBinary(msg => warnings.push(msg)));
    const savedFp = cfg.session || (await loadSavedSessionFp(cfg.key));

    const tryStart = args =>
      new Promise((resolveStart, rejectStart) => {
        const child = spawnCommand(executable, args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: childEnv,
          windowsHide: true,
        });
        let errors = "";
        let settled = false;
        child.stderr.on("data", chunk => {
          errors = (errors + chunk).slice(-2000);
        });
        child.on("error", err => {
          if (!settled) {
            settled = true;
            rejectStart(err);
          }
        });
        child.on("exit", (code, signal) => {
          if (!settled) {
            settled = true;
            rejectStart(new Error(errors.trim() || (signal ? `signal ${signal}` : `exit ${code}`)));
            return;
          }
          if (shuttingDown || listenChild !== child) return;
          const again = fp && bin ? `: ${bin} --session ${fp} ${attached ? "attach" : "listen"}` : ".";
          const detail = errors.trim();
          const why = signal ? `signal ${signal}` : `exit ${code}`;
          const notice = `letmeknow stopped (${why})${detail ? `: ${detail}` : ""}. Nothing reaches you until it runs again${again}`;
          queueImmediateNotice(notice);
        });
        createInterface({ input: child.stdout }).on("line", line => {
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event.type !== "ready") {
            wake(line);
            return;
          }
          fp = event.fp;
          bin = event.bin || executable;
          log = event.log || "";
          attached = args.includes("attach");
          if (!settled) {
            settled = true;
            listenChild = child;
            resolveStart();
            return;
          }
          if (cfg.key) void saveSessionFp(cfg.key, fp).catch(() => {});
          void writeTermState().catch(() => {});
        });
      });

    const startWithFallbacks = async () => {
      if (savedFp && savedFp !== cfg.attach) {
        try {
          await tryStart(["--session", savedFp, "listen"]);
          return;
        } catch (err) {
          warnings.push(`letmeknow: not ${savedFp} again (${err.message})`);
        }
      }
      if (cfg.attach) {
        try {
          await tryStart(["--session", cfg.attach, "attach"]);
          return;
        } catch (err) {
          warnings.push(`letmeknow: not attached to ${cfg.attach} (${err.message}); starting a new letmeknow session`);
        }
      }
      await tryStart(["listen"]);
    };

    await startWithFallbacks();
    if (shuttingDown) return;

    if (cfg.key) {
      await saveSessionFp(cfg.key, fp).catch(() => {});
    }
    await writeTermState();

    // Release prepare.mjs / in-place wrapper immediately so the harness boots concurrently with group join.
    notifyIpc({ ok: true, fp, bin, log, sidecarPid: process.pid });

    // Start hc events + boot fallback timer right away so we never miss initial OSC 7501 status.
    bootTimer = setTimeout(() => {
      bootTimer = undefined;
      openBootGate();
    }, cfg.bootFallbackMs);
    startHcEvents();

    // Best-effort hc label lmk=<fp>.
    void execFileCommand(cfg.hcBin, ["label", terminalId, `lmk=${fp}`], {
      env: childEnv,
      timeout: 10_000,
      windowsHide: true,
    }).catch(() => {});

    let joinError;
    try {
      const joined = await joinListed(bin, fp, cfg.groups, stop.signal, childEnv);
      activeGroups = joined.joined;
      warnings.push(...joined.warnings);
    } catch (err) {
      if (shuttingDown) return;
      joinError = err;
      warnings.push(`letmeknow: joining groups failed: ${err.message}`);
    }
    if (shuttingDown) return;

    if (cfg.intro && !joinError) {
      if (activeGroups.length > 0) {
        for (const group of activeGroups) {
          if (shuttingDown) return;
          try {
            await lmkJson(bin, ["--session", fp, "intro", "--group", group, cfg.intro], childEnv, 30_000);
          } catch (err) {
            warnings.push(`letmeknow: intro failed for ${group}: ${err.stderr?.trim() || err.message}`);
          }
        }
      } else {
        try {
          await lmkJson(bin, ["--session", fp, "intro", cfg.intro], childEnv, 30_000);
        } catch (err) {
          warnings.push(`letmeknow: intro failed: ${err.stderr?.trim() || err.message}`);
        }
      }
    }
    if (shuttingDown) return;

    await writeTermState();

    if (joinError) {
      await emitReadyFile({ fp, groups: [], warnings, error: joinError.message });
    } else {
      await emitReadyFile({ fp, groups: activeGroups, warnings });
    }
  } catch (err) {
    console.error(`hc-letmeknow sidecar error: ${err.message}`);
    notifyIpc({ ok: false, error: err.message });
    await emitReadyFile({ error: err.message }).catch(() => {});
    await shutdown(1);
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const args = parseSidecarArgv(process.argv.slice(2));
  void runSidecar(args);
}
