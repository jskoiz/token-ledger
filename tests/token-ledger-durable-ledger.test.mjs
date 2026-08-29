import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rename,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
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
  updateDurableLedger,
} from "../lib/token-ledger-ledger.mjs";
import {
  readPrivateSnapshot,
  stagePrivateSnapshot,
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

function recoveryArtifactPaths(ledgerPath) {
  return {
    marker: `${ledgerPath}.recovery.json`,
    backup: `${ledgerPath}.recovery.sqlite`,
  };
}

function crashCollection(fixture, point, directUpdate = false) {
  const importerUrl = new URL(
    "../lib/token-ledger-importer.mjs",
    import.meta.url,
  ).href;
  const ledgerUrl = new URL(
    "../lib/token-ledger-ledger.mjs",
    import.meta.url,
  ).href;
  const script = `
    import { collectUsage } from ${JSON.stringify(importerUrl)};
    import { updateDurableLedger } from ${JSON.stringify(ledgerUrl)};
    const selected = JSON.parse(process.env.TOKEN_LEDGER_CRASH_OPTIONS);
    const faultInjector = ({ point }) => {
        if (point === process.env.TOKEN_LEDGER_CRASH_POINT) process.exit(86);
    };
    if (process.env.TOKEN_LEDGER_DIRECT_UPDATE === "1") {
      await updateDurableLedger({
        options: selected,
        codexHome: selected.codexHome,
        inventory: { sources: [] },
        faultInjector,
      });
    } else {
      await collectUsage({ ...selected, faultInjector });
    }
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TOKEN_LEDGER_CRASH_OPTIONS: JSON.stringify(options(fixture)),
        TOKEN_LEDGER_CRASH_POINT: point,
        TOKEN_LEDGER_DIRECT_UPDATE: directUpdate ? "1" : "0",
      },
      timeout: 30_000,
    },
  );
  assert.equal(
    child.status,
    86,
    `crash child did not stop at ${point}: ${child.stderr || child.stdout}`,
  );
}

function shellCall(timestamp, callId) {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: callId,
    },
  };
}

function totalToolCalls(snapshot) {
  return snapshot.events.reduce((sum, event) => sum + event.toolCalls, 0);
}

function legacySnapshotForFixture(fixture, snapshot) {
  return {
    ...snapshot,
    provenance: {
      ...snapshot.provenance,
      collection: snapshot.provenance?.collection || {
        since: null,
        includeArchived: true,
      },
    },
    metadata: {
      ...snapshot.metadata,
      durableLedger: {
        ...snapshot.metadata?.durableLedger,
        codexHomeFingerprint: codexHomeFingerprint(fixture.root),
      },
    },
  };
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

test("first active-only refresh excludes a rollout moved into the archive", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  try {
    await appendFile(fixture.file, serialize([{
      timestamp: "2026-08-20T10:01:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        call_id: "call-before-archive",
      },
    }]));
    const initial = await collectUsage(options(fixture));
    assert.equal(initial.coverage.observedTokens, 100);
    assert.equal(initial.quotaObservations.length, 1);
    assert.equal(initial.events[0].toolCalls, 1);

    await mkdir(archivedDirectory, { recursive: true });
    await copyFile(fixture.file, archivedFile);
    await rm(fixture.file);
    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
      { includeArchived: false },
    );

    assert.equal(totalTokens(activeOnly), 0);
    assert.equal(activeOnly.quotaObservations.length, 0);
    assert.equal(activeOnly.events.length, 0);
    assert.equal(ledger.usageRows.length, 0);
    assert.equal(ledger.quotaRows.length, 0);
    assert.equal(ledger.toolRows.length, 0);
    assert.equal(ledger.sourceSummary.states.length, 1);
    assert.equal(ledger.sourceSummary.states[0].location, "archived");
    assert.equal(ledger.sourceSummary.states[0].status, "archived");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only refresh preserves an atomically replaced archive source", async () => {
  const fixture = await createFixture([100], { usedPercent: 37 });
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "21",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  const replacement = resolve(fixture.root, "archived-replacement.jsonl");
  try {
    await appendFile(fixture.file, serialize([
      shellCall("2026-08-20T10:01:00.000Z", "call-active-retained"),
    ]));
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      serialize([
        ...rolloutRows([200], {
          baseTimestamp: "2026-08-21T10:00:00.000Z",
          usedPercent: 58,
        }),
        shellCall("2026-08-21T10:01:00.000Z", "call-archive-retained"),
      ]),
    );

    const initial = await collectUsage(options(fixture));
    await copyFile(archivedFile, replacement);
    await rename(replacement, archivedFile);

    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const retainedAfterActiveOnly = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    await rm(archivedFile);
    const afterArchivedDeletion = await collectUsage(options(fixture));
    const activeOnlyAfterDeletion = await collectUsage(options(fixture, {
      includeArchived: false,
    }));

    assert.equal(totalTokens(initial), 300);
    assert.equal(initial.quotaObservations.length, 2);
    assert.equal(totalToolCalls(initial), 2);
    assert.equal(totalTokens(activeOnly), 100);
    assert.equal(activeOnly.quotaObservations.length, 1);
    assert.equal(totalToolCalls(activeOnly), 1);
    assert.equal(
      retainedAfterActiveOnly.usageRows.reduce(
        (sum, row) => sum + row.totalTokens,
        0,
      ),
      300,
    );
    assert.equal(retainedAfterActiveOnly.quotaRows.length, 2);
    assert.equal(retainedAfterActiveOnly.toolRows.length, 2);
    assert.equal(totalTokens(afterArchivedDeletion), 300);
    assert.equal(afterArchivedDeletion.quotaObservations.length, 2);
    assert.equal(totalToolCalls(afterArchivedDeletion), 2);
    assert.equal(totalTokens(activeOnlyAfterDeletion), 100);
    assert.equal(activeOnlyAfterDeletion.quotaObservations.length, 1);
    assert.equal(totalToolCalls(activeOnlyAfterDeletion), 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("full refresh reconciles an archive replaced during active-only tracking", async () => {
  const fixture = await createFixture([]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  const replacement = resolve(fixture.root, "smaller-archive.jsonl");
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(archivedFile, serialize([
      ...rolloutRows([100, 150], { usedPercent: 37 }),
      shellCall("2026-08-20T10:02:00.000Z", "call-old-archive-one"),
      shellCall("2026-08-20T10:03:00.000Z", "call-old-archive-two"),
    ]));
    await rm(fixture.file);
    const initial = await collectUsage(options(fixture));

    await writeFile(replacement, serialize([
      ...rolloutRows([200], { usedPercent: 58 }),
      shellCall("2026-08-20T10:01:00.000Z", "call-new-archive"),
    ]));
    assert.equal(
      (await stat(replacement)).size < (await stat(archivedFile)).size,
      true,
    );
    await rename(replacement, archivedFile);

    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const retainedBeforeRescan = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    const rescanned = await collectUsage(options(fixture));
    const reconciled = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    await rm(archivedFile);
    const afterDeletion = await collectUsage(options(fixture));

    assert.equal(totalTokens(initial), 250);
    assert.equal(initial.quotaObservations[0].usedPercent, 37);
    assert.equal(totalToolCalls(initial), 2);
    assert.equal(totalTokens(activeOnly), 0);
    assert.equal(activeOnly.quotaObservations.length, 0);
    assert.equal(totalToolCalls(activeOnly), 0);
    assert.equal(
      retainedBeforeRescan.usageRows.reduce(
        (sum, row) => sum + row.totalTokens,
        0,
      ),
      250,
    );
    assert.equal(retainedBeforeRescan.quotaRows[0].usedPercent, 37);
    assert.equal(retainedBeforeRescan.toolRows.length, 2);
    assert.equal(totalTokens(rescanned), 200);
    assert.equal(rescanned.quotaObservations.length, 1);
    assert.equal(rescanned.quotaObservations[0].usedPercent, 58);
    assert.equal(totalToolCalls(rescanned), 1);
    assert.equal(reconciled.usageRows.length, 1);
    assert.equal(reconciled.quotaRows.length, 1);
    assert.equal(reconciled.toolRows.length, 1);
    assert.equal(reconciled.sourceSummary.states[0].changeCount, 1);
    assert.equal(totalTokens(afterDeletion), 200);
    assert.equal(afterDeletion.quotaObservations[0].usedPercent, 58);
    assert.equal(totalToolCalls(afterDeletion), 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active move reconciles an archive replaced during active-only tracking", async () => {
  const fixture = await createFixture([]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "20",
  );
  const archivedFile = resolve(archivedDirectory, ROLLOUT_NAME);
  const replacement = resolve(fixture.root, "smaller-active-move.jsonl");
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(archivedFile, serialize([
      ...rolloutRows([100, 150], { usedPercent: 37 }),
      shellCall("2026-08-20T10:02:00.000Z", "call-old-before-move-one"),
      shellCall("2026-08-20T10:03:00.000Z", "call-old-before-move-two"),
    ]));
    await rm(fixture.file);
    await collectUsage(options(fixture));

    await writeFile(replacement, serialize([
      ...rolloutRows([200], { usedPercent: 58 }),
      shellCall("2026-08-20T10:01:00.000Z", "call-new-after-move"),
    ]));
    await rename(replacement, archivedFile);
    const activeOnlyBeforeMove = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    await rename(archivedFile, fixture.file);

    const rescanned = await collectUsage(options(fixture));
    const activeOnlyAfterMove = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(activeOnlyBeforeMove), 0);
    assert.equal(activeOnlyBeforeMove.quotaObservations.length, 0);
    assert.equal(totalToolCalls(activeOnlyBeforeMove), 0);
    assert.equal(totalTokens(rescanned), 200);
    assert.equal(rescanned.quotaObservations[0].usedPercent, 58);
    assert.equal(totalToolCalls(rescanned), 1);
    assert.equal(totalTokens(activeOnlyAfterMove), 200);
    assert.equal(activeOnlyAfterMove.quotaObservations[0].usedPercent, 58);
    assert.equal(totalToolCalls(activeOnlyAfterMove), 1);
    assert.equal(ledger.usageRows.length, 1);
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(ledger.toolRows.length, 1);
    assert.equal(ledger.sourceSummary.states[0].location, "active");
    assert.equal(ledger.sourceSummary.states[0].changeCount, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("uncertain replacement is evidence-only until a clean rescan", async () => {
  const fixture = await createFixture([100, 150], { usedPercent: 37 });
  const replacement = resolve(fixture.root, "uncertain-replacement.jsonl");
  const recovered = resolve(fixture.root, "recovered-replacement.jsonl");
  const validReplacementRows = [
    ...rolloutRows([200], { usedPercent: 58 }),
    shellCall("2026-08-20T10:01:00.000Z", "call-new-after-parse-error"),
  ];
  try {
    await appendFile(fixture.file, serialize([
      shellCall("2026-08-20T10:02:00.000Z", "call-old-before-error-one"),
      shellCall("2026-08-20T10:03:00.000Z", "call-old-before-error-two"),
    ]));
    const initial = await collectUsage(options(fixture));

    await writeFile(
      replacement,
      `${serialize(validReplacementRows)}{"type":"event_msg","payload":{"type":"token_count"\n`,
    );
    await rename(replacement, fixture.file);
    const uncertain = await collectUsage(options(fixture));
    const retained = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    await writeFile(recovered, serialize(validReplacementRows));
    await rename(recovered, fixture.file);
    const clean = await collectUsage(options(fixture));
    const reconciled = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(initial), 250);
    assert.equal(initial.quotaObservations.length, 1);
    assert.equal(totalToolCalls(initial), 2);
    assert.equal(uncertain.coverage.parseErrors, 1);
    assert.equal(totalTokens(uncertain), 250);
    assert.deepEqual(
      uncertain.quotaObservations.map((quota) => quota.usedPercent).sort(),
      [37],
    );
    assert.equal(totalToolCalls(uncertain), 2);
    assert.equal(
      retained.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      250,
    );
    assert.equal(retained.quotaRows.length, 1);
    assert.equal(retained.toolRows.length, 2);
    assert.equal(retained.sourceSummary.states[0].reconciliationPending, true);
    assert.equal(totalTokens(afterRemoval), 250);
    assert.equal(afterRemoval.quotaObservations.length, 1);
    assert.equal(totalToolCalls(afterRemoval), 2);
    assert.equal(clean.coverage.parseErrors, 0);
    assert.equal(totalTokens(clean), 200);
    assert.deepEqual(
      clean.quotaObservations.map((quota) => quota.usedPercent),
      [58],
    );
    assert.equal(totalToolCalls(clean), 1);
    assert.equal(reconciled.usageRows.length, 1);
    assert.equal(reconciled.quotaRows.length, 1);
    assert.equal(reconciled.toolRows.length, 1);
    assert.equal(
      reconciled.sourceSummary.states[0].reconciliationPending,
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("invalid-token uncertainty is scoped to its replaced source", async () => {
  const fixture = await createFixture([100, 150], { usedPercent: 37 });
  const secondFile = resolve(
    fixture.root,
    "sessions",
    "2026",
    "08",
    "20",
    SHARED_ROLLOUT_NAME,
  );
  const firstReplacement = resolve(fixture.root, "invalid-first-source.jsonl");
  const secondReplacement = resolve(fixture.root, "valid-second-source.jsonl");
  const recoveredFirst = resolve(fixture.root, "valid-first-source.jsonl");
  const invalidToken = tokenCount("2026-08-20T10:02:01.000Z", 500, 58);
  invalidToken.payload.info.last_token_usage.total_tokens = "invalid";
  try {
    await appendFile(fixture.file, serialize([
      shellCall("2026-08-20T10:02:00.000Z", "call-first-old-one"),
      shellCall("2026-08-20T10:03:00.000Z", "call-first-old-two"),
    ]));
    await writeFile(secondFile, serialize([
      ...rolloutRows([300, 350], { offset: 10, usedPercent: 45 }),
      shellCall("2026-08-20T10:12:00.000Z", "call-second-old-one"),
      shellCall("2026-08-20T10:13:00.000Z", "call-second-old-two"),
    ]));
    const initial = await collectUsage(options(fixture));

    await writeFile(firstReplacement, serialize([
      ...rolloutRows([200], { usedPercent: 58 }),
      shellCall("2026-08-20T10:01:00.000Z", "call-first-uncertain"),
      ...turnStart("2026-08-20T10:02:00.000Z", "invalid-turn"),
      invalidToken,
    ]));
    await writeFile(secondReplacement, serialize([
      ...rolloutRows([400], { offset: 10, usedPercent: 67 }),
      shellCall("2026-08-20T10:11:00.000Z", "call-second-valid"),
    ]));
    await rename(firstReplacement, fixture.file);
    await rename(secondReplacement, secondFile);
    const sourceScoped = await collectUsage(options(fixture));

    await writeFile(recoveredFirst, serialize([
      ...rolloutRows([250], { usedPercent: 59 }),
      shellCall("2026-08-20T10:01:00.000Z", "call-first-recovered"),
    ]));
    await rename(recoveredFirst, fixture.file);
    const recovered = await collectUsage(options(fixture));

    assert.equal(totalTokens(initial), 900);
    assert.equal(totalToolCalls(initial), 4);
    assert.equal(sourceScoped.coverage.invalidTokenRecords, 1);
    assert.equal(totalTokens(sourceScoped), 650);
    assert.deepEqual(
      sourceScoped.quotaObservations
        .map((quota) => quota.usedPercent)
        .sort((left, right) => left - right),
      [37, 67],
    );
    assert.equal(totalToolCalls(sourceScoped), 3);
    assert.equal(recovered.coverage.invalidTokenRecords, 0);
    assert.equal(totalTokens(recovered), 650);
    assert.deepEqual(
      recovered.quotaObservations
        .map((quota) => quota.usedPercent)
        .sort((left, right) => left - right),
      [59, 67],
    );
    assert.equal(totalToolCalls(recovered), 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("same-inode uncertain scans cannot overwrite positional usage", async () => {
  const fixture = await createFixture([100, 150]);
  const invalidToken = tokenCount("2026-08-20T10:02:01.000Z", 500);
  invalidToken.payload.info.last_token_usage.total_tokens = "invalid";
  try {
    const initial = await collectUsage(options(fixture));
    const before = await stat(fixture.file);
    await writeFile(fixture.file, serialize([
      ...rolloutRows([50]),
      ...turnStart("2026-08-20T10:02:00.000Z", "invalid-turn"),
      invalidToken,
      {
        timestamp: "2026-08-20T10:03:00.000Z",
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

    const uncertain = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(initial), 250);
    assert.equal(uncertain.coverage.invalidTokenRecords, 1);
    assert.equal(totalTokens(uncertain), 250);
    assert.equal(totalTokens(afterRemoval), 250);
    assert.deepEqual(
      ledger.usageRows.map((row) => row.totalTokens).sort((a, b) => a - b),
      [100, 150],
    );
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("uncertain scans cannot clear prior tool ownership", async () => {
  const fixture = await createFixture([100]);
  try {
    await appendFile(fixture.file, serialize([
      shellCall("2026-08-20T10:01:00.000Z", "call-before-uncertainty"),
    ]));
    const initial = await collectUsage(options(fixture));
    const before = await stat(fixture.file);
    await writeFile(
      fixture.file,
      `${serialize(rolloutRows([50]))}{"type":"response_item","payload":{"type":"function_call"\n`,
    );
    const after = await stat(fixture.file);
    assert.equal(after.ino, before.ino);

    const uncertain = await collectUsage(options(fixture));
    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(initial), 100);
    assert.equal(totalToolCalls(initial), 1);
    assert.equal(uncertain.coverage.parseErrors, 1);
    assert.equal(totalTokens(uncertain), 100);
    assert.equal(totalToolCalls(uncertain), 1);
    assert.equal(totalTokens(afterRemoval), 100);
    assert.equal(totalToolCalls(afterRemoval), 1);
    assert.equal(ledger.toolRows.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("deferred replacement reconciles after a clean append", async () => {
  const fixture = await createFixture([100, 150], { usedPercent: 37 });
  const replacement = resolve(fixture.root, "deferred-replacement.jsonl");
  const validRows = [
    ...rolloutRows([200], { usedPercent: 58 }),
    shellCall("2026-08-20T10:01:00.000Z", "call-after-recovery"),
  ];
  try {
    await appendFile(fixture.file, serialize([
      shellCall("2026-08-20T10:02:00.000Z", "call-old-one"),
      shellCall("2026-08-20T10:03:00.000Z", "call-old-two"),
    ]));
    await collectUsage(options(fixture));

    await writeFile(
      replacement,
      `${serialize(validRows)}{"type":"event_msg","payload":{"type":"user_message","message":"`,
    );
    await rename(replacement, fixture.file);
    const uncertain = await collectUsage(options(fixture));
    let ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    assert.equal(totalTokens(uncertain), 250);
    assert.equal(ledger.sourceSummary.states[0].changeCount, 1);
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);

    await appendFile(fixture.file, `completed"}}\n`);
    const recovered = await collectUsage(options(fixture));
    ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(recovered.coverage.parseErrors, 0);
    assert.equal(totalTokens(recovered), 200);
    assert.deepEqual(
      recovered.quotaObservations.map((quota) => quota.usedPercent),
      [58],
    );
    assert.equal(totalToolCalls(recovered), 1);
    assert.equal(ledger.usageRows.length, 1);
    assert.equal(ledger.quotaRows.length, 1);
    assert.equal(ledger.toolRows.length, 1);
    assert.equal(ledger.sourceSummary.states[0].changeCount, 1);
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("pending reconciliation survives truncation lifecycle tracking and tombstone", async () => {
  const fixture = await createFixture([100]);
  const replacement = resolve(fixture.root, "uncertain-replacement.jsonl");
  const archived = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    ROLLOUT_NAME,
  );
  const ledgerPath = resolveDurableLedgerPath({
    stateDirectory: fixture.stateDirectory,
  });
  try {
    await collectUsage(options(fixture));
    await writeFile(
      replacement,
      `${serialize(rolloutRows([200]))}{"type":"event_msg","payload":\n`,
    );
    await rename(replacement, fixture.file);
    await collectUsage(options(fixture));
    let ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);

    await writeFile(fixture.file, serialize(rolloutRows([200])));
    await collectUsage(options(fixture));
    ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].changeState, "truncated");
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);

    await mkdir(resolve(archived, ".."), { recursive: true });
    await rename(fixture.file, archived);
    await collectUsage(options(fixture, { includeArchived: false }));
    ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].location, "archived");
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);

    await rm(archived);
    await collectUsage(options(fixture));
    ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].status, "tombstoned");
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("pending reconciliation survives a missing zero-observation source", async () => {
  const fixture = await createFixture([]);
  const replacement = resolve(fixture.root, "uncertain-empty-replacement.jsonl");
  const ledgerPath = resolveDurableLedgerPath({
    stateDirectory: fixture.stateDirectory,
  });
  try {
    await collectUsage(options(fixture));
    await writeFile(
      replacement,
      `{"type":"event_msg","payload":{"type":"token_count"\n`,
    );
    await rename(replacement, fixture.file);
    await collectUsage(options(fixture));
    let ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].observedEventCount, 0);
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);

    await rm(fixture.file);
    await collectUsage(options(fixture));
    ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].status, "missing");
    assert.equal(ledger.sourceSummary.states[0].reconciliationPending, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only lifecycle keeps simultaneous active and archived copies distinct", async () => {
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
    await collectUsage(options(fixture));
    await mkdir(archivedDirectory, { recursive: true });
    await copyFile(fixture.file, archivedFile);

    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const allSources = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(activeOnly), 100);
    assert.equal(totalTokens(allSources), 100);
    assert.equal(ledger.sourceSummary.states.length, 2);
    assert.deepEqual(
      ledger.sourceSummary.states.map((state) => state.location).sort(),
      ["active", "archived"],
    );
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

