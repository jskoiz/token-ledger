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
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  collectUsage,
  sourceLocationForPath,
} from "../lib/token-ledger-importer.mjs";
import {
  DURABLE_LEDGER_FILENAME,
  codexHomeFingerprint,
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
const ARCHIVED_THREAD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ARCHIVED_ROLLOUT_NAME = `rollout-${ARCHIVED_THREAD_ID}.jsonl`;
const SHARED_THREAD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SHARED_ROLLOUT_NAME = `rollout-${SHARED_THREAD_ID}.jsonl`;
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
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(second.coverage.observedTokens, 100);
    assert.equal(second.quotaObservations.length, 1);
    assert.equal(second.coverage.sourceIncomplete, true);
    assert.equal(second.coverage.sourceStates.tombstoned, 1);
    assert.equal(activeOnly.coverage.observedTokens, 100);
    assert.equal(activeOnly.quotaObservations.length, 1);
    assert.equal(ledger.usageRows.length, 1);
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(ledger.sourceSummary.states[0].status, "tombstoned");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("durable ledgers reject a different Codex data directory", async () => {
  const firstFixture = await createFixture([100]);
  const secondFixture = await createFixture([200]);
  try {
    await collectUsage(options(firstFixture));
    await assert.rejects(
      collectUsage(options(secondFixture, {
        output: firstFixture.output,
        stateDirectory: firstFixture.stateDirectory,
      })),
      (error) => error?.code === "ERR_DURABLE_LEDGER_CODEX_HOME",
    );
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: firstFixture.stateDirectory }),
    );

    assert.equal(
      ledger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      100,
    );
    assert.equal(ledger.revision, 1);
  } finally {
    await rm(firstFixture.root, { recursive: true, force: true });
    await rm(secondFixture.root, { recursive: true, force: true });
  }
});

