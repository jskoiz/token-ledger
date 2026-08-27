import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  collectUsage,
} from "../lib/token-ledger-importer.mjs";
import {
  DURABLE_LEDGER_FILENAME,
  readDurableLedger,
  readDurableLedgerRevision,
  resolveDurableLedgerPath,
} from "../lib/token-ledger-ledger.mjs";
import {
  readPrivateSnapshot,
  writePrivateSnapshot,
} from "../lib/token-ledger-snapshot.mjs";

const THREAD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROLLOUT_NAME = `rollout-${THREAD_ID}.jsonl`;
const BASE_TIMESTAMP = "2026-08-20T10:00:00.000Z";
const WEEKLY_RESET = Date.parse("2026-08-30T10:00:00.000Z") / 1_000;

function serialize(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function turnStart(timestamp, turnId, model = "gpt-5.4") {
  return [
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turnId,
        started_at: Date.parse(timestamp) / 1_000,
      },
    },
    {
      timestamp,
      type: "turn_context",
      payload: {
        turn_id: turnId,
        model,
        effort: "medium",
      },
    },
  ];
}

function tokenCount(timestamp, total, usedPercent = null) {
  const row = {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: total - 10,
          cached_input_tokens: 10,
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: total,
        },
        last_token_usage: {
          input_tokens: total - 10,
          cached_input_tokens: 10,
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: total,
        },
        model_context_window: 128_000,
      },
    },
  };
  if (usedPercent !== null) {
    row.payload.rate_limits = {
      primary: {
        window_minutes: 10_080,
        used_percent: usedPercent,
        resets_at: WEEKLY_RESET,
        limit_id: "weekly",
        plan_type: "plus",
      },
    };
  }
  return row;
}

function rolloutRows(
  totals,
  { offset = 0, baseTimestamp = BASE_TIMESTAMP, usedPercent = null } = {},
) {
  const baseMs = Date.parse(baseTimestamp);
  return totals.flatMap((total, index) => {
    const turnIndex = offset + index;
    const timestamp = new Date(baseMs + turnIndex * 60_000).toISOString();
    return [
      ...turnStart(timestamp, `turn-${turnIndex + 1}`),
      tokenCount(
        new Date(Date.parse(timestamp) + 1_000).toISOString(),
        total,
        usedPercent,
      ),
    ];
  });
}

async function createFixture(
  totals,
  { usedPercent = null, baseTimestamp = BASE_TIMESTAMP } = {},
) {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-durable-"));
  const sessions = resolve(root, "sessions", "2026", "08", "20");
  const stateDirectory = resolve(root, "private-state");
  const output = resolve(root, "exports", "snapshot.json.gz");
  const file = resolve(sessions, ROLLOUT_NAME);
  await mkdir(sessions, { recursive: true });
  await writeFile(
    file,
    serialize(rolloutRows(totals, { usedPercent, baseTimestamp })),
  );
  return { root, file, stateDirectory, output };
}

function options(fixture, extra = {}) {
  return {
    output: fixture.output,
    codexHome: fixture.root,
    stateDirectory: fixture.stateDirectory,
    includeArchived: true,
    since: null,
    ...extra,
  };
}

function totalTokens(snapshot) {
  return snapshot.events.reduce((sum, event) => sum + event.totalTokens, 0);
}