test("true append after atomic replacement does not count another replacement", async () => {
  const fixture = await createFixture([100]);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  try {
    await collectUsage(options(fixture));
    await writeFile(replacement, serialize(rolloutRows([200])));
    await rename(replacement, fixture.file);
    const replaced = await collectUsage(options(fixture));

    await appendFile(
      fixture.file,
      serialize(rolloutRows([300], { offset: 1 })),
    );
    const appended = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(replaced), 200);
    assert.equal(totalTokens(appended), 500);
    assert.equal(ledger.usageRows.length, 2);
    assert.equal(ledger.sourceSummary.states.length, 1);
    assert.equal(ledger.sourceSummary.states[0].changeCount, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("move plus same-inode rewrite reconciles as a replacement", async () => {
  const fixture = await createFixture([100, 200]);
  const archived = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    ROLLOUT_NAME,
  );
  try {
    await collectUsage(options(fixture));
    const before = await stat(fixture.file);
    await mkdir(resolve(archived, ".."), { recursive: true });
    await rename(fixture.file, archived);
    await writeFile(archived, serialize(rolloutRows([300])));
    const after = await stat(archived);
    assert.equal(after.ino, before.ino);
    assert.ok(after.size < before.size);

    const rewritten = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );
    assert.equal(totalTokens(rewritten), 300);
    assert.equal(ledger.usageRows.length, 1);
    assert.equal(ledger.sourceSummary.states[0].location, "archived");
    assert.equal(ledger.sourceSummary.states[0].changeCount, 1);
    assert.equal(ledger.sourceSummary.states[0].changeState, "replaced");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("forced reconciliation removes stale positions for shared observations", async () => {
  const fixture = await createFixture([100, 200]);
  const sharedFile = resolve(fixture.file, "..", SHARED_ROLLOUT_NAME);
  const replacement = resolve(fixture.root, "replacement.jsonl");
  const ledgerPath = resolveDurableLedgerPath({
    stateDirectory: fixture.stateDirectory,
  });
  let database;
  try {
    await writeFile(sharedFile, await readFile(fixture.file));
    await collectUsage(options(fixture));
    const originalInode = (await stat(fixture.file)).ino;
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const activeSourceId = String(database.prepare(`
      SELECT source_id AS sourceId
        FROM source_state
       WHERE inode = ?
    `).get(originalInode).sourceId);
    database.close();
    database = null;

    await writeFile(replacement, serialize(rolloutRows([300])));
    await rename(replacement, fixture.file);
    const replaced = await collectUsage(options(fixture));

    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const replacedPositions = database.prepare(`
      SELECT event_ordinal AS eventOrdinal
        FROM source_event_positions
       WHERE source_id = ?
       ORDER BY event_ordinal
    `).all(activeSourceId);
    const retainedSharedUsage = database.prepare(`
      SELECT COUNT(*) AS count
        FROM usage_observations
       WHERE total_tokens IN (100, 200)
    `).get().count;

    assert.equal(totalTokens(replaced), 600);
    assert.equal(replacedPositions.length, 1);
    assert.equal(retainedSharedUsage, 2);
  } finally {
    try {
      database?.close();
    } catch {
      // Fixture cleanup remains authoritative.
    }
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
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.equal(totalTokens(replaced), 300);
    assert.equal(totalTokens(afterRemoval), 300);
    assert.equal(replaced.coverage.sourceIncomplete, true);
    assert.equal(replaced.coverage.sourceStates.changed, 1);
    assert.equal(ledger.sourceSummary.states[0].changeState, "replaced");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("metadata-only touches with identical content remain stable", async () => {
  const fixture = await createFixture([100]);
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const touchedAt = new Date(Date.now() + 2_000);
    await utimes(fixture.file, touchedAt, touchedAt);

    const touched = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(totalTokens(touched), 100);
    assert.equal(touched.coverage.sourceIncomplete, false);
    assert.equal(touched.coverage.sourceStates.changed, 0);
    assert.equal(ledger.sourceSummary.states[0].changeState, "stable");
    assert.equal(ledger.sourceSummary.states[0].changeCount, 0);
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

test("source changes after final validation restore the committed attempt", async () => {
  const fixture = await createFixture([100]);
  let changed = false;
  let observedCommittedCandidate = false;
  let observedRestoredBaseline = false;
  try {
    const initial = await collectUsage(options(fixture));
    await writePrivateSnapshot(fixture.output, initial);
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    const snapshot = await collectUsage(options(fixture, {
      stageSnapshot: (candidate) =>
        stagePrivateSnapshot(fixture.output, candidate),
      faultInjector: async ({ point, path }) => {
        if (
          point === "before-commit" &&
          changed &&
          observedCommittedCandidate &&
          !observedRestoredBaseline
        ) {
          const database = new DatabaseSync(path, { readOnly: true });
          try {
            assert.equal(
              Number(database.prepare(
                "SELECT value FROM ledger_meta WHERE key = 'revision'",
              ).get().value),
              1,
            );
            assert.equal(
              database.prepare(
                "SELECT SUM(total_tokens) AS total FROM usage_observations",
              ).get().total,
              100,
            );
          } finally {
            database.close();
          }
          const storedDuringRetry = await readPrivateSnapshot(fixture.output);
          assert.equal(totalTokens(storedDuringRetry), 100);
          assert.equal(storedDuringRetry.metadata.durableLedger.revision, 1);
          observedRestoredBaseline = true;
        }
        if (point === "after-final-validation" && !changed) {
          changed = true;
          await writeFile(fixture.file, serialize(rolloutRows([100])));
        }
        if (
          point === "after-sqlite-commit" &&
          changed &&
          !observedCommittedCandidate
        ) {
          const database = new DatabaseSync(path, { readOnly: true });
          try {
            assert.equal(
              Number(database.prepare(
                "SELECT value FROM ledger_meta WHERE key = 'revision'",
              ).get().value),
              2,
            );
            assert.equal(
              database.prepare(
                "SELECT SUM(total_tokens) AS total FROM usage_observations",
              ).get().total,
              300,
            );
          } finally {
            database.close();
          }
          observedCommittedCandidate = true;
        }
      },
    }));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const ledger = await readDurableLedger(ledgerPath);
    const stored = await readPrivateSnapshot(fixture.output);

    assert.equal(changed, true);
    assert.equal(observedCommittedCandidate, true);
    assert.equal(observedRestoredBaseline, true);
    assert.equal(totalTokens(snapshot), 100);
    assert.equal(totalTokens(stored), 100);
    assert.equal(snapshot.metadata.durableLedger.revision, 2);
    assert.equal(stored.metadata.durableLedger.revision, 2);
    assert.equal(await readDurableLedgerRevision(ledgerPath), 2);
    assert.deepEqual(ledger.usageRows.map((row) => row.totalTokens), [100]);
    assert.deepEqual(
      (await readdir(fixture.stateDirectory)).filter((name) =>
        name.startsWith(".token-ledger-rollback-")
      ),
      [],
    );

    await rm(fixture.file);
    const afterRemoval = await collectUsage(options(fixture));
    assert.equal(totalTokens(afterRemoval), 100);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a renamed recovery marker retains its backup if activation fails", async () => {
  const fixture = await createFixture([100]);
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const artifacts = recoveryArtifactPaths(ledgerPath);
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    await assert.rejects(
      () => collectUsage(options(fixture, {
        faultInjector: ({ point }) => {
          if (point === "after-recovery-marker-rename") {
            throw new Error("injected marker activation failure");
          }
        },
      })),
      /injected marker activation failure/,
    );
    assert.equal((await stat(artifacts.marker)).mode & 0o777, 0o600);
    assert.equal((await stat(artifacts.backup)).mode & 0o777, 0o600);

    const recovered = await readDurableLedger(ledgerPath);
    assert.equal(recovered.revision, 1);
    assert.deepEqual(recovered.usageRows.map((row) => row.totalTokens), [100]);
    await assert.rejects(stat(artifacts.marker), { code: "ENOENT" });
    await assert.rejects(stat(artifacts.backup), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recovery staging refuses a raced symlink without clobbering its target", async () => {
  const fixture = await createFixture([100]);
  const ledgerPath = resolveDurableLedgerPath({
    stateDirectory: fixture.stateDirectory,
  });
  const backupTemporary = `${ledgerPath}.recovery.prepare`;
  const victim = resolve(fixture.root, "symlink-victim.txt");
  try {
    await writeFile(victim, "keep this content\n", { mode: 0o600 });
    await assert.rejects(
      () => collectUsage(options(fixture, {
        faultInjector: async ({ point }) => {
          if (point === "before-recovery-backup-copy") {
            await symlink(victim, backupTemporary);
          }
        },
      })),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(await readFile(victim, "utf8"), "keep this content\n");
    await assert.rejects(lstat(backupTemporary), { code: "ENOENT" });

    const recovered = await collectUsage(options(fixture));
    assert.equal(totalTokens(recovered), 100);
    assert.equal(await readDurableLedgerRevision(ledgerPath), 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("direct reads recover process crashes before and after commit", async () => {
  const fixture = await createFixture([100]);
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const artifacts = recoveryArtifactPaths(ledgerPath);
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    crashCollection(fixture, "after-recovery-marker");
    assert.equal((await stat(artifacts.marker)).mode & 0o777, 0o600);
    assert.equal((await stat(artifacts.backup)).mode & 0o777, 0o600);

    const recovered = await readDurableLedger(ledgerPath);
    assert.equal(recovered.revision, 1);
    assert.deepEqual(recovered.usageRows.map((row) => row.totalTokens), [100]);
    await assert.rejects(stat(artifacts.marker), { code: "ENOENT" });
    await assert.rejects(stat(artifacts.backup), { code: "ENOENT" });

    crashCollection(fixture, "after-sqlite-commit");
    const recoveredAfterCommit = await readDurableLedger(ledgerPath);
    assert.equal(recoveredAfterCommit.revision, 1);
    assert.deepEqual(
      recoveredAfterCommit.usageRows.map((row) => row.totalTokens),
      [100],
    );
    await assert.rejects(stat(artifacts.marker), { code: "ENOENT" });
    await assert.rejects(stat(artifacts.backup), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recovery is repeatable after commit and a crash during restore", async () => {
  const fixture = await createFixture([100]);
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const artifacts = recoveryArtifactPaths(ledgerPath);
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    crashCollection(fixture, "after-sqlite-commit");
    crashCollection(fixture, "after-recovery-ledger-replace", true);
    await stat(artifacts.marker);
    await stat(artifacts.backup);

    const recovered = await readDurableLedger(ledgerPath);
    assert.equal(recovered.revision, 1);
    assert.deepEqual(recovered.usageRows.map((row) => row.totalTokens), [100]);
    const refreshed = await collectUsage(options(fixture));
    assert.equal(totalTokens(refreshed), 300);
    assert.equal(await readDurableLedgerRevision(ledgerPath), 2);
    await assert.rejects(stat(artifacts.marker), { code: "ENOENT" });
    await assert.rejects(stat(artifacts.backup), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing, corrupt, or linked recovery backups fail closed", async () => {
  for (const damage of ["missing", "corrupt", "symlink"]) {
    const fixture = await createFixture([100]);
    try {
      await collectUsage(options(fixture));
      const ledgerPath = resolveDurableLedgerPath({
        stateDirectory: fixture.stateDirectory,
      });
      const artifacts = recoveryArtifactPaths(ledgerPath);
      await appendFile(
        fixture.file,
        serialize(rolloutRows([200], { offset: 1 })),
      );
      crashCollection(fixture, "after-sqlite-commit");
      if (damage === "missing") await rm(artifacts.backup);
      else if (damage === "corrupt") {
        await writeFile(artifacts.backup, "not a SQLite recovery backup");
      } else {
        await rm(artifacts.backup);
        await symlink(ledgerPath, artifacts.backup);
      }

      await assert.rejects(
        () => readDurableLedger(ledgerPath),
        (error) => error?.code === "ERR_DURABLE_LEDGER_RECOVERY",
      );
      assert.equal(await readDurableLedgerRevision(ledgerPath), null);
      await stat(artifacts.marker);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("staged cleanup errors do not mask committed-attempt failures", async () => {
  const fixture = await createFixture([100]);
  try {
    await collectUsage(options(fixture));
    await appendFile(
      fixture.file,
      serialize(rolloutRows([200], { offset: 1 })),
    );

    await assert.rejects(
      () => collectUsage(options(fixture, {
        stageSnapshot: async (snapshot) => ({
          snapshot,
          publish: async () => {},
          discard: async () => {
            throw new Error("injected staged cleanup failure");
          },
        }),
        faultInjector: ({ point }) => {
          if (point === "after-sqlite-commit") {
            throw new Error("injected authoritative commit failure");
          }
        },
      })),
      (error) => {
        assert.equal(error?.message, "injected authoritative commit failure");
        assert.deepEqual(
          error?.cleanupErrors?.map((cleanup) => cleanup.message),
          ["injected staged cleanup failure"],
        );
        return true;
      },
    );
    const ledger = await readDurableLedger(resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    }));
    assert.equal(ledger.revision, 1);
    assert.deepEqual(ledger.usageRows.map((row) => row.totalTokens), [100]);
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
      PRAGMA user_version = 3;
    `);
    database.close();
    database = null;

    await assert.rejects(
      () => collectUsage(options(fixture)),
      (error) => error?.code === "ERR_DURABLE_LEDGER_SCHEMA",
    );

    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 3);
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

test("v2 ledgers add reconciliation state without breaking read-only access", async () => {
  const fixture = await createFixture([100]);
  const ledgerPath = resolveDurableLedgerPath({
    stateDirectory: fixture.stateDirectory,
  });
  let database;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    database.exec("ALTER TABLE source_state DROP COLUMN reconciliation_pending");
    database.close();
    database = null;

    const legacyV2 = await readDurableLedger(ledgerPath);
    assert.equal(legacyV2.sourceSummary.states[0].reconciliationPending, false);
    await collectUsage(options(fixture));

    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const columns = database.prepare("PRAGMA table_info(source_state)").all()
      .map((column) => String(column.name));
    assert(columns.includes("reconciliation_pending"));
  } finally {
    try {
      database?.close();
    } catch {
      // Fixture cleanup remains authoritative.
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source identity compares device and inode as one pair", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-device-identity-"));
  const stateDirectory = resolve(root, "private-state");
  const sourcePath = resolve(root, "sessions", ROLLOUT_NAME);
  const ledgerPath = resolveDurableLedgerPath({ stateDirectory });
  const source = ({
    device,
    inode = 17,
    size,
    cursorFingerprint,
    continuityBytes = null,
    continuityFingerprint = null,
  }) => ({
    path: sourcePath,
    sourceId: "synthetic-device-source",
    location: "active",
    size,
    mtimeMs: size,
    ctimeMs: size,
    dev: device,
    ino: inode,
    cursorBytes: size,
    cursorFingerprint,
    continuityBytes,
    continuityFingerprint,
  });
  const update = async (entry) => updateDurableLedger({
    options: { stateDirectory },
    codexHome: root,
    inventory: { files: [entry], lifecycleFiles: [entry] },
    includeArchived: true,
  });
  try {
    await update(source({
      device: 1,
      size: 100,
      cursorFingerprint: "a".repeat(64),
    }));
    await update(source({
      device: 2,
      size: 100,
      cursorFingerprint: "b".repeat(64),
    }));
    let ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].changeState, "replaced");
    assert.equal(ledger.sourceSummary.states[0].changeCount, 1);

    await rm(stateDirectory, { recursive: true, force: true });
    await update(source({
      device: 3,
      size: 100,
      cursorFingerprint: "c".repeat(64),
    }));
    await update(source({
      device: 3,
      size: 120,
      cursorFingerprint: "d".repeat(64),
      continuityBytes: 100,
      continuityFingerprint: "c".repeat(64),
    }));
    ledger = await readDurableLedger(ledgerPath);
    assert.equal(ledger.sourceSummary.states[0].changeState, "stable");
    assert.equal(ledger.sourceSummary.states[0].changeCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed legacy snapshots preserve the one-shot migration retry", async () => {
  const fixture = await createFixture([]);
  const legacySnapshotPath = resolve(fixture.root, "exports", "snapshot.json");
  const ledgerPath = resolveDurableLedgerPath({
    stateDirectory: fixture.stateDirectory,
  });
  const malformed = Buffer.from("{not-json\n", "utf8");
  const generatedAt = "2026-08-20T12:00:00.000Z";
  let database;
  try {
    await mkdir(dirname(legacySnapshotPath), { recursive: true });
    await writeFile(legacySnapshotPath, malformed);
    await assert.rejects(
      () => collectUsage(options(fixture, { output: legacySnapshotPath })),
      (error) => {
        assert.equal(error?.code, "ERR_DURABLE_LEDGER_LEGACY_SNAPSHOT");
        assert.ok(error.cause instanceof SyntaxError);
        return true;
      },
    );
    assert.deepEqual(await readFile(legacySnapshotPath), malformed);
    assert.equal(await readDurableLedgerRevision(ledgerPath), 0);
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare(
      "SELECT value FROM ledger_meta WHERE key = 'legacy_snapshot_checked'",
    ).get(), undefined);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM migration_runs",
    ).get().count, 0);
    database.close();
    database = null;

    const validLegacy = legacySnapshotForFixture(fixture, {
      schemaVersion: 3,
      generatedAt,
      events: [{
        timestamp: generatedAt,
        startAt: generatedAt,
        endAt: generatedAt,
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
        threadIds: ["legacy-retry-thread"],
      }],
    });
    await writePrivateSnapshot(legacySnapshotPath, validLegacy);
    const first = await collectUsage(options(fixture, {
      output: legacySnapshotPath,
    }));
    const second = await collectUsage(options(fixture, {
      output: legacySnapshotPath,
    }));
    const ledger = await readDurableLedger(ledgerPath);
    database = new DatabaseSync(ledgerPath, { readOnly: true });

    assert.equal(totalTokens(first), 100);
    assert.equal(totalTokens(second), 100);
    assert.equal(first.metadata.durableLedger.revision, 1);
    assert.equal(second.metadata.durableLedger.revision, 2);
    assert.equal(ledger.migratedUsageRows, 1);
    assert.equal(database.prepare(
      "SELECT value FROM ledger_meta WHERE key = 'legacy_snapshot_checked'",
    ).get().value, "1");
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM migration_runs",
    ).get().count, 1);
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("readable non-v3 legacy snapshots remain retryable hard failures", async () => {
  const fixture = await createFixture([]);
  const legacySnapshotPath = resolve(fixture.root, "exports", "snapshot.json");
  const ledgerPath = resolveDurableLedgerPath({
    stateDirectory: fixture.stateDirectory,
  });
  let database;
  try {
    await mkdir(dirname(legacySnapshotPath), { recursive: true });
    await writeFile(legacySnapshotPath, JSON.stringify({
      schemaVersion: 4,
      events: [],
    }));
    await assert.rejects(
      () => collectUsage(options(fixture, { output: legacySnapshotPath })),
      (error) => {
        assert.equal(error?.code, "ERR_DURABLE_LEDGER_LEGACY_SNAPSHOT");
        assert.match(error.message, /unsupported schema/i);
        return true;
      },
    );
    assert.equal(await readDurableLedgerRevision(ledgerPath), 0);
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare(
      "SELECT value FROM ledger_meta WHERE key = 'legacy_snapshot_checked'",
    ).get(), undefined);
  } finally {
    database?.close();
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
    await writePrivateSnapshot(
      fixture.output,
      legacySnapshotForFixture(fixture, legacy),
    );
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
    await writePrivateSnapshot(
      fixture.output,
      legacySnapshotForFixture(fixture, legacy),
    );
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
    await writePrivateSnapshot(
      fixture.output,
      legacySnapshotForFixture(fixture, legacy),
    );
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
    await writePrivateSnapshot(
      fixture.output,
      legacySnapshotForFixture(fixture, legacy),
    );
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
    assert.equal(ledger.migration.collectionSince, null);
    assert.equal(ledger.migration.scopeKnown, true);
    assert.equal(ledger.migratedUsageRows, 1);
    assert.equal(ledger.migratedQuotaRows, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("active-only migration does not subtract unrelated archived exact usage", async () => {
  const fixture = await createFixture([]);
  const archivedDirectory = resolve(
    fixture.root,
    "archived_sessions",
    "2026",
    "08",
    "21",
  );
  const archivedFile = resolve(archivedDirectory, ARCHIVED_ROLLOUT_NAME);
  const timestamp = "2026-08-21T10:00:01.000Z";
  const legacy = legacySnapshotForFixture(fixture, {
    schemaVersion: 3,
    generatedAt: "2026-08-22T00:00:00.000Z",
    provenance: {
      collection: { since: null, includeArchived: false },
    },
    events: [{
      timestamp,
      startAt: timestamp,
      endAt: timestamp,
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
      threadIds: ["active-history-thread"],
    }],
  });
  try {
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      archivedFile,
      serialize(rolloutRows([100], {
        baseTimestamp: "2026-08-21T10:00:00.000Z",
      })),
    );
    await writePrivateSnapshot(fixture.output, legacy);

    const activeOnly = await collectUsage(options(fixture, {
      includeArchived: false,
    }));
    const full = await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const activeLedger = await readDurableLedger(ledgerPath, {
      includeArchived: false,
    });
    const fullLedger = await readDurableLedger(ledgerPath);

    assert.equal(totalTokens(activeOnly), 100);
    assert.equal(totalTokens(full), 200);
    assert.equal(
      activeLedger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      100,
    );
    assert.equal(
      fullLedger.usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
      200,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("legacy migration requires matching collection and Codex-home provenance", async () => {
  const fixture = await createFixture([]);
  const legacy = {
    schemaVersion: 3,
    generatedAt: "2026-08-20T12:00:00.000Z",
    provenance: {
      collection: { since: null, includeArchived: true },
    },
    events: [{
      timestamp: "2026-08-20T10:00:01.000Z",
      project: "unverified-history",
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
      callCount: 1,
      detailedCallCount: 1,
      inputCallCount: 1,
      breakdownAvailable: true,
    }],
  };
  let database;
  try {
    await writePrivateSnapshot(fixture.output, legacy);
    const snapshot = await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    const ledger = await readDurableLedger(ledgerPath);
    database = new DatabaseSync(ledgerPath, { readOnly: true });

    assert.equal(totalTokens(snapshot), 0);
    assert.equal(ledger.migration, null);
    assert.equal(ledger.legacySnapshotStatus, "codex-home-unverified");
    assert.equal(
      snapshot.coverage.legacySnapshotStatus,
      "codex-home-unverified",
    );
    assert.equal(
      snapshot.metadata.durableLedger.legacySnapshotStatus,
      "codex-home-unverified",
    );
    assert.equal(
      database.prepare(
        "SELECT value FROM ledger_meta WHERE key = 'legacy_snapshot_status'",
      ).get().value,
      "codex-home-unverified",
    );
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("collection cutoff slices migrated compacted ranges", async () => {
  const fixture = await createFixture([]);
  const legacy = {
    schemaVersion: 3,
    generatedAt: "2026-08-22T00:00:00.000Z",
    provenance: {
      collection: {
        since: "2026-08-20T00:00:00.000Z",
        includeArchived: true,
      },
    },
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
    await writePrivateSnapshot(
      fixture.output,
      legacySnapshotForFixture(fixture, legacy),
    );
    const snapshot = await collectUsage(options(fixture, {
      since: "2026-08-21T00:00:00.000Z",
    }));
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ stateDirectory: fixture.stateDirectory }),
    );

    assert.ok(Math.abs(totalTokens(snapshot) - 100) < 1e-6);
    assert.ok(Math.abs(snapshot.coverage.migratedCompactedTokens - 100) < 1e-6);
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].rangeAllocationEstimated, true);
    assert.equal(
      ledger.migration.collectionSince,
      "2026-08-20T00:00:00.000Z",
    );
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

test("unchanged compacted observations retain membership provenance", async () => {
  const fixture = await createFixture([100, 200], {
    baseTimestamp: "2015-08-20T10:00:00.000Z",
  });
  try {
    await collectUsage(options(fixture));
    const ledgerPath = resolveDurableLedgerPath({
      stateDirectory: fixture.stateDirectory,
    });
    let database = new DatabaseSync(ledgerPath, { readOnly: true });
    const before = database.prepare(`
      SELECT event_key AS eventKey, observation_id AS observationId,
             first_seen_at AS firstSeenAt
        FROM usage_compaction_membership
       ORDER BY event_key
    `).all();
    database.close();

    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const after = database.prepare(`
      SELECT event_key AS eventKey, observation_id AS observationId,
             first_seen_at AS firstSeenAt
        FROM usage_compaction_membership
       ORDER BY event_key
    `).all();
    const indexes = new Map([
      [
        "source_event_positions",
        "source_event_positions_observation",
      ],
      [
        "usage_compaction_membership",
        "usage_compaction_membership_observation",
      ],
      ["usage_sources", "usage_sources_source"],
      ["tool_sources", "tool_sources_source"],
      ["quota_sources", "quota_sources_source"],
    ]);
    for (const [table, indexName] of indexes) {
      const names = database.prepare(`PRAGMA index_list(${table})`).all()
        .map((row) => String(row.name));
      assert(names.includes(indexName), `${indexName} should index ${table}`);
    }
    database.close();

    assert.equal(before.length, 2);
    assert.deepEqual(after, before);
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

test("existing default private state directory is tightened to 0700", async () => {
  const fixture = await createFixture([100]);
  const defaultDirectory = resolve(fixture.root, ".token-ledger");
  const output = resolve(defaultDirectory, "token-ledger-snapshot-v3.json.gz");
  try {
    await mkdir(defaultDirectory, { recursive: true });
    await chmod(defaultDirectory, 0o755);
    await collectUsage(options(fixture, {
      output,
      stateDirectory: undefined,
      privateStateDirectory: true,
    }));

    assert.equal((await stat(defaultDirectory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(resolveDurableLedgerPath({ output }))).mode & 0o777,
      0o600,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("schema v1 upgrades transactionally and scrubs persisted private metadata", async () => {
  const fixture = await createFixture([100]);
  const cwdCanary = "/private/credential-path-canary";
  const remoteCanary = "https://user:secret@example.test/private.git";
  const sourceCanary = "/private/raw-source-canary.jsonl";
  const homeCanary = "/private/canonical-codex-home-canary";
  const ledgerPath = resolveDurableLedgerPath({
    stateDirectory: fixture.stateDirectory,
  });
  let database;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    database.exec(`
      DROP TABLE migration_runs;
      CREATE TABLE migration_runs (
        migration_key TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL,
        source_label TEXT NOT NULL,
        generated_at TEXT,
        migrated_at TEXT NOT NULL,
        usage_rows INTEGER NOT NULL,
        quota_rows INTEGER NOT NULL
      ) WITHOUT ROWID;
    `);
    database.prepare(`
      UPDATE usage_observations
         SET token_cwd = ?, token_git_origin = ?, token_raw_source = ?,
             origin_cwd = ?, origin_git_origin = ?, origin_raw_source = ?
    `).run(
      cwdCanary,
      remoteCanary,
      sourceCanary,
      cwdCanary,
      remoteCanary,
      sourceCanary,
    );
    database.prepare(`
      INSERT INTO ledger_meta(key, value) VALUES ('codex_home', ?)
    `).run(homeCanary);
    database.exec("PRAGMA user_version = 1");
    database.close();
    database = null;

    await collectUsage(options(fixture));

    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 2);
    const migrationColumns = new Set(database.prepare(
      "PRAGMA table_info(migration_runs)",
    ).all().map((column) => column.name));
    assert.equal(migrationColumns.has("collection_since"), true);
    assert.equal(migrationColumns.has("include_archived"), true);
    assert.equal(migrationColumns.has("scope_known"), true);
    assert.equal(migrationColumns.has("codex_home_fingerprint"), true);
    const persisted = database.prepare(`
      SELECT token_cwd AS tokenCwd, token_git_origin AS tokenGitOrigin,
             token_raw_source AS tokenRawSource, origin_cwd AS originCwd,
             origin_git_origin AS originGitOrigin,
             origin_raw_source AS originRawSource
        FROM usage_observations
       LIMIT 1
    `).get();
    assert.deepEqual({ ...persisted }, {
      tokenCwd: "",
      tokenGitOrigin: null,
      tokenRawSource: null,
      originCwd: null,
      originGitOrigin: null,
      originRawSource: null,
    });
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM ledger_meta WHERE key = 'codex_home'",
      ).get().count,
      0,
    );
    assert.match(
      database.prepare(
        "SELECT value FROM ledger_meta WHERE key = 'codex_home_fingerprint'",
      ).get().value,
      /^[0-9a-f]{64}$/,
    );
    database.close();
    database = null;

    const storedBytes = await readFile(ledgerPath, "utf8");
    for (const canary of [cwdCanary, remoteCanary, sourceCanary, homeCanary]) {
      assert.equal(storedBytes.includes(canary), false);
    }
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unscoped early-v1 migrated history is rejected without mutation", async () => {
  const fixture = await createFixture([100]);
  const ledgerPath = resolveDurableLedgerPath({
    stateDirectory: fixture.stateDirectory,
  });
  let database;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    database.exec(`
      DROP TABLE migration_runs;
      CREATE TABLE migration_runs (
        migration_key TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL,
        source_label TEXT NOT NULL,
        generated_at TEXT,
        migrated_at TEXT NOT NULL,
        usage_rows INTEGER NOT NULL,
        quota_rows INTEGER NOT NULL
      ) WITHOUT ROWID;
      INSERT INTO migration_runs (
        migration_key, source_fingerprint, source_label, generated_at,
        migrated_at, usage_rows, quota_rows
      ) VALUES (
        'snapshot-v3-default', 'legacy-fingerprint', 'legacy-snapshot',
        '2026-08-20T12:00:00.000Z', '2026-08-20T12:00:00.000Z', 1, 0
      );
      PRAGMA user_version = 1;
    `);
    database.close();
    database = null;
    const before = await readFile(ledgerPath);

    await assert.rejects(
      collectUsage(options(fixture)),
      (error) => {
        assert.equal(error?.code, "ERR_DURABLE_LEDGER_MIGRATION_SCOPE");
        assert.match(error.message, /ledger was left untouched/i);
        assert.match(error.message, /keep it as a backup/i);
        return true;
      },
    );

    assert.deepEqual(await readFile(ledgerPath), before);
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(
      new Set(database.prepare("PRAGMA table_info(migration_runs)").all()
        .map((column) => column.name)).has("include_archived"),
      false,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM migration_runs").get().count,
      1,
    );
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("scoped v1 migration records upgrade without changing exact totals", async () => {
  const fixture = await createFixture([100]);
  const ledgerPath = resolveDurableLedgerPath({
    stateDirectory: fixture.stateDirectory,
  });
  let database;
  try {
    await collectUsage(options(fixture));
    database = new DatabaseSync(ledgerPath);
    database.exec(`
      DROP TABLE migration_runs;
      CREATE TABLE migration_runs (
        migration_key TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL,
        source_label TEXT NOT NULL,
        generated_at TEXT,
        migrated_at TEXT NOT NULL,
        include_archived INTEGER NOT NULL,
        usage_rows INTEGER NOT NULL,
        quota_rows INTEGER NOT NULL
      ) WITHOUT ROWID;
      INSERT INTO migration_runs (
        migration_key, source_fingerprint, source_label, generated_at,
        migrated_at, include_archived, usage_rows, quota_rows
      ) VALUES (
        'snapshot-v3-default', 'legacy-fingerprint', 'legacy-snapshot',
        '2026-08-20T12:00:00.000Z', '2026-08-20T12:00:00.000Z', 0, 0, 0
      );
      PRAGMA user_version = 1;
    `);
    database.close();
    database = null;

    const snapshot = await collectUsage(options(fixture));
    const ledger = await readDurableLedger(ledgerPath);

    assert.equal(totalTokens(snapshot), 100);
    assert.equal(ledger.revision, 2);
    assert.equal(ledger.migration.includeArchived, false);
    assert.equal(ledger.migration.collectionSince, null);
    assert.equal(ledger.migration.scopeKnown, false);
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 2);
  } finally {
    database?.close();
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
  const cwdCanary = "/private/new-write-cwd-canary";
  const remoteCanary = "https://user:secret@example.test/new-write.git";
  const sourceCanary = "/private/new-write-source-canary.jsonl";
  let database;
  try {
    await writeFile(
      fixture.file,
      serialize([
        {
          timestamp: BASE_TIMESTAMP,
          type: "session_meta",
          payload: {
            id: THREAD_ID,
            source: sourceCanary,
            cwd: cwdCanary,
            git: { repository_url: remoteCanary },
          },
        },
        ...rolloutRows([100]),
        {
          timestamp: BASE_TIMESTAMP,
          type: "event_msg",
          payload: {
            type: "message",
            message: secretPrompt,
            cwd: fixture.root,
          },
        },
      ]),
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
    assert.equal(encoded.includes(cwdCanary), false);
    assert.equal(encoded.includes(remoteCanary), false);
    assert.equal(encoded.includes(sourceCanary), false);
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
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    const persisted = database.prepare(`
      SELECT token_cwd AS tokenCwd, token_git_origin AS tokenGitOrigin,
             token_raw_source AS tokenRawSource
        FROM usage_observations
       LIMIT 1
    `).get();
    assert.deepEqual({ ...persisted }, {
      tokenCwd: "",
      tokenGitOrigin: null,
      tokenRawSource: null,
    });
    database.close();
    database = null;
    const storedBytes = await readFile(ledgerPath, "utf8");
    assert.equal(storedBytes.includes(cwdCanary), false);
    assert.equal(storedBytes.includes(remoteCanary), false);
    assert.equal(storedBytes.includes(sourceCanary), false);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        assert.equal((await stat(`${ledgerPath}${suffix}`)).mode & 0o777, 0o600);
      } catch (error) {
        assert.equal(error.code, "ENOENT");
      }
    }
  } finally {
    database?.close();
    await chmod(fixture.file, 0o600).catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});
