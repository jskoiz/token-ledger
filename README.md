# Token Ledger

Token Ledger is a local-only Codex usage dashboard with two outputs:

- a generated PNG report for trends, model composition, and weekly-meter
  context;
- a terminal dashboard for a fast project and token summary.

This README describes the local checkout. It does not assume a hosted report
or a published npm package.

## Install

Requires Node.js 22.13 or newer. From this checkout:

```bash
npm install
npm install -g .
```

The second command installs `tledger` on your PATH. From the checkout, you can
use `npx tledger` instead.

## Basics

| What you need | Command |
| --- | --- |
| Quick guide | `tledger` |
| Last 24 hours | `tledger 1d` |
| Last 7 calendar days | `tledger week` |
| Rolling 30 days | `tledger 30d` |
| Purchased-credit estimate | `tledger cost 7d --basis codex-credits` |
| Hypothetical API USD estimate | `tledger cost 7d --basis api-usd` |
| 7-day PNG report | `tledger report 7d` |
| Cache-only PNG report | `tledger report 7d --cache-rate` |

The main options are:

- `--static` prints once instead of opening the terminal dashboard.
- `--refresh` rebuilds the local usage cache.
- `--since <ISO timestamp>` refreshes only history at or after the cutoff.
- `--image-output <file>` chooses where to save a PNG.
- `--no-open` writes a PNG without opening it.
- `--help-all` shows the complete command and option reference.

When invoked from the checkout root, default report images are local
repository-root artifacts and are ignored by Git: `token-ledger-report-<period>.png`,
`token-ledger-cache-report-<period>.png`, and
`token-ledger-trend-<period>.png`. Default image paths are resolved from the
current working directory; use `--image-output <file>` when invoking the CLI
elsewhere or when you want to choose an intentional destination, such as a
tracked image under `docs/`.

`week` covers seven local calendar days ending on the selected day. `1d` is a
rolling 24-hour view ending when the command starts. In a TTY, the project
dashboard is interactive. `j`/`k` select a project; `q`, `Q`, `Esc`, or
`Ctrl-C` exits. Enter does not inspect a project, and `d` / `w` / `m` do not
change the range; choose the range in the command.

## Cost estimates

The `cost` command is a static terminal report and always requires an explicit
basis. It accepts `1d`, any positive `Nd` or `Nw` duration, or `week`:

```bash
tledger cost 7d --basis codex-credits --no-refresh --plain
tledger cost week --basis api-usd --no-refresh --plain
```

Both reports recompute the selected local events against a dated rate card and
show rated-token coverage, unrated tokens, and reason labels. They do not reuse
a stored amount when current pricing is unavailable.

| Basis | Unit and estimate | It does not prove |
| --- | --- | --- |
| `codex-credits` | Eligible usage paid with Codex purchased credits | Included-plan meter consumption, five-hour or weekly limits, or API dollars |
| `api-usd` | Hypothetical API-equivalent text-token cost in USD | An API invoice, account usage, contract terms, taxes, regional pricing, or unsupported tool/image/search charges |

The API basis partitions cached reads, cache writes, and uncached input without
double counting. Published GPT-5.6 cache-write pricing is applied when the
local record contains cache-write tokens. GPT-5.6 Sol API `fast` and `priority`
usage is priced at 2× the corresponding Standard API rate; this is separate
from the 2.5× purchased-credit multiplier. `ultrafast`, other unsupported
tiers, and fast use without a published model-specific API price remain
unrated.

For an exact single GPT-5.6 Sol call above 272,000 input tokens, the API basis
applies the published long-context rates to the full request. A compacted
multi-call bucket at or below that aggregate threshold is safely priced at the
standard context rate. Above it, Token Ledger cannot recover which individual
request crossed the threshold, so the bucket is visibly unrated as
`compacted-long-context-ambiguous` rather than guessed. Local history can also
be incomplete or pruned, and unrecognized models or incomplete token
breakdowns reduce coverage instead of becoming zero-cost usage.

Calendar boundaries use the first representable instant on a local date when
midnight is skipped. If a time-zone transition skips an entire local date, that
date contributes an empty interval and the next representable date boundary is
used.

## Cache and input controls

