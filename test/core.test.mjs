import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { promisify } from "node:util";
import {
  EXECUTABLE,
  TARGET,
  buildExecArgv,
  buildHcRunArgs,
  buildWinCmdInvocation,
  capLine,
  capLines,
  classifyHcError,
  decodeExecOpts,
  encodeExecOpts,
  escapeWinCmdArg,
  escapeWinCmdCommand,
  extractExecOpts,
  formatInboxPointer,
  formatInlineCandidate,
  hasNewTerminalFlags,
  installBinary,
  isMainModule,
  isWinBatchFile,
  joinListed,
  parseCliArgs,
  prepareSpawnSpec,
  renameWithRetry,
  resolveSidecarConfig,
  resolveWinCommand,
  sanitizeSingleLine,
  shQuote,
  stripEnvVar,
} from "../src/core.mjs";

const run = promisify(execFile);
const tmpRoot = await mkdtemp(join(tmpdir(), "hc-lmk-core-test-"));
after(async () => {
  mock.restoreAll();
  await rm(tmpRoot, { recursive: true, force: true });
});

async function makeTarball(dir, version, content = `bin-${version}`) {
  const src = await mkdtemp(join(dir, "pkg-"));
  await mkdir(join(src, "package", "bin"), { recursive: true });
  await writeFile(join(src, "package", "bin", EXECUTABLE), content, { mode: 0o755 });
  await run("tar", ["-czf", "package.tgz", "package"], { cwd: src });
  const bytes = await readFile(join(src, "package.tgz"));
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  return { bytes, integrity };
}

test("parseCliArgs stops at first positional command or -- so harness flags pass straight through", () => {
  const p1 = parseCliArgs(["codex", "--no-daemon", "-m", "gpt-5", "--bg"]);
  assert.deepEqual(p1.command, ["codex", "--no-daemon", "-m", "gpt-5", "--bg"]);
  assert.equal(p1.bg, false);
  assert.equal(hasNewTerminalFlags(p1), false);

  const p2 = parseCliArgs(["--join", "g1,g2", "--join=g3,g1", "--bg", "--", "--cmd-with-dash", "-x"]);
  assert.equal(p2.joinSpecified, true);
  assert.deepEqual(p2.join, ["g1", "g2", "g3"]);
  assert.equal(p2.bg, true);
  assert.deepEqual(p2.command, ["--cmd-with-dash", "-x"]);
  assert.equal(hasNewTerminalFlags(p2), true);
});

test("parseCliArgs handles --no-join, --join '', --attach '', and all options", () => {
  const pNoJoin = parseCliArgs(["--no-join", "--attach", "", "bash"]);
  assert.equal(pNoJoin.joinSpecified, true);
  assert.deepEqual(pNoJoin.join, []);
  assert.equal(pNoJoin.attachSpecified, true);
  assert.equal(pNoJoin.attach, "");

  const pEmptyJoin = parseCliArgs(["--join", "g1", "--join", "", "bash"]);
  assert.equal(pEmptyJoin.joinSpecified, true);
  assert.deepEqual(pEmptyJoin.join, []);

  const pFull = parseCliArgs([
    "--join", "g1",
    "--attach=fp_attach",
    "--session", "fp_sess",
    "--key", "my-key",
    "--ready-file", "/tmp/r.json",
    "--deliver", "idle",
    "--inline-bytes", "0",
    "--boot-fallback-ms=250",
    "--config", "/tmp/cfg.json",
    "--hc", "/opt/hc",
    "--letmeknow-bin", "/opt/lmk",
    "--intro", "hello team",
    "--prefix", "[msg]",
    "--bg", "--new", "--json",
    "--name", "worker-1",
    "--cwd", "/srv/app",
    "--on", "vps",
    "--label", "owner=tg",
    "--label=role=agent",
    "--no-parent", "--outlive-parent", "--no-notify", "--keep", "--rm",
    "--", "agy", "--dangerously-skip-permissions",
  ]);
  assert.equal(pFull.attach, "fp_attach");
  assert.equal(pFull.session, "fp_sess");
  assert.equal(pFull.key, "my-key");
  assert.equal(pFull.readyFile, "/tmp/r.json");
  assert.equal(pFull.deliver, "idle");
  assert.equal(pFull.inlineBytes, 0);
  assert.equal(pFull.bootFallbackMs, 250);
  assert.equal(pFull.config, "/tmp/cfg.json");
  assert.equal(pFull.hc, "/opt/hc");
  assert.equal(pFull.letmeknowBin, "/opt/lmk");
  assert.equal(pFull.intro, "hello team");
  assert.equal(pFull.prefix, "[msg]");
  assert.deepEqual(pFull.labels, ["owner=tg", "role=agent"]);
  assert.equal(pFull.new, true);
  assert.equal(pFull.keep, true);
  assert.equal(pFull.rm, true);
  assert.deepEqual(pFull.command, ["agy", "--dangerously-skip-permissions"]);

  // buildHcRunArgs must NOT forward --new, and must always include --bg --json
  const hcArgs = buildHcRunArgs(pFull, ["hc-lmk", "_exec", "v1:abc", "--", "agy"]);
  assert.equal(hcArgs.includes("--new"), false);
  assert.deepEqual(hcArgs.slice(0, 3), ["run", "--bg", "--json"]);
  assert.ok(hcArgs.includes("--on"));
  assert.ok(hcArgs.includes("vps"));
  assert.ok(hcArgs.includes("--no-parent"));
  assert.ok(hcArgs.includes("--outlive-parent"));
  assert.ok(hcArgs.includes("--no-notify"));
  assert.ok(hcArgs.includes("--keep"));
  assert.ok(hcArgs.includes("--rm"));
});

