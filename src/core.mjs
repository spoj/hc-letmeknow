import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

export const MINOR = "0.26";
export const TARGET = `${process.platform}-${process.arch}`;
export const EXECUTABLE = process.platform === "win32" ? "letmeknow.exe" : "letmeknow";
export const INVITE_WAIT_MS = 180_000;
export const DEFAULT_DEBOUNCE_MS = 2000;
export const MAX_LINE_CHARS = 12 * 1024;
export const MAX_BATCH_BYTES = 50 * 1024;
export const MAX_BATCH_LINES = 2000;
export const DEFAULT_INLINE_BYTES = 1536;
export const DEFAULT_BOOT_FALLBACK_MS = 5000;
export const DEFAULT_PREFIX = "[letmeknow]";
export const DEFAULT_DELIVER = "always";
export const DEFAULT_HC = "hc";
export const EXEC_OPTS_PREFIX = "v1:";

const run = promisify(execFile);

export function stateDir() {
  return join(homedir(), ".local", "state", "hc-letmeknow");
}

export function defaultConfigPath() {
  return join(homedir(), ".config", "hc-letmeknow", "config.json");
}

export function cacheDirs() {
  const home = homedir();
  return [
    join(home, ".cache", "hc-letmeknow", TARGET),
    join(home, ".cache", "agy-letmeknow", TARGET),
    join(home, ".cache", "pi-letmeknow", TARGET),
  ];
}

export function safePathSegment(raw) {
  const cleaned = String(raw ?? "").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "unknown";
  }
  return cleaned;
}

export function termStatePath(terminalId) {
  return join(stateDir(), `term-${safePathSegment(terminalId)}.json`);
}

export function sessionsFilePath() {
  return join(stateDir(), "sessions.json");
}

export function inboxDirPath(fp) {
  return join(stateDir(), "inbox", safePathSegment(fp));
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export async function writeFileAtomic(filePath, content, mode = 0o600) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, content, { mode });
  await chmod(tmp, mode).catch(() => {});
  await rename(tmp, filePath);
}

export async function writeJsonAtomic(filePath, payload) {
  await writeFileAtomic(filePath, `${JSON.stringify(payload)}\n`, 0o600);
}

export function readJsonIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildEnvExports({ fp, bin, log }) {
  const entries = [
    ["LETMEKNOW_SESSION", fp],
    ["LETMEKNOW_BIN", bin],
    ["LETMEKNOW_LOG", log ?? ""],
    ["AGY_LETMEKNOW_DISABLE", "1"],
    ["PI_LETMEKNOW_DISABLE", "1"],
    ["CLAUDE_LETMEKNOW_DISABLE", "1"],
    ["AGY_CLI_OSC7501", "on"],
  ];
  return entries;
}

export function formatShellEnvFile(info) {
  return `${buildEnvExports(info).map(([k, v]) => `export ${k}=${shQuote(v)}`).join("\n")}\n`;
}

export function encodeExecOpts(opts) {
  return `${EXEC_OPTS_PREFIX}${Buffer.from(JSON.stringify(opts), "utf8").toString("base64url")}`;
}

export function decodeExecOpts(encoded) {
  if (typeof encoded !== "string" || !encoded.startsWith(EXEC_OPTS_PREFIX)) {
    throw new Error("invalid encoded hc-lmk options");
  }
  const raw = Buffer.from(encoded.slice(EXEC_OPTS_PREFIX.length), "base64url").toString("utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("decoded hc-lmk options must be an object");
  }
  return parsed;
}