`tledger report [Nd|Nw] --cache-rate` writes a separate, purpose-built cache
report to `token-ledger-cache-report-<period>.png`. Its primary view is the
input-token-weighted cache rate (`cached input / measured input`), shown
across the selected period with input-volume context. A smaller model breakout
shows which models account for that input and their individual cache rates.
The cache report intentionally omits the general report's project, quota-meter,
runway, and output-token sections. Cached input is clamped to input per event,
and the report states how much token volume had a usable component breakdown.
Use `--image-output`, `--image-width`, `--date`, `--tz`, and `--no-open` the
same way as on the standard report.

The default privacy-reduced snapshot is
`~/.token-ledger/token-ledger-snapshot-v3.json.gz`. It is gzip-compressed,
written atomically with mode `0600`, targets 12 MiB, and has a hard 16 MiB
on-disk limit. Its expanded JSON representation also targets 48 MiB and has a
64 MiB safety limit, so the old 93 MiB raw-cache behavior cannot recur on the
default production path. Reads check the compressed size before loading and
bound gzip expansion to the same 64 MiB JSON limit. The collector de-duplicates
through a private temporary SQLite spool, then keeps exact recent calls while
rolling older history into minute, hour, and day buckets. If a dense history
approaches the target, it increases the bucket resolution automatically while
preserving additive token, model, project, cache, tool-call, and thread totals.
When a compacted bucket crosses a requested range or chart boundary, Token
Ledger allocates its additive values proportionally across the overlap and
marks the terminal result as estimated; exact recent calls remain exact. The
temporary spool is removed when collection completes or exits with a handled
error.

If even the coarsest bounded representation exceeds the hard limit, Token
Ledger preserves the previous cache and asks you to reduce the source with
`--no-archived` or the collector's `--since` option. It never replaces the
production cache with an oversized or partial file. On a normal default-path
run, the collector validates a bounded source watermark after scanning and
retries if local sources changed during the scan. Automatic reuse compares that
persisted watermark with the current local source manifest, so a later
cache-file mtime cannot hide an append, replacement, truncation, or newly
created rollout. The cache age shown in reports is an age label only;
`--no-refresh` explicitly bypasses the source check.
`--since <ISO timestamp>` excludes model-call events and quota observations
before the normalized cutoff. `--no-archived` excludes `archived_sessions`;
either choice is recorded in snapshot provenance, and terminal and PNG output
label the result `TRUNCATED HISTORY`. A range before a `--since` cutoff is
reported as not collected, not as a verified zero.

The default-path cache is reused only when its collection scope matches the
current `--since` and archive policy. An incompatible cache is rebuilt during
normal operation; `--no-refresh` reports the mismatch instead of silently
reading it as complete. The persisted source watermark is checked before
reusing a stale snapshot, and collection retries if local sources change during
the scan. A later cache-file mtime cannot hide an append, replacement,
truncation, or newly created rollout.

```bash
# Force a rebuild from CODEX_HOME or ~/.codex
tledger week --refresh

# Keep only history from this timestamp onward
tledger week --refresh --since 2026-08-01T00:00:00Z

# Read the existing default snapshot without a source-freshness check
tledger week --no-refresh

# Read an explicit snapshot without automatic freshness checks
tledger week --input /path/to/token-ledger-snapshot-v3.json.gz
```

`--refresh` rebuilds the default snapshot and cannot be combined with
`--input` in this checkout. `--since` and `--no-archived` apply when a refresh
occurs, and their collection scope must match a reusable cache. The collector
can also be run directly:

```bash
node lib/token-ledger-importer.mjs --output /path/to/token-ledger-snapshot-v3.json.gz
```

Explicit `.json` snapshots remain readable for fixtures and deliberate exports,
but `.json.gz` is the bounded production cache format. After an upgrade, the
new cache does not read or delete schema-v1 or schema-v2 cache files; remove an
old generated cache separately once the v3 cache is proven.

## Report versus CLI

| | Generated report | Terminal dashboard |
| --- | --- | --- |
| Command | `tledger report 7d` or `tledger trend 7d --image` | `tledger week`, `tledger 1d`, or `tledger day <date>` |
| Output | One PNG with a stat quad, weekly-meter pace/runway, daily token columns, an aligned cache-rate strip, top projects, and per-model cache rates | Interactive or static project rows with totals, shares, thread counts, model mix, usage type, cache split, and reset-cycle context |
| Range | A selected local-calendar-day trend window, such as 7d or 2w | A calendar day/week or a rolling 24-hour/`Nd`/`Nw` window |
| Estimate surface | Meter-derived burn and runway are called out; cache coverage comes from measured token breakdowns | The sidebar can show derived `View burn`; project detail includes rate-card credit shares when available |