test("parseCliArgs rejects unknown flags, bad deliver mode, and invalid numbers", () => {
  assert.throws(() => parseCliArgs(["--unknown", "bash"]), /unknown option/);
  assert.throws(() => parseCliArgs(["--deliver", "sometimes", "bash"]), /--deliver must be/);
  assert.throws(() => parseCliArgs(["--inline-bytes", "-5", "bash"]), /non-negative integer/);
  assert.throws(() => parseCliArgs(["--boot-fallback-ms", "abc", "bash"]), /non-negative integer/);
  assert.throws(() => parseCliArgs(["--join"]), /missing value/);
  assert.throws(() => parseCliArgs(["--bg=true", "bash"]), /does not take a value/);
});

test("hasNewTerminalFlags distinguishes in-place from new-terminal invocations", () => {
  assert.equal(hasNewTerminalFlags(parseCliArgs(["--join", "g1", "--json", "bash"])), false);
  for (const args of [
    ["--bg", "bash"],
    ["--new", "bash"],
    ["--name", "n1", "bash"],
    ["--on", "box", "bash"],
    ["--cwd", "/tmp", "bash"],
    ["--label", "a=b", "bash"],
    ["--no-parent", "bash"],
    ["--outlive-parent", "bash"],
    ["--no-notify", "bash"],
    ["--keep", "bash"],
    ["--rm", "bash"],
  ]) {
    assert.equal(hasNewTerminalFlags(parseCliArgs(args)), true, `expected true for ${args.join(" ")}`);
  }
});

test("encodeExecOpts/decodeExecOpts and resolveSidecarConfig precedence", () => {
  const parsed = parseCliArgs(["--join", "", "--attach", "", "--intro", "hi 'world'\n🚀", "bash"]);
  const extracted = extractExecOpts(parsed, { isRemote: true });
  const encoded = encodeExecOpts(extracted);
  assert.ok(encoded.startsWith("v1:"));
  assert.deepEqual(decodeExecOpts(encoded), extracted);
  assert.throws(() => decodeExecOpts("bad-token"), /invalid encoded/);

  // Config defaults overridden by explicit empty --join / --attach
  const cfgOverridden = resolveSidecarConfig(extracted, {
    join: ["cfg_group"],
    attach: "cfg_attach_fp",
    deliver: "idle",
    inlineBytes: 512,
  });
  assert.deepEqual(cfgOverridden.groups, []);
  assert.equal(cfgOverridden.attach, undefined);
  assert.equal(cfgOverridden.deliver, "idle");
  assert.equal(cfgOverridden.inlineBytes, 512);

  // Unspecified CLI falls back to config, then defaults
  const cfgFallback = resolveSidecarConfig({}, { join: ["cfg_group"], attach: "cfg_fp" });
  assert.deepEqual(cfgFallback.groups, ["cfg_group"]);
  assert.equal(cfgFallback.attach, "cfg_fp");
  assert.equal(cfgFallback.deliver, "always");
  assert.equal(cfgFallback.inlineBytes, 1536);
  assert.equal(cfgFallback.bootFallbackMs, 5000);
  assert.equal(cfgFallback.prefix, "[letmeknow]");
});

