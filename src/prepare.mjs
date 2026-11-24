import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import {
  decodeExecOpts,
  formatShellEnvFile,
  safePathSegment,
  stateDir,
  writeFileAtomic,
  writeJsonAtomic,
} from "./core.mjs";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SIDECAR_PATH = join(SRC_DIR, "sidecar.mjs");
const STARTUP_TIMEOUT_MS = Number(process.env.HC_LETMEKNOW_STARTUP_TIMEOUT_MS) || 45_000;

export async function startSidecarAndWait({ encodedOpts, terminalId, watchPid, env = process.env }) {
  if (!terminalId) {
    throw new Error("HC_TERMINAL_ID is not set (must run inside an hc terminal)");
  }
  const execOpts = decodeExecOpts(encodedOpts);
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const errLogPath = join(
    dir,
    `sidecar-${safePathSegment(terminalId)}-${process.pid}-${randomBytes(4).toString("hex")}.log`
  );
  const errFd = openSync(errLogPath, "w", 0o600);

  const sidecarArgs = [SIDECAR_PATH, "--opts", encodedOpts, "--terminal", terminalId, "--err-log", errLogPath];
  if (watchPid && Number.isInteger(Number(watchPid)) && Number(watchPid) > 0) {
    sidecarArgs.push("--watch-pid", String(watchPid));
  }

  let child;
  try {
    child = spawn(process.execPath, sidecarArgs, {
      env,
      detached: true,
      stdio: ["ignore", "ignore", errFd, "ipc"],
      windowsHide: true,
    });
  } finally {
    closeSync(errFd);
  }

  const readErrLog = () => {
    try {
      return existsSync(errLogPath) ? readFileSync(errLogPath, "utf8").trim() : "";
    } catch {
      return "";
    }
  };

  try {
    const ready = await new Promise((resolveReady, rejectReady) => {
      let settled = false;
      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeAllListeners("message");
        child.removeAllListeners("error");
        child.removeAllListeners("exit");
        fn(val);
      };

      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        finish(rejectReady, new Error(`timed out waiting for letmeknow sidecar ready (${STARTUP_TIMEOUT_MS}ms)`));
      }, STARTUP_TIMEOUT_MS);

      child.on("error", err => finish(rejectReady, err));
      child.on("message", msg => {
        if (msg && msg.ok === true && msg.fp && msg.bin) {
          finish(resolveReady, msg);
        } else {
          const errText = msg?.error || readErrLog() || "sidecar failed to initialize";
          finish(rejectReady, new Error(errText));
        }
      });
      child.on("exit", (code, signal) => {
        const log = readErrLog();
        const detail = log ? `: ${log}` : "";
        finish(rejectReady, new Error(`sidecar exited early (${signal || `code ${code}`})${detail}`));
      });
    });

    if (child.connected) {
      child.disconnect();
    }
    child.unref();
    return ready;
  } catch (err) {
    if (execOpts.readyFile && !existsSync(execOpts.readyFile)) {
      await writeJsonAtomic(execOpts.readyFile, { error: err.message }).catch(() => {});
    }
    try {
      if (existsSync(errLogPath) && readErrLog() === "") rmSync(errLogPath, { force: true });
    } catch {}
    throw err;
  }
}

export async function prepareEnvFile({ encodedOpts, terminalId, watchPid, env = process.env }) {
  const ready = await startSidecarAndWait({ encodedOpts, terminalId, watchPid, env });
  const envFilePath = join(
    stateDir(),
    `env-${safePathSegment(terminalId)}-${process.pid}-${randomBytes(6).toString("hex")}.sh`
  );
  await writeFileAtomic(envFilePath, formatShellEnvFile(ready), 0o600);
  return { envFilePath, ready };
}

async function main() {
  const encodedOpts = process.argv[2];
  const watchPid = process.argv[3] ? Number(process.argv[3]) : undefined;
  if (!encodedOpts) {
    console.error("hc-lmk-exec: missing encoded options");
    process.exit(2);
  }
  const terminalId = process.env.HC_TERMINAL_ID;
  const { envFilePath } = await prepareEnvFile({
    encodedOpts,
    terminalId,
    watchPid: Number.isInteger(watchPid) && watchPid > 0 ? watchPid : undefined,
  });
  process.stdout.write(`${envFilePath}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  try {
    await main();
  } catch (err) {
    console.error(`hc-lmk: ${err.message}`);
    process.exit(1);
  }
}