export function splitGroups(raw) {
  return String(raw)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function parseNonNegInt(flag, raw) {
  if (raw === "" || !/^\d+$/.test(String(raw))) {
    throw new Error(`${flag} expects a non-negative integer, got: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${flag} expects a non-negative integer, got: ${raw}`);
  }
  return value;
}

export const HC_NEW_TERMINAL_FLAGS = [
  "bg",
  "new",
  "name",
  "on",
  "cwd",
  "noParent",
  "outliveParent",
  "noNotify",
  "keep",
  "rm",
];

export function hasNewTerminalFlags(parsed) {
  if (parsed.labels.length > 0) return true;
  return HC_NEW_TERMINAL_FLAGS.some(key => Boolean(parsed[key]));
}

export function parseCliArgs(argv) {
  const result = {
    help: false,
    // letmeknow options
    joinSpecified: false,
    join: [],
    attachSpecified: false,
    attach: undefined,
    session: undefined,
    key: undefined,
    readyFile: undefined,
    deliver: undefined,
    inlineBytes: undefined,
    bootFallbackMs: undefined,
    config: undefined,
    hc: undefined,
    letmeknowBin: undefined,
    intro: undefined,
    prefix: undefined,
    // hc passthrough options
    bg: false,
    new: false,
    json: false,
    name: undefined,
    cwd: undefined,
    on: undefined,
    labels: [],
    noParent: false,
    outliveParent: false,
    noNotify: false,
    keep: false,
    rm: false,
    // target command
    command: [],
  };

  let i = 0;
  const takeValue = (flag, inlineVal) => {
    if (inlineVal !== undefined) return inlineVal;
    if (i + 1 >= argv.length) {
      throw new Error(`missing value for ${flag}`);
    }
    i += 1;
    return argv[i];
  };

  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      result.command = argv.slice(i + 1);
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      result.command = argv.slice(i);
      break;
    }

    const eqIdx = arg.indexOf("=");
    const flag = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
    const inlineVal = eqIdx >= 0 ? arg.slice(eqIdx + 1) : undefined;

    const assertNoValue = () => {
      if (inlineVal !== undefined) {
        throw new Error(`${flag} does not take a value`);
      }
    };

    switch (flag) {
      case "-h":
      case "--help":
        assertNoValue();
        result.help = true;
        return result;
      case "--join": {
        const val = takeValue(flag, inlineVal);
        result.joinSpecified = true;
        const items = splitGroups(val);
        if (items.length === 0) {
          result.join = [];
        } else {
          for (const g of items) {
            if (!result.join.includes(g)) result.join.push(g);
          }
        }
        break;
      }
      case "--no-join":
        assertNoValue();
        result.joinSpecified = true;
        result.join = [];
        break;
      case "--attach": {
        const val = takeValue(flag, inlineVal);
        result.attachSpecified = true;
        result.attach = val;
        break;
      }
      case "--no-attach":
        assertNoValue();
        result.attachSpecified = true;
        result.attach = "";
        break;
      case "--session":
        result.session = takeValue(flag, inlineVal);
        break;
      case "--key":
        result.key = takeValue(flag, inlineVal);
        break;
      case "--ready-file":
        result.readyFile = takeValue(flag, inlineVal);
        break;
      case "--deliver": {
        const val = takeValue(flag, inlineVal);
        if (val !== "always" && val !== "idle") {
          throw new Error(`--deliver must be "always" or "idle", got: ${val}`);
        }
        result.deliver = val;
        break;
      }
      case "--inline-bytes":
        result.inlineBytes = parseNonNegInt(flag, takeValue(flag, inlineVal));
        break;
      case "--boot-fallback-ms":
        result.bootFallbackMs = parseNonNegInt(flag, takeValue(flag, inlineVal));
        break;
      case "--config":
        result.config = takeValue(flag, inlineVal);
        break;
      case "--hc":
        result.hc = takeValue(flag, inlineVal);
        break;
      case "--letmeknow-bin":
        result.letmeknowBin = takeValue(flag, inlineVal);
        break;
      case "--intro":
        result.intro = takeValue(flag, inlineVal);
        break;
      case "--prefix":
        result.prefix = takeValue(flag, inlineVal);
        break;
      case "--bg":
        assertNoValue();
        result.bg = true;
        break;
      case "--new":
        assertNoValue();
        result.new = true;
        break;
      case "--json":
        assertNoValue();
        result.json = true;
        break;
      case "--name":
        result.name = takeValue(flag, inlineVal);
        break;
      case "--cwd":
        result.cwd = takeValue(flag, inlineVal);
        break;
      case "--on":
        result.on = takeValue(flag, inlineVal);
        break;
      case "--label":
        result.labels.push(takeValue(flag, inlineVal));
        break;
      case "--no-parent":
        assertNoValue();
        result.noParent = true;
        break;
      case "--outlive-parent":
        assertNoValue();
        result.outliveParent = true;
        break;
      case "--no-notify":
        assertNoValue();
        result.noNotify = true;
        break;
      case "--keep":
        assertNoValue();
        result.keep = true;
        break;
      case "--rm":
        assertNoValue();
        result.rm = true;
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }

  return result;
}