test("durable ledger binding canonicalizes Codex home aliases", async () => {
  const fixture = await createFixture([100]);
  const alias = resolve(fixture.root, "codex-home-alias");
  try {
    await collectUsage(options(fixture));
    await symlink(fixture.root, alias, "dir");
    const throughAlias = await collectUsage(options(fixture, {
      codexHome: alias,
    }));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(throughAlias), 100);
    assert.equal(ledger.revision, 2);
    assert.equal(
      codexHomeFingerprint(alias),
      codexHomeFingerprint(fixture.root),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exact observations retain tool-call ownership after source disappearance", async () => {
  const fixture = await createFixture([100]);
  try {
    await appendFile(
      fixture.file,
      serialize([{
        timestamp: "2026-08-20T10:01:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "call-exact-tool",
        },
      }]),
    );
    const first = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture, {
      includeArchived: false,
    }));

    assert.equal(first.events[0].toolCalls, 1);
    assert.equal(afterRemoval.events[0].toolCalls, 1);
    assert.equal(afterRemoval.threads[0].toolCalls, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("shared observations retain the durable union of partial tool calls", async () => {
  const fixture = await createFixture([100]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  const call = (callId) => ({
    timestamp: "2026-08-20T10:01:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: callId,
    },
  });
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await appendFile(
      fixture.file,
      serialize([call("call-shared"), call("call-active-only")]),
    );
    await writeFile(
      archivedFile,
      serialize([...rolloutRows([100]), call("call-shared")]),
    );

    const allSources = await collectUsage(options(fixture));
    await rm(fixture.file);
    const partialSource = await collectUsage(options(fixture));
    await rm(archivedFile);
    const afterRemoval = await collectUsage(options(fixture));

    assert.equal(allSources.events[0].toolCalls, 2);
    assert.equal(partialSource.events[0].toolCalls, 2);
    assert.equal(partialSource.threads[0].toolCalls, 2);
    assert.equal(afterRemoval.events[0].toolCalls, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacement removes only its stale shared-event membership", async () => {
  const fixture = await createFixture([100]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(archivedFile, await readFile(fixture.file));
    await collectUsage(options(fixture));
    await writeFile(replacement, serialize(rolloutRows([200])));
    await rename(replacement, fixture.file);

    const allSources = await collectUsage(options(fixture));
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    const archivedSourceId = ledger.sourceSummary.states.find(
      (state) => state.location === "archived",
    )?.sourceId;
    const oldObservation = ledger.usageRows.find(
      (row) => row.totalTokens === 100,
    );

    assert.equal(totalTokens(allSources), 300);
    assert.equal(totalTokens(activeOnly), 200);
    assert.deepEqual([...oldObservation.sourceIds], [archivedSourceId]);
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

test("turnless usage events reconcile by stable source position", async () => {
  const fixture = await createFixture([]);
  const legacyRows = (totals) => totals.map((total, index) => tokenCount(
    new Date(Date.parse(BASE_TIMESTAMP) + index * 60_000).toISOString(),
    total,
  ));
  try {
    await writeFile(fixture.file, serialize(legacyRows([100, 200])));
    const first = await collectUsage(options(fixture));
    await writeFile(fixture.file, serialize(legacyRows([200, 300])));
    const replaced = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(first), 300);
    assert.equal(totalTokens(replaced), 500);
    assert.equal(totalTokens(afterRemoval), 500);
    assert.equal(ledger.usageRows.length, 2);
    assert.equal(
      ledger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      500,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("atomic replacement preserves source identity and reconciles positions", async () => {
  const fixture = await createFixture([100, 200]);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    await collectUsage(options(fixture));
    const beforeLedger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    await writeFile(replacement, serialize(rolloutRows([100, 300])));
    await rename(replacement, fixture.file);

    const replaced = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(replaced), 400);
    assert.equal(ledger.usageRows.length, 2);
    assert.equal(ledger.sourceSummary.states.length, 1);
    assert.equal(
      ledger.sourceSummary.states[0].sourceId,
      beforeLedger.sourceSummary.states[0].sourceId,
    );
    assert.equal(ledger.sourceSummary.states[0].changeState, "replaced");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("shorter atomic replacement removes unmatched source observations", async () => {
  const fixture = await createFixture([100, 200]);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    await collectUsage(options(fixture));
    await writeFile(replacement, serialize(rolloutRows([300])));
    await rename(replacement, fixture.file);

    const replaced = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(replaced), 300);
    assert.equal(totalTokens(afterRemoval), 300);
    assert.equal(ledger.usageRows.length, 1);
    assert.equal(ledger.usageRows[0].totalTokens, 300);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("larger same-inode overwrite removes unmatched source observations", async () => {
  const fixture = await createFixture([100, 200]);
  try {
    await collectUsage(options(fixture));
    const before = await stat(fixture.file);
    await writeFile(fixture.file, serialize([
      ...rolloutRows([300]),
      {
        timestamp: "2026-08-20T10:02:00.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "padding".repeat(1_024),
        },
      },
    ]));
    const after = await stat(fixture.file);
    assert.equal(after.ino, before.ino);
    assert.ok(after.size > before.size);

    const replaced = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));

    assert.equal(totalTokens(replaced), 300);
    assert.equal(totalTokens(afterRemoval), 300);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacing one source does not rewrite a shared observation", async () => {
  const fixture = await createFixture([100]);
  const sharedFile = resolve(fixture.file, "..", SHARED_ROLLOUT_NAME);
  try {
    await writeFile(sharedFile, await readFile(fixture.file));
    const shared = await collectUsage(options(fixture));

    await writeFile(fixture.file, serialize(rolloutRows([200])));
    const replaced = await collectUsage(options(fixture));
    await rm(fixture.file);
    await rm(sharedFile);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(shared), 100);
    assert.equal(totalTokens(replaced), 300);
    assert.equal(totalTokens(afterRemoval), 300);
    assert.deepEqual(
      ledger.usageRows.map((row) => row.totalTokens).sort((left, right) => left - right),
      [100, 200],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("original promotion refreshes persisted origin attribution", async () => {
  const fixture = await createFixture([]);
  const originalFile = resolve(fixture.file, "..", SHARED_ROLLOUT_NAME);
  const inheritedRows = rolloutRows([100]);
  inheritedRows[0].payload.started_at =
    Date.parse("2026-08-19T10:00:00.000Z") / 1_000;
  const originalRows = rolloutRows([100]);
  originalRows[1].payload.model = "gpt-5.6-sol";
  try {
    await writeFile(fixture.file, serialize(inheritedRows));
    await collectUsage(options(fixture));
    let ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    assert.equal(ledger.usageRows[0].originalLikely, false);
    assert.equal(ledger.usageRows[0].originThreadId, THREAD_ID);

    await writeFile(originalFile, serialize(originalRows));
    await collectUsage(options(fixture));
    ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    assert.equal(ledger.usageRows[0].originalLikely, true);
    assert.equal(ledger.usageRows[0].threadId, SHARED_THREAD_ID);
    assert.equal(ledger.usageRows[0].originThreadId, SHARED_THREAD_ID);
    assert.equal(ledger.usageRows[0].model, "gpt-5.6-sol");
    assert.equal(ledger.usageRows[0].originModel, "gpt-5.6-sol");

    await rm(fixture.file);
    await rm(originalFile);
    await collectUsage(options(fixture));
    ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    assert.equal(ledger.usageRows[0].originThreadId, SHARED_THREAD_ID);
    assert.equal(ledger.usageRows[0].originModel, "gpt-5.6-sol");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source replacement refreshes tool ownership without stale call counts", async () => {
  const fixture = await createFixture([100, 200]);
  const call = (callId) => ({
    timestamp: "2026-08-20T10:02:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: callId,
    },
  });
  try {
    await appendFile(fixture.file, serialize([call("call-before-replace")]));
    const first = await collectUsage(options(fixture));

    await writeFile(
      fixture.file,
      serialize([
        ...rolloutRows([100, 300]),
        call("call-after-replace"),
      ]),
    );
    const replaced = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));

    assert.equal(first.events.reduce((sum, event) => sum + event.toolCalls, 0), 1);
    assert.equal(replaced.events.reduce((sum, event) => sum + event.toolCalls, 0), 1);
    assert.equal(afterRemoval.events.reduce((sum, event) => sum + event.toolCalls, 0), 1);
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

test("simultaneous active and archived rollout copies keep separate scope", async () => {
  const fixture = await createFixture([100]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      serialize(rolloutRows([200], { offset: 1 })),
    );
    const allSources = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    await rm(fixture.file);
    const afterActiveRemoval = await collectUsage(options(fixture));
    const retainedActiveHistory = await collectUsage(options(fixture, {
      includeArchived: false,
    }));

    assert.equal(totalTokens(allSources), 300);
    assert.equal(totalTokens(activeOnly), 100);
    assert.equal(totalTokens(afterActiveRemoval), 300);
    assert.equal(totalTokens(retainedActiveHistory), 100);
    assert.deepEqual(
      ledger.sourceSummary.states.map((state) => state.location).sort(),
      ["active", "archived"],
    );
    assert.equal(new Set(
      ledger.sourceSummary.states.map((state) => state.sourceId),
    ).size, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("atomic replacement keeps one simultaneous rollout copy isolated", async () => {
  const fixture = await createFixture([100]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      serialize(rolloutRows([200], { offset: 1 })),
    );
    await collectUsage(options(fixture));
    const beforeLedger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    await writeFile(replacement, serialize(rolloutRows([300])));
    await rename(replacement, fixture.file);

    const replaced = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    const sourceIdByLocation = (value) => new Map(
      value.sourceSummary.states.map((state) => [state.location, state.sourceId]),
    );

    assert.equal(totalTokens(replaced), 500);
    assert.equal(ledger.sourceSummary.states.length, 2);
    assert.deepEqual(
      sourceIdByLocation(ledger),
      sourceIdByLocation(beforeLedger),
    );
    assert.equal(
      ledger.sourceSummary.states.find((state) => state.location === "active")
        ?.changeState,
      "replaced",
    );
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

test("overlapping ledger writers cannot commit through the rollback window", async () => {
  const fixture = await createFixture([100]);
  let writerGuard;
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const priorRevision = await readDurableLedgerRevision(ledgerPath);
    writerGuard = new DatabaseSync(`${ledgerPath}.writer-lock.sqlite`);
    writerGuard.exec("BEGIN IMMEDIATE");
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    await assert.rejects(
      () => collectUsage(options(fixture)),
      /database is locked|SQLITE_BUSY/i,
    );
    assert.equal(await readDurableLedgerRevision(ledgerPath), priorRevision);
    const unchanged = await readDurableLedger(ledgerPath);
    assert.equal(
      unchanged.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      100,
    );

    writerGuard.exec("ROLLBACK");
    writerGuard.close();
    writerGuard = null;
    const recovered = await collectUsage(options(fixture));
    assert.equal(totalTokens(recovered), 300);
  } finally {
    try {
      writerGuard?.exec("ROLLBACK");
    } catch {
      // Best-effort test cleanup.
    }
    writerGuard?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ledger readers exclude rollback restoration until they close", async () => {
  const fixture = await createFixture([100]);
  let readerGuard;
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const priorRevision = await readDurableLedgerRevision(ledgerPath);
    readerGuard = new DatabaseSync(`${ledgerPath}.writer-lock.sqlite`);
    readerGuard.exec("BEGIN");
    readerGuard.prepare("SELECT COUNT(*) FROM writer_guard").get();
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    await assert.rejects(
      () => collectUsage(options(fixture)),
      /database is locked|SQLITE_BUSY/i,
    );
    assert.equal(await readDurableLedgerRevision(ledgerPath), priorRevision);

    readerGuard.exec("ROLLBACK");
    readerGuard.close();
    readerGuard = null;
    const recovered = await collectUsage(options(fixture));
    assert.equal(totalTokens(recovered), 300);
  } finally {
    try {
      readerGuard?.exec("ROLLBACK");
    } catch {
      // Best-effort test cleanup.
    }
    readerGuard?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("revision reads tolerate Node SQLite corruption error codes", async () => {
  const fixture = await createFixture([]);
  const ledgerPath = resolveDurableLedgerPath({
    stateDirectory: fixture.stateDirectory,
  });
  try {
    await mkdir(fixture.stateDirectory, { recursive: true });
    await writeFile(ledgerPath, "not a sqlite database");
    assert.equal(await readDurableLedgerRevision(ledgerPath), null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source changes before commit roll back transient observations", async () => {
  const fixture = await createFixture([100, 150]);
  let replaced = false;
  try {
    const snapshot = await collectUsage(options(fixture, {
      faultInjector: async ({ point }) => {
        if (point === "before-commit" && !replaced) {
          replaced = true;
          await writeFile(fixture.file, serialize(rolloutRows([200])));
        }
      },
    }));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(snapshot), 200);
    assert.equal(totalTokens(afterRemoval), 200);
    assert.deepEqual(ledger.usageRows.map((row) => row.totalTokens), [200]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source changes after validation restore the prior ledger before retry", async () => {
  const fixture = await createFixture([100]);
  let changed = false;
  try {
    await collectUsage(options(fixture));
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );
    const snapshot = await collectUsage(options(fixture, {
      faultInjector: async ({ point }) => {
        if (point === "after-validation" && !changed) {
          changed = true;
          await writeFile(fixture.file, serialize(rolloutRows([100])));
        }
      },
    }));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(changed, true);
    assert.equal(totalTokens(snapshot), 100);
    assert.equal(
      ledger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      100,
    );
    assert.equal(ledger.usageRows.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source changes after commit do not retry an already committed attempt", async () => {
  const fixture = await createFixture([100, 200]);
  let changed = false;
  try {
    const committed = await collectUsage(options(fixture, {
      faultInjector: async ({ point }) => {
        if (point === "after-commit" && !changed) {
          changed = true;
          await writeFile(fixture.file, serialize(rolloutRows([100])));
        }
      },
    }));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(changed, true);
    assert.equal(totalTokens(committed), 300);
    assert.equal(await readDurableLedgerRevision(ledgerPath), 1);
    assert.equal(
      ledger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      300,
    );
    assert.equal(ledger.usageRows.length, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("write-open rejects newer durable ledger schemas without rewriting them", async () => {
  const fixture = await createFixture([100]);
  const ledgerPath = resolveDurableLedgerPath({
    stateDirectory: fixture.stateDirectory,
  });
  let database;
  try {
    await mkdir(fixture.stateDirectory, { recursive: true });
    database = new DatabaseSync(ledgerPath);
    database.exec(`
      CREATE TABLE future_only (value TEXT);
      PRAGMA user_version = 2;
    `);
    database.close();
    database = null;

    await assert.rejects(
      () => collectUsage(options(fixture)),
      (error) => error?.code === "ERR_DURABLE_LEDGER_SCHEMA",
    );

    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
          FROM sqlite_master
         WHERE type = 'table' AND name = 'source_state'
      `).get().count,
      0,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM future_only").get().count,
      0,
    );
  } finally {
    try {
      database?.close();
    } catch {
      // Fixture cleanup remains authoritative.
    }
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

test("partial legacy overlap does not retain credits for rescanned usage", async () => {
  const fixture = await createFixture([40]);
  const legacy = {
    schemaVersion: 3,
    generatedAt: "2026-08-20T12:00:00.000Z",
    events: [{
      timestamp: "2026-08-20T09:00:00.000Z",
      startAt: "2026-08-20T09:00:00.000Z",
      endAt: "2026-08-20T12:00:00.000Z",
      project: "Unknown project",
      model: "gpt-5.4",
      rateCardModel: "gpt-5.4",
      effort: "medium",
      source: "unknown",
      useType: "unknown",
      inputTokens: 190,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 200,
      toolCalls: 0,
      rateCardCredits: 7,
      callCount: 1,
      detailedCallCount: 1,
      inputCallCount: 1,
      breakdownAvailable: true,
      threadIds: [THREAD_ID],
    }],
  };
  try {
    await writePrivateSnapshot(fixture.output, legacy);
    const snapshot = await collectUsage(options(fixture));
    const credits = snapshot.events.reduce(
      (sum, event) => sum + (event.rateCardCredits || 0),
      0,
    );

    assert.equal(snapshot.coverage.observedTokens, 200);
    assert.ok(credits < 7);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("legacy overlap subtracts rescanned observations after compaction", async () => {
  const baseTimestamp = "2015-08-20T10:00:00.000Z";
  const eventTimestamp = "2015-08-20T10:00:01.000Z";
  const fixture = await createFixture([100], { baseTimestamp });
  const legacy = {
    schemaVersion: 3,
    generatedAt: "2026-08-20T12:00:00.000Z",
    events: [{
      timestamp: eventTimestamp,
      startAt: eventTimestamp,
      endAt: eventTimestamp,
      project: "Unknown project",
      model: "gpt-5.4",
      rateCardModel: "gpt-5.4",
      effort: "medium",
      source: "unknown",
      useType: "unknown",
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
      threadIds: [THREAD_ID],
    }],
  };
  try {
    await writePrivateSnapshot(fixture.output, legacy);
    const snapshot = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(ledger.compactedUsageRows, 1);
    assert.equal(ledger.migratedUsageRows, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only legacy migrations survive --no-archived refreshes", async () => {
  const fixture = await createFixture([]);
  const generatedAt = "2026-08-20T12:00:00.000Z";
  const legacy = {
    schemaVersion: 3,
    generatedAt,
    provenance: {
      collection: { since: null, includeArchived: false },
    },
    quotaObservations: [{
      timestamp: generatedAt,
      lastSeenAt: generatedAt,
      usedPercent: 22,
      windowMinutes: 10_080,
      resetsAt: WEEKLY_RESET,
      planType: "plus",
      limitKey: "weekly",
      scope: "account",
    }],
    events: [{
      timestamp: generatedAt,
      project: "active-history",
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
      threadIds: ["active-history-thread"],
    }],
  };
  try {
    await writePrivateSnapshot(fixture.output, legacy);
    const snapshot = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
      { includeArchived: false },
    );

    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(snapshot.coverage.migratedCompactedTokens, 100);
    assert.equal(snapshot.quotaObservations.length, 1);
    assert.equal(ledger.migration.includeArchived, false);
    assert.equal(ledger.migratedUsageRows, 1);
    assert.equal(ledger.migratedQuotaRows, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("collection cutoff slices migrated compacted ranges", async () => {
  const fixture = await createFixture([]);
  const legacy = {
    schemaVersion: 3,
    generatedAt: "2026-08-22T00:00:00.000Z",
    events: [{
      timestamp: "2026-08-20T00:00:00.000Z",
      startAt: "2026-08-20T00:00:00.000Z",
      endAt: "2026-08-22T00:00:00.000Z",
      project: "cutoff-history",
      model: "gpt-5.4",
      rateCardModel: "gpt-5.4",
      effort: "medium",
      source: "local",
      useType: "interactive",
      inputTokens: 190,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 200,
      toolCalls: 0,
      callCount: 1,
      detailedCallCount: 1,
      inputCallCount: 1,
      breakdownAvailable: true,
      threadIds: ["cutoff-thread"],
    }],
  };
  try {
    await writePrivateSnapshot(fixture.output, legacy);
    const snapshot = await collectUsage(options(fixture, {
      since: "2026-08-21T00:00:00.000Z",
    }));

    assert.ok(Math.abs(totalTokens(snapshot) - 100) < 1e-6);
    assert.ok(Math.abs(snapshot.coverage.migratedCompactedTokens - 100) < 1e-6);
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].rangeAllocationEstimated, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("collection cutoff retains overlapping durable quota readings", async () => {
  const fixture = await createFixture([100, 200], { usedPercent: 37 });
  const cutoff = "2026-08-20T10:00:30.000Z";
  try {
    await collectUsage(options(fixture));
    const snapshot = await collectUsage(options(fixture, { since: cutoff }));

    assert.equal(snapshot.quotaObservations.length, 1);
    assert.equal(snapshot.quotaObservations[0].timestamp, cutoff);
    assert.equal(
      snapshot.quotaObservations[0].lastSeenAt,
      "2026-08-20T10:01:01.000Z",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only quota spans exclude archived observations", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "21",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      serialize(rolloutRows([200], {
        baseTimestamp: "2026-08-21T10:00:00.000Z",
        usedPercent: 37,
      })),
    );
    const allSources = await collectUsage(options(fixture));
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const activeOnlySinceArchivedSample = await collectUsage(options(fixture, {
      includeArchived: false,
      since: "2026-08-21T00:00:00.000Z",
    }));

    assert.equal(
      allSources.quotaObservations[0].lastSeenAt,
      "2026-08-21T10:00:01.000Z",
    );
    assert.equal(
      activeOnly.quotaObservations[0].lastSeenAt,
      "2026-08-20T10:00:01.000Z",
    );
    assert.equal(activeOnlySinceArchivedSample.quotaObservations.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacement reconciles shared quota and tool source ownership", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  const sharedCall = {
    timestamp: "2026-08-20T10:01:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: "call-shared-replacement",
    },
  };
  try {
    await appendFile(fixture.file, serialize([sharedCall]));
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(archivedFile, await readFile(fixture.file));
    await collectUsage(options(fixture));
    await writeFile(replacement, serialize(rolloutRows([200])));
    await rename(replacement, fixture.file);

    const allSources = await collectUsage(options(fixture));
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    await rm(archivedFile);
    const afterArchivedRemoval = await collectUsage(options(fixture));

    assert.equal(totalTokens(allSources), 300);
    assert.equal(allSources.quotaObservations.length, 1);
    assert.equal(
      allSources.events.reduce((sum, event) => sum + event.toolCalls, 0),
      1,
    );
    assert.equal(totalTokens(activeOnly), 200);
    assert.equal(activeOnly.quotaObservations.length, 0);
    assert.equal(activeOnly.events[0].toolCalls, 0);
    assert.equal(totalTokens(afterArchivedRemoval), 300);
    assert.equal(afterArchivedRemoval.quotaObservations.length, 1);
    assert.equal(
      afterArchivedRemoval.events.reduce(
        (sum, event) => sum + event.toolCalls,
        0,
      ),
      1,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacement resets retained quota source bounds", async () => {
  const fixture = await createFixture([100], {
    baseTimestamp: "2026-08-21T10:00:00.000Z",
    usedPercent: 37,
  });
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    await collectUsage(options(fixture));
    await writeFile(replacement, serialize(rolloutRows([200], {
      baseTimestamp: "2026-08-20T10:00:00.000Z",
      usedPercent: 37,
    })));
    await rename(replacement, fixture.file);

    const allSources = await collectUsage(options(fixture));
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const allSourcesAfterOldSample = await collectUsage(options(fixture, {
      since: "2026-08-21T00:00:00.000Z",
    }));
    const afterOldSample = await collectUsage(options(fixture, {
      includeArchived: false,
      since: "2026-08-21T00:00:00.000Z",
    }));

    assert.equal(
      allSources.quotaObservations[0].lastSeenAt,
      "2026-08-20T10:00:01.000Z",
    );
    assert.equal(
      activeOnly.quotaObservations[0].lastSeenAt,
      "2026-08-20T10:00:01.000Z",
    );
    assert.equal(allSourcesAfterOldSample.quotaObservations.length, 0);
    assert.equal(afterOldSample.quotaObservations.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacement prunes orphaned compacted observations", async () => {
  const baseTimestamp = "2015-08-20T10:00:00.000Z";
  const fixture = await createFixture([100, 200], { baseTimestamp });
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    const initial = await collectUsage(options(fixture));
    await writeFile(
      replacement,
      serialize(rolloutRows([100], { baseTimestamp })),
    );
    await rename(replacement, fixture.file);

    const replaced = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(initial), 300);
    assert.equal(totalTokens(replaced), 100);
    assert.equal(totalTokens(afterRemoval), 100);
    assert.equal(ledger.compactedUsageRows, 1);
    assert.equal(ledger.usageRows[0].totalTokens, 100);
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

test("compacted observations retain tool-call ownership after source disappearance", async () => {
  const fixture = await createFixture([100], {
    baseTimestamp: "2015-08-20T10:00:00.000Z",
  });
  try {
    await appendFile(
      fixture.file,
      serialize([{
        timestamp: "2015-08-20T10:01:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "call-old-tool",
        },
      }]),
    );
    const first = await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(first.events[0].toolCalls, 1);
    assert.equal(ledger.usageRows[0].toolCalls, 1);
    assert.deepEqual(ledger.usageRows[0].toolCallKeys, ["id|call-old-tool"]);

    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    assert.equal(afterRemoval.events[0].toolCalls, 1);
    assert.equal(afterRemoval.threads[0].toolCalls, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only reads exclude tool calls owned only by archived sources", async () => {
  const fixture = await createFixture([100]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  const archivedCall = {
    timestamp: "2026-08-20T10:01:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: "call-archived-only",
    },
  };
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      `${await readFile(fixture.file, "utf8")}${serialize([archivedCall])}`,
    );
    const allSources = await collectUsage(options(fixture));
    await rm(fixture.file);
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const activeOnlyLedger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
      { includeArchived: false },
    );

    assert.equal(totalTokens(allSources), 100);
    assert.equal(allSources.events[0].toolCalls, 1);
    assert.equal(totalTokens(activeOnly), 100);
    assert.equal(activeOnly.events[0].toolCalls, 0);
    assert.deepEqual(activeOnlyLedger.usageRows[0].toolCallKeys, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only refreshes preserve archived tool ownership durably", async () => {
  const fixture = await createFixture([100]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  const archivedCall = {
    timestamp: "2026-08-20T10:01:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: "call-archived-preserved",
    },
  };
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      `${await readFile(fixture.file, "utf8")}${serialize([archivedCall])}`,
    );
    const allSources = await collectUsage(options(fixture));
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const afterActiveOnlyLedger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    assert.deepEqual(
      afterActiveOnlyLedger.usageRows[0].toolCallKeys,
      ["id|call-archived-preserved"],
    );
    const archivedSourceId = afterActiveOnlyLedger.sourceSummary.states.find(
      (state) => state.location === "archived",
    )?.sourceId;
    assert.deepEqual(
      [...afterActiveOnlyLedger.toolRows[0].sourceIds].sort(),
      [archivedSourceId],
    );
    await rm(archivedFile);
    const afterArchiveRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(allSources.events[0].toolCalls, 1);
    assert.equal(activeOnly.events[0].toolCalls, 0);
    assert.deepEqual(
      ledger.usageRows[0].toolCallKeys,
      ["id|call-archived-preserved"],
    );
    assert.equal(afterArchiveRemoval.events[0].toolCalls, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only compacted reads derive tool totals from scoped memberships", async () => {
  const baseTimestamp = "2015-08-20T10:00:00.000Z";
  const fixture = await createFixture([100], { baseTimestamp });
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2015",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  const archivedCall = {
    timestamp: "2015-08-20T10:01:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: "call-archived-compacted",
    },
  };
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      `${await readFile(fixture.file, "utf8")}${serialize([archivedCall])}`,
    );
    const allSources = await collectUsage(options(fixture));
    await rm(fixture.file);
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const activeOnlyLedger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
      { includeArchived: false },
    );

    assert.equal(allSources.events[0].toolCalls, 1);
    assert.equal(activeOnlyLedger.compactedUsageRows, 1);
    assert.equal(activeOnly.events[0].toolCalls, 0);
    assert.deepEqual(activeOnlyLedger.usageRows[0].toolCallKeys, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("compaction keeps active and archived source scopes filterable", async () => {
  const fixture = await createFixture([100], {
    baseTimestamp: "2015-08-20T10:00:00.000Z",
  });
  const call = (timestamp, callId) => ({
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: callId,
    },
  });
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await appendFile(
      fixture.file,
      serialize([call("2015-08-20T10:01:00.000Z", "call-active")]),
    );
    await writeFile(
      archivedFile,
      serialize([
        ...rolloutRows([200], {
          offset: 10,
          baseTimestamp: "2015-08-20T10:00:00.000Z",
        }),
        call("2015-08-20T10:11:00.000Z", "call-archived"),
      ]),
    );
    const allSources = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));

    assert.equal(totalTokens(allSources), 300);
    assert.equal(allSources.events.reduce((sum, event) => sum + event.toolCalls, 0), 2);
    assert.equal(ledger.compactedUsageRows, 2);
    assert.equal(totalTokens(activeOnly), 100);
    assert.equal(
      activeOnly.events.reduce((sum, event) => sum + event.toolCalls, 0),
      1,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a reappearing compacted member does not expose its archived siblings", async () => {
  const baseTimestamp = "2015-08-20T10:00:00.000Z";
  const fixture = await createFixture([], { baseTimestamp });
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2015",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      serialize(rolloutRows([100, 200], { baseTimestamp })),
    );
    const archivedOnly = await collectUsage(options(fixture));
    let ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    assert.equal(totalTokens(archivedOnly), 300);
    assert.equal(ledger.compactedUsageRows, 1);

    await writeFile(
      fixture.file,
      serialize(rolloutRows([100], { baseTimestamp })),
    );
    const withReappearedMember = await collectUsage(options(fixture));
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    await rm(fixture.file);
    const retainedActiveHistory = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(withReappearedMember), 300);
    assert.equal(totalTokens(activeOnly), 100);
    assert.equal(totalTokens(retainedActiveHistory), 100);
    assert.equal(ledger.compactedUsageRows, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("user-selected output directories keep their existing permissions", async () => {
  const fixture = await createFixture([100]);
  const selectedDirectory = resolve(fixture.root, "shared-output");
  const selectedOutput = resolve(selectedDirectory, "snapshot.json.gz");
  try {
    await mkdir(selectedDirectory, { recursive: true });
    await chmod(selectedDirectory, 0o755);
    await collectUsage(options(fixture, {
      output: selectedOutput,
      stateDirectory: undefined,
    }));

    const ledgerPath = resolveDurableLedgerPath({ output: selectedOutput });
    assert.equal((await stat(selectedDirectory)).mode & 0o777, 0o755);
    assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("user-selected state directories keep their existing permissions", async () => {
  const fixture = await createFixture([100]);
  const selectedDirectory = resolve(fixture.root, "shared-state");
  try {
    await mkdir(selectedDirectory, { recursive: true });
    await chmod(selectedDirectory, 0o755);
    await collectUsage(options(fixture, {
      stateDirectory: selectedDirectory,
    }));

    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: selectedDirectory,
    });
    assert.equal((await stat(selectedDirectory)).mode & 0o777, 0o755);
    assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("archive source classification normalizes path separators", () => {
  assert.equal(
    sourceLocationForPath(
      "C:\\Users\\tester\\.codex",
      "C:\\Users\\tester\\.codex/archived_sessions\\2026\\rollout.jsonl",
    ),
    "archived",
  );
  assert.equal(
    sourceLocationForPath(
      "/tmp/codex",
      "/tmp/codex/sessions/2026/rollout.jsonl",
    ),
    "active",
  );
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
