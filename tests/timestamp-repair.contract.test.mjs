import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { collectUsage } from "../lib/token-ledger-importer.mjs";
import {
  readDurableLedger,
  resolveDurableLedgerPath,
} from "../lib/token-ledger-ledger.mjs";

const THREAD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_THREAD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORIGIN = "2026-09-05T18:32:44.000Z";
const ROLLOUT_NAME = `rollout-${THREAD_ID}.jsonl`;

function serialize(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function turnStart(timestamp, turnId, { recordTimestamp = timestamp } = {}) {
  return [
    {
      timestamp: recordTimestamp,
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
      payload: { turn_id: turnId, model: "gpt-5.6-sol", effort: "medium" },
    },
  ];
}

function tokenCount(
  timestamp,
  total,
  {
    inputTokens = total - 10,
    cachedInputTokens = 10,
    outputTokens = 10,
    reasoningTokens = 4,
  } = {},
) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: cachedInputTokens,
          output_tokens: outputTokens,
          reasoning_output_tokens: reasoningTokens,
          total_tokens: total,
        },
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: cachedInputTokens,
          output_tokens: outputTokens,
          reasoning_output_tokens: reasoningTokens,
          total_tokens: total,
        },
        model_context_window: 128_000,
      },
    },
  };
}

async function createFixture(rows) {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-timestamp-"));
  const directory = resolve(root, "sessions", "2026", "09", "05");
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, ROLLOUT_NAME);
  await writeFile(file, serialize(rows));
  return {
    root,
    file,
    output: resolve(root, "exports", "snapshot.json.gz"),
    ledgerPath: resolveDurableLedgerPath({ codexHome: root }),
  };
}

async function disposeFixture(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
  await rm(dirname(fixture.ledgerPath), { recursive: true, force: true });
}

function options(fixture) {
  return {
    output: fixture.output,
    codexHome: fixture.root,
    includeArchived: true,
    since: null,
  };
}

function totalTokens(snapshot) {
  return snapshot.events.reduce((sum, event) => sum + event.totalTokens, 0);
}

function correctionFor(row) {
  return row.rangeAllocationOrigin?.timestampCorrection;
}

function mutatePersistedRows(fixture) {
  const ledgerPath = resolveDurableLedgerPath({ codexHome: fixture.root });
  const database = new DatabaseSync(ledgerPath);
  try {
    const badTimestamp = database.prepare(`
      SELECT observation_id AS observationId,
             range_allocation_origin AS rangeAllocationOrigin
        FROM usage_observations
       WHERE turn_id = 'turn-bad'
    `).get();
    const origin = JSON.parse(badTimestamp.rangeAllocationOrigin);
    const originalTimestamp = origin.timestampCorrection.originalTimestamp;
    database.exec("BEGIN IMMEDIATE");
    database.prepare(`
      UPDATE usage_observations
         SET timestamp = ?,
             range_allocation_estimated = 0,
             range_allocation_origin = NULL
       WHERE observation_id = ?
    `).run(originalTimestamp, badTimestamp.observationId);
    database.prepare(`
      UPDATE usage_observations
         SET detailed_call_count = 1
       WHERE turn_id = 'turn-total-only'
    `).run();
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the test mutation error.
    }
    throw error;
  } finally {
    database.close();
  }
}

function mutatePersistedRowToOtherThread(fixture) {
  const database = new DatabaseSync(fixture.ledgerPath);
  try {
    const row = database.prepare(`
      SELECT observation_id AS observationId,
             range_allocation_origin AS rangeAllocationOrigin
        FROM usage_observations
       WHERE turn_id = 'turn-other-thread'
    `).get();
    const originalTimestamp = JSON.parse(
      row.rangeAllocationOrigin,
    ).timestampCorrection.originalTimestamp;
    database.exec("BEGIN IMMEDIATE");
    database.prepare(`
      UPDATE usage_observations
         SET timestamp = ?,
             origin_thread_id = ?,
             range_allocation_estimated = 0,
             range_allocation_origin = NULL
       WHERE observation_id = ?
    `).run(originalTimestamp, OTHER_THREAD_ID, row.observationId);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the test mutation error.
    }
    throw error;
  } finally {
    database.close();
  }
}