test("capLine, capLines, sanitizeSingleLine, shQuote, and delivery formatting", () => {
  const short = "x".repeat(12 * 1024);
  assert.equal(capLine(short), short);
  const long = "a".repeat(12 * 1024 + 10);
  assert.match(capLine(long), /line truncated/);

  const bigBatch = Array.from({ length: 20 }, (_, i) => `${i}:${"z".repeat(4000)}`);
  const capped = capLines(bigBatch);
  assert.match(capped.at(-1), /output truncated/);
  assert.ok(Buffer.byteLength(capped.join("\n"), "utf8") < 52 * 1024);

  const dirty = "line1\nline2\r\x1b[31mred\x00\u2028\u2029ok";
  const clean = sanitizeSingleLine(dirty);
  assert.equal(/[\r\n\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(clean), false);
  assert.ok(clean.includes("\\u2028"));

  assert.equal(shQuote("a'b\"c$d"), `'a'\\''b"c$d'`);

  const first = formatInlineCandidate('{"type":"message","content":"hi"}', {
    prefix: "[letmeknow]",
    fp: "abcdef0123456789",
    log: "/tmp/a.log",
    firstDelivery: true,
  });
  assert.equal(
    first,
    '[letmeknow] (session=abcdef0123456789 log=/tmp/a.log; use lmk CLI) {"type":"message","content":"hi"}'
  );
  const second = formatInlineCandidate('{"type":"message","content":"hi"}', {
    prefix: "[letmeknow]",
    fp: "abcdef0123456789",
    log: "/tmp/a.log",
    firstDelivery: false,
  });
  assert.equal(second, '[letmeknow] {"type":"message","content":"hi"}');

  const ptr = formatInboxPointer({
    count: 3,
    bytes: 4096,
    inboxPath: "/home/u/.local/state/hc-letmeknow/inbox/abc/000001.jsonl",
    prefix: "[letmeknow]",
    fp: "abc",
    log: "",
    firstDelivery: false,
  });
  assert.equal(
    ptr,
    "[letmeknow] 3 events (4096 B) saved to /home/u/.local/state/hc-letmeknow/inbox/abc/000001.jsonl — read and handle"
  );
});

test("classifyHcError recognizes exit codes and JSON error kinds", () => {
  assert.equal(classifyHcError({ code: 3 }), "not_found");
  assert.equal(classifyHcError({ code: 11 }), "finished");
  assert.equal(classifyHcError({ code: 9 }), "blocked");
  assert.equal(classifyHcError({ code: 10 }), "status_mismatch");
  assert.equal(
    classifyHcError({ code: 1, stderr: JSON.stringify({ error: { kind: "cancelled" } }) }),
    "cancelled"
  );
  assert.equal(
    classifyHcError({ code: 1, stdout: JSON.stringify({ error: { kind: "not_found" } }) }),
    "not_found"
  );
  assert.equal(classifyHcError({ code: 1, stderr: "socket reset" }), "transient");
});

test("installBinary downloads verified 0.26.x, rejects bad SHA-512, and falls back offline across hc/agy/pi caches", async () => {
  const home = await mkdtemp(join(tmpRoot, "home-install-"));
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const pkg4 = await makeTarball(tmpRoot, "0.26.4", "bin-0.26.4");
    const pkg5 = await makeTarball(tmpRoot, "0.26.5", "bin-0.26.5");
    const url4 = "https://fixtures.invalid/0.26.4.tgz";
    const url5 = "https://fixtures.invalid/0.26.5.tgz";

    let mode = "online";
    mock.method(globalThis, "fetch", async url => {
      if (mode === "offline") throw new Error("network unreachable");
      if (url === `https://registry.npmjs.org/@letmeknow/${TARGET}`) {
        if (mode === "bad-integrity") {
          return Response.json({
            versions: { "0.26.5": { dist: { tarball: url5, integrity: "sha512-BAD" } } },
          });
        }
        return Response.json({
          versions: {
            "0.25.9": { dist: { tarball: url4, integrity: pkg4.integrity } },
            "0.26.4": { dist: { tarball: url4, integrity: pkg4.integrity } },
            "0.27.0": { dist: { tarball: url5, integrity: pkg5.integrity } },
          },
        });
      }
      if (url === url4) return new Response(pkg4.bytes);
      if (url === url5) return new Response(pkg5.bytes);
      throw new Error(`unexpected url ${url}`);
    });

    // Online downloads verified 0.26.4 into ~/.cache/hc-letmeknow
    const bin4 = await installBinary();
    assert.equal(bin4, join(home, ".cache", "hc-letmeknow", TARGET, "0.26.4", "bin", EXECUTABLE));
    assert.equal(await readFile(bin4, "utf8"), "bin-0.26.4");

    // Bad SHA-512 integrity rejects without falling back
    mode = "bad-integrity";
    await assert.rejects(() => installBinary(), /does not match its integrity/);

    // Offline picks highest across hc-letmeknow (0.26.4), agy-letmeknow (0.26.5), pi-letmeknow (0.26.6)
    const agyDir = join(home, ".cache", "agy-letmeknow", TARGET, "0.26.5", "bin");
    const piDir = join(home, ".cache", "pi-letmeknow", TARGET, "0.26.6", "bin");
    await mkdir(agyDir, { recursive: true });
    await mkdir(piDir, { recursive: true });
    await writeFile(join(agyDir, EXECUTABLE), "bin-0.26.5", { mode: 0o755 });
    const piBin = join(piDir, EXECUTABLE);
    await writeFile(piBin, "bin-0.26.6", { mode: 0o755 });

    mode = "offline";
    const warnings = [];
    const offlineBin = await installBinary(w => warnings.push(w));
    assert.equal(offlineBin, piBin);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /running cached 0\.26\.6/);
  } finally {
    mock.restoreAll();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
  }
});