test("usage and quota survive rollout source disappearance", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  try {
    const first = await collectUsage(options(fixture));
    assert.equal(first.coverage.observedTokens, 100);
    assert.equal(first.quotaObservations.length, 1);

    await rm(fixture.file);
    const second = await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(second.coverage.observedTokens, 100);
    assert.equal(second.quotaObservations.length, 1);
    assert.equal(second.coverage.sourceIncomplete, true);
    assert.equal(second.coverage.sourceStates.tombstoned, 1);
    assert.equal(ledger.usageRows.length, 1);
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(ledger.sourceSummary.states[0].status, "tombstoned");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unchanged and appended sources add each logical event once", async () => {
  const fixture = await createFixture([100]);
  try {
    const first = await collectUsage(options(fixture));
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );
    const appended = await collectUsage(options(fixture));
    const unchanged = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(first.coverage.observedTokens, 100);
    assert.equal(appended.coverage.observedTokens, 300);
    assert.equal(unchanged.coverage.observedTokens, 300);
    assert.equal(ledger.usageRows.filter((row) => row.identityKind === "exact").length, 2);
    assert.equal(
      ledger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      300,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacement and truncation reconcile without double counting", async () => {
  const fixture = await createFixture([100, 200]);
  try {
    await collectUsage(options(fixture));
    await writeFile(
      fixture.file,
      serialize(rolloutRows([100, 300])),
    );
    const replaced = await collectUsage(options(fixture));
    let ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    assert.equal(replaced.coverage.observedTokens, 400);
    assert.equal(ledger.usageRows.filter((row) => row.identityKind === "exact").length, 2);
    assert.equal(replaced.coverage.sourceStates.changed, 1);
    assert.equal(ledger.sourceSummary.states[0].changeState, "replaced");

    await writeFile(fixture.file, serialize(rolloutRows([100])));
    const truncated = await collectUsage(options(fixture));
    ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    assert.equal(truncated.coverage.observedTokens, 400);
    assert.equal(ledger.usageRows.filter((row) => row.identityKind === "exact").length, 2);
    assert.equal(truncated.coverage.sourceIncomplete, true);
    assert.equal(truncated.coverage.sourceStates.changed, 1);
    assert.equal(ledger.sourceSummary.states[0].changeState, "truncated");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-to-archived movement preserves one source and event set", async () => {
  const fixture = await createFixture([100]);
  try {
    await collectUsage(options(fixture));
    const archived = resolve(
      fixture.root,
      "archived_sessions",
      "2026",
      "08",
      ROLLOUT_NAME,
    );
    await mkdir(resolve(archived, ".."), { recursive: true });
    await rename(fixture.file, archived);

    const moved = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    const withoutArchived = await collectUsage(
      options(fixture, { includeArchived: false }),
    );

    assert.equal(moved.coverage.observedTokens, 100);
    assert.equal(ledger.usageRows.length, 1);
    assert.equal(ledger.sourceSummary.states.length, 1);
    assert.equal(ledger.sourceSummary.states[0].location, "archived");
    assert.equal(ledger.sourceSummary.states[0].status, "archived");
    assert.equal(ledger.sourceSummary.counts.changed, 0);
    assert.equal(withoutArchived.coverage.observedTokens, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a failed persistence transaction leaves the last complete ledger usable", async () => {
  const fixture = await createFixture([100]);
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const priorRevision = await readDurableLedgerRevision(ledgerPath);
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    await assert.rejects(
      () => collectUsage(options(fixture, {
        faultInjector: ({ point }) => {
          if (point === "before-commit") throw new Error("injected persistence failure");
        },
      })),
      /injected persistence failure/,
    );
    const afterFailure = await readDurableLedger(ledgerPath);
    assert.equal(await readDurableLedgerRevision(ledgerPath), priorRevision);
    assert.equal(
      afterFailure.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      100,
    );

    const recovered = await collectUsage(options(fixture));
    assert.equal(recovered.coverage.observedTokens, 300);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("old v3 snapshot migration is idempotent and marks compacted estimates", async () => {
  const fixture = await createFixture([]);
  const generatedAt = "2026-08-20T12:00:00.000Z";
  const rangeStart = "2024-01-02T12:00:00.000Z";
  const rangeEnd = "2024-01-03T12:00:00.000Z";
  const legacy = {
    schemaVersion: 3,
    generatedAt,
    quotaObservations: [{
      id: "legacy-quota",
      timestamp: generatedAt,
      lastSeenAt: generatedAt,
      usedPercent: 22,
      windowMinutes: 10_080,
      resetsAt: WEEKLY_RESET,
      planType: "plus",
      limitKey: "weekly",
      scope: "account",
    }],
    threads: [{
      id: "legacy-thread",
      title: "Migrated thread",
      project: "legacy-project",
      model: "gpt-5.4",
      effort: "medium",
      source: "local",
      useType: "interactive",
      reportedCumulativeTokens: 100,
      firstActiveAt: rangeStart,
      lastActiveAt: rangeEnd,
    }],
    events: [{
      timestamp: rangeStart,
      startAt: rangeStart,
      endAt: rangeEnd,
      project: "legacy-project",
      model: "gpt-5.4",
      rateCardModel: "gpt-5.4",
      effort: "medium",
      source: "local",
      useType: "interactive",
      inputTokens: 90,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 100,
      toolCalls: 0,
      callCount: 1,
      detailedCallCount: 1,
      inputCallCount: 1,
      breakdownAvailable: true,
      threadIds: ["legacy-thread"],
    }],
  };
  try {
    await writePrivateSnapshot(fixture.output, legacy);
    const first = await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const firstLedger = await readDurableLedger(ledgerPath);
    const second = await collectUsage(options(fixture));
    const secondLedger = await readDurableLedger(ledgerPath);

    assert.equal(totalTokens(first), 100);
    assert.equal(first.coverage.migratedCompactedCalls, 1);
    assert.equal(first.coverage.migratedCompactedTokens, 100);
    assert.equal(first.coverage.completeSinceWindowStart, false);
    assert.equal(firstLedger.migration.usageRows, 1);
    assert.equal(firstLedger.migration.quotaRows, 1);
    assert.equal(firstLedger.migratedUsageRows, 1);
    assert.equal(firstLedger.usageRows[0].rangeAllocationEstimated, true);
    assert.equal(firstLedger.usageRows[0].startAt, rangeStart);
    assert.equal(firstLedger.usageRows[0].endAt, rangeEnd);
    assert.equal(second.coverage.migratedCompactedCalls, 1);
    assert.equal(secondLedger.migration.usageRows, 1);
    assert.equal(secondLedger.usageRows.length, 1);
    assert.equal(secondLedger.quotaRows.length, 1);
    assert.equal(secondLedger.threadRows[0].id, "legacy-thread");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("old compacted observations retain source membership without rescan double counts", async () => {
  const fixture = await createFixture([100], {
    baseTimestamp: "2015-08-20T10:00:00.000Z",
  });
  try {
    const first = await collectUsage(options(fixture));
    const second = await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const ledger = await readDurableLedger(ledgerPath);
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));

    assert.equal(first.coverage.observedTokens, 100);
    assert.equal(second.coverage.observedTokens, 100);
    assert.equal(ledger.compactedUsageRows, 1);
    assert.equal(ledger.usageRows[0].identityKind, "compacted");
    assert.equal(ledger.usageRows[0].sourceIds.size, 1);
    assert.equal(afterRemoval.coverage.observedTokens, 100);
    assert.equal(afterRemoval.coverage.sourceIncomplete, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("durable storage and exported snapshots keep privacy and permissions", async () => {
  const fixture = await createFixture([100]);
  const secretPrompt = "do not export this prompt";
  try {
    await appendFile(
      fixture.file,
      serialize([{
        timestamp: BASE_TIMESTAMP,
        type: "event_msg",
        payload: {
          type: "message",
          message: secretPrompt,
          cwd: fixture.root,
        },
      }]),
    );
    const snapshot = await collectUsage(options(fixture));
    const writeResult = await writePrivateSnapshot(fixture.output, snapshot);
    const encoded = await readFile(fixture.output, "utf8");
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });

    assert.equal(writeResult.snapshot.coverage.observedTokens, 100);
    assert.equal(encoded.includes(fixture.root), false);
    assert.equal(encoded.includes(secretPrompt), false);
    assert.equal((await stat(fixture.stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
    assert.equal((await stat(fixture.output)).mode & 0o777, 0o600);
    assert.equal(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
      resolve(fixture.stateDirectory, DURABLE_LEDGER_FILENAME),
    );
    assert.deepEqual(
      (await readPrivateSnapshot(fixture.output)).coverage.observedTokens,
      100,
    );
    for (const suffix of ["-wal", "-shm"]) {
      try {
        assert.equal((await stat(`${ledgerPath}${suffix}`)).mode & 0o777, 0o600);
      } catch (error) {
        assert.equal(error.code, "ENOENT");
      }
    }
  } finally {
    await chmod(fixture.file, 0o600).catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});
