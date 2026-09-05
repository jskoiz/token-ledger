# Token Ledger 0.4.0

## Highlights

- One-day PNG reports now show hourly token usage and cache efficiency, with
  a partial current hour and support for daylight-saving transitions.
- Add `--private` to a report to replace project names with ranked anonymous
  labels. Usage figures stay visible, the source snapshot stays unchanged,
  and the default output filename ends in `-private.png`.
- Recognize Astra in usage reports. Models without bundled prices remain
  explicitly unrated in purchased-credit and API-equivalent estimates.

## Correctness and reliability

- Allocate compacted usage across local calendar and hourly boundaries, retain
  persisted call counts, and compare equivalent partial reporting periods.
- Keep report cutoffs fixed during collection and disclose allocated estimates.
- Preserve competing snapshot replacements during publication checks.
- Redact local project paths during legacy migration and report materialization,
  and redact local paths in CLI and collector diagnostics.
- Reject malformed quota readings, handle fragmented terminal key sequences,
  and tolerate XML-invalid label characters during PNG encoding.
- Improve cross-month labels, narrow chart spacing, peak-hour labels, and
  fallback to token bars when observed drain is unavailable.
- Preserve persisted thread-title updates and isolate benchmark state from the
  live ledger.

## Release checks and requirements

Requires Node.js 22.13 or newer. CI and prepublish checks include regular and
stress tests, lint, and offline installation of the packed artifact with CLI
and PNG smoke tests. Token Ledger remains a local-only CLI.