export function extractExecOpts(parsed, { isRemote = false, baseCwd = process.cwd() } = {}) {
  const resolveLocal = p => (p && !isRemote ? resolve(baseCwd, p) : p);
  const opts = {};
  if (parsed.joinSpecified) {
    opts.joinSpecified = true;
    opts.join = parsed.join;
  }
  if (parsed.attachSpecified) {
    opts.attachSpecified = true;
    opts.attach = parsed.attach;
  }
  if (parsed.session !== undefined) opts.session = parsed.session;
  if (parsed.key !== undefined) opts.key = parsed.key;
  if (parsed.readyFile !== undefined) opts.readyFile = resolveLocal(parsed.readyFile);
  if (parsed.deliver !== undefined) opts.deliver = parsed.deliver;
  if (parsed.inlineBytes !== undefined) opts.inlineBytes = parsed.inlineBytes;
  if (parsed.bootFallbackMs !== undefined) opts.bootFallbackMs = parsed.bootFallbackMs;
  if (parsed.config !== undefined) opts.config = resolveLocal(parsed.config);
  if (parsed.hc !== undefined) opts.hc = parsed.hc;
  if (parsed.letmeknowBin !== undefined) opts.letmeknowBin = resolveLocal(parsed.letmeknowBin);
  if (parsed.intro !== undefined) opts.intro = parsed.intro;
  if (parsed.prefix !== undefined) opts.prefix = parsed.prefix;
  return opts;
}

export function buildHcRunArgs(parsed, execArgv) {
  const args = ["run", "--bg", "--json"];
  if (parsed.name) args.push("--name", parsed.name);
  if (parsed.cwd) args.push("--cwd", parsed.cwd);
  if (parsed.on) args.push("--on", parsed.on);
  for (const label of parsed.labels) args.push("--label", label);
  if (parsed.noParent) args.push("--no-parent");
  if (parsed.outliveParent) args.push("--outlive-parent");
  if (parsed.noNotify) args.push("--no-notify");
  if (parsed.keep) args.push("--keep");
  if (parsed.rm) args.push("--rm");
  args.push("--", ...execArgv);
  return args;
}

export function resolveSidecarConfig(execOpts, fileConfig = {}) {
  const groups = execOpts.joinSpecified
    ? (Array.isArray(execOpts.join) ? execOpts.join.filter(Boolean) : [])
    : (Array.isArray(fileConfig.join) ? fileConfig.join.map(s => String(s).trim()).filter(Boolean) : []);

  const attach = execOpts.attachSpecified
    ? (execOpts.attach || undefined)
    : (fileConfig.attach || undefined);

  const deliver = execOpts.deliver ?? fileConfig.deliver ?? DEFAULT_DELIVER;
  if (deliver !== "always" && deliver !== "idle") {
    throw new Error(`invalid deliver mode: ${deliver}`);
  }

  const inlineBytes = execOpts.inlineBytes ?? fileConfig.inlineBytes ?? DEFAULT_INLINE_BYTES;
  const bootFallbackMs = execOpts.bootFallbackMs ?? fileConfig.bootFallbackMs ?? DEFAULT_BOOT_FALLBACK_MS;
  const hcBin = execOpts.hc ?? fileConfig.hc ?? DEFAULT_HC;
  const letmeknowBin = execOpts.letmeknowBin ?? fileConfig.letmeknowBin ?? undefined;
  const intro = execOpts.intro ?? fileConfig.intro ?? undefined;
  const prefix = execOpts.prefix ?? fileConfig.prefix ?? DEFAULT_PREFIX;

  return {
    groups,
    attach,
    session: execOpts.session || undefined,
    key: execOpts.key || undefined,
    readyFile: execOpts.readyFile || undefined,
    deliver,
    inlineBytes,
    bootFallbackMs,
    hcBin,
    letmeknowBin,
    intro,
    prefix,
  };
}

