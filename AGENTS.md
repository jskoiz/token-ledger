# AGENTS.md

## Cursor Cloud specific instructions

Token Ledger (`tledger`) is a local-only Node.js CLI (ESM, `"type": "module"`)
that turns local Codex usage metadata into a terminal dashboard and PNG
reports. There is no server or long-running service — everything runs as
one-shot `node bin/token-ledger.mjs …` commands. Requires Node.js >= 22.13
(uses Node's built-in SQLite and test runner); the VM ships a compatible Node.

The update script runs `npm ci`, so dependencies (including the native `sharp`
image encoder used for PNG reports) are already installed when a session
starts. Standard commands live in `package.json` and `README.md`; use those
rather than duplicating them here (`npm test`, `npm run lint`,
`npm run verify:release`). Lint runs `eslint`.

Non-obvious gotchas for running/testing the CLI:

- The CLI reads real Codex data from `CODEX_HOME` (default `~/.codex`), which
  does NOT exist in the cloud VM. Do not expect live data. Instead feed it a
  privacy-reduced snapshot with `--input <file.json> --no-refresh` so it never
  scans the (absent) source directory.
- Use `tests/fixtures/rolling-24h-projects.json` for a ready-made snapshot, but
  note its events are dated Aug 2026. Anchor calendar views such as `week` with
  a matching `--date`. The rolling `1d` view does not accept `--date`, so generate
  a snapshot whose event timestamps are relative to "now" instead (see
  `writeSmokeFixture` in `tools/verify-release.mjs` for the schema). Time-windowed
  views show "No model-call events found" when the fixture falls outside their
  selected range.
- Always pass `--static` (prints once instead of the interactive TUI) and, for
  determinism, `--tz UTC` when running non-interactively. Use `--plain` /
  `NO_COLOR=1` to drop ANSI color.
- For PNG reports use `report <Nd|Nw> --no-open --image-output <path.png>`.
  `--no-open` is important: without it the CLI tries to open the image in a
  desktop viewer. The default output PNG paths in the repo root are gitignored.
