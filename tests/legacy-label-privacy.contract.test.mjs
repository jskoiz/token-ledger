import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

process.env.NODE_TEST_CONTEXT = "legacy-label-privacy";
process.env.TOKEN_LEDGER_TEST_STATE_NAMESPACE = String(process.pid);

const [{ collectUsage }, ledgerModule, snapshotModule] = await Promise.all([
  import("../lib/token-ledger-importer.mjs"),
  import("../lib/token-ledger-ledger.mjs"),
  import("../lib/token-ledger-snapshot.mjs"),
]);

const {
  codexHomeFingerprint,
  readDurableLedger,
  resolveDurableLedgerPath,
} = ledgerModule;
const {
  readPrivateSnapshot,
  stagePrivateSnapshot,
  writePrivateSnapshot,
} = snapshotModule;

const TEST_LEDGER_STATE_ROOT = resolve(
  userInfo().homedir,
  ".token-ledger",
  "test-state",
  String(process.pid),
);
const LOCAL_PATH_PLACEHOLDER = "[local path]";
const GENERATED_AT = "2026-08-20T12:00:00.000Z";

test.after(async () => {
  await rm(TEST_LEDGER_STATE_ROOT, { recursive: true, force: true });
});

function legacyEvent(project, threadId, totalTokens, index) {
  return {
    timestamp: new Date(Date.parse(GENERATED_AT) + index * 60_000).toISOString(),
    project,
    model: "gpt-5.4",
    rateCardModel: "gpt-5.4",
    effort: "medium",
    source: "local",
    useType: "interactive",
    inputTokens: totalTokens - 10,
    cachedInputTokens: 10,
    outputTokens: 10,
    reasoningTokens: 4,
    totalTokens,
    toolCalls: 0,
    callCount: 1,
    detailedCallCount: 1,
    inputCallCount: 1,
    breakdownAvailable: true,
    threadIds: [threadId],
  };
}

function legacyThread(project, threadId) {
  return {
    id: threadId,
    title: "Synthetic user-written display title",
    project,
    model: "gpt-5.4",
    effort: "medium",
    source: "local",
    useType: "interactive",
    reportedCumulativeTokens: 100,
    firstActiveAt: GENERATED_AT,
    lastActiveAt: GENERATED_AT,
  };
}

function projectByThread(rows, threadId) {
  return rows.find((row) => row.id === threadId)?.project;
}

function usageProjectByThread(rows, threadId) {
  return rows.find((row) => row.threadId === threadId)?.project;
}

function snapshotEventByThread(snapshot, threadId) {
  return snapshot.events.find((event) => event.threadIds?.includes(threadId));
}

