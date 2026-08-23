# Token Ledger

Token Ledger is a small, local-only terminal dashboard for Codex usage. It
shows ranked project bars, model mix, usage type, cache coverage, and reset
cycle context without sending your data anywhere.

## Install

Requires Node.js 22.13 or newer.

Once published, install the CLI with:

```bash
npm install -g tledger
```

For a one-time run without a permanent global install:

```bash
npx tledger week
```

Until the package is published, install it from this repository:

```bash
git clone <repository-url>
cd token-ledger
npm install -g .
```

The package uses a small runtime image encoder for PNG report output, Node's
built-in SQLite support, and reads Codex data directly from the local machine.

## Run

The shortest useful command is:

```bash
tledger week
```

It defaults to today's seven-day window, the computer's local timezone, the
top 10 projects, and the local Codex data directory. The default terminal view
is interactive; press `q` or `esc` to exit.

Other common views:

```bash
tledger 1d
tledger 1d --static
tledger 2d
tledger 1w
tledger 3w --static
tledger day 2026-08-05
tledger week --top 5
tledger week --static
tledger trend 7d --static
tledger trend 7d --image --image-output artifacts/token-ledger-trend-7d.png
tledger report 7d
tledger report 7d --cache-rate
```

Bare duration aliases such as `tledger 1d`, `tledger 2d`, `tledger 3d`,
`tledger 1w`, `tledger 2w`, and `tledger 3w` show the `TOKENS BY PROJECT`
breakdown for a rolling window ending when the command starts. Day and week
aliases accept any positive `Nd` or `Nw` value up to 3,650 days. `tledger 1d`
is the existing rolling 24-hour view; `tledger 1w` is a rolling seven-day
window. This is different from `tledger day today`, which covers the current
calendar day from local midnight, and `tledger week`, which covers seven local
calendar days.

`tledger report [Nd|Nw]` is the one-step report output: it writes the
dashboard PNG (identical to `trend --image`) to
`token-ledger-report-<period>.png` in the current directory. It accepts the
same flags as the trend view (`--drain`, `--date`, `--tz`, `--image-output`,
`--image-width`) and prints progress while rendering and encoding the image.

`tledger report [Nd|Nw] --cache-rate` writes a separate, purpose-built cache
report to `token-ledger-cache-report-<period>.png`. Its primary view is the
input-token-weighted cache rate (`cached input / all measured input`), shown
across the selected period with input-volume context. A smaller model breakout
shows which models account for that input and their individual cache rates.
The cache report intentionally omits the general report's project, quota-meter,
runway, and output-token sections. Cached input is clamped to input per event,
and the report states how much token volume had a usable component breakdown.
Use `--image-output`, `--image-width`, `--date`, `--tz`, and `--no-open` the
same way as on the standard report.

The terminal trend view is a compact approximation of the image view. For the
full chart grammar, use `--image`: it writes a single shareable report card as
a PNG — model stat cards with week-over-week delta chips and share micro-bars,
calendar-day columns of local token volume stacked by model, the observed
weekly meter remaining overlaid as a smoothed amber line with dashed reset
breaks and a few callout pills, a top-projects row with pace and runway
figures, and a plain-language footnote strip (meter points burned, estimated
cost, scheduled vs early resets, and data freshness).

When run from a terminal, the finished PNG opens in the default image viewer
automatically so the report lands on screen instead of in a file browser.
Pass `--no-open` to skip that; piped or scripted runs never open a window.

Turns run in fast mode (service tier "priority") are drawn as a darker shade
within their model's segment, with a legend entry explaining the shade;
fast-mode turns are weighted 1.5× in the credit estimate because they debit
the plan limit at a higher rate.

Pass `--drain` to flip the columns into limit-drain units instead: each column
becomes the weekly limit percentage the meter dropped, stacked by model using
rate-card credit weights (an estimate — the official card is the best
available proxy for per-model debit, but subscription limits are not billed
per token), on the same percent scale as the meter line.

Meter windows are keyed by their server-reported reset timestamp, so a fresh
window that starts days early (a provider-initiated limit restart) is drawn as
its own cycle and labeled `restart`, while a true weekly expiry is labeled
`reset`.
Stale readings from sessions still reporting a superseded window are dropped
instead of being fused into the line as phantom drain. Drops observed after a
sparse meter gap (over 36 hours) are spread across the covered days and marked
with `≈`. When a range has no usable meter drain, columns fall back to raw
local token counts and the chart says so.

`--image` defaults to `token-ledger-trend-7d.png` in the current directory.
Use `--image-output <file.png>` to choose the path and `--image-width <px>` to
choose a width from 900 to 2400 pixels.

Use `trend 14d` for daily columns across two weeks. At 30 days, the terminal
uses readable multi-day bins: three-day bins at ordinary widths and two-day
bins on wider terminals. The image view uses the same readable multi-day
binning at 30 days. The image also reports the separate local rate-card credit
estimate when token breakdowns are available; that estimate is an absolute
credit count and never rescales the observed-drain columns.

The CLI automatically checks the local Codex source files before rendering. If
they are newer than the local cache, it rebuilds the privacy-reduced snapshot.
The first refresh may scan historical rollout files; later runs use the cache
for one hour before checking source freshness again. Use `--refresh` when you
need to force an immediate rebuild.

The `1d` project dashboard shows a compact snapshot-age line such as
`SNAPSHOT · fresh · 12m old`. `fresh` means the snapshot is within the
one-hour cache window, `stale` means it is older, and `age unknown` means the
snapshot has no usable capture-time metadata. The indicator does not print a
local path or trigger another source scan.

Useful overrides:

```bash
# Use another timezone instead of the computer's local timezone
tledger week --tz America/New_York

# Force a complete local refresh
tledger week --refresh

# Skip the freshness check and use the existing cache
tledger week --no-refresh

# Read a specific privacy-reduced snapshot
tledger week --input /path/to/token-ledger-snapshot.json
```

`--static` prints once for pipes, logs, or terminals without interactive input.
`--plain` or `NO_COLOR=1` disables ANSI color. `--youplot` is an optional
legacy renderer and is not required for the default dashboard.

## Local data and privacy

The CLI reads from `CODEX_HOME` when set, otherwise `~/.codex`. It uses local
Codex rollout JSONL files, the session index, and local state metadata. It
writes its privacy-reduced cache to:

```text
~/.token-ledger/token-ledger-snapshot.json
```

The collector does not export message bodies, reasoning text, tool arguments or
results, credentials, file contents, or full local paths. Display titles may
contain user-written text. CLI errors and empty-state source labels show only a
safe filename label, not an absolute input or source path. When a PNG or report
is written, the explicit output path is reported so you can find the file. The
CLI makes no network requests.

## Keyboard controls

In the interactive dashboard:

- `↑` / `↓` or `j` / `k` moves between projects.
- `q`, `Q`, `Esc`, or `Ctrl-C` exits.
- Enter does not inspect a project, and `d` / `w` / `m` do not change the
  range; choose the desired range in the command instead.

## Verify from source

```bash
npm test
npm run lint
npm run verify:release
npm pack --dry-run --json
```

`npm run verify:release` packs the allowlisted artifact, installs that tarball
in a clean temporary directory with no network or Codex data access, and runs
the installed `tledger --help` and synthetic `tledger 1d --static` smoke checks.