export function capLine(line) {
  return line.length > MAX_LINE_CHARS
    ? `${line.slice(0, MAX_LINE_CHARS)} [letmeknow: line truncated; the session's log has the whole line.]`
    : line;
}

export function capLines(lines) {
  const kept = [];
  let bytes = 0;
  let truncated = false;
  for (const line of lines) {
    const add = Buffer.byteLength(line, "utf8") + (kept.length ? 1 : 0);
    if (kept.length >= MAX_BATCH_LINES || (kept.length > 0 && bytes + add > MAX_BATCH_BYTES)) {
      truncated = true;
      break;
    }
    kept.push(line);
    bytes += add;
  }
  if (truncated) kept.push("[letmeknow: output truncated; the rest is in the session's log.]");
  return kept;
}

export function sanitizeSingleLine(text) {
  return String(text)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

export function formatDeliveryHeader({ prefix = DEFAULT_PREFIX, fp, log, firstDelivery }) {
  const safePrefix = sanitizeSingleLine(prefix).trim() || DEFAULT_PREFIX;
  if (!firstDelivery) return safePrefix;
  const safeFp = sanitizeSingleLine(fp).trim();
  const safeLog = log ? sanitizeSingleLine(log).trim() : "";
  const meta = safeLog ? `session=${safeFp} log=${safeLog}; use lmk CLI` : `session=${safeFp}; use lmk CLI`;
  return `${safePrefix} (${meta})`;
}

export function formatInlineCandidate(line, opts) {
  const header = formatDeliveryHeader(opts);
  const safeLine = sanitizeSingleLine(line);
  return `${header} ${safeLine}`;
}

export function formatInboxPointer({ count, bytes, inboxPath, prefix = DEFAULT_PREFIX, fp, log, firstDelivery }) {
  const header = formatDeliveryHeader({ prefix, fp, log, firstDelivery });
  const safePath = sanitizeSingleLine(inboxPath);
  const noun = count === 1 ? "event" : "events";
  return `${header} ${count} ${noun} (${bytes} B) saved to ${safePath} — read and handle`;
}

export function classifyHcError(err) {
  const code = typeof err?.code === "number" ? err.code : undefined;
  let kind;
  for (const raw of [err?.stderr, err?.stdout]) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    for (const line of raw.trim().split("\n")) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.error?.kind === "string") {
          kind = parsed.error.kind;
          break;
        }
      } catch {}
    }
    if (kind) break;
  }
  if (kind === "not_found" || code === 3) return "not_found";
  if (kind === "finished" || code === 11) return "finished";
  if (kind === "blocked" || code === 9) return "blocked";
  if (kind === "status_mismatch" || code === 10) return "status_mismatch";
  if (kind === "cancelled") return "cancelled";
  return "transient";
}

function highestMinor(versions) {
  return versions
    .filter(v => v.startsWith(`${MINOR}.`) && /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => Number(a.split(".")[2]) - Number(b.split(".")[2]))
    .at(-1);
}

async function cachedIn(dir) {
  if (!existsSync(dir)) return undefined;
  const versions = (await readdir(dir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, "bin", EXECUTABLE)))
    .map(entry => entry.name);
  const version = highestMinor(versions);
  return version ? { version, executable: join(dir, version, "bin", EXECUTABLE) } : undefined;
}

export async function findBestCachedBinary() {
  let best;
  for (const dir of cacheDirs()) {
    const found = await cachedIn(dir);
    if (!found) continue;
    if (!best || Number(found.version.split(".")[2]) > Number(best.version.split(".")[2])) {
      best = found;
    }
  }
  return best;
}