test("joinListed starts a stopped sibling temporarily, invites, joins, and stops it cleanly", async () => {
  const work = await mkdtemp(join(tmpRoot, "join-sib-"));
  const logFile = join(work, "sib.jsonl");
  const isWin = process.platform === "win32";
  const scriptBin = join(work, isWin ? "fake-letmeknow.mjs" : EXECUTABLE);
  const fakeBin = isWin ? join(work, "fake-letmeknow.cmd") : scriptBin;
  await writeFile(
    scriptBin,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "sessions") {
  process.stdout.write(JSON.stringify({ sessions: [
    { fp: "stoppedsib000001", running: false, groups: ["grp_stopped"] },
    { fp: "newsession000001", running: true, groups: [] },
  ] }) + "\\n");
  process.exit(0);
}
if (args[0] === "--session" && args[2] === "listen") {
  process.stdout.write(JSON.stringify({ type: "ready", fp: args[1], bin: ${JSON.stringify(fakeBin)} }) + "\\n");
  const iv = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => {
    clearInterval(iv);
    appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(["stopped", args[1]]) + "\\n");
    process.exit(0);
  });
}
if (args[0] === "--session" && args[2] === "invite") {
  process.stdout.write(JSON.stringify({ link: "https://letmeknow.dev/i/from-stopped" }) + "\\n");
  process.exit(0);
}
if (args[0] === "--session" && args[2] === "join") {
  process.stdout.write(JSON.stringify({ joined: "grp_stopped" }) + "\\n");
  process.exit(0);
}
`,
    { mode: 0o755 }
  );
  if (isWin) {
    await writeFile(fakeBin, `@echo off\r\n"${process.execPath}" "${scriptBin}" %*\r\n`);
  } else {
    await chmod(scriptBin, 0o755);
  }

  const ac = new AbortController();
  const res = await joinListed(fakeBin, "newsession000001", ["grp_stopped", "grp_missing"], ac.signal, process.env);
  assert.deepEqual(res.joined, ["grp_stopped"]);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /cannot join grp_missing/);

  if (!isWin) {
    const lines = (await readFile(logFile, "utf8")).trim().split("\n").map(l => JSON.parse(l));
    assert.ok(lines.some(l => l[0] === "stopped" && l[1] === "stoppedsib000001"));
  }
});

test("buildExecArgv picks node bin/hc-lmk _exec on win32, hc-lmk-exec on Unix, and remote hc-lmk _exec for --on", () => {
  const winArgv = buildExecArgv({
    isRemote: false,
    platform: "win32",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    hcLmkPath: "C:\\Users\\u\\src\\hc-letmeknow\\bin\\hc-lmk",
    hcLmkExecPath: "C:\\Users\\u\\src\\hc-letmeknow\\bin\\hc-lmk-exec",
    encodedOpts: "v1:abc",
    command: ["pi", "--model", "x"],
  });
  assert.deepEqual(winArgv, [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Users\\u\\src\\hc-letmeknow\\bin\\hc-lmk",
    "_exec",
    "v1:abc",
    "--",
    "pi",
    "--model",
    "x",
  ]);
  assert.equal(winArgv.some(a => a.includes("hc-lmk-exec")), false);

  const unixArgv = buildExecArgv({
    isRemote: false,
    platform: "linux",
    nodePath: "/usr/bin/node",
    hcLmkPath: "/opt/hc-letmeknow/bin/hc-lmk",
    hcLmkExecPath: "/opt/hc-letmeknow/bin/hc-lmk-exec",
    encodedOpts: "v1:abc",
    command: ["agy"],
  });
  assert.deepEqual(unixArgv, ["/opt/hc-letmeknow/bin/hc-lmk-exec", "v1:abc", "--", "agy"]);

  const remoteArgv = buildExecArgv({
    isRemote: true,
    platform: "win32",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    hcLmkPath: "C:\\Users\\u\\src\\hc-letmeknow\\bin\\hc-lmk",
    hcLmkExecPath: "C:\\Users\\u\\src\\hc-letmeknow\\bin\\hc-lmk-exec",
    encodedOpts: "v1:abc",
    command: ["codex", "--no-daemon"],
  });
  assert.deepEqual(remoteArgv, ["hc-lmk", "_exec", "v1:abc", "--", "codex", "--no-daemon"]);
});

test("Windows command resolution, PATHEXT filtering, and cmd.exe batch escaping handle .exe directly and .cmd safely", () => {
  const existing = new Set([
    "C:\\Users\\u\\.pi\\agent\\bin\\pi",
    "C:\\Users\\u\\.pi\\agent\\bin\\pi.ps1",
    "C:\\Users\\u\\.pi\\agent\\bin\\pi.cmd",
    "C:\\Users\\u\\AppData\\Local\\Programs\\herdr-core\\hc.exe",
    "C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe",
    "C:\\Program Files\\nodejs\\npm.cmd",
    "C:\\tools\\dual.exe",
    "C:\\tools\\dual.cmd",
  ]);
  const isFile = p => existing.has(p);
  const env = {
    Path: '"C:\\Users\\u\\.pi\\agent\\bin";C:\\Users\\u\\AppData\\Local\\Programs\\herdr-core;C:\\Users\\u\\AppData\\Local\\agy\\bin;C:\\Program Files\\nodejs;C:\\tools',
    PATHEXT: ".PS1;.COM;.EXE;.BAT;.CMD;.VBS;.JS",
    ComSpec: "C:\\WINDOWS\\system32\\cmd.exe",
  };

  // Native .exe resolves directly with isBatch=false
  const hcRes = resolveWinCommand("hc", env, { platform: "win32", isFile });
  assert.deepEqual(hcRes, {
    file: "C:\\Users\\u\\AppData\\Local\\Programs\\herdr-core\\hc.exe",
    isBatch: false,
  });

  // .exe takes priority over .cmd even when both exist
  const dualRes = resolveWinCommand("dual", env, { platform: "win32", isFile });
  assert.deepEqual(dualRes, { file: "C:\\tools\\dual.exe", isBatch: false });

  // Extensionless POSIX shim and .ps1 are skipped in favor of .cmd
  const piRes = resolveWinCommand("pi", env, { platform: "win32", isFile });
  assert.deepEqual(piRes, {
    file: "C:\\Users\\u\\.pi\\agent\\bin\\pi.cmd",
    isBatch: true,
  });

  // Explicit path without extension still finds .cmd over POSIX extensionless file
  const explicitPi = resolveWinCommand("C:\\Users\\u\\.pi\\agent\\bin\\pi", env, { platform: "win32", isFile });
  assert.deepEqual(explicitPi, {
    file: "C:\\Users\\u\\.pi\\agent\\bin\\pi.cmd",
    isBatch: true,
  });

  // Non-win32 returns command untouched
  assert.deepEqual(resolveWinCommand("pi", env, { platform: "linux", isFile }), {
    file: "pi",
    isBatch: false,
  });

  assert.equal(isWinBatchFile("foo.cmd"), true);
  assert.equal(isWinBatchFile("FOO.BAT"), true);
  assert.equal(isWinBatchFile("foo.exe"), false);

  // prepareSpawnSpec spawns .exe directly and wraps .cmd via ComSpec /d /s /c with windowsVerbatimArguments
  const exeSpec = prepareSpawnSpec("agy", ["--resume", "abc"], { env, windowsHide: false }, "win32", isFile);
  assert.equal(exeSpec.viaCmd, false);
  assert.equal(exeSpec.file, "C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe");
  assert.deepEqual(exeSpec.args, ["--resume", "abc"]);
  assert.equal(exeSpec.options.windowsHide, false);

  const cmdSpec = prepareSpawnSpec(
    "npm",
    ["run", "a&b", 'say "hi"', "%PATH%"],
    { env, windowsHide: true },
    "win32",
    isFile
  );
  assert.equal(cmdSpec.viaCmd, true);
  assert.equal(cmdSpec.file, "C:\\WINDOWS\\system32\\cmd.exe");
  assert.equal(cmdSpec.options.windowsVerbatimArguments, true);
  assert.equal(cmdSpec.options.windowsHide, true);
  assert.deepEqual(cmdSpec.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.ok(cmdSpec.args[3].startsWith('"C:\\Program^ Files\\nodejs\\npm.cmd '));
  assert.ok(cmdSpec.args[3].includes("^^^&"));
  assert.ok(cmdSpec.args[3].includes("^^^%"));

  assert.equal(escapeWinCmdCommand("C:\\Program Files\\a&b.cmd"), "C:\\Program^ Files\\a^&b.cmd");
  const inv = buildWinCmdInvocation("C:\\x\\tool.cmd", [], env);
  assert.deepEqual(inv.args, ["/d", "/s", "/c", '"C:\\x\\tool.cmd"']);
  assert.ok(escapeWinCmdArg("x\\").includes("\\\\"));
});

test("stripEnvVar, isMainModule, and renameWithRetry handle Windows semantics cleanly", async () => {
  const env = { Path: "C:\\bin", letmeknow_session: "lower", LETMEKNOW_SESSION: "upper", KEEP: "1" };
  assert.deepEqual(stripEnvVar(env, "LETMEKNOW_SESSION", "win32"), { Path: "C:\\bin", KEEP: "1" });
  assert.deepEqual(stripEnvVar(env, "LETMEKNOW_SESSION", "linux"), {
    Path: "C:\\bin",
    letmeknow_session: "lower",
    KEEP: "1",
  });

  // isMainModule matches current file across case rules
  const thisFile = new URL(import.meta.url).pathname;
  if (process.platform !== "win32") {
    assert.equal(isMainModule(import.meta.url, thisFile, "linux"), true);
    assert.equal(isMainModule(import.meta.url, thisFile, "win32"), true);
    assert.equal(isMainModule(import.meta.url, "", "win32"), false);
  }

  // renameWithRetry retries EPERM/EBUSY on win32 and succeeds
  let attempts = 0;
  await renameWithRetry("a", "b", {
    platform: "win32",
    retries: 4,
    baseDelayMs: 5,
    renameFn: async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error("busy");
        err.code = attempts === 1 ? "EPERM" : "EBUSY";
        throw err;
      }
    },
  });
  assert.equal(attempts, 3);

  // Non-retryable ENOENT fails immediately even on win32
  let enoentAttempts = 0;
  await assert.rejects(
    () =>
      renameWithRetry("a", "b", {
        platform: "win32",
        retries: 4,
        baseDelayMs: 5,
        renameFn: async () => {
          enoentAttempts += 1;
          const err = new Error("missing");
          err.code = "ENOENT";
          throw err;
        },
      }),
    /missing/
  );
  assert.equal(enoentAttempts, 1);
});