test("repairs strict pre-origin timestamps without expanding the event range", async () => {
  const badTimestamp = "2026-09-05T18:32:43.999Z";
  const fixture = await createFixture([
    ...turnStart(ORIGIN, "turn-repair", {
      recordTimestamp: "2026-06-11T17:37:04.707Z",
    }),
    tokenCount(badTimestamp, 100),
  ]);
  try {
    const snapshot = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    const event = snapshot.events[0];
    const row = ledger.usageRows[0];

    assert.equal(totalTokens(snapshot), 100);
    assert.equal(event.timestamp, ORIGIN);
    assert.equal(event.startAt.slice(0, 10), ORIGIN.slice(0, 10));
    assert.equal(event.endAt.slice(0, 10), ORIGIN.slice(0, 10));
    assert.equal(event.rangeAllocationEstimated, true);
    assert.equal(row.timestamp, ORIGIN);
    assert.equal(row.rangeAllocationEstimated, true);
    assert.deepEqual(correctionFor(row), {
      kind: "before-own-turn",
      originalTimestamp: badTimestamp,
      fallbackTimestamp: ORIGIN,
    });
    assert.equal(row.startAt, null);
    assert.equal(row.endAt, null);
    assert.equal(row.totalTokens, 100);
  } finally {
    await disposeFixture(fixture);
  }
});

test("keeps a valid event timestamp and detailed breakdown unchanged", async () => {
  const eventTimestamp = "2026-09-05T18:32:45.000Z";
  const fixture = await createFixture([
    ...turnStart(ORIGIN, "turn-valid"),
    tokenCount(eventTimestamp, 200),
  ]);
  try {
    const snapshot = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );

    assert.equal(snapshot.events[0].timestamp, eventTimestamp);
    assert.notEqual(snapshot.events[0].rangeAllocationEstimated, true);
    assert.equal(ledger.usageRows[0].timestamp, eventTimestamp);
    assert.equal(ledger.usageRows[0].rangeAllocationEstimated, false);
    assert.equal(ledger.usageRows[0].rangeAllocationOrigin, null);
    assert.equal(ledger.usageRows[0].detailedCallCount, 1);
  } finally {
    await disposeFixture(fixture);
  }
});

test("replayed actual timestamp clears the estimate but retains provenance", async () => {
  const badTimestamp = "2026-06-11T17:37:04.707Z";
  const actualTimestamp = "2026-09-05T18:32:46.000Z";
  const fixture = await createFixture([
    ...turnStart(ORIGIN, "turn-replay", {
      recordTimestamp: badTimestamp,
    }),
    tokenCount(badTimestamp, 300),
  ]);
  try {
    const first = await collectUsage(options(fixture));
    assert.equal(first.events[0].timestamp, ORIGIN);
    await writeFile(fixture.file, serialize([
      ...turnStart(ORIGIN, "turn-replay", {
        recordTimestamp: badTimestamp,
      }),
      tokenCount(actualTimestamp, 300),
    ]));

    const second = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    const event = second.events[0];
    const row = ledger.usageRows[0];

    assert.equal(totalTokens(second), 300);
    assert.equal(second.events.length, 1);
    assert.equal(event.timestamp, actualTimestamp);
    assert.notEqual(event.rangeAllocationEstimated, true);
    assert.equal(correctionFor(row).originalTimestamp, badTimestamp);
    assert.equal(correctionFor(row).fallbackTimestamp, ORIGIN);
    assert.equal(row.timestamp, actualTimestamp);
    assert.equal(row.rangeAllocationEstimated, false);
    assert.equal(correctionFor(row).originalTimestamp, badTimestamp);
    assert.equal(ledger.usageRows.length, 1);

    await writeFile(fixture.file, serialize([
      ...turnStart(ORIGIN, "turn-replay", {
        recordTimestamp: badTimestamp,
      }),
      tokenCount(badTimestamp, 300),
    ]));
    const third = await collectUsage(options(fixture));
    assert.equal(totalTokens(third), 300);
    assert.equal(third.events.length, 1);
    assert.equal(third.events[0].timestamp, actualTimestamp);
    assert.notEqual(third.events[0].rangeAllocationEstimated, true);
  } finally {
    await disposeFixture(fixture);
  }
});

