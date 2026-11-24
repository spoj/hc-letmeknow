import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodeExecOpts, encodeExecOpts, isAlive } from "../src/core.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = dirname(TEST_DIR);
const HC_LMK = join(REPO_DIR, "bin", "hc-lmk");
const HC_LMK_EXEC = join(REPO_DIR, "bin", "hc-lmk-exec");
const LMK_BIN = join(REPO_DIR, "bin", "lmk");
const SIDECAR = join(REPO_DIR, "src", "sidecar.mjs");

const tmpRoot = await mkdtemp(join(tmpdir(), "hc-lmk-int-test-"));
const spawnedChildren = [];

after(async () => {
  for (const child of spawnedChildren) {
    try { child.kill("SIGKILL"); } catch {}
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

async function waitFor(fn, timeoutMs = 8000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise(r => setTimeout(r, 40));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function runCmd(cmd, args, { env, input, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    spawnedChildren.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", c => (stdout += c));
    child.stderr.on("data", c => (stderr += c));
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function createFakeEnv(name) {
  const work = await mkdtemp(join(tmpRoot, `${name}-`));
  const home = join(work, "home");
  await mkdir(home, { recursive: true });

  const hcLogPath = join(work, "hc-calls.jsonl");
  const hcEventsFile = join(work, "hc-events.jsonl");
  const hcControlFile = join(work, "hc-control.json");
  const lmkLogPath = join(work, "lmk-calls.jsonl");
  const lmkEventsFile = join(work, "lmk-events.jsonl");
  const lmkStateFile = join(work, "lmk-state.json");
  const lmkControlFile = join(work, "lmk-control.json");

  await writeFile(hcControlFile, JSON.stringify({
    terminalState: "live",
    terminalStatus: null,
    sendResponses: [], // queue of { code, kind, message } or "ok"
    dropEventsOnce: false,
    runExitCode: 0,
    runAddress: "t99",
  }));
  await writeFile(lmkControlFile, JSON.stringify({
    joinDelayMs: 0,
    attachFails: true,
    sessionFailFps: [],
    crashAfterMs: 0,
  }));

  const fakeHcPath = join(work, "fake-hc");
  await writeFile(
    fakeHcPath,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const logPath = ${JSON.stringify(hcLogPath)};
const eventsFile = ${JSON.stringify(hcEventsFile)};
const controlFile = ${JSON.stringify(hcControlFile)};
const loadCtl = () => JSON.parse(readFileSync(controlFile, "utf8"));
const saveCtl = c => writeFileSync(controlFile, JSON.stringify(c));
appendFileSync(logPath, JSON.stringify({ args, at: Date.now() }) + "\\n");

const sub = args[0];
if (sub === "run") {
  const ctl = loadCtl();
  if (ctl.runExitCode && ctl.runExitCode !== 0) {
    process.stderr.write(JSON.stringify({ error: { kind: "name_taken", message: "name in use" } }) + "\\n");
    process.exit(ctl.runExitCode);
  }
  process.stdout.write(JSON.stringify({ address: ctl.runAddress || "t99", state: "live", labels: {} }) + "\\n");
  process.exit(0);
}
if (sub === "label") {
  process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
  process.exit(0);
}
if (sub === "get") {
  const ctl = loadCtl();
  if (ctl.terminalState === "not_found") {
    process.stderr.write(JSON.stringify({ error: { kind: "not_found", message: "missing" } }) + "\\n");
    process.exit(3);
  }
  const tid = args.at(-1);
  process.stdout.write(JSON.stringify({
    address: tid,
    state: ctl.terminalState || "live",
    status: ctl.terminalStatus ? { state: ctl.terminalStatus } : null,
  }) + "\\n");
  process.exit(0);
}
if (sub === "send") {
  const ctl = loadCtl();
  const next = Array.isArray(ctl.sendResponses) && ctl.sendResponses.length ? ctl.sendResponses.shift() : "ok";
  saveCtl(ctl);
  if (next && next !== "ok") {
    process.stderr.write(JSON.stringify({ error: { kind: next.kind, message: next.message || next.kind } }) + "\\n");
    process.exit(next.code ?? 1);
  }
  process.stdout.write(JSON.stringify({ turn: 1, status: ctl.terminalStatus || null, started: true }) + "\\n");
  process.exit(0);
}
if (sub === "events") {
  const ctl = loadCtl();
  const tidIdx = args.indexOf("--terminal");
  const tid = tidIdx >= 0 ? args[tidIdx + 1] : "t1";
  process.stdout.write(JSON.stringify({
    channel: null,
    seq: 1,
    terminals: [{
      address: tid,
      state: ctl.terminalState || "live",
      status: ctl.terminalStatus ? { state: ctl.terminalStatus } : null,
    }],
  }) + "\\n");
  if (ctl.dropEventsOnce) {
    ctl.dropEventsOnce = false;
    saveCtl(ctl);
    setTimeout(() => process.exit(1), 60);
    await new Promise(() => {});
  }
  let offset = 0;
  const iv = setInterval(() => {
    if (!existsSync(eventsFile)) return;
    const raw = readFileSync(eventsFile, "utf8");
    if (raw.length <= offset) return;
    const chunk = raw.slice(offset);
    offset = raw.length;
    for (const line of chunk.split("\\n").filter(Boolean)) {
      process.stdout.write(line + "\\n");
    }
  }, 30);
  const stop = () => { clearInterval(iv); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
`,
    { mode: 0o755 }
  );
  await chmod(fakeHcPath, 0o755);

  const fakeLmkPath = join(work, "fake-letmeknow");
  await writeFile(
    fakeLmkPath,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const logPath = ${JSON.stringify(lmkLogPath)};
const eventsFile = ${JSON.stringify(lmkEventsFile)};
const stateFile = ${JSON.stringify(lmkStateFile)};
const controlFile = ${JSON.stringify(lmkControlFile)};
const loadSt = () => existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { seq: 0, sessions: {} };
const saveSt = s => writeFileSync(stateFile, JSON.stringify(s));
const loadCtl = () => JSON.parse(readFileSync(controlFile, "utf8"));
appendFileSync(logPath, JSON.stringify({
  args,
  hadLmkSession: "LETMEKNOW_SESSION" in process.env,
  pid: process.pid,
  at: Date.now(),
}) + "\\n");

let sessionArg = "";
let rest = [...args];
if (rest[0] === "--session") {
  sessionArg = rest[1];
  rest = rest.slice(2);
}
const cmd = rest[0];

if (cmd === "sessions") {
  const st = loadSt();
  const list = [
    { fp: "sib0000000000001", running: true, groups: ["grp_alpha", "grp_beta"] },
    ...Object.entries(st.sessions).map(([fp, v]) => ({ fp, running: v.running, groups: v.groups })),
  ];
  process.stdout.write(JSON.stringify({ sessions: list }) + "\\n");
  process.exit(0);
}
if (cmd === "invite") {
  const gIdx = rest.indexOf("--group");
  const grp = gIdx >= 0 ? rest[gIdx + 1] : "grp_alpha";
  const ctl = loadCtl();
  if (ctl.joinDelayMs > 0) {
    await new Promise(r => setTimeout(r, ctl.joinDelayMs));
  }
  process.stdout.write(JSON.stringify({ link: "https://letmeknow.dev/i/" + grp }) + "\\n");
  process.exit(0);
}
if (cmd === "join") {
  const link = rest[1] || "";
  const grp = link.split("/").at(-1) || "grp_alpha";
  const st = loadSt();
  if (st.sessions[sessionArg] && !st.sessions[sessionArg].groups.includes(grp)) {
    st.sessions[sessionArg].groups.push(grp);
    saveSt(st);
  }
  process.stdout.write(JSON.stringify({ joined: grp }) + "\\n");
  process.exit(0);
}
if (cmd === "intro") {
  process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
  process.exit(0);
}
if (cmd === "echo") {
  let stdin = "";
  for await (const c of process.stdin) stdin += c;
  process.stdout.write(JSON.stringify({ session: sessionArg, rest, stdin, hadLmkSession: "LETMEKNOW_SESSION" in process.env }) + "\\n");
  process.exit(0);
}
if (cmd === "fail") {
  process.exit(Number(rest[1] || 7));
}
if (cmd === "attach") {
  const ctl = loadCtl();
  if (ctl.attachFails) {
    process.stderr.write("cannot attach to session\\n");
    process.exit(1);
  }
  const fp = sessionArg || "attach0000000001";
  process.stdout.write(JSON.stringify({ type: "ready", fp, bin: ${JSON.stringify(fakeLmkPath)}, log: "/tmp/fake-attach.log" }) + "\\n");
  const iv = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => { clearInterval(iv); process.exit(0); });
  await new Promise(() => {});
}
if (cmd === "listen") {
  const st = loadSt();
  const ctl = loadCtl();
  let fp = sessionArg;
  if (fp && (ctl.sessionFailFps || []).includes(fp)) {
    process.stderr.write("session gone\\n");
    process.exit(1);
  }
  if (!fp) {
    st.seq += 1;
    fp = String(st.seq).padStart(16, "f");
    st.sessions[fp] = { running: true, groups: [] };
    saveSt(st);
  } else if (!st.sessions[fp]) {
    process.stderr.write("unknown session\\n");
    process.exit(1);
  } else {
    st.sessions[fp].running = true;
    saveSt(st);
  }
  const logFile = ${JSON.stringify(join(work, "lmk-session.log"))};
  process.stdout.write(JSON.stringify({ type: "ready", fp, bin: ${JSON.stringify(fakeLmkPath)}, log: logFile }) + "\\n");
  let offset = 0;
  const iv = setInterval(() => {
    if (!existsSync(eventsFile)) return;
    const raw = readFileSync(eventsFile, "utf8");
    if (raw.length <= offset) return;
    const chunk = raw.slice(offset);
    offset = raw.length;
    for (const line of chunk.split("\\n").filter(Boolean)) {
      process.stdout.write(line + "\\n");
    }
  }, 30);
  if (ctl.crashAfterMs > 0) {
    setTimeout(() => {
      clearInterval(iv);
      process.stderr.write("simulated crash\\n");
      process.exit(2);
    }, ctl.crashAfterMs);
  }
  const stop = () => {
    clearInterval(iv);
    const cur = loadSt();
    if (cur.sessions[fp]) cur.sessions[fp].running = false;
    saveSt(cur);
    appendFileSync(logPath, JSON.stringify({ stopped: fp, pid: process.pid }) + "\\n");
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
`,
    { mode: 0o755 }
  );
  await chmod(fakeLmkPath, 0o755);

  const readHcCalls = async () => {
    if (!existsSync(hcLogPath)) return [];
    return (await readFile(hcLogPath, "utf8")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  };
  const readLmkCalls = async () => {
    if (!existsSync(lmkLogPath)) return [];
    return (await readFile(lmkLogPath, "utf8")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  };
  const setHcControl = async patch => {
    const cur = JSON.parse(await readFile(hcControlFile, "utf8"));
    await writeFile(hcControlFile, JSON.stringify({ ...cur, ...patch }));
  };
  const setLmkControl = async patch => {
    const cur = JSON.parse(await readFile(lmkControlFile, "utf8"));
    await writeFile(lmkControlFile, JSON.stringify({ ...cur, ...patch }));
  };
  const emitHcEvent = async obj => {
    await appendFile(hcEventsFile, `${JSON.stringify(obj)}\n`);
  };
  const emitLmkEvent = async obj => {
    await appendFile(lmkEventsFile, `${JSON.stringify(obj)}\n`);
  };

  return {
    work,
    home,
    fakeHcPath,
    fakeLmkPath,
    readHcCalls,
    readLmkCalls,
    setHcControl,
    setLmkControl,
    emitHcEvent,
    emitLmkEvent,
  };
}

test("outer hc-lmk launches hc run with local hc-lmk-exec, remote _exec, --json/address output, and forwards errors", async () => {
  const fx = await createFakeEnv("outer");
  const baseEnv = { ...process.env, HOME: fx.home };
  delete baseEnv.HC_TERMINAL_ID;

  // 1. Local outer launch with --bg --json
  const r1 = await runCmd(
    HC_LMK,
    ["--bg", "--json", "--hc", fx.fakeHcPath, "--join", "grp_alpha", "--name", "bot1", "--label", "owner=tg", "codex", "--no-daemon"],
    { env: baseEnv, cwd: fx.work }
  );
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(JSON.parse(r1.stdout).address, "t99");

  let calls = await fx.readHcCalls();
  assert.equal(calls.length, 1);
  const runArgs1 = calls[0].args;
  assert.deepEqual(runArgs1.slice(0, 3), ["run", "--bg", "--json"]);
  const sep = runArgs1.indexOf("--");
  assert.equal(runArgs1[sep + 1], HC_LMK_EXEC);
  const decoded1 = decodeExecOpts(runArgs1[sep + 2]);
  assert.deepEqual(decoded1.join, ["grp_alpha"]);
  assert.deepEqual(runArgs1.slice(sep + 3), ["--", "codex", "--no-daemon"]);

  // 2. Non-TTY without --json prints plain address
  const r2 = await runCmd(HC_LMK, ["--hc", fx.fakeHcPath, "bash"], { env: baseEnv });
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(r2.stdout.trim(), "t99");

  // 3. Remote --on uses `hc-lmk _exec` instead of local abs path, keeps remote relative --ready-file
  const r3 = await runCmd(
    HC_LMK,
    ["--bg", "--on", "vps", "--ready-file", "rel/ready.json", "--hc", fx.fakeHcPath, "pi", "--name", "x"],
    { env: baseEnv }
  );
  assert.equal(r3.code, 0, r3.stderr);
  calls = await fx.readHcCalls();
  const runArgs3 = calls[2].args;
  const sep3 = runArgs3.indexOf("--");
  assert.equal(runArgs3[sep3 + 1], "hc-lmk");
  assert.equal(runArgs3[sep3 + 2], "_exec");
  assert.equal(decodeExecOpts(runArgs3[sep3 + 3]).readyFile, "rel/ready.json");
  assert.deepEqual(runArgs3.slice(sep3 + 4), ["--", "pi", "--name", "x"]);

  // 4. Inside hc WITH --new spawns new hc run (without passing --new to hc)
  const r4 = await runCmd(
    HC_LMK,
    ["--new", "--hc", fx.fakeHcPath, "bash"],
    { env: { ...baseEnv, HC_TERMINAL_ID: "t5" } }
  );
  assert.equal(r4.code, 0, r4.stderr);
  calls = await fx.readHcCalls();
  assert.equal(calls[3].args.includes("--new"), false);

  // 5. Name collision / hc run failure propagates non-zero exit code + stderr
  await fx.setHcControl({ runExitCode: 6 });
  const r5 = await runCmd(HC_LMK, ["--bg", "--json", "--name", "dup", "--hc", fx.fakeHcPath, "bash"], { env: baseEnv });
  assert.equal(r5.code, 6);
  assert.match(r5.stderr, /name_taken/);
});

test("hc-lmk-exec performs POSIX exec (same PID), exports env, deletes temp env file, boots concurrently with slow join, and cleans up on exit", async () => {
  const fx = await createFakeEnv("posix-exec");
  await fx.setLmkControl({ joinDelayMs: 600 });

  const readyFile = join(fx.work, "ready.json");
  const reportFile = join(fx.work, "child-report.json");
  const releaseFile = join(fx.work, "release.flag");
  const encoded = encodeExecOpts({
    joinSpecified: true,
    join: ["grp_alpha"],
    attachSpecified: true,
    attach: "",
    readyFile,
    hc: fx.fakeHcPath,
    letmeknowBin: fx.fakeLmkPath,
    intro: "worker intro",
    bootFallbackMs: 200,
  });

  // Launch hc-lmk-exec directly, simulating inside an hc terminal
  const childScript = `
    import { existsSync, readdirSync, writeFileSync } from "node:fs";
    const stateDir = ${JSON.stringify(join(fx.home, ".local", "state", "hc-letmeknow"))};
    const envFilesLeft = existsSync(stateDir) ? readdirSync(stateDir).filter(f => f.startsWith("env-")) : [];
    writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify({
      pid: process.pid,
      readyExistsAtBoot: existsSync(${JSON.stringify(readyFile)}),
      envFilesLeft,
      env: {
        LETMEKNOW_SESSION: process.env.LETMEKNOW_SESSION,
        LETMEKNOW_BIN: process.env.LETMEKNOW_BIN,
        LETMEKNOW_LOG: process.env.LETMEKNOW_LOG,
        AGY_LETMEKNOW_DISABLE: process.env.AGY_LETMEKNOW_DISABLE,
        PI_LETMEKNOW_DISABLE: process.env.PI_LETMEKNOW_DISABLE,
        CLAUDE_LETMEKNOW_DISABLE: process.env.CLAUDE_LETMEKNOW_DISABLE,
        AGY_CLI_OSC7501: process.env.AGY_CLI_OSC7501,
      },
    }));
    while (!existsSync(${JSON.stringify(releaseFile)})) {
      await new Promise(r => setTimeout(r, 30));
    }
    process.exit(17);
  `;
  const scriptPath = join(fx.work, "target.mjs");
  await writeFile(scriptPath, childScript);

  const proc = spawn(HC_LMK_EXEC, [encoded, "--", process.execPath, scriptPath], {
    env: {
      ...process.env,
      HOME: fx.home,
      HC_TERMINAL_ID: "t42",
      LETMEKNOW_SESSION: "outer-should-not-leak-to-lmk",
      HC_LETMEKNOW_POLL_MS: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawnedChildren.push(proc);
  let stderr = "";
  proc.stderr.on("data", c => (stderr += c));

  // Target must boot BEFORE the 600ms group join completes, AND inherit the exact PID of hc-lmk-exec!
  const report = await waitFor(async () => existsSync(reportFile) && JSON.parse(await readFile(reportFile, "utf8")), 5000, "target boot");
  assert.equal(report.pid, proc.pid, "POSIX exec must preserve PID (no lingering sh/node wrapper)");
  assert.equal(report.readyExistsAtBoot, false, "harness must boot concurrently BEFORE slow group join completes");
  assert.deepEqual(report.envFilesLeft, [], "temp env file must be deleted before exec");
  assert.equal(report.env.LETMEKNOW_SESSION, "fffffffffffffff1");
  assert.equal(report.env.LETMEKNOW_BIN, fx.fakeLmkPath);
  assert.ok(report.env.LETMEKNOW_LOG.endsWith("lmk-session.log"));
  assert.equal(report.env.AGY_LETMEKNOW_DISABLE, "1");
  assert.equal(report.env.PI_LETMEKNOW_DISABLE, "1");
  assert.equal(report.env.CLAUDE_LETMEKNOW_DISABLE, "1");
  assert.equal(report.env.AGY_CLI_OSC7501, "on");

  // Ready file written after slow sibling join finishes
  const ready = await waitFor(async () => existsSync(readyFile) && JSON.parse(await readFile(readyFile, "utf8")), 5000, "ready file");
  assert.equal(ready.fp, "fffffffffffffff1");
  assert.deepEqual(ready.groups, ["grp_alpha"]);
  assert.deepEqual(ready.warnings, []);
  const readyMode = (await stat(readyFile)).mode & 0o777;
  assert.equal(readyMode, 0o600);

  // term-t42.json exists with mode 0600 and expected fields
  const termFile = join(fx.home, ".local", "state", "hc-letmeknow", "term-t42.json");
  const termState = JSON.parse(await readFile(termFile, "utf8"));
  assert.equal((await stat(termFile)).mode & 0o777, 0o600);
  assert.equal(termState.fp, "fffffffffffffff1");
  assert.equal(termState.bin, fx.fakeLmkPath);
  assert.deepEqual(termState.groups, ["grp_alpha"]);
  assert.equal(isAlive(termState.sidecarPid), true);

  // Verify hc label and letmeknow intro were called, and LETMEKNOW_SESSION was stripped from letmeknow children
  const hcCalls = await fx.readHcCalls();
  assert.ok(hcCalls.some(c => c.args[0] === "label" && c.args[1] === "t42" && c.args[2] === "lmk=fffffffffffffff1"));
  const lmkCalls = await fx.readLmkCalls();
  assert.ok(lmkCalls.some(c => c.args.includes("intro") && c.args.includes("worker intro")));
  assert.ok(lmkCalls.filter(c => c.args).every(c => c.hadLmkSession === false));

  // Test `lmk` CLI both WITH env vars and WITH env vars stripped (fallback to term-t42.json)
  const lmkWithEnv = await runCmd(LMK_BIN, ["echo", "hello"], {
    env: {
      ...process.env,
      HOME: fx.home,
      LETMEKNOW_BIN: fx.fakeLmkPath,
      LETMEKNOW_SESSION: "fffffffffffffff1",
    },
    input: "pipe-data",
  });
  assert.equal(lmkWithEnv.code, 0, lmkWithEnv.stderr);
  assert.deepEqual(JSON.parse(lmkWithEnv.stdout), {
    session: "fffffffffffffff1",
    rest: ["echo", "hello"],
    stdin: "pipe-data",
    hadLmkSession: false,
  });

  const strippedEnv = { PATH: process.env.PATH, HOME: fx.home, HC_TERMINAL_ID: "t42" };
  const lmkFallback = await runCmd(LMK_BIN, ["echo", "from-state"], {
    env: strippedEnv,
    input: "fallback-in",
  });
  assert.equal(lmkFallback.code, 0, lmkFallback.stderr);
  assert.deepEqual(JSON.parse(lmkFallback.stdout), {
    session: "fffffffffffffff1",
    rest: ["echo", "from-state"],
    stdin: "fallback-in",
    hadLmkSession: false,
  });

  // `lmk` mirrors child exit code
  const lmkFail = await runCmd(LMK_BIN, ["fail", "23"], { env: strippedEnv });
  assert.equal(lmkFail.code, 23);

  // Release target process -> exits with 17; sidecar must detect watched PID exit, stop letmeknow listen, and delete term-t42.json
  const exitPromise = new Promise(resolve => proc.once("exit", code => resolve(code)));
  await writeFile(releaseFile, "go");
  const exitCode = await exitPromise;
  assert.equal(exitCode, 17, stderr);

  await waitFor(() => !isAlive(termState.sidecarPid) && !existsSync(termFile), 5000, "sidecar cleanup");
  const finalLmkCalls = await fx.readLmkCalls();
  assert.ok(finalLmkCalls.some(c => c.stopped === "fffffffffffffff1"));

  // After shutdown, `lmk` with stripped env must fail cleanly
  const lmkAfter = await runCmd(LMK_BIN, ["echo", "gone"], { env: strippedEnv });
  assert.equal(lmkAfter.code, 1);
  assert.match(lmkAfter.stderr, /no active hc-letmeknow session/);
});

test("hc-lmk in-place mode inside hc wraps command, mirrors exit code, and stops sidecar on exit", async () => {
  const fx = await createFakeEnv("in-place");
  const outFile = join(fx.work, "inplace.json");
  const cmdCode = `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      fp: process.env.LETMEKNOW_SESSION,
      bin: process.env.LETMEKNOW_BIN,
      osc: process.env.AGY_CLI_OSC7501,
      piDisable: process.env.PI_LETMEKNOW_DISABLE,
      agyDisable: process.env.AGY_LETMEKNOW_DISABLE,
      claudeDisable: process.env.CLAUDE_LETMEKNOW_DISABLE,
    }));
    process.exit(42);
  `;
  const res = await runCmd(
    HC_LMK,
    ["--no-join", "--hc", fx.fakeHcPath, "--letmeknow-bin", fx.fakeLmkPath, process.execPath, "-e", cmdCode],
    {
      env: { ...process.env, HOME: fx.home, HC_TERMINAL_ID: "t88" },
    }
  );
  assert.equal(res.code, 42, res.stderr);
  const info = JSON.parse(await readFile(outFile, "utf8"));
  assert.equal(info.fp, "fffffffffffffff1");
  assert.equal(info.bin, fx.fakeLmkPath);
  assert.equal(info.osc, "on");
  assert.equal(info.piDisable, "1");
  assert.equal(info.agyDisable, "1");
  assert.equal(info.claudeDisable, "1");

  // Sidecar stopped and term-t88.json cleaned up before hc-lmk returned
  const termFile = join(fx.home, ".local", "state", "hc-letmeknow", "term-t88.json");
  assert.equal(existsSync(termFile), false);
});

test("sidecar boot gate (OSC 7501), inline vs inbox spill, blocked retry, reconnect, and unexpected letmeknow exit", async () => {
  const fx = await createFakeEnv("delivery-always");
  // Queue a blocked (exit 9) response on the very first hc send, then succeed
  await fx.setHcControl({
    terminalState: "live",
    terminalStatus: null,
    dropEventsOnce: true,
    sendResponses: [{ code: 9, kind: "blocked", message: "permission prompt" }, "ok", "ok", "ok", "ok"],
  });

  const encoded = encodeExecOpts({
    joinSpecified: true,
    join: [],
    attachSpecified: true,
    attach: "",
    deliver: "always",
    inlineBytes: 180,
    bootFallbackMs: 60_000, // Long fallback so ONLY OSC 7501 opens boot gate
    hc: fx.fakeHcPath,
    letmeknowBin: fx.fakeLmkPath,
    prefix: "[lmk]",
  });

  const sidecar = spawn(process.execPath, [SIDECAR, "--opts", encoded, "--terminal", "t10"], {
    env: {
      ...process.env,
      HOME: fx.home,
      HC_LETMEKNOW_DEBOUNCE_MS: "120",
      HC_LETMEKNOW_RETRY_MS: "10000", // Long safety timer so status-change retry is proven!
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  spawnedChildren.push(sidecar);
  const readyMsg = await new Promise((resolve, reject) => {
    sidecar.once("message", resolve);
    sidecar.once("error", reject);
  });
  assert.equal(readyMsg.ok, true);

  // Wait for first events drop + reconnect (hc events called twice)
  await waitFor(async () => (await fx.readHcCalls()).filter(c => c.args[0] === "events").length >= 2, 5000, "events reconnect");

  // Emit event 1 while terminal has NOT sent OSC 7501 yet -> must be held by boot gate!
  await fx.emitLmkEvent({ type: "message", from: "alice", content: "hello\nworld" });
  await new Promise(r => setTimeout(r, 300));
  let sends = (await fx.readHcCalls()).filter(c => c.args[0] === "send");
  assert.equal(sends.length, 0, "event must be held by boot gate before OSC 7501");

  // Emit OSC 7501 status=idle -> opens boot gate -> first send hits blocked (exit 9)
  await fx.emitHcEvent({
    jsonrpc: "2.0",
    method: "event",
    params: { terminal: "t10", type: "status", data: { status: { state: "idle" } } },
  });
  await waitFor(async () => (await fx.readHcCalls()).filter(c => c.args[0] === "send").length >= 1, 4000, "first blocked send");
  // Confirm NO --if idle in always mode
  sends = (await fx.readHcCalls()).filter(c => c.args[0] === "send");
  assert.equal(sends[0].args.includes("--if"), false);

  // Now transition status -> working -> immediately retries blocked batch and succeeds!
  await fx.emitHcEvent({
    jsonrpc: "2.0",
    method: "event",
    params: { terminal: "t10", type: "status", data: { status: { state: "working" } } },
  });
  await waitFor(async () => (await fx.readHcCalls()).filter(c => c.args[0] === "send").length >= 2, 4000, "retry send");
  sends = (await fx.readHcCalls()).filter(c => c.args[0] === "send");
  const firstDelivered = sends[1].args.at(-1);
  assert.match(firstDelivered, /^\[lmk\] \(session=fffffffffffffff1 log=.*?; use lmk CLI\) /);
  assert.equal(/[\r\n]/.test(firstDelivered), false, "paste must be guaranteed single-line");
  assert.ok(firstDelivered.includes('"content":"hello\\nworld"'));

  // Event 2: short single event -> inline WITHOUT session/log header
  await fx.emitLmkEvent({ type: "message", from: "bob", content: "short" });
  await waitFor(async () => (await fx.readHcCalls()).filter(c => c.args[0] === "send").length >= 3, 4000, "second inline send");
  sends = (await fx.readHcCalls()).filter(c => c.args[0] === "send");
  const secondDelivered = sends[2].args.at(-1);
  assert.ok(secondDelivered.startsWith("[lmk] {"));
  assert.equal(secondDelivered.includes("session="), false);

  // Event 3: single event exceeding inlineBytes (180) -> spills to inbox/fp/000001.jsonl (0600)
  await fx.emitLmkEvent({ type: "message", from: "carol", content: "X".repeat(250) });
  await waitFor(async () => (await fx.readHcCalls()).filter(c => c.args[0] === "send").length >= 4, 4000, "large spill send");
  sends = (await fx.readHcCalls()).filter(c => c.args[0] === "send");
  const spill1 = sends[3].args.at(-1);
  assert.match(spill1, /^\[lmk\] 1 event \(\d+ B\) saved to .*000001\.jsonl — read and handle$/);
  const inboxDir = join(fx.home, ".local", "state", "hc-letmeknow", "inbox", "fffffffffffffff1");
  const inbox1 = join(inboxDir, "000001.jsonl");
  assert.equal((await stat(inbox1)).mode & 0o777, 0o600);
  assert.ok((await readFile(inbox1, "utf8")).includes("X".repeat(250)));

  // Events 4 & 5: two events coalesced within debounce window -> spills to 000002.jsonl
  await fx.emitLmkEvent({ type: "message", from: "d1", content: "m1" });
  await fx.emitLmkEvent({ type: "message", from: "d2", content: "m2" });
  await waitFor(async () => (await fx.readHcCalls()).filter(c => c.args[0] === "send").length >= 5, 4000, "multi spill send");
  sends = (await fx.readHcCalls()).filter(c => c.args[0] === "send");
  const spill2 = sends[4].args.at(-1);
  assert.match(spill2, /^\[lmk\] 2 events \(\d+ B\) saved to .*000002\.jsonl — read and handle$/);
  const inbox2Lines = (await readFile(join(inboxDir, "000002.jsonl"), "utf8")).trim().split("\n");
  assert.equal(inbox2Lines.length, 2);

  // Send finished event from hc events -> sidecar shuts down cleanly!
  const exitPromise = new Promise(resolve => sidecar.once("exit", code => resolve(code)));
  await fx.emitHcEvent({
    jsonrpc: "2.0",
    method: "event",
    params: { terminal: "t10", type: "finished", data: { exit_code: 0 } },
  });
  const code = await exitPromise;
  assert.equal(code, 0);
  assert.equal(existsSync(join(fx.home, ".local", "state", "hc-letmeknow", "term-t10.json")), false);
});

test("sidecar --deliver idle uses --if idle, retries on status_mismatch (exit 10), respects bootFallbackMs, and notices unexpected letmeknow exit", async () => {
  const fx = await createFakeEnv("delivery-idle");
  await fx.setHcControl({
    terminalState: "live",
    terminalStatus: null,
    sendResponses: [
      { code: 10, kind: "status_mismatch", message: "t20 is working, not idle" },
      "ok",
      "ok",
    ],
  });
  await fx.setLmkControl({ crashAfterMs: 700 });

  const encoded = encodeExecOpts({
    joinSpecified: true,
    join: [],
    attachSpecified: true,
    attach: "",
    deliver: "idle",
    bootFallbackMs: 150, // Fast fallback for non-7501 program
    hc: fx.fakeHcPath,
    letmeknowBin: fx.fakeLmkPath,
  });

  const sidecar = spawn(process.execPath, [SIDECAR, "--opts", encoded, "--terminal", "t20"], {
    env: {
      ...process.env,
      HOME: fx.home,
      HC_LETMEKNOW_DEBOUNCE_MS: "80",
      HC_LETMEKNOW_RETRY_MS: "10000",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  spawnedChildren.push(sidecar);
  const readyMsg = await new Promise((resolve, reject) => {
    sidecar.once("message", resolve);
    sidecar.once("error", reject);
  });
  assert.equal(readyMsg.ok, true);

  // Emit event -> bootFallbackMs (150ms) opens gate -> sends with --if idle -- t20 -> hits status_mismatch (exit 10)
  await fx.emitLmkEvent({ type: "message", from: "eve", content: "idle-check" });
  await waitFor(async () => (await fx.readHcCalls()).filter(c => c.args[0] === "send").length >= 1, 4000, "idle mismatch send");
  let sends = (await fx.readHcCalls()).filter(c => c.args[0] === "send");
  assert.deepEqual(sends[0].args.slice(0, 6), ["send", "--json", "--if", "idle", "--", "t20"]);

  // Emit status=idle -> immediately retries and succeeds!
  await fx.emitHcEvent({
    jsonrpc: "2.0",
    method: "event",
    params: { terminal: "t20", type: "status", data: { status: { state: "idle" } } },
  });
  await waitFor(async () => (await fx.readHcCalls()).filter(c => c.args[0] === "send").length >= 2, 4000, "idle retry send");

  // Fake letmeknow crashes at ~700ms -> sidecar queues crash notice to terminal!
  await waitFor(async () => (await fx.readHcCalls()).filter(c => c.args[0] === "send").length >= 3, 4000, "crash notice send");
  sends = (await fx.readHcCalls()).filter(c => c.args[0] === "send");
  assert.match(sends[2].args.at(-1), /letmeknow stopped \(exit 2\): simulated crash/);

  // Trigger finished via hc send returning exit 11 (finished) on next event
  await fx.setHcControl({ sendResponses: [{ code: 11, kind: "finished", message: "done" }] });
  const exitPromise = new Promise(resolve => sidecar.once("exit", code => resolve(code)));
  await fx.emitHcEvent({
    jsonrpc: "2.0",
    method: "event",
    params: { terminal: "t20", type: "removed", data: {} },
  });
  assert.equal(await exitPromise, 0);
});

test("sidecar shuts down on hc send exit 3 (not_found) / exit 11 (finished), reuses inbox file on retry, and hc-lmk _exec works", async () => {
  const fx = await createFakeEnv("send-fatal-and-exec");
  await fx.setHcControl({
    terminalState: "live",
    terminalStatus: "idle",
    sendResponses: [
      { code: 9, kind: "blocked", message: "blocked once" },
      "ok",
      { code: 11, kind: "finished", message: "terminal ended" },
    ],
  });

  const encoded = encodeExecOpts({
    joinSpecified: true,
    join: [],
    attachSpecified: true,
    attach: "",
    deliver: "always",
    inlineBytes: 40, // force inbox spill
    bootFallbackMs: 200,
    hc: fx.fakeHcPath,
    letmeknowBin: fx.fakeLmkPath,
  });

  const sidecar = spawn(process.execPath, [SIDECAR, "--opts", encoded, "--terminal", "t55"], {
    env: {
      ...process.env,
      HOME: fx.home,
      HC_LETMEKNOW_DEBOUNCE_MS: "60",
      HC_LETMEKNOW_RETRY_MS: "120",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  spawnedChildren.push(sidecar);
  const ready = await new Promise(resolve => sidecar.once("message", resolve));
  assert.equal(ready.ok, true);

  // Event 1 spills to inbox -> first send blocked -> safety retry succeeds WITHOUT creating a duplicate inbox file!
  await fx.emitLmkEvent({ type: "message", from: "u1", content: "spill-and-retry-payload" });
  await waitFor(async () => (await fx.readHcCalls()).filter(c => c.args[0] === "send").length >= 2, 4000, "retry send");
  const inboxDir = join(fx.home, ".local", "state", "hc-letmeknow", "inbox", "fffffffffffffff1");
  const filesAfterRetry = await readdir(inboxDir);
  assert.deepEqual(filesAfterRetry, ["000001.jsonl"], "retrying same batch must not create duplicate inbox files");

  // Event 2 hits hc send exit 11 (finished) -> sidecar must shut down cleanly!
  const exitPromise = new Promise(resolve => sidecar.once("exit", code => resolve(code)));
  await fx.emitLmkEvent({ type: "message", from: "u2", content: "after-finished-payload" });
  assert.equal(await exitPromise, 0);
  assert.equal(existsSync(join(fx.home, ".local", "state", "hc-letmeknow", "term-t55.json")), false);

  // Test `hc-lmk _exec` internal remote entrypoint directly
  const execEncoded = encodeExecOpts({
    joinSpecified: true,
    join: [],
    attachSpecified: true,
    attach: "",
    hc: fx.fakeHcPath,
    letmeknowBin: fx.fakeLmkPath,
  });
  const execRes = await runCmd(
    HC_LMK,
    ["_exec", execEncoded, "--", process.execPath, "-e", "process.stdout.write(process.env.LETMEKNOW_SESSION || ''); process.exit(9)"],
    { env: { ...process.env, HOME: fx.home, HC_TERMINAL_ID: "t56" } }
  );
  assert.equal(execRes.code, 9, execRes.stderr);
  assert.equal(execRes.stdout, "fffffffffffffff2");
  assert.equal(existsSync(join(fx.home, ".local", "state", "hc-letmeknow", "term-t56.json")), false);

  // Test failure before ready writes { error } to readyFile and exits non-zero
  const badReady = join(fx.work, "bad-ready.json");
  const badEncoded = encodeExecOpts({
    joinSpecified: true,
    join: [],
    readyFile: badReady,
    hc: fx.fakeHcPath,
    letmeknowBin: join(fx.work, "does-not-exist-lmk"),
  });
  const failRes = await runCmd(HC_LMK_EXEC, [badEncoded, "--", "true"], {
    env: { ...process.env, HOME: fx.home, HC_TERMINAL_ID: "t57" },
  });
  assert.notEqual(failRes.code, 0);
  const badReceipt = JSON.parse(await readFile(badReady, "utf8"));
  assert.ok(typeof badReceipt.error === "string" && badReceipt.error.length > 0);
});

test("sidecar --deliver idle defers during working, delivers on confirmed done without --if idle, and passes -- before dash-prefixed text", async () => {
  const fx = await createFakeEnv("deliver-idle-done");
  await fx.setHcControl({
    terminalState: "live",
    terminalStatus: "working",
    sendResponses: ["ok", { code: 10, kind: "status_mismatch", message: "t60 is done, not idle" }, "ok"],
  });

  const encoded = encodeExecOpts({
    joinSpecified: true,
    join: [],
    attachSpecified: true,
    attach: "",
    deliver: "idle",
    bootFallbackMs: 60_000,
    hc: fx.fakeHcPath,
    letmeknowBin: fx.fakeLmkPath,
    prefix: "-hello",
  });

  const sidecar = spawn(process.execPath, [SIDECAR, "--opts", encoded, "--terminal", "t60"], {
    env: {
      ...process.env,
      HOME: fx.home,
      HC_LETMEKNOW_DEBOUNCE_MS: "60",
      HC_LETMEKNOW_RETRY_MS: "10000",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  spawnedChildren.push(sidecar);
  const ready = await new Promise(resolve => sidecar.once("message", resolve));
  assert.equal(ready.ok, true);

  // Event arrives while terminal is "working" -> boot gate is open (snapshot status was working),
  // but --deliver idle MUST defer without calling hc send!
  await fx.emitLmkEvent({ type: "message", from: "u1", content: "wait-for-done" });
  await new Promise(r => setTimeout(r, 250));
  assert.equal((await fx.readHcCalls()).filter(c => c.args[0] === "send").length, 0, "must defer while working");

  // Transition to "done" in hc events while hc get STILL reports "working" -> confirmation guard must keep deferring!
  await fx.emitHcEvent({
    jsonrpc: "2.0",
    method: "event",
    params: { terminal: "t60", type: "status", data: { status: { state: "done" } } },
  });
  await new Promise(r => setTimeout(r, 200));
  assert.equal((await fx.readHcCalls()).filter(c => c.args[0] === "send").length, 0, "must defer if hc get sees working");

  // Now hc get confirms "done" and hc events transitions working -> done -> delivers WITHOUT --if idle and WITH -- before "-hello ..."!
  await fx.setHcControl({ terminalStatus: "done" });
  await fx.emitHcEvent({
    jsonrpc: "2.0",
    method: "event",
    params: { terminal: "t60", type: "status", data: { status: { state: "done" } } },
  });
  await waitFor(async () => (await fx.readHcCalls()).filter(c => c.args[0] === "send").length >= 1, 4000, "done delivery");
  let sends = (await fx.readHcCalls()).filter(c => c.args[0] === "send");
  assert.deepEqual(sends[0].args.slice(0, 4), ["send", "--json", "--", "t60"]);
  assert.equal(sends[0].args.includes("--if"), false, "confirmed done must omit --if idle");
  assert.ok(sends[0].args[4].startsWith("-hello "), "dash-prefixed text safely follows -- separator");

  // Self-heal when hc events reported "idle" but terminal transitioned to "done" before hc send --if idle arrived:
  // send #2 hits exit 10 (status_mismatch), sidecar checks hc get -> sees "done" -> immediately retries send #3 without --if idle!
  await fx.emitHcEvent({
    jsonrpc: "2.0",
    method: "event",
    params: { terminal: "t60", type: "status", data: { status: { state: "idle" } } },
  });
  await new Promise(r => setTimeout(r, 80));
  await fx.emitLmkEvent({ type: "message", from: "u2", content: "lagged-done" });
  await waitFor(async () => (await fx.readHcCalls()).filter(c => c.args[0] === "send").length >= 3, 4000, "status_mismatch done self-heal");
  sends = (await fx.readHcCalls()).filter(c => c.args[0] === "send");
  assert.deepEqual(sends[1].args.slice(0, 6), ["send", "--json", "--if", "idle", "--", "t60"]);
  assert.deepEqual(sends[2].args.slice(0, 4), ["send", "--json", "--", "t60"]);

  sidecar.kill("SIGTERM");
  await new Promise(resolve => sidecar.once("exit", resolve));
});

test("sidecar start priority: --session -> --key -> attach -> fresh listen with fallbacks", async () => {
  const fx = await createFakeEnv("priority");
  await fx.setLmkControl({ attachFails: true });

  // 1. First run with --key myconv and failing --attach -> falls back to fresh listen (fp = fffffffffffffff1) and saves key
  const ready1 = join(fx.work, "r1.json");
  const enc1 = encodeExecOpts({
    joinSpecified: true,
    join: [],
    key: "myconv",
    attachSpecified: true,
    attach: "deadattach000001",
    readyFile: ready1,
    hc: fx.fakeHcPath,
    letmeknowBin: fx.fakeLmkPath,
  });
  const s1 = spawn(process.execPath, [SIDECAR, "--opts", enc1, "--terminal", "t31"], {
    env: { ...process.env, HOME: fx.home },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  spawnedChildren.push(s1);
  const m1 = await new Promise(resolve => s1.once("message", resolve));
  assert.equal(m1.ok, true);
  assert.equal(m1.fp, "fffffffffffffff1");
  const r1Data = await waitFor(async () => existsSync(ready1) && JSON.parse(await readFile(ready1, "utf8")));
  assert.equal(r1Data.warnings.some(w => w.includes("not attached to deadattach000001")), true);
  s1.kill("SIGTERM");
  await new Promise(resolve => s1.once("exit", resolve));

  // 2. Second run with same --key myconv -> resumes fffffffffffffff1!
  const ready2 = join(fx.work, "r2.json");
  const enc2 = encodeExecOpts({
    joinSpecified: true,
    join: [],
    key: "myconv",
    attachSpecified: true,
    attach: "",
    readyFile: ready2,
    hc: fx.fakeHcPath,
    letmeknowBin: fx.fakeLmkPath,
  });
  const s2 = spawn(process.execPath, [SIDECAR, "--opts", enc2, "--terminal", "t32"], {
    env: { ...process.env, HOME: fx.home },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  spawnedChildren.push(s2);
  const m2 = await new Promise(resolve => s2.once("message", resolve));
  assert.equal(m2.ok, true);
  assert.equal(m2.fp, "fffffffffffffff1");
  s2.kill("SIGTERM");
  await new Promise(resolve => s2.once("exit", resolve));

  // 3. Explicit --session failing falls back to working --attach!
  await fx.setLmkControl({ attachFails: false, sessionFailFps: ["missing000000001"] });
  const ready3 = join(fx.work, "r3.json");
  const enc3 = encodeExecOpts({
    joinSpecified: true,
    join: [],
    session: "missing000000001",
    attachSpecified: true,
    attach: "liveattach000001",
    readyFile: ready3,
    hc: fx.fakeHcPath,
    letmeknowBin: fx.fakeLmkPath,
  });
  const s3 = spawn(process.execPath, [SIDECAR, "--opts", enc3, "--terminal", "t33"], {
    env: { ...process.env, HOME: fx.home },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  spawnedChildren.push(s3);
  const m3 = await new Promise(resolve => s3.once("message", resolve));
  assert.equal(m3.ok, true);
  assert.equal(m3.fp, "liveattach000001");
  const r3Data = await waitFor(async () => existsSync(ready3) && JSON.parse(await readFile(ready3, "utf8")));
  assert.equal(r3Data.warnings.some(w => w.includes("not missing000000001 again")), true);
  s3.kill("SIGTERM");
  await new Promise(resolve => s3.once("exit", resolve));
});
