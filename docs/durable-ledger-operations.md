# Durable ledger operations

Token Ledger keeps two local artifacts with different responsibilities:

- `token-ledger-ledger.sqlite` is the durable, deduplicated source of truth.
- `token-ledger-snapshot-v3.json.gz` is a bounded report cache that can be
  regenerated from the ledger and currently available Codex sources.

Deleting or replacing the report cache must not be treated as deleting ledger
history. Conversely, a successfully parsed report cache is not proof that its
revision matches the current ledger.

## Health signals

Generated snapshots expose the durable schema version, revision, hashed Codex
home identity, retention horizons, and `legacySnapshotStatus` under
`metadata.durableLedger`. Coverage also includes source-state counts,
`sourceIncomplete`, compacted and migrated bucket counts, and the same legacy
status.

The main legacy statuses are:

- `migrated`: the legacy v3 snapshot had a provable collection scope and a
  matching hashed Codex-home identity, so its history was imported as
  estimated compacted rows.
- `collection-scope-unverified`: the snapshot did not prove whether it included
  archived sources or a time cutoff.
- `codex-home-unverified`: the snapshot did not carry a verifiable hashed Codex
  home identity.
- `codex-home-mismatch`: the snapshot belonged to a different Codex home.

The last three statuses mean legacy history was deliberately excluded. Exact
rollout collection still proceeds, and PNG reports show `LEGACY HISTORY
SKIPPED` so the omission is not silent.

A missing legacy snapshot is a completed absence check. By contrast, an
existing malformed, unreadable, oversized, non-regular, or non-v3 snapshot
stops with `ERR_DURABLE_LEDGER_LEGACY_SNAPSHOT`. That failure does not advance
the ledger revision, mark the one-shot migration as checked, or publish a new
cache. Preserve the unreadable artifact in a private backup, then repair or
replace it with the matching legacy v3 snapshot and retry. If migration is
intentionally declined, move the preserved artifact out of the configured
snapshot path; the next successful refresh records that absence as checked.

`sourceIncomplete` means a previously observed source is missing, tombstoned,
truncated, or replaced. It is a provenance warning, not proof that SQLite is
corrupt. A true append keeps stable provenance; a larger same-inode rewrite is
classified as a replacement rather than an append.

A source scan with malformed JSON or an invalid token record is evidence-only:
its coverage counters and source watermark are retained, but none of its token,
quota, tool, position, ownership, origin, or thread operations can change the
last complete durable interpretation. If that scan also detected a replacement,
the source state records a pending reconciliation. The bit survives lifecycle
moves, missing or tombstoned state, and truncation, then clears atomically only
after a clean complete scan reconciles every source-owned membership and
position.

## Schema and privacy upgrades

Schema-v1 preview ledgers with reconstructable migration scope upgrade to v2
inside one SQLite transaction. The upgrade removes stored working directories,
Git remotes, and raw source values, then compacts the database so those bytes do
not remain in free pages. New v2 writes store no raw versions of those values.

An early schema-v1 ledger that contains migrated history without a
reconstructable scope stops with `ERR_DURABLE_LEDGER_MIGRATION_SCOPE`. That
database is left unchanged because guessing its scope could either double-count
or erase usage.

## Non-destructive recovery

1. Stop concurrent Token Ledger refreshes and copy the ledger plus any SQLite
   `-wal` and `-shm` sidecars to a private backup location.
2. For `ERR_DURABLE_LEDGER_CODEX_HOME`, select the Codex home that originally
   created the ledger. Do not rebind the ledger to a different home.
3. For `ERR_DURABLE_LEDGER_MIGRATION_SCOPE`, keep the preview ledger as a
   backup. Create a new v2 ledger location and rebuild exact history from the
   matching Codex sources. Import a legacy snapshot only when its collection
   scope and Codex-home fingerprint are both known.
4. For a stale or oversized report cache, preserve the ledger and retry with a
   compressed output, `--since`, or `--no-archived`. Removing only the cache is
   safe when a rebuild is desired.
5. Treat missing or rewritten rollout history as incomplete provenance. Do not
   delete the ledger to make that warning disappear.

Snapshot encoding is staged in a private temporary file. Source watermarks are
validated twice before the SQLite commit and once immediately after it. Before
the candidate transaction starts, Token Ledger checkpoints the WAL, stages a
private baseline copy, syncs it, and then publishes and syncs a recovery marker.
The marker records the ledger identity, schema, baseline revision, backup size,
and recovery attempt. Coordinated readers that encounter an active marker
recover the baseline under the same exclusive writer guard instead of exposing
the committed-but-unvalidated candidate.

After post-commit validation succeeds, Token Ledger removes and syncs the
marker before publishing the staged report cache. A crash before that point is
conservatively recovered to the baseline on the next read or refresh. A crash
after marker removal can leave the cache behind a valid ledger, but revision
validation marks it stale and rebuilds it rather than labeling it
verified-current. Recovery first validates the private backup, then removes
candidate WAL and shared-memory sidecars, syncs a copied restore file, and
atomically replaces the main ledger. The marker and original backup remain in
place until that replacement is validated, so recovery can be repeated after a
second crash. Missing, corrupt, or mismatched recovery artifacts fail closed
with `ERR_DURABLE_LEDGER_RECOVERY`; preserve them for diagnosis instead of
deleting the marker or opening the candidate as authoritative.

## Repeatable refresh benchmark

The benchmark can generate actual old token-count events, prove that the
durable ledger compacted them, verify the durable token total and revision, and
measure cold plus warm refreshes:

```bash
for events in 100 1000 5000 10000; do
  npm run benchmark:refresh -- \
    --files 24 \
    --token-events "$events" \
    --warm-runs 3 \
    --event-age-days 4000
done
```

Record the operating system, CPU, memory, Node and npm versions with the result.
Use `warmMedianWallTimeMs` for the steady-state refresh comparison and retain
`coldWallTimeMs` separately. A valid compaction run has nonzero
`durableCompactedBuckets`, a `durableRevision` equal to `warmRuns`, the expected
`durableTotalTokens`, and zero parse errors. Running several benchmarks in
parallel invalidates timing comparisons.