The report is the broader visual summary. The CLI does not open or generate a
report unless you request the `report`, `trend --image`, or `--image` form.

## Examples

### Seven-day report

![Seven-day Token Ledger report example](docs/token-ledger-report-7-day.png)

### Non-report CLI output

![Anonymized Token Ledger terminal output](docs/token-ledger-cli-week.png)

The terminal capture was made from a local privacy-reduced snapshot after
replacing project and thread labels with neutral names. It contains no prompts,
responses, secrets, home paths, or project names.

## What is observed

The collector reads local rollout JSONL under `sessions/` and, unless disabled,
`archived_sessions/`, plus `session_index.jsonl` and read-only `state_5.sqlite`
metadata. It retains positive `last_token_usage` model-call events and their
timestamps, turn IDs, model/source attribution, and token categories.

Observed totals are the sum of globally de-duplicated retained events. Events
with turn IDs use the turn plus cumulative/last-usage/context signatures;
legacy events without turn IDs use a high-specificity usage signature and are
marked as heuristic. State database token counters are kept as non-additive
reference values because forks and subagents inherit cumulative history.

Input, cached-input, output, and reasoning are stored as separate categories:
cached input is a subset of input, and reasoning is a subset of output. Any
composition that presents them together subtracts those subsets to avoid
double counting. Models are attributed from turn context/settings and local
thread metadata, then normalized for display.

The weekly meter uses local rate-limit observations for the account-wide
weekly window. Reset timestamps identify windows; stale readings and separate
named pools are not stitched into that meter. Remaining percentage,
observation time, and the selected window are local observations; the reset
type (weekly expiry versus restart) is derived by comparing the prior window's
reset timestamp with the first reading of the new window. None of this is an
official account-wide quota or billing record. The percentage comes from the
newest OpenAI reading recorded in a completed local Codex response; Token
Ledger does not invent a newer percentage from token counts.

The exported snapshot contains token metadata, model/use-type labels, project
labels, and display titles. It omits message bodies, reasoning text, tool
arguments/results, credential fields, and full local paths. Path-like source
labels become a neutral `local` category, local path tokens in titles and other
labels are redacted, and unrelated user-written title text may remain. Normal
successful dashboard output is privacy-reduced, but diagnostics or explicit
PNG writes may echo configured snapshot, Codex, or output path labels.

The state database is optional attribution enrichment rather than the additive
usage source. Missing, incompatible, locked, or corrupt state metadata does not
prevent rollout token collection; the snapshot records its normalized status in
`metadata.stateDatabase` without exporting the database path or raw error text.

## What is estimated

`rateCardCredits` estimates eligible Codex usage paid with purchased credits
using the hardcoded OpenAI rate card dated **2026-08-23**. Cached input is
priced separately. Both `priority` and `fast` service tiers are recognized:
supported GPT-5.6 and GPT-5.5 models consume purchased credits at 2.5× the
standard rate, while supported GPT-5.4 consumes them at 2×. Fast mode's
approximately 1.5× figure describes model speed, not credit consumption.
Events without a detailed input/output breakdown, a known model rate, or a
published fast multiplier are unrated.

These purchased-credit estimates are not API-dollar estimates. The separate
`cost --basis api-usd` view uses an independent API rate card and does not
convert credits to dollars. GPT-5.6 Sol's promotional purchased-credit rate
does not determine included plan usage, five-hour or weekly limits, or legacy
credit rates. Raw observed token counts and recorded meter readings remain
unchanged by either calculator.

When meter observations are available, report bars in `--drain` mode represent
observed meter drops; model attribution within a drop uses rate-card weights
when possible and token weights as a fallback. Long observation gaps are
spread across local calendar days as estimates. Tokens-per-meter-point,
model-split burn, runway, and CLI `View burn` are derived estimates. None is
official billing, quota, or account-completeness truth.

Model allocation remains an estimate even when current credit weights are
available. Local history can be pruned or incomplete, so it is not an
authoritative lifetime account record.

## Verify

```bash
npm test
npm run lint
npm run verify:release
npm pack --dry-run --json
```