test("a copied non-original row cannot replace a valid original timestamp", async () => {
  const actualTimestamp = "2026-09-05T18:32:46.000Z";
  const badTimestamp = "2026-06-11T17:37:04.707Z";
  const fixture = await createFixture([
    ...turnStart(ORIGIN, "turn-copy"),
    tokenCount(actualTimestamp, 400),
  ]);
  try {
    const first = await collectUsage(options(fixture));
    assert.equal(first.events[0].timestamp, actualTimestamp);

    await writeFile(fixture.file, serialize([
      ...turnStart(ORIGIN, "turn-copy", {
        recordTimestamp: "2026-09-05T18:32:54.000Z",
      }),
      tokenCount(badTimestamp, 400),
    ]));
    const second = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(fixture.ledgerPath);

    assert.equal(totalTokens(second), 400);
    assert.equal(second.events[0].timestamp, actualTimestamp);
    assert.notEqual(second.events[0].rangeAllocationEstimated, true);
    assert.equal(ledger.usageRows[0].timestamp, actualTimestamp);
    assert.equal(ledger.usageRows[0].originalLikely, true);
    assert.equal(ledger.usageRows.length, 1);

    // A plausible time on weaker copied evidence must not displace the
    // preferred original merely because it does not need a timestamp repair.
    await writeFile(fixture.file, serialize([
      ...turnStart(ORIGIN, "turn-copy", {
        recordTimestamp: "2026-09-05T18:32:54.000Z",
      }),
      tokenCount("2026-09-05T18:33:00.000Z", 400),
    ]));
    const third = await collectUsage(options(fixture));
    const finalLedger = await readDurableLedger(fixture.ledgerPath);
    assert.equal(totalTokens(third), 400);
    assert.equal(third.events[0].timestamp, actualTimestamp);
    assert.equal(finalLedger.usageRows[0].timestamp, actualTimestamp);
    assert.equal(finalLedger.usageRows.length, 1);
  } finally {
    await disposeFixture(fixture);
  }
});

test("does not repair a pre-origin row whose origin belongs to another thread", async () => {
  const badTimestamp = "2026-06-11T17:37:04.707Z";
  const fixture = await createFixture([
    ...turnStart(ORIGIN, "turn-other-thread"),
    tokenCount(badTimestamp, 500),
  ]);
  try {
    const first = await collectUsage(options(fixture));
    assert.equal(first.events[0].timestamp, ORIGIN);
    mutatePersistedRowToOtherThread(fixture);

    const second = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(fixture.ledgerPath);
    const row = ledger.usageRows[0];

    assert.equal(totalTokens(second), 500);
    assert.equal(row.timestamp, badTimestamp);
    assert.equal(row.originThreadId, OTHER_THREAD_ID);
    assert.notEqual(row.rangeAllocationEstimated, true);
    assert.equal(row.rangeAllocationOrigin, null);
  } finally {
    await disposeFixture(fixture);
  }
});

test("normal refresh repairs persisted rows and impossible exact detailed counts", async () => {
  const fixture = await createFixture([
    ...turnStart(ORIGIN, "turn-bad", {
      recordTimestamp: "2026-06-11T17:37:04.707Z",
    }),
    tokenCount("2026-06-11T17:37:04.707Z", 100),
    ...turnStart("2026-09-05T18:33:44.000Z", "turn-valid"),
    tokenCount("2026-09-05T18:33:45.000Z", 200),
    ...turnStart("2026-09-05T18:34:44.000Z", "turn-total-only"),
    tokenCount("2026-09-05T18:34:45.000Z", 300, {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    }),
  ]);
  try {
    const first = await collectUsage(options(fixture));
    assert.equal(totalTokens(first), 600);
    mutatePersistedRows(fixture);

    const second = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    const bad = ledger.usageRows.find((row) => row.turnId === "turn-bad");
    const totalOnly = ledger.usageRows.find(
      (row) => row.turnId === "turn-total-only",
    );

    assert.equal(second.coverage.filesReused, 1);
    assert.equal(totalTokens(second), 600);
    assert.equal(ledger.usageRows.length, 3);
    assert.equal(
      ledger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      600,
    );
    assert.equal(bad.timestamp, ORIGIN);
    assert.equal(bad.rangeAllocationEstimated, true);
    assert.equal(correctionFor(bad).originalTimestamp, "2026-06-11T17:37:04.707Z");
    assert.equal(totalOnly.detailedCallCount, 0);

    const third = await collectUsage(options(fixture));
    const replayedLedger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: fixture.root }),
    );
    const replayedBad = replayedLedger.usageRows.find(
      (row) => row.turnId === "turn-bad",
    );
    assert.equal(totalTokens(third), 600);
    assert.equal(replayedLedger.usageRows.length, 3);
    assert.deepEqual(correctionFor(replayedBad), correctionFor(bad));
    assert.equal(replayedBad.timestamp, ORIGIN);
  } finally {
    await disposeFixture(fixture);
  }
});
