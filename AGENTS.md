# Token Ledger

Token Ledger (`tledger`) is a local-only ESM Node.js CLI (Node >=22.13) that
turns local Codex usage metadata into a terminal dashboard and PNG reports.
There is no server or long-running service.

## Canonical commands

Use `package.json` and `README.md` as the command reference. The main local
gates are:

```sh
npm ci
npm test
npm run lint
npm run verify:release
```

`sharp` is the native image encoder used by PNG reports.

## Non-obvious CLI verification

- The default source is `CODEX_HOME` (`~/.codex`). In environments without
  that directory, use a privacy-reduced snapshot with `--input <file.json>
  --no-refresh`; do not expect live data.
- `tests/fixtures/rolling-24h-projects.json` is dated August 2026. Use a
  matching `--date` for calendar views such as `week`; rolling `1d` needs a
  fixture whose timestamps are relative to now.
- For scripted runs use `--static --tz UTC` and add `--plain` or `NO_COLOR=1`
  when stable, uncolored output is needed.
- For PNG reports use `report <Nd|Nw> --no-open --image-output <path.png>`;
  otherwise the CLI may open the generated image.
