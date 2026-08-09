# Token Ledger

Token Ledger is a lightweight, local-only terminal dashboard for Codex token
usage. It ranks projects, shows model and cache mix, and adds reset-cycle
context without sending usage data anywhere. Codex Auto Review is shown
separately with its token total, distinct-turn share, and cached-input share.

Token Ledger reads Codex history stored on the computer where it runs. It does
not sign in, fetch account-wide usage, or combine activity from other machines.

![Token Ledger running with synthetic demo data](https://raw.githubusercontent.com/jskoiz/token-ledger/main/docs/token-ledger-demo.svg)

_The screenshot is generated from an intentionally synthetic fixture._

## Requirements

Token Ledger requires Node.js 22.13 or newer and npm. Install a supported LTS
release from [nodejs.org](https://nodejs.org/en/download) if either command is
missing, then confirm the versions in a new terminal:

```bash
node --version
npm --version
```

## Install

Token Ledger has no runtime npm dependencies and runs no installation script.

```bash
npm install --global tledger
tledger --help
```

## Use

```bash
tledger                 # current seven-day window
tledger week            # same default, stated explicitly
tledger day             # today
tledger day yesterday
tledger week 2026-08-05
tledger month           # rolling 30-day window
tledger 90d             # rolling 90-day window
tledger 90d 2026-08-05  # 90 days ending on a chosen day
tledger all             # every dated event in the local snapshot
```

`week`, `month`, and custom ranges such as `90d` are inclusive rolling
calendar-day windows ending today unless an end day is supplied.

The local timezone and top 10 projects are selected automatically. The default
view is interactive in a terminal; use arrow keys or `j`/`k` to move and `q` or
Escape to exit. If the selected period is empty, Token Ledger reports the most
recent local activity date and prints the exact command for opening it.

Useful options:

```text
--tz <zone>          Use another IANA timezone
--top <1-100>        Change the project limit
--refresh            Force a fresh local scan
--no-refresh         Use the existing cache without a freshness check
--input <file>       Read an explicit privacy-reduced snapshot
--codex-home <dir>   Read another Codex data directory
--no-archived        Skip archived sessions during collection
--raw-projects       Keep singleton project labels separate
--static             Print once instead of opening the interactive view
--plain              Print once without ANSI color
--ascii              Use ASCII bars
--width <40-200>     Set the static layout width
--date <day>         Set today, yesterday, or YYYY-MM-DD
--help               Show complete CLI help
```

## Update or uninstall

```bash
npm install --global tledger@latest
npm uninstall --global tledger
```

Uninstalling the npm package leaves the privacy-reduced cache at
`~/.token-ledger/token-ledger-snapshot.json`. Remove that directory separately
only when you also want the next installation to perform a completely fresh
scan.

## Local data and privacy

By default, Token Ledger reads `CODEX_HOME` or `~/.codex` and keeps a
privacy-reduced cache at `~/.token-ledger/token-ledger-snapshot.json`. It checks
source freshness automatically. Fresh scans use a bounded pool of up to four
workers; unchanged runs read the existing cache. Token Ledger makes no network
requests and excludes
message bodies, reasoning text, tool payloads, credentials, and full local
paths from the cache. Project labels can still reveal local context, so keep
snapshots private unless you have reviewed them. Reset-cycle burn
is an estimate, not official quota or billing data.

## Develop

```bash
npm test
npm run demo
npm pack --dry-run
```

## License

[MIT](LICENSE)