test("legacy project labels are redacted in durable and regenerated output", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-legacy-labels-"));
  const output = resolve(root, "snapshot.json.gz");
  const threadIds = {
    posix: "11111111-1111-4111-8111-111111111111",
    windows: "22222222-2222-4222-8222-222222222222",
    fileUrl: "33333333-3333-4333-8333-333333333333",
    remote: "44444444-4444-4444-8444-444444444444",
    plain: "55555555-5555-4555-8555-555555555555",
  };
  const projects = {
    posix: "/tmp/token-ledger-synthetic-posix-private-project",
    windows: "C:\\synthetic\\Token Ledger\\private-project",
    fileUrl: "file:///tmp/token-ledger-synthetic-file-private-project",
    remote: "https://example.test/org/project.git",
    plain: "synthetic-project",
  };
  const entries = Object.entries(projects);
  const legacy = {
    schemaVersion: 3,
    generatedAt: GENERATED_AT,
    provenance: {
      collection: { since: null, includeArchived: true },
    },
    metadata: {
      durableLedger: {
        codexHomeFingerprint: codexHomeFingerprint(root),
      },
    },
    quotaObservations: [],
    threads: entries.map(([kind]) => legacyThread(projects[kind], threadIds[kind])),
    events: entries.map(([kind], index) =>
      legacyEvent(projects[kind], threadIds[kind], 100 + index * 100, index)),
  };

  try {
    await mkdir(dirname(output), { recursive: true });
    await writePrivateSnapshot(output, legacy);
    const collected = await collectUsage({
      output,
      codexHome: root,
      includeArchived: true,
      since: null,
      stageSnapshot: (candidate) => stagePrivateSnapshot(output, candidate),
    });
    const ledgerPath = resolveDurableLedgerPath({ codexHome: root, output });
    const ledger = await readDurableLedger(ledgerPath);
    const stored = await readPrivateSnapshot(output);

    assert.equal(ledger.migration?.migrationKey, "snapshot-v3-default");
    assert.equal(ledger.migration?.usageRows, entries.length);
    for (const [kind, project] of entries) {
      const threadId = threadIds[kind];
      const expected = project.startsWith("http") || kind === "plain"
        ? project
        : LOCAL_PATH_PLACEHOLDER;
      assert.equal(projectByThread(ledger.threadRows, threadId), expected, kind);
      assert.equal(usageProjectByThread(ledger.usageRows, threadId), expected, kind);
      assert.equal(
        collected.threads.find((row) => row.id === threadId)?.project,
        expected,
        `${kind} collected thread`,
      );
      assert.equal(
        snapshotEventByThread(collected, threadId)?.project,
        expected,
        `${kind} collected event`,
      );
      assert.equal(
        stored.threads.find((row) => row.id === threadId)?.project,
        expected,
        `${kind} stored thread`,
      );
      assert.equal(
        snapshotEventByThread(stored, threadId)?.project,
        expected,
        `${kind} stored event`,
      );
    }
    assert.equal(
      stored.threads.find((row) => row.id === threadIds.posix)?.title,
      "Synthetic user-written display title",
    );
    for (const project of [projects.posix, projects.windows, projects.fileUrl]) {
      assert.equal(JSON.stringify({ ledger, collected, stored }).includes(project), false);
    }

    // A pre-fix durable row must not re-enter either supported read or output
    // surface if an older ledger already contains the raw label.
    const database = new DatabaseSync(ledgerPath);
    database.prepare(
      "UPDATE thread_records SET project = ? WHERE thread_id = ?",
    ).run(projects.posix, threadIds.posix);
    database.prepare(
      "UPDATE usage_observations SET project = ? WHERE thread_id = ?",
    ).run(projects.windows, threadIds.windows);
    database.close();

    const repairedRead = await readDurableLedger(ledgerPath);
    assert.equal(
      projectByThread(repairedRead.threadRows, threadIds.posix),
      LOCAL_PATH_PLACEHOLDER,
    );
    assert.equal(
      usageProjectByThread(repairedRead.usageRows, threadIds.windows),
      LOCAL_PATH_PLACEHOLDER,
    );

    const regenerated = await collectUsage({
      output,
      codexHome: root,
      includeArchived: true,
      since: null,
      stageSnapshot: (candidate) => stagePrivateSnapshot(output, candidate),
    });
    const regeneratedStored = await readPrivateSnapshot(output);
    assert.equal(
      regenerated.threads.find((row) => row.id === threadIds.posix)?.project,
      LOCAL_PATH_PLACEHOLDER,
    );
    assert.equal(
      snapshotEventByThread(regenerated, threadIds.windows)?.project,
      LOCAL_PATH_PLACEHOLDER,
    );
    assert.equal(
      regeneratedStored.threads.find((row) => row.id === threadIds.posix)?.project,
      LOCAL_PATH_PLACEHOLDER,
    );
    assert.equal(
      snapshotEventByThread(regeneratedStored, threadIds.windows)?.project,
      LOCAL_PATH_PLACEHOLDER,
    );
    assert.equal(JSON.stringify(regeneratedStored).includes(projects.posix), false);
    assert.equal(JSON.stringify(regeneratedStored).includes(projects.windows), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