export async function installBinary(warn = () => {}) {
  const [primaryCache] = cacheDirs();
  await mkdir(primaryCache, { recursive: true });
  let versions;
  try {
    const found = await fetch(`https://registry.npmjs.org/@letmeknow/${TARGET}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!found.ok) throw new Error(`npm has no @letmeknow/${TARGET} (${found.status})`);
    ({ versions } = await found.json());
  } catch (offline) {
    const best = await findBestCachedBinary();
    if (!best) throw offline;
    warn(`letmeknow: cannot look for a newer ${MINOR} release (${offline.message}); running cached ${best.version}`);
    return best.executable;
  }
  const latest = highestMinor(Object.keys(versions ?? {}));
  if (!latest) throw new Error(`letmeknow has no ${MINOR} release for ${TARGET}`);
  const dest = join(primaryCache, latest);
  const executable = join(dest, "bin", EXECUTABLE);
  if (existsSync(executable)) return executable;
  const { tarball, integrity } = versions[latest].dist;
  const fetched = await fetch(tarball);
  if (!fetched.ok) throw new Error(`cannot fetch letmeknow ${latest} (${fetched.status})`);
  const bytes = Buffer.from(await fetched.arrayBuffer());
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity) {
    throw new Error(`letmeknow ${latest} does not match its integrity`);
  }
  const tmp = await mkdtemp(join(primaryCache, "new-"));
  try {
    await writeFile(join(tmp, "package.tgz"), bytes);
    await run("tar", ["-xzf", "package.tgz"], { cwd: tmp, windowsHide: true });
    await access(join(tmp, "package", "bin", EXECUTABLE));
    try {
      await rename(join(tmp, "package"), dest);
    } catch (error) {
      if (!existsSync(executable)) throw error;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return executable;
}

export async function killChildCleanly(child, graceMs = 2000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolveExit => child.once("exit", resolveExit));
  if (process.platform === "win32") {
    try { child.kill(); } catch {}
    await Promise.race([exited, new Promise(r => setTimeout(r, graceMs))]);
    return;
  }
  try { child.kill("SIGTERM"); } catch {}
  const done = await Promise.race([
    exited.then(() => true),
    new Promise(r => setTimeout(() => r(false), graceMs)),
  ]);
  if (!done && child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch {}
    await Promise.race([exited, new Promise(r => setTimeout(r, 1000))]);
  }
}

export async function killPidCleanly(pid, graceMs = 2500) {
  if (!isAlive(pid)) return;
  if (process.platform === "win32") {
    try { process.kill(pid); } catch {}
  } else {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise(r => setTimeout(r, 40));
  }
  if (isAlive(pid) && process.platform !== "win32") {
    try { process.kill(pid, "SIGKILL"); } catch {}
    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline && isAlive(pid)) {
      await new Promise(r => setTimeout(r, 40));
    }
  }
}

export async function lmkJson(executable, args, env, timeout = 0) {
  return JSON.parse((await run(executable, args, { env, timeout, windowsHide: true })).stdout);
}

async function inviteFrom(executable, sibling, group, use, signal, env, inviteWaitMs = INVITE_WAIT_MS) {
  const invite = async () =>
    (await lmkJson(executable, ["--session", sibling.fp, "invite", "--group", group], env, inviteWaitMs)).link;
  if (sibling.running) {
    await use(await invite());
    return;
  }
  const listen = spawn(executable, ["--session", sibling.fp, "listen"], {
    stdio: ["ignore", "pipe", "pipe"],
    signal,
    env,
    windowsHide: true,
  });
  try {
    await new Promise((resolveReady, rejectReady) => {
      let errors = "";
      let settled = false;
      const done = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(val);
      };
      listen.stderr.on("data", chunk => (errors = (errors + chunk).slice(-2000)));
      listen.on("error", err => done(rejectReady, err));
      listen.on("exit", code => done(rejectReady, new Error(`session ${sibling.fp} stopped (exit ${code}): ${errors.trim()}`)));
      const timer = setTimeout(
        () => done(rejectReady, new Error(`session ${sibling.fp} was not ready within ${inviteWaitMs / 1000} s`)),
        inviteWaitMs
      );
      timer.unref();
      createInterface({ input: listen.stdout }).on("line", line => {
        try {
          if (JSON.parse(line).type === "ready") done(resolveReady);
        } catch {}
      });
    });
    signal.throwIfAborted();
    await use(await invite());
  } finally {
    await killChildCleanly(listen, 1500);
  }
}

export async function joinListed(executable, fp, groups, signal, env, inviteWaitMs = INVITE_WAIT_MS) {
  if (!groups.length) return { joined: [], warnings: [] };
  const { sessions } = await lmkJson(executable, ["sessions"], env);
  const list = Array.isArray(sessions) ? sessions : [];
  const joined = [];
  const warnings = [];
  for (const group of groups) {
    signal.throwIfAborted();
    if (list.find(s => s.fp === fp)?.groups?.includes(group)) {
      joined.push(group);
      continue;
    }
    const siblings = list
      .filter(s => s.fp !== fp && s.groups?.includes(group))
      .sort(
        (a, b) =>
          (Number(Boolean(b.running)) - Number(Boolean(a.running))) ||
          String(b.last_ran ?? "").localeCompare(String(a.last_ran ?? ""))
      );
    const failures = [];
    let ok = false;
    for (const sibling of siblings) {
      signal.throwIfAborted();
      try {
        await inviteFrom(
          executable,
          sibling,
          group,
          link => lmkJson(executable, ["--session", fp, "join", link], env, inviteWaitMs),
          signal,
          env,
          inviteWaitMs
        );
        joined.push(group);
        ok = true;
        break;
      } catch (error) {
        failures.push(`${sibling.fp}: ${error.stderr?.trim() || error.message}`);
      }
    }
    if (!ok) {
      warnings.push(
        `letmeknow: cannot join ${group} through a session of this machine${failures.length ? ` (${failures.join("; ")})` : ""}`
      );
    }
  }
  return { joined, warnings };
}

export async function saveSessionFp(key, fp, file = sessionsFilePath()) {
  if (!key || !fp) return;
  let sessions = {};
  if (existsSync(file)) {
    try {
      sessions = JSON.parse(await readFile(file, "utf8"));
    } catch {
      sessions = {};
    }
  }
  if (sessions[key]?.fp === fp) return;
  sessions[key] = { fp };
  await writeJsonAtomic(file, sessions);
}

export async function loadSavedSessionFp(key, file = sessionsFilePath()) {
  if (!key || !existsSync(file)) return undefined;
  try {
    const sessions = JSON.parse(await readFile(file, "utf8"));
    return typeof sessions?.[key]?.fp === "string" ? sessions[key].fp : undefined;
  } catch {
    return undefined;
  }
}

export const USAGE = `Usage: hc-lmk [options] [--] <command> [args...]

Harness-agnostic letmeknow wrapper for herdr-core (hc).
Stops parsing options at the first positional <command> or --.

letmeknow options:
  --join <g1,g2>           Join group IDs (repeatable/comma-separated; "" disables)
  --no-join                Disable group joining
  --attach <fp>            Attach to an existing detached session ("" disables)
  --session <fp>           Resume a saved letmeknow session fingerprint
  --key <name>             Persist and resume session fingerprint under this key
  --ready-file <path>      Write atomic JSON { fp, groups, warnings } or { error }
  --deliver <always|idle>  Delivery mode (default: always; idle adds --if idle)
  --inline-bytes <n>       Max UTF-8 bytes to inline a single event (default: 1536)
  --boot-fallback-ms <n>   Boot gate fallback for non-OSC-7501 programs (default: 5000)
  --config <path>          Config JSON path (default: ~/.config/hc-letmeknow/config.json)
  --hc <bin>               Path or name of hc binary (default: hc)
  --letmeknow-bin <path>   Explicit letmeknow binary path (skips npm cache/fetch)
  --intro <text>           Set letmeknow session intro after joining groups
  --prefix <text>          Message delivery prefix (default: [letmeknow])

hc passthrough options (trigger new terminal when inside hc):
  --bg, --new, --json, --name <name>, --cwd <dir>, --on <machine>,
  --label <k=v> (repeatable), --no-parent, --outlive-parent,
  --no-notify, --keep, --rm
`;
