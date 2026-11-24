# hc-letmeknow

Harness-agnostic [letmeknow](https://github.com/spoj/letmeknow) wrapper for `hc` (`herdr-core`), exposing `hc-lmk` outside and `lmk` inside.

Works with any CLI agent or shell (`agy`, `pi`, `codex`, `claude`, `bash`, etc.) without per-harness plugins.

## Install

Requires Node.js >= 20 and `hc` (`herdr-core`) on your `PATH` (or configured via `--hc`).

1. Clone the repository and symlink `bin/hc-lmk` and `bin/lmk` onto your `PATH`:

```sh
git clone https://github.com/spoj/hc-letmeknow.git
cd hc-letmeknow
mkdir -p ~/.local/bin
ln -s "$PWD/bin/hc-lmk" ~/.local/bin/hc-lmk
ln -s "$PWD/bin/lmk" ~/.local/bin/lmk
```

Alternatively, run `npm link` from the repository directory.

2. Optionally configure default groups or attach fingerprint in `~/.config/hc-letmeknow/config.json`:

```json
{
  "join": ["<group-id>"]
}
```

## Usage

### Outer launcher: `hc-lmk`

```sh
hc-lmk [options] [--] <command> [args...]
```

Option parsing stops at the first non-option positional (`<command>`) or `--`, so harness flags pass straight through:

```sh
hc-lmk codex --no-daemon -m gpt-5
hc-lmk --bg --json --name worker --join <group> -- agy --dangerously-skip-permissions
```

**`letmeknow` options:**
- `--join <g1,g2>`: repeatable/comma-separated group IDs (`""` or `--no-join` disables joining)
- `--attach <fp>`: attach to an existing detached session (`""` or `--no-attach` disables attach)
- `--session <fp>`: resume a saved session fingerprint
- `--key <name>`: persist and resume session fingerprint in `~/.local/state/hc-letmeknow/sessions.json`
- `--ready-file <path>`: atomic JSON `{ fp, groups, warnings }` or `{ error }` written after group join
- `--deliver <always|idle>`: delivery mode (default: `always`; `idle` defers while `working`/`blocked` and delivers on `idle` via `--if idle` or confirmed `done`)
- `--inline-bytes <n>`: max UTF-8 bytes for single-event inline delivery (default: `1536`)
- `--boot-fallback-ms <n>`: boot gate fallback for non-OSC-7501 programs (default: `5000`)
- `--config <path>`: config file path (default: `~/.config/hc-letmeknow/config.json`)
- `--hc <bin>`: `hc` binary name or path (default: `hc`)
- `--letmeknow-bin <path>`: explicit `letmeknow` binary path (skips npm cache/download)
- `--intro <text>`: set session intro after joining groups
- `--prefix <text>`: delivery prefix (default: `[letmeknow]`)

**`hc` passthrough options:**
- `--bg`, `--new`, `--json`, `--name <name>`, `--cwd <dir>`, `--on <machine>`, `--label <k=v>` (repeatable), `--no-parent`, `--outlive-parent`, `--no-notify`, `--keep`, `--rm`

**Launch modes:**
- Outside `hc` (no `$HC_TERMINAL_ID`) or when any new-terminal flag is set: launches `hc run --bg --json ... -- <hc-lmk-exec> <encoded-opts> -- <cmd> [args...]` (or `hc-lmk _exec` via remote `PATH` when `--on` is set). Prints JSON (with `--json`) or address when `--bg`/non-TTY, or runs `hc attach <address>` when interactive TTY without `--bg`.
- Already inside `hc` (`$HC_TERMINAL_ID` set) with no new-terminal flags: wraps in-place in the current terminal, exporting session env vars to `<cmd>`, stopping the sidecar cleanly on exit, and mirroring `<cmd>`'s exit code.

### Inside agent CLI: `lmk`

Inside an `hc-lmk` terminal, run `lmk <args...>` to execute commands against the terminal's active `letmeknow` session (e.g., `lmk skill`, `lmk groups`, `lmk send --to <fp> -`):

- Resolves `{ bin, fp }` from `LETMEKNOW_BIN` + `LETMEKNOW_SESSION`, falling back to `~/.local/state/hc-letmeknow/term-$HC_TERMINAL_ID.json` if env vars were stripped.
- Spawns `bin` with `["--session", fp, ...args]`, stripping `LETMEKNOW_SESSION` from the child environment and mirroring exit code/signal.

## Architecture

1. **`bin/hc-lmk-exec`** (POSIX `sh`): runs `node src/prepare.mjs` to spawn detached `src/sidecar.mjs`, waits only for `letmeknow` `ready` (so the harness boots concurrently with slow sibling group joins), sources & deletes a `0600` temp env file exporting `LETMEKNOW_SESSION`, `LETMEKNOW_BIN`, `LETMEKNOW_LOG`, `AGY_LETMEKNOW_DISABLE=1`, `PI_LETMEKNOW_DISABLE=1`, `CLAUDE_LETMEKNOW_DISABLE=1`, and `AGY_CLI_OSC7501=on`, then calls POSIX `exec "$@"` so the harness owns the PTY directly.
2. **`src/sidecar.mjs`**:
   - Downloads & SHA-512 verifies the latest `0.26.x` `@letmeknow/<platform>-<arch>` into `~/.cache/hc-letmeknow/`, falling back offline to `~/.cache/{hc,agy,pi}-letmeknow`.
   - Starts session with priority `--session` / `--key` -> `attach` -> fresh `listen`.
   - Writes `~/.local/state/hc-letmeknow/term-<HC_TERMINAL_ID>.json` (`0600`), sets `hc label <id> lmk=<fp>` (best-effort), joins groups via local siblings (180s timeout), optionally runs `intro`, and writes `--ready-file` atomically.
   - Follows `hc events --json --terminal <id>` (with reconnect & `hc get` check) and watches the target PID.
   - Holds inbound events during boot until first OSC 7501 `idle`/`done`/`working` status or `bootFallbackMs`.
   - Coalesces events for 2s (12 KiB line cap, 50 KB / 2000 line batch cap), delivering guaranteed single-line pastes via `hc send --json [--if idle]`. Single events `<= inlineBytes` are inlined (with `session`/`log` hint on first delivery); larger or multi-event batches spill atomically (`0600`) to `~/.local/state/hc-letmeknow/inbox/<fp>/<seq>.jsonl` with a 1-line pointer.
   - Retries on `blocked` (exit 9), `status_mismatch` (exit 10), `cancelled`, or transient errors on the next status change (+ safety timer). Shuts down cleanly on `not_found` (exit 3), `finished` (exit 11), `finished`/`removed` event, or watched PID exit.

## Tests

```sh
node --test test/*.test.mjs
```

## License

MIT — see [LICENSE](LICENSE).
