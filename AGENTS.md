# Token Ledger

Token Ledger (`tledger`) is a local-only ESM Node.js CLI (Node >=22.13) that
turns local Codex usage metadata into a terminal dashboard and PNG reports.
There is no server or long-running service.

## Canonical commands

Use `package.json` and `README.md` as the command reference. Match checks to
the changed surface:

- Run `npm ci` when dependencies changed or the install state is unavailable.
- For CLI, report, dependency, or release behavior changes, run
  `npm run test:all`, `npm run lint`, and `npm run verify:release`.
- For a documentation or typo edit, use `git diff --check` and a focused
  documentation check when one exists. Do not repeat a passing full gate when
  no relevant code or dependency changed.

`sharp` is the native image encoder used by PNG reports.

## Non-obvious CLI verification

- The default source is `CODEX_HOME` (`~/.codex`). In environments without
  that directory, use a privacy-reduced snapshot with `--input <file.json>
  --no-refresh`; do not expect live data.
- CLI tests generate their own synthetic snapshots; there is no checked-in
  rolling-window JSON fixture. For manual calendar views such as `week`, use a
  `--date` matching the fixture; rolling `1d` needs timestamps relative to now.
- `node tools/render-report-fixture.mjs <output.png>` renders the documentation
  report from synthetic data without reading local Codex history.
- For scripted runs use `--static --tz UTC` and add `--plain` or `NO_COLOR=1`
  when stable, uncolored output is needed.
- For PNG reports use `report <Nd|Nw> --no-open --image-output <path.png>`;
  otherwise the CLI may open the generated image.
