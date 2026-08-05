# Token Ledger

Token Ledger is a lightweight, local-only terminal dashboard for Codex token
usage. It ranks projects, shows model and cache mix, and adds reset-cycle
context without sending usage data anywhere.

![Token Ledger running with synthetic demo data](https://raw.githubusercontent.com/jskoiz/token-ledger/main/docs/token-ledger-demo.svg)

_The screenshot is generated from an intentionally synthetic fixture._

## Install

Token Ledger requires Node.js 22.13 or newer and has no runtime npm
dependencies.

```bash
npm install --global token-ledger
```

## Use

```bash
token-ledger                 # current seven-day window
token-ledger week            # same default, stated explicitly
token-ledger day             # today
token-ledger day yesterday
token-ledger week 2026-08-05
```

The local timezone and top 10 projects are selected automatically. The default
view is interactive in a terminal; use arrow keys or `j`/`k` to move and `q` or
Escape to exit.

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

By default, Token Ledger reads `CODEX_HOME` or `~/.codex` and keeps a
privacy-reduced cache at `~/.token-ledger/token-ledger-snapshot.json`. It checks
source freshness automatically, makes no network requests, and excludes
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
