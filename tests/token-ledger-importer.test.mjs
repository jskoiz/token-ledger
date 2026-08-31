import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import {
  appendFile,
  chmod,
  link,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  cleanupOrphanedUsageSpools,
  collectUsage,
  collectUsageSequential,
  rolloutWorkerStateEntry,
  sourceInventory,
  sourceWatermarksEqual,
} from "../lib/token-ledger-importer.mjs";
import {
  DEFAULT_SNAPSHOT_MAX_BYTES,
  readPrivateSnapshot,
  stagePrivateSnapshot,
  writePrivateSnapshot,
} from "../lib/token-ledger-snapshot.mjs";
import {
  codexHomeFingerprint,
  readDurableLedger,
  resolveDurableLedgerPath,
} from "../lib/token-ledger-ledger.mjs";
import {
  buildUsageBuckets,
  normalizeTokenUsage,
  SNAPSHOT_SCHEMA_VERSION,
  splitUsageBucketsAtBoundaries,
  usageBuckets,
  usageBucketStats,
} from "../lib/token-ledger-usage.mjs";

const TEST_LEDGER_STATE_ROOT = resolve(
  userInfo().homedir,
  ".token-ledger",
  "test-state",
  String(process.pid),
);

test.after(async () => {
  await rm(TEST_LEDGER_STATE_ROOT, { recursive: true, force: true });
});

async function createPrivateFixtureRoot(prefix) {
  return mkdtemp(resolve(tmpdir(), prefix));
}

function tokenCount(timestamp, total, last) {
  return {
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
          input_tokens: last - 10,
          cached_input_tokens: 10,
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: last,
        },
        model_context_window: 128000,
      },
    },
  };
}

function serialize(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function rolloutRows(totals, offset = 0) {
  const baseMs = Date.parse("2026-08-23T10:00:00.000Z");
  return totals.flatMap((total, index) => {
    const turnIndex = offset + index;
    const timestamp = new Date(baseMs + turnIndex * 1_000).toISOString();
    return [
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: `turn-${turnIndex + 1}`,
          started_at: Date.parse(timestamp) / 1_000,
        },
      },
      tokenCount(timestamp, total, total),
    ];
  });
}

test("rollout workers receive only the matched scan metadata", () => {
  const includedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const excludedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const includedFile = resolve(
    "/sessions",
    `rollout-${includedId}.jsonl`,
  );
  const stateRows = new Map([
    [includedId, {
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      cwd: "/private/project",
      git_origin_url: "https://example.invalid/org/repo.git",
      source: '{"subagent":{}}',
      title: "large user-authored text".repeat(10_000),
      updated_at: 1_777_777_777,
    }],
    [excludedId, {
      model: "gpt-5.6-luna",
      title: "unrelated state row",
    }],
  ]);

  assert.deepEqual(rolloutWorkerStateEntry(includedFile, stateRows), [
    includedId,
    {
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      cwd: "/private/project",
      git_origin_url: "https://example.invalid/org/repo.git",
      source: '{"subagent":{}}',
    },
  ]);
  assert.equal(
    rolloutWorkerStateEntry(
      resolve("/sessions", `rollout-${excludedId}.jsonl`),
      new Map([[includedId, stateRows.get(includedId)]]),
    ),
    null,
  );
  assert.equal(
    rolloutWorkerStateEntry(
      resolve("/sessions", "rollout-without-a-thread-id.jsonl"),
      stateRows,
    ),
    null,
  );
});

async function createRolloutFixture(totals, fileName = "rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl") {
  const root = await createPrivateFixtureRoot("token-ledger-collection-");
  const directory = resolve(root, "sessions", "2026", "08");
  const file = resolve(directory, fileName);
  await mkdir(directory, { recursive: true });
  await writeFile(file, serialize(rolloutRows(totals)));
  return { root, directory, file };
}

test("orphan spool cleanup removes only dead-process private directories", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-spool-cleanup-");
  const orphan = resolve(root, "token-ledger-import-999999-abc123");
  const live = resolve(root, `token-ledger-import-${process.pid}-def456`);
  const unrelated = resolve(root, "token-ledger-import-unrelated-ghi789");
  const symlinkTarget = resolve(root, "symlink-target");
  const linked = resolve(root, "token-ledger-import-999998-jkl012");
  try {
    await mkdir(orphan);
    await mkdir(live);
    await mkdir(unrelated);
    await mkdir(symlinkTarget);
    await writeFile(resolve(orphan, "usage.sqlite"), "orphan canary");
    await writeFile(resolve(orphan, "usage.sqlite-wal"), "wal canary");
    await writeFile(resolve(orphan, "usage.sqlite-shm"), "shm canary");
    await writeFile(resolve(live, "usage.sqlite"), "live canary");
    await writeFile(resolve(unrelated, "usage.sqlite"), "unrelated canary");
    await writeFile(resolve(symlinkTarget, "canary"), "linked target canary");
    await symlink(symlinkTarget, linked, "dir");

    assert.equal(
      await cleanupOrphanedUsageSpools({ tempDirectory: root }),
      1,
    );
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(live), true);
    assert.equal(existsSync(unrelated), true);
    assert.equal(existsSync(linked), true);
    assert.equal(
      await readFile(resolve(symlinkTarget, "canary"), "utf8"),
      "linked target canary",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orphan spool cleanup rejects hardlinks and raced directory identities", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-spool-race-");
  const hardlinkTarget = resolve(root, "hardlink-target");
  const hardlinkPath = resolve(root, "token-ledger-import-999997-mno345");
  const raced = resolve(root, "token-ledger-import-999996-pqr678");
  const relocated = resolve(root, "relocated-original");
  try {
    await writeFile(hardlinkTarget, "hardlink canary");
    await link(hardlinkTarget, hardlinkPath);
    await mkdir(raced);
    await writeFile(resolve(raced, "usage.sqlite"), "original canary");

    assert.equal(
      await cleanupOrphanedUsageSpools({
        tempDirectory: root,
        beforeRevalidate: async (candidate) => {
          if (candidate !== raced) return;
          await rename(candidate, relocated);
          await mkdir(candidate);
          await writeFile(resolve(candidate, "replacement"), "replacement canary");
        },
      }),
      0,
    );
    assert.equal(await readFile(hardlinkTarget, "utf8"), "hardlink canary");
    assert.equal(await readFile(hardlinkPath, "utf8"), "hardlink canary");
    assert.equal(
      await readFile(resolve(relocated, "usage.sqlite"), "utf8"),
      "original canary",
    );
    assert.equal(
      await readFile(resolve(raced, "replacement"), "utf8"),
      "replacement canary",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("temporary spool stores privacy-reduced source metadata", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-spool-privacy-");
  const threadId = "60606060-6060-4060-8060-606060606060";
  const timestamp = "2026-08-23T10:00:00.000Z";
  const cwdCanary = "/private/user-secret/repo";
  const originCanary =
    "https://private-user:private-password@example.test/org/repo.git";
  const sourceCanary = "/private/source-canary";
  let inspected = false;
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "23");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize([
        {
          timestamp,
          type: "session_meta",
          payload: {
            id: threadId,
            cwd: cwdCanary,
            source: sourceCanary,
            git: { repository_url: originCanary },
          },
        },
        ...rolloutRows([100]),
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
      faultInjector: ({ point }) => {
        if (point !== "before-commit" || inspected) return;
        const prefix = `token-ledger-import-${process.pid}-`;
        const spoolDirectory = readdirSync(tmpdir()).find((entry) =>
          entry.startsWith(prefix)
        );
        assert.ok(spoolDirectory);
        const database = new DatabaseSync(
          resolve(tmpdir(), spoolDirectory, "usage.sqlite"),
          { readOnly: true },
        );
        try {
          const token = database.prepare(`
            SELECT cwd, git_origin AS gitOrigin, raw_source AS rawSource
              FROM token_events
          `).get();
          const origin = database.prepare(`
            SELECT cwd, git_origin AS gitOrigin, raw_source AS rawSource
              FROM turn_origins
          `).get();
          const serialized = JSON.stringify({ token, origin });
          assert.doesNotMatch(serialized, /user-secret|private-user/);
          assert.doesNotMatch(serialized, /private-password|source-canary/);
          assert.equal(token.cwd, "repo");
          assert.equal(token.gitOrigin, "org/repo");
          assert.equal(token.rawSource, "/");
          inspected = true;
        } finally {
          database.close();
        }
      },
    });

    assert.equal(inspected, true);
    assert.equal(snapshot.events[0].project, "org/repo");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage spool retains SQLite statements through long row iteration", async () => {
  const { root } = await createRolloutFixture(Array(10_000).fill(100));
  try {
    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: false,
      since: null,
    });

    assert.equal(snapshot.coverage.observedModelCalls, 10_000);
    assert.equal(snapshot.coverage.observedTokens, 1_000_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("large refreshes stream spool rows within a bounded JavaScript heap", () => {
  const benchmark = fileURLToPath(
    new URL("../tools/benchmark-importer.mjs", import.meta.url),
  );
  const child = spawnSync(process.execPath, [
    "--max-old-space-size=128",
    benchmark,
    "--files",
    "24",
    "--token-events",
    "20000",
    "--warm-runs",
    "1",
    "--event-age-days",
    "4000",
  ], {
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(
    child.status,
    0,
    `bounded refresh failed: ${child.stderr || child.stdout}`,
  );
  const result = JSON.parse(child.stdout);
  assert.equal(result.durableTotalTokens, 2_000_000);
  assert.equal(result.parsedOutputEvents, 20_000);
  assert.equal(result.durableRevision, 1);
  assert.equal(result.parseErrors, 0);
});

test("source appends after the cutoff publish safely and converge next time", async () => {
  const { root, file } = await createRolloutFixture([100]);
  const output = resolve(root, "snapshot.json.gz");
  let appended = false;
  try {
    const snapshot = await collectUsage(
      {
        output,
        codexHome: root,
        includeArchived: true,
        since: null,
      },
      async ({ current }) => {
        if (current === 1 && !appended) {
          appended = true;
          await appendFile(file, serialize(rolloutRows([200], 1)));
        }
      },
    );
    const writeResult = await writePrivateSnapshot(output, snapshot);
    const persisted = await readPrivateSnapshot(output);
    const afterAppend = await sourceInventory(root, true);
    const converged = await collectUsage({
      output,
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    const current = await sourceInventory(root, true);

    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.ok(Number.isFinite(Date.parse(snapshot.provenance.sourceCutoffAt)));
    assert.ok(
      Date.parse(snapshot.provenance.sourceCutoffAt) <=
        Date.parse(snapshot.generatedAt),
    );
    assert.equal(writeResult.snapshot.coverage.observedTokens, 100);
    assert.equal(persisted.coverage.observedTokens, 100);
    assert.equal(sourceWatermarksEqual(
      persisted.sourceWatermark,
      afterAppend.watermark,
    ), false);
    assert.equal(converged.coverage.observedTokens, 300);
    assert.ok(sourceWatermarksEqual(converged.sourceWatermark, current.watermark));
    assert.equal(
      persisted.metadata.durableLedger.codexHomeFingerprint,
      codexHomeFingerprint(root),
    );
    assert.ok(!JSON.stringify(persisted).includes(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite WAL changes invalidate the source watermark", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-wal-watermark-");
  const database = resolve(root, "state_5.sqlite");
  const wal = `${database}-wal`;
  try {
    await writeFile(database, "main-v1");
    await writeFile(wal, "wal-v1");
    const before = await sourceInventory(root, true);

    await appendFile(wal, "-wal-v2");
    const after = await sourceInventory(root, true);

    assert.notEqual(before.watermark.fingerprint, after.watermark.fingerprint);
    assert.equal(sourceWatermarksEqual(before.watermark, after.watermark), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new rollout files after the cutoff are deferred until the next refresh", async () => {
  const { root, directory } = await createRolloutFixture([100]);
  const output = resolve(root, "snapshot.json.gz");
  const newFile = resolve(
    directory,
    "rollout-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl",
  );
  let created = false;
  let progressCalls = 0;
  try {
    const snapshot = await collectUsage(
      {
        output,
        codexHome: root,
        includeArchived: true,
        since: null,
        stageSnapshot: (candidate) => stagePrivateSnapshot(output, candidate),
      },
      async ({ current }) => {
        progressCalls += 1;
        if (current === 1 && !created) {
          created = true;
          await writeFile(newFile, serialize(rolloutRows([250])));
        }
      },
    );
    const persisted = await readPrivateSnapshot(output);
    const afterCreation = await sourceInventory(root, true);
    const converged = await collectUsage({
      output,
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    const current = await sourceInventory(root, true);

    assert.equal(progressCalls, 1);
    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(snapshot.coverage.filesScanned, 1);
    assert.equal(persisted.coverage.observedTokens, 100);
    assert.equal(
      sourceWatermarksEqual(snapshot.sourceWatermark, afterCreation.watermark),
      false,
    );
    assert.equal(converged.coverage.observedTokens, 350);
    assert.equal(converged.coverage.filesScanned, 2);
    assert.ok(sourceWatermarksEqual(converged.sourceWatermark, current.watermark));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new rollout files after staging do not reject the captured cutoff", async () => {
  const { root, directory } = await createRolloutFixture([100]);
  const output = resolve(root, "snapshot.json.gz");
  const newFile = resolve(
    directory,
    "rollout-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl",
  );
  let created = false;
  try {
    const snapshot = await collectUsage({
      output,
      codexHome: root,
      includeArchived: true,
      since: null,
      stageSnapshot: (candidate) => stagePrivateSnapshot(output, candidate),
      faultInjector: async ({ point }) => {
        if (point !== "after-sqlite-commit" || created) return;
        created = true;
        await writeFile(newFile, serialize(rolloutRows([250])));
      },
    });
    const persisted = await readPrivateSnapshot(output);
    const afterCreation = await sourceInventory(root, true);
    const converged = await collectUsage({
      output,
      codexHome: root,
      includeArchived: true,
      since: null,
    });

    assert.equal(created, true);
    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(persisted.coverage.observedTokens, 100);
    assert.equal(
      sourceWatermarksEqual(snapshot.sourceWatermark, afterCreation.watermark),
      false,
    );
    assert.equal(converged.coverage.observedTokens, 350);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollout replacement after staging does not discard the captured cutoff", async () => {
  const { root, directory, file } = await createRolloutFixture([100]);
  const output = resolve(root, "snapshot.json.gz");
  const replacement = resolve(directory, "replacement.jsonl");
  let replaced = false;
  try {
    const snapshot = await collectUsage({
      output,
      codexHome: root,
      includeArchived: true,
      since: null,
      stageSnapshot: (candidate) => stagePrivateSnapshot(output, candidate),
      faultInjector: async ({ point }) => {
        if (point !== "after-sqlite-commit" || replaced) return;
        replaced = true;
        await writeFile(replacement, serialize(rolloutRows([300])));
        await rename(replacement, file);
      },
    });
    const persisted = await readPrivateSnapshot(output);
    const afterReplacement = await sourceInventory(root, true);
    const converged = await collectUsage({
      output,
      codexHome: root,
      includeArchived: true,
      since: null,
    });

    assert.equal(replaced, true);
    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(persisted.coverage.observedTokens, 100);
    assert.equal(
      sourceWatermarksEqual(
        snapshot.sourceWatermark,
        afterReplacement.watermark,
      ),
      false,
    );
    assert.equal(converged.coverage.observedTokens, 300);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replacement after a bounded read is deferred until the next refresh", async () => {
  const { root, directory, file } = await createRolloutFixture([100]);
  const replacement = resolve(directory, "replacement.jsonl");
  let replaced = false;
  let progressCalls = 0;
  try {
    const snapshot = await collectUsage(
      {
        output: resolve(root, "snapshot.json"),
        codexHome: root,
        includeArchived: true,
        since: null,
        stageSnapshot: (candidate) =>
          stagePrivateSnapshot(resolve(root, "snapshot.json"), candidate),
      },
      async ({ current }) => {
        if (current === 1) progressCalls += 1;
        if (current === 1 && !replaced) {
          replaced = true;
          await writeFile(replacement, serialize(rolloutRows([300])));
          await rename(replacement, file);
        }
      },
    );
    const converged = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(progressCalls, 1);
    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(snapshot.coverage.filesScanned, 1);
    assert.equal(converged.coverage.observedTokens, 300);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("truncation after a bounded read does not erase captured usage", async () => {
  const { root, file } = await createRolloutFixture([100, 200]);
  let truncated = false;
  let progressCalls = 0;
  try {
    const snapshot = await collectUsage(
      {
        output: resolve(root, "snapshot.json"),
        codexHome: root,
        includeArchived: true,
        since: null,
        stageSnapshot: (candidate) =>
          stagePrivateSnapshot(resolve(root, "snapshot.json"), candidate),
      },
      async ({ current }) => {
        if (current === 1) progressCalls += 1;
        if (current === 1 && !truncated) {
          truncated = true;
          await writeFile(file, serialize(rolloutRows([100])));
        }
      },
    );
    const converged = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(progressCalls, 1);
    assert.equal(snapshot.coverage.observedTokens, 300);
    assert.equal(snapshot.coverage.filesScanned, 1);
    assert.equal(converged.coverage.observedTokens, 300);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continuously appended sources publish one stable cutoff", async () => {
  const { root, file } = await createRolloutFixture([100]);
  let progressCalls = 0;
  try {
    const first = await collectUsage(
      {
        output: resolve(root, "snapshot.json"),
        codexHome: root,
        includeArchived: true,
        since: null,
      },
      async ({ current }) => {
        if (current !== 1) return;
        progressCalls += 1;
        await appendFile(
          file,
          serialize(rolloutRows([101], 2)),
        );
      },
    );
    const converged = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });

    assert.equal(progressCalls, 1);
    assert.equal(first.coverage.observedTokens, 100);
    assert.equal(converged.coverage.observedTokens, 201);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata churn does not invalidate a stable rollout cutoff", async () => {
  const { root } = await createRolloutFixture([100]);
  const wal = resolve(root, "state_5.sqlite-wal");
  const output = resolve(root, "snapshot.json");
  let progressCalls = 0;
  let postStageMutation = false;
  try {
    await writeFile(wal, "before");
    const snapshot = await collectUsage(
      {
        output,
        codexHome: root,
        includeArchived: true,
        since: null,
        stageSnapshot: (candidate) => stagePrivateSnapshot(output, candidate),
        faultInjector: async ({ point }) => {
          if (point !== "after-sqlite-commit" || postStageMutation) return;
          postStageMutation = true;
          await appendFile(wal, "-after-stage");
        },
      },
      async ({ current }) => {
        if (current !== 1) return;
        progressCalls += 1;
        await appendFile(wal, "after");
      },
    );
    const persisted = await readPrivateSnapshot(output);
    const current = await sourceInventory(root, true);

    assert.equal(progressCalls, 1);
    assert.equal(postStageMutation, true);
    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(
      sourceWatermarksEqual(snapshot.sourceWatermark, current.watermark),
      false,
    );
    assert.equal(
      sourceWatermarksEqual(persisted.sourceWatermark, current.watermark),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty thread settings reset the service tier for the next turn", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  const threadId = "11111111-1111-4111-8111-111111111111";
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    const firstTimestamp = "2026-08-18T10:00:00.000Z";
    const secondTimestamp = "2026-08-18T10:01:00.000Z";
    const thirdTimestamp = "2026-08-18T10:02:00.000Z";
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize([
        {
          timestamp: firstTimestamp,
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
            started_at: Date.parse(firstTimestamp) / 1000,
          },
        },
        {
          timestamp: firstTimestamp,
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: {
              model: "gpt-5.5",
              reasoning_effort: "medium",
              service_tier: "priority",
            },
          },
        },
        {
          timestamp: firstTimestamp,
          type: "turn_context",
          payload: {
            turn_id: "turn-1",
            model: "gpt-5.5",
            effort: "medium",
          },
        },
        tokenCount("2026-08-18T10:00:01.000Z", 100, 100),
        {
          timestamp: secondTimestamp,
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-2",
            started_at: Date.parse(secondTimestamp) / 1000,
          },
        },
        {
          timestamp: secondTimestamp,
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: {
              model: "gpt-5.5",
              reasoning_effort: "medium",
              service_tier: "",
            },
          },
        },
        {
          timestamp: secondTimestamp,
          type: "turn_context",
          payload: {
            turn_id: "turn-2",
            model: "gpt-5.5",
            effort: "medium",
          },
        },
        tokenCount("2026-08-18T10:01:01.000Z", 200, 100),
        {
          timestamp: thirdTimestamp,
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-3",
            started_at: Date.parse(thirdTimestamp) / 1000,
          },
        },
        {
          timestamp: thirdTimestamp,
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: {
              model: "gpt-5.4",
              reasoning_effort: "medium",
              service_tier: " FAST ",
            },
          },
        },
        {
          timestamp: thirdTimestamp,
          type: "turn_context",
          payload: {
            turn_id: "turn-3",
            model: "gpt-5.4",
            effort: "medium",
          },
        },
        tokenCount("2026-08-18T10:02:01.000Z", 300, 100),
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.events.length, 3);
    assert.equal(snapshot.events[0].serviceTier, "priority");
    assert.equal(snapshot.events[1].serviceTier, null);
    assert.equal(snapshot.events[2].serviceTier, "FAST");
    assert.ok(
      Math.abs(
        snapshot.events[0].rateCardCredits -
          snapshot.events[1].rateCardCredits * 2.5,
      ) < 0.000001,
    );
    // The 2x GPT-5.4 fast price equals the standard GPT-5.5 price for this
    // input/cache/output mix.
    assert.equal(
      snapshot.events[2].rateCardCredits,
      snapshot.events[1].rateCardCredits,
    );
    assert.equal(snapshot.provenance.rateCardKind, "codex-purchased-credits");
    assert.equal(snapshot.provenance.rateCardAsOf, "2026-08-23");
    assert.equal(
      snapshot.provenance.rateCardUrl,
      "https://help.openai.com/en/articles/11481834",
    );
    assert.match(snapshot.provenance.rateCardScope, /not API USD/i);
    assert.match(snapshot.provenance.rateCardScope, /not included plan-limit/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collector applies current Sol and priority Daybreak Red purchased-credit rates", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  const threadId = "22222222-2222-4222-8222-222222222222";
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize([
        ...turnStart("2026-08-18T11:00:00.000Z", "turn-sol", "gpt-5.6-sol"),
        tokenCount("2026-08-18T11:00:01.000Z", 100, 100),
        ...turnStart(
          "2026-08-18T11:01:00.000Z",
          "turn-red",
          "gpt-5.5-cyber",
        ),
        {
          timestamp: "2026-08-18T11:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: {
              model: "gpt-5.5-cyber",
              reasoning_effort: "medium",
              service_tier: "priority",
            },
          },
        },
        tokenCount("2026-08-18T11:01:01.000Z", 200, 100),
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.events.length, 2);
    assert.equal(snapshot.events[0].model, "gpt-5.6-sol");
    assert.ok(Math.abs(snapshot.events[0].rateCardCredits - 0.0131) < 1e-12);
    assert.equal(snapshot.events[1].model, "daybreak-red");
    assert.ok(
      Math.abs(snapshot.events[1].rateCardCredits - 0.11015625) < 1e-12,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collector leaves unsupported Daybreak latest aliases unrated", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  const threadId = "88888888-8888-4888-8888-888888888888";
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize([
        ...turnStart(
          "2026-08-18T12:00:00.000Z",
          "turn-red-latest",
          "gpt-daybreak-red-latest",
        ),
        {
          timestamp: "2026-08-18T12:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: {
              model: "gpt-daybreak-red-latest",
              reasoning_effort: "medium",
              service_tier: "priority",
            },
          },
        },
        tokenCount("2026-08-18T12:00:01.000Z", 100, 100),
        ...turnStart(
          "2026-08-18T12:01:00.000Z",
          "turn-blue-latest",
          "gpt-5.5-daybreak-blue-latest",
        ),
        {
          timestamp: "2026-08-18T12:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: {
              model: "gpt-5.5-daybreak-blue-latest",
              reasoning_effort: "medium",
              service_tier: "fast",
            },
          },
        },
        tokenCount("2026-08-18T12:01:01.000Z", 200, 100),
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });

    assert.equal(snapshot.events.length, 2);
    assert.deepEqual(
      snapshot.events.map((event) => event.model),
      ["daybreak-red", "daybreak-blue"],
    );
    assert.deepEqual(
      snapshot.events.map((event) => event.rateCardModel),
      ["gpt-daybreak-red-latest", "gpt-5.5-daybreak-blue-latest"],
    );
    assert.deepEqual(
      snapshot.events.map((event) => event.serviceTier),
      ["priority", "fast"],
    );
    assert.deepEqual(
      snapshot.events.map((event) => event.rateCardCredits),
      [null, null],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports clamp token subsets and price whitespace model names", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  const threadId = "33333333-3333-4333-8333-333333333333";
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "19");
    await mkdir(rolloutDirectory, { recursive: true });
    const timestamp = "2026-08-19T09:00:00.000Z";
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize([
        {
          timestamp,
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
            started_at: Date.parse(timestamp) / 1000,
          },
        },
        {
          timestamp,
          type: "turn_context",
          payload: {
            turn_id: "turn-1",
            model: "gpt-5.4 mini",
            effort: "medium",
          },
        },
        {
          timestamp: "2026-08-19T09:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 90,
                cached_input_tokens: 500,
                output_tokens: 10,
                reasoning_output_tokens: 40,
                total_tokens: 100,
              },
              last_token_usage: {
                input_tokens: 90,
                cached_input_tokens: 500,
                output_tokens: 10,
                reasoning_output_tokens: 40,
                total_tokens: 100,
              },
              model_context_window: 128000,
            },
          },
        },
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.events.length, 1);
    const event = snapshot.events[0];
    assert.equal(event.model, "gpt-5.4-mini");
    assert.equal(event.cachedInputTokens, 90);
    assert.equal(event.reasoningTokens, 10);
    // Priced at the mini rate: (90 cached × 1.875 + 10 output × 113) per 1M.
    assert.ok(Math.abs(event.rateCardCredits - 0.00129875) < 1e-9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private snapshots replace atomically and enforce mode 0600", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-write-");
  try {
    const output = resolve(root, "snapshot.json");
    await writeFile(output, "old\n");
    await chmod(output, 0o644);
    await writePrivateSnapshot(output, { events: [], synthetic: true });

    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      events: [],
      synthetic: true,
    });
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staged snapshots stay private until publication and discard cleanly", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-stage-write-");
  const output = resolve(root, "snapshot.json");
  try {
    await writePrivateSnapshot(output, { version: "previous", events: [] });
    const discarded = await stagePrivateSnapshot(output, {
      version: "discarded",
      events: [],
    });
    assert.equal((await readPrivateSnapshot(output)).version, "previous");
    assert.equal(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")).length,
      1,
    );
    await discarded.discard();
    assert.equal((await readPrivateSnapshot(output)).version, "previous");
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );

    const published = await stagePrivateSnapshot(output, {
      version: "published",
      events: [],
    });
    assert.equal((await readPrivateSnapshot(output)).version, "previous");
    await published.publish();
    await published.discard();
    assert.equal((await readPrivateSnapshot(output)).version, "published");
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staged snapshots reject a replaced candidate without following it", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-stage-race-");
  const output = resolve(root, "snapshot.json");
  const victim = resolve(root, "victim.txt");
  try {
    await writePrivateSnapshot(output, { version: "previous", events: [] });
    await writeFile(victim, "victim\n", { mode: 0o640 });
    const victimBefore = await stat(victim);
    const staged = await stagePrivateSnapshot(output, {
      version: "candidate",
      events: [],
    });
    const temporaryName = (await readdir(root)).find((name) =>
      name.endsWith(".tmp")
    );
    assert.ok(temporaryName);
    const temporary = resolve(root, temporaryName);
    await rm(temporary);
    await symlink(victim, temporary);

    await assert.rejects(
      staged.publish(),
      (error) => error?.code === "ERR_SNAPSHOT_CANDIDATE_CHANGED",
    );
    const victimAfter = await stat(victim);
    assert.equal(victimAfter.mode & 0o777, victimBefore.mode & 0o777);
    assert.equal(await readFile(victim, "utf8"), "victim\n");
    assert.equal((await readPrivateSnapshot(output)).version, "previous");
    await staged.discard();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gzip snapshots are compact, readable, atomic, and private", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-gzip-write-");
  try {
    const output = resolve(root, "snapshot.json.gz");
    const snapshot = {
      generatedAt: "2026-08-22T00:00:00.000Z",
      events: Array.from({ length: 1_000 }, (_, index) => ({
        id: `event-${index}`,
        timestamp: "2026-08-22T00:00:00.000Z",
        project: "repeated-project",
        model: "gpt-5.6-sol",
        totalTokens: index + 1,
      })),
    };

    const result = await writePrivateSnapshot(output, snapshot);
    const encoded = await readFile(output);

    assert.deepEqual([...encoded.subarray(0, 2)], [0x1f, 0x8b]);
    assert.deepEqual(await readPrivateSnapshot(output), snapshot);
    assert.equal(result.encoding, "gzip");
    assert.equal(result.bytesWritten, encoded.byteLength);
    assert.ok(result.bytesWritten < result.jsonBytes / 4);
    assert.equal(result.maxBytes, DEFAULT_SNAPSHOT_MAX_BYTES);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot reader rejects compressed inputs above the pre-read limit", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-gzip-read-size-");
  try {
    const output = resolve(root, "oversized.json.gz");
    await writeFile(output, Buffer.alloc(1_025, 0));

    await assert.rejects(
      () => readPrivateSnapshot(output, {
        maxBytes: 1_024,
        maxJsonBytes: 4_096,
      }),
      (error) => {
        assert.equal(error.code, "ERR_SNAPSHOT_SIZE_LIMIT");
        assert.match(error.message, /compressed read limit/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot reader bounds gzip expansion and preserves valid reads", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-gzip-read-json-");
  try {
    const output = resolve(root, "snapshot.json.gz");
    const snapshot = { label: "x".repeat(4_096), events: [] };
    const encoded = gzipSync(Buffer.from(JSON.stringify(snapshot)));
    await writeFile(output, encoded);

    await assert.rejects(
      () => readPrivateSnapshot(output, {
        maxBytes: encoded.byteLength + 1,
        maxJsonBytes: 1_024,
      }),
      (error) => {
        assert.equal(error.code, "ERR_SNAPSHOT_SIZE_LIMIT");
        assert.match(error.message, /expands beyond the .* JSON read limit/);
        return true;
      },
    );
    assert.deepEqual(
      await readPrivateSnapshot(output, {
        maxBytes: encoded.byteLength + 1,
        maxJsonBytes: 8_192,
      }),
      snapshot,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot size limit preserves the previous cache", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-size-limit-");
  try {
    const output = resolve(root, "snapshot.json.gz");
    await writeFile(output, "previous-cache\n");

    await assert.rejects(
      () => writePrivateSnapshot(
        output,
        {
          events: Array.from({ length: 100 }, (_, index) => ({
            id: `event-${index}-${"x".repeat(index + 1)}`,
          })),
        },
        { maxBytes: 1 },
      ),
      /exceeding the .* safety limit/,
    );

    assert.equal(await readFile(output, "utf8"), "previous-cache\n");
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expanded JSON limit preserves the previous compressed cache", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-json-limit-");
  try {
    const output = resolve(root, "snapshot.json.gz");
    await writeFile(output, "previous-cache\n");

    await assert.rejects(
      () => writePrivateSnapshot(
        output,
        {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          coverage: {},
          label: "x".repeat(5_000),
          events: [],
        },
        {
          maxBytes: 64 * 1_024,
          targetBytes: 64 * 1_024,
          maxJsonBytes: 1_024,
          targetJsonBytes: 512,
        },
      ),
      /exceeding the .* in-memory safety limit/,
    );

    assert.equal(await readFile(output, "utf8"), "previous-cache\n");
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage buckets preserve additive totals across age tiers", () => {
  const latestTimestampMs = Date.parse("2026-08-22T12:00:00.000Z");
  const rows = [
    ["2026-08-22T11:59:58.000Z", "recent-a", 10],
    ["2026-08-22T11:59:59.000Z", "recent-b", 20],
    ["2026-08-19T10:00:01.000Z", "minute-a", 30],
    ["2026-08-19T10:00:20.000Z", "minute-b", 40],
    ["2026-07-10T10:01:00.000Z", "hour-a", 50],
    ["2026-07-10T10:40:00.000Z", "hour-b", 60],
    ["2025-06-01T10:00:00.000Z", "day-a", 70],
    ["2025-06-01T18:00:00.000Z", "day-b", 80],
  ].map(([timestamp, threadId, totalTokens]) => ({
    timestamp,
    threadId,
    project: "bounded-history",
    model: "gpt-5.6-luna",
    effort: "medium",
    source: "desktop",
    useType: "interactive",
    serviceTier: null,
    inputTokens: totalTokens - 2,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 1,
    outputTokens: 2,
    reasoningTokens: 1,
    totalTokens,
    toolCalls: 1,
    rateCardCredits: totalTokens / 1_000,
    breakdownAvailable: true,
  }));

  const buckets = buildUsageBuckets(rows, { latestTimestampMs });
  const stats = usageBucketStats(buckets);
  assert.equal(stats.bucketCount, 5);
  assert.equal(stats.callCount, rows.length);
  assert.equal(stats.maximumResolutionSeconds, 86_400);
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
    rows.reduce((sum, row) => sum + row.totalTokens, 0),
  );
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.cacheWriteInputTokens, 0),
    rows.length,
  );
  assert.deepEqual(
    buckets.flatMap((bucket) => bucket.threadIds).sort(),
    rows.map((row) => row.threadId).sort(),
  );
});

test("usage buckets cap safe aggregates and exclude invalid totals", () => {
  const large = 5_000_000_000_000_000;
  const rows = [
    {
      timestamp: "2026-08-22T11:59:58.000Z",
      project: "bounded-history",
      model: "gpt-5.6-luna",
      inputTokens: large - 10,
      cachedInputTokens: large - 20,
      outputTokens: 10,
      reasoningTokens: 5,
      totalTokens: large,
      breakdownAvailable: true,
    },
    {
      timestamp: "2026-08-22T11:59:59.000Z",
      project: "bounded-history",
      model: "gpt-5.6-luna",
      inputTokens: large - 10,
      cachedInputTokens: large - 20,
      outputTokens: 10,
      reasoningTokens: 5,
      totalTokens: large,
      breakdownAvailable: true,
    },
    {
      timestamp: "2026-08-22T12:00:00.000Z",
      project: "bounded-history",
      model: "gpt-5.6-luna",
      inputTokens: "malformed",
      outputTokens: 10,
      totalTokens: 100,
      breakdownAvailable: true,
    },
    {
      timestamp: "2026-08-22T12:00:01.000Z",
      project: "bounded-history",
      model: "gpt-5.6-luna",
      inputTokens: 90,
      outputTokens: 10,
      totalTokens: "100",
      breakdownAvailable: true,
    },
  ];

  const buckets = buildUsageBuckets(rows, {
    latestTimestampMs: Date.parse("2026-08-22T12:00:01.000Z"),
    policy: [{ maximumAgeMs: Infinity, resolutionMs: 86_400_000 }],
  });
  const capped = buckets.find(
    (bucket) => bucket.totalTokens === Number.MAX_SAFE_INTEGER,
  );
  const unknown = buckets.find((bucket) => bucket.totalTokens === 100);
  assert.equal(capped.breakdownAvailable, false);
  assert.equal(capped.inputTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(capped.cachedInputTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(unknown.totalTokens, 100);
  assert.equal(unknown.inputTokens, 0);
  assert.equal(usageBucketStats(buckets).callCount, 3);
  assert.ok(buckets.every((bucket) =>
    [
      bucket.inputTokens,
      bucket.cachedInputTokens,
      bucket.outputTokens,
      bucket.reasoningTokens,
      bucket.totalTokens,
    ].every(Number.isFinite)),
  );
});

test("compacted buckets split proportionally at range boundaries", () => {
  const rows = [
    ["2025-06-01T06:00:00.000Z", 70],
    ["2025-06-01T18:00:00.000Z", 80],
  ].map(([timestamp, totalTokens], index) => ({
    timestamp,
    threadId: `thread-${index}`,
    project: "boundary-history",
    model: "gpt-5.6-luna",
    effort: "medium",
    source: "desktop",
    useType: "interactive",
    serviceTier: null,
    inputTokens: totalTokens - 10,
    cachedInputTokens: 10,
    outputTokens: 10,
    totalTokens,
    callCount: 1,
    breakdownAvailable: true,
  }));
  const [bucket] = buildUsageBuckets(rows, {
    latestTimestampMs: Date.parse("2026-08-23T00:00:00.000Z"),
    policy: [{ maximumAgeMs: Infinity, resolutionMs: 86_400_000 }],
  });
  const fragments = splitUsageBucketsAtBoundaries(
    [bucket],
    [Date.parse("2025-06-01T07:00:00.000Z")],
  );

  assert.equal(fragments.length, 2);
  assert.ok(fragments.every((fragment) => fragment.rangeAllocationEstimated));
  assert.ok(fragments[0].totalTokens > 0);
  assert.ok(fragments[1].totalTokens > 0);
  assert.ok(Math.abs(
    fragments.reduce((sum, fragment) => sum + fragment.totalTokens, 0) -
      bucket.totalTokens,
  ) < 1e-9);
  assert.ok(Math.abs(
    fragments.reduce((sum, fragment) => sum + fragment.inputTokens, 0) -
      bucket.inputTokens,
  ) < 1e-9);
  assert.ok(Math.abs(
    fragments.reduce((sum, fragment) => sum + fragment.callCount, 0) -
      bucket.callCount,
  ) < 1e-9);
  const normalizedFragments = usageBuckets({ events: fragments });
  assert.ok(normalizedFragments.every((fragment) => fragment.breakdownAvailable));
});

test("estimated token components tolerate floating-point reconciliation", () => {
  const normalized = normalizeTokenUsage({
    inputTokens: 0.1,
    outputTokens: 0.5,
    totalTokens: 0.6,
    rangeAllocationEstimated: true,
    breakdownAvailable: true,
  });

  assert.equal(normalized.breakdownAvailable, true);
});

test("usage buckets omit invalid token rows before metadata consumers see them", () => {
  const rows = usageBuckets({
    events: [
      {
        timestamp: "2026-08-22T12:00:00.000Z",
        project: "malformed-project",
        threadId: "malformed-thread",
        totalTokens: "not-a-token-count",
      },
      {
        timestamp: "2026-08-22T12:01:00.000Z",
        project: "valid-project",
        threadId: "valid-thread",
        totalTokens: 10,
        inputTokens: 10,
        outputTokens: 0,
      },
    ],
  });

  assert.deepEqual(
    rows.map(({ project, threadId }) => ({ project, threadId })),
    [{ project: "valid-project", threadId: "valid-thread" }],
  );
});

test("dense recent usage compacts during collection before memory grows unbounded", () => {
  const latestTimestampMs = Date.parse("2026-08-22T12:00:00.000Z");
  const rows = Array.from({ length: 50_100 }, (_, index) => ({
    timestamp: new Date(latestTimestampMs - index).toISOString(),
    threadId: `thread-${index % 10}`,
    project: "dense-history",
    model: "gpt-5.6-luna",
    effort: "medium",
    source: "desktop",
    useType: "interactive",
    serviceTier: null,
    inputTokens: 9,
    cachedInputTokens: 4,
    cacheWriteInputTokens: 1,
    outputTokens: 1,
    reasoningTokens: 0,
    totalTokens: 10,
    toolCalls: 0,
    rateCardCredits: 0.001,
    breakdownAvailable: true,
  }));

  const buckets = buildUsageBuckets(rows, { latestTimestampMs });
  const stats = usageBucketStats(buckets);
  assert.ok(stats.bucketCount < 1_000);
  assert.equal(stats.callCount, rows.length);
  assert.ok(stats.maximumResolutionSeconds >= 300);
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
    501_000,
  );
});

test("snapshot writer coarsens toward its soft target without losing totals", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-adaptive-write-");
  try {
    const output = resolve(root, "snapshot.json.gz");
    const snapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      generatedAt: "2026-08-22T12:00:00.000Z",
      coverage: {},
      threads: [],
      events: Array.from({ length: 2_000 }, (_, index) => ({
        timestamp: new Date(
          Date.parse("2026-08-22T10:00:00.000Z") + index * 1_000,
        ).toISOString(),
        threadId: `thread-${index % 10}`,
        project: "adaptive-history",
        model: "gpt-5.6-luna",
        effort: "medium",
        source: "desktop",
        useType: "interactive",
        serviceTier: null,
        inputTokens: 9,
        cachedInputTokens: 4,
        cacheWriteInputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 10,
        toolCalls: index % 2,
        rateCardCredits: 0.001,
        breakdownAvailable: true,
      })),
    };

    const result = await writePrivateSnapshot(output, snapshot, {
      maxBytes: 64 * 1_024,
      targetBytes: 4 * 1_024,
    });
    const stored = await readPrivateSnapshot(output);
    const stats = usageBucketStats(stored.events);
    assert.ok(result.adaptiveResolutionSeconds >= 300);
    assert.ok(result.bytesWritten <= result.targetBytes);
    assert.equal(stats.callCount, snapshot.events.length);
    assert.equal(
      stored.events.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
      20_000,
    );
    assert.equal(stored.storage.modelCalls, snapshot.events.length);
    assert.equal(stored.coverage.usageBucketCount, stored.events.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function turnStart(timestamp, turnId, model = "gpt-5.5") {
  return [
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turnId,
        started_at: Date.parse(timestamp) / 1000,
      },
    },
    {
      timestamp,
      type: "turn_context",
      payload: { turn_id: turnId, model, effort: "medium" },
    },
  ];
}

async function writeSingleUsageRollout(root, threadId) {
  const timestamp = "2026-08-18T10:00:00.000Z";
  const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
  await mkdir(rolloutDirectory, { recursive: true });
  await writeFile(
    resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
    serialize([
      ...turnStart(timestamp, "turn-state-metadata"),
      tokenCount("2026-08-18T10:00:01.000Z", 100, 100),
    ]),
  );
}

test("state enrichment tolerates missing optional columns and edge table", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-state-schema-");
  const threadId = "abababab-abab-4bab-8bab-abababababab";
  const database = new DatabaseSync(resolve(root, "state_5.sqlite"));
  try {
    database.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, tokens_used INTEGER)",
    );
    database
      .prepare("INSERT INTO threads (id, title, tokens_used) VALUES (?, ?, ?)")
      .run(threadId, "Reduced state schema", 250);
    database.close();
    await writeSingleUsageRollout(root, threadId);

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });

    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].totalTokens, 100);
    assert.equal(snapshot.threads[0].title, "Reduced state schema");
    assert.equal(snapshot.threads[0].reportedCumulativeTokens, 250);
    assert.deepEqual(snapshot.metadata.stateDatabase, {
      status: "available",
      reason: null,
      threadRows: 1,
      parentEdges: 0,
    });
  } finally {
    if (database.isOpen) database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("thread rows survive an incompatible spawn-edge schema", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-state-edges-");
  const threadId = "acacacac-acac-4cac-8cac-acacacacacac";
  const database = new DatabaseSync(resolve(root, "state_5.sqlite"));
  try {
    database.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT);" +
        "CREATE TABLE thread_spawn_edges (parent TEXT, child TEXT)",
    );
    database
      .prepare("INSERT INTO threads (id, title) VALUES (?, ?)")
      .run(threadId, "Usable thread metadata");
    database.close();
    await writeSingleUsageRollout(root, threadId);

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });

    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(snapshot.threads[0].title, "Usable thread metadata");
    assert.deepEqual(snapshot.metadata.stateDatabase, {
      status: "partial",
      reason: "schema-mismatch",
      threadRows: 1,
      parentEdges: 0,
    });
  } finally {
    if (database.isOpen) database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rollout totals survive an incompatible state database schema", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-state-mismatch-");
  const threadId = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";
  const database = new DatabaseSync(resolve(root, "state_5.sqlite"));
  try {
    database.exec("CREATE TABLE unrelated_metadata (value TEXT)");
    database.close();
    await writeSingleUsageRollout(root, threadId);

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });

    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(snapshot.events.length, 1);
    assert.deepEqual(snapshot.metadata.stateDatabase, {
      status: "unavailable",
      reason: "schema-mismatch",
      threadRows: 0,
      parentEdges: 0,
    });
  } finally {
    if (database.isOpen) database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rollout totals survive a corrupt state database", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-state-corrupt-");
  const threadId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
  try {
    await writeFile(resolve(root, "state_5.sqlite"), "not a sqlite database");
    await writeSingleUsageRollout(root, threadId);

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });

    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(snapshot.events.length, 1);
    assert.deepEqual(snapshot.metadata.stateDatabase, {
      status: "unavailable",
      reason: "corrupt",
      threadRows: 0,
      parentEdges: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollout totals survive a busy state database", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-state-busy-");
  const threadId = "dededede-dede-4ede-8ede-dededededede";
  const database = new DatabaseSync(resolve(root, "state_5.sqlite"));
  try {
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY)");
    database.exec("BEGIN EXCLUSIVE");
    await writeSingleUsageRollout(root, threadId);

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });

    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(snapshot.events.length, 1);
    assert.deepEqual(snapshot.metadata.stateDatabase, {
      status: "unavailable",
      reason: "busy",
      threadRows: 0,
      parentEdges: 0,
    });
  } finally {
    if (database.isOpen) {
      database.exec("ROLLBACK");
      database.close();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("source labels resolve structured, encoded, and plain thread sources", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  const parentId = "99999999-9999-4999-8999-999999999999";
  const threads = [
    {
      id: "44444444-4444-4444-8444-444444444444",
      turn: "turn-a",
      timestamp: "2026-08-18T10:00:00.000Z",
      total: 100,
      source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
      expected: { source: "subagent", useType: "subagent" },
    },
    {
      id: "55555555-5555-4555-8555-555555555555",
      turn: "turn-b",
      timestamp: "2026-08-18T11:00:00.000Z",
      total: 200,
      source: "exec",
      expected: { source: "cli", useType: "cli" },
    },
    {
      id: "66666666-6666-4666-8666-666666666666",
      turn: "turn-c",
      timestamp: "2026-08-18T12:00:00.000Z",
      total: 300,
      source: '{"subagent":{"id":"delegated"}}',
      expected: { source: "subagent", useType: "subagent" },
    },
    {
      id: "77777777-7777-4777-8777-777777777777",
      turn: "turn-d",
      timestamp: "2026-08-18T13:00:00.000Z",
      total: 400,
      source: "a custom launcher label that runs far past forty characters",
      expected: {
        source: "a custom launcher label that runs far pa",
        useType: "interactive",
      },
    },
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      turn: "turn-e",
      timestamp: "2026-08-18T14:00:00.000Z",
      total: 500,
      source: { toString: null, valueOf: null },
      expected: { source: "unknown", useType: "unknown" },
    },
  ];
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    for (const thread of threads) {
      await writeFile(
        resolve(rolloutDirectory, `rollout-${thread.id}.jsonl`),
        serialize([
          {
            timestamp: thread.timestamp,
            type: "session_meta",
            payload: { id: thread.id, source: thread.source },
          },
          ...turnStart(thread.timestamp, thread.turn),
          tokenCount(thread.timestamp, thread.total, thread.total),
        ]),
      );
    }

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.events.length, threads.length);
    for (const [index, thread] of threads.entries()) {
      assert.equal(snapshot.events[index].source, thread.expected.source);
      assert.equal(snapshot.events[index].useType, thread.expected.useType);
    }
    const subagentThread = snapshot.threads.find(
      (thread) => thread.id === threads[0].id,
    );
    assert.equal(subagentThread.parentThreadId, parentId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collection retries when an inventoried rollout disappears mid-scan", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-source-mutation-");
  const firstId = "12121212-1212-4121-8121-121212121212";
  const secondId = "34343434-3434-4343-8434-343434343434";
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "23");
    await mkdir(rolloutDirectory, { recursive: true });
    const rows = [
      [firstId, "2026-08-23T10:00:00.000Z"],
      [secondId, "2026-08-23T10:01:00.000Z"],
    ];
    await writeFile(
      resolve(root, "session_index.jsonl"),
      serialize(rows.map(([id, timestamp]) => ({
        id,
        thread_name: `thread-${id.slice(0, 4)}`,
        updated_at: timestamp,
      }))),
    );
    for (const [id, timestamp] of rows) {
      await writeFile(
        resolve(rolloutDirectory, `rollout-${id}.jsonl`),
        serialize([
          {
            timestamp,
            type: "session_meta",
            payload: { id, source: "desktop", cwd: "project" },
          },
          ...turnStart(timestamp, `turn-${id.slice(0, 4)}`),
          tokenCount(
            new Date(Date.parse(timestamp) + 1_000).toISOString(),
            100,
            100,
          ),
        ]),
      );
    }

    let removed = false;
    const snapshot = await collectUsage(
      {
        output: resolve(root, "snapshot.json"),
        codexHome: root,
        includeArchived: true,
        since: null,
      },
      async ({ current }) => {
        if (current === 1 && !removed) {
          removed = true;
          await rm(resolve(rolloutDirectory, `rollout-${secondId}.jsonl`));
        }
      },
    );

    assert.equal(removed, true);
    assert.equal(snapshot.coverage.filesScanned, 1);
    assert.equal(snapshot.coverage.observedModelCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("since filters events and quotas while recording archive scope", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-since-");
  const activeThreadId = "abababab-abab-4aba-8aba-abababababab";
  const archivedThreadId = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
  const cutoff = new Date("2026-08-18T12:00:00.000Z");
  const quotaRecord = (timestamp, usedPercent) => ({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: {
          window_minutes: 10_080,
          used_percent: usedPercent,
          resets_at: Date.parse("2026-08-25T00:00:00.000Z") / 1_000,
        },
        plan_type: "plus",
      },
    },
  });
  try {
    const activeDirectory = resolve(root, "sessions", "2026", "08", "18");
    const archivedDirectory = resolve(root, "archived_sessions", "2026", "08", "18");
    await mkdir(activeDirectory, { recursive: true });
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(
      resolve(activeDirectory, `rollout-${activeThreadId}.jsonl`),
      serialize([
        ...turnStart("2026-08-18T10:00:00.000Z", "old-turn"),
        quotaRecord("2026-08-18T10:00:00.000Z", 10),
        tokenCount("2026-08-18T10:00:01.000Z", 100, 100),
        ...turnStart("2026-08-18T13:00:00.000Z", "new-turn"),
        quotaRecord("2026-08-18T13:00:00.000Z", 20),
        tokenCount("2026-08-18T13:00:01.000Z", 200, 100),
      ]),
    );
    await writeFile(
      resolve(archivedDirectory, `rollout-${archivedThreadId}.jsonl`),
      serialize([
        ...turnStart("2026-08-18T13:00:00.000Z", "archived-turn"),
        tokenCount("2026-08-18T13:00:01.000Z", 300, 300),
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: false,
      since: cutoff,
    });

    assert.equal(snapshot.coverage.observedModelCalls, 1);
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].totalTokens, 100);
    assert.equal(snapshot.threads.length, 1);
    assert.equal(snapshot.threads[0].eventCount, 1);
    assert.equal(snapshot.quotaObservations.length, 1);
    assert.equal(snapshot.quotaObservations[0].timestamp, "2026-08-18T13:00:00.000Z");
    assert.deepEqual(snapshot.provenance.collection, {
      since: cutoff.toISOString(),
      includeArchived: false,
    });
    assert.equal(snapshot.coverage.completeSinceWindowStart, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid usage makes its source evidence-only", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  const threadId = "88888888-8888-4888-8888-888888888888";
  const timestamp = "2026-08-18T10:00:00.000Z";
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize([
        ...turnStart(timestamp, "turn-1"),
        {
          timestamp,
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: "garbage",
            info: { last_token_usage: "garbage", total_token_usage: 7 },
          },
        },
        {
          timestamp,
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: {
                window_minutes: 10080,
                used_percent: 12.5,
                resets_at: Date.parse("2026-08-24T00:00:00.000Z") / 1000,
              },
              plan_type: "plus",
              limit_name: "weekly",
            },
          },
        },
        tokenCount("2026-08-18T10:00:01.000Z", 100, 100),
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.coverage.invalidTokenRecords, 1);
    assert.equal(snapshot.events.length, 0);
    assert.equal(snapshot.quotaObservations.length, 0);
    assert.equal(snapshot.coverage.parseErrors, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("null live timestamps never enter durable retention", async () => {
  const { root, directory } = await createRolloutFixture(
    [100],
    "rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
  );
  const invalidFile = resolve(
    directory,
    "rollout-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl",
  );
  const output = resolve(root, "snapshot.json");
  const invalidRows = rolloutRows([200]);
  invalidRows[1].timestamp = null;
  try {
    await writeFile(invalidFile, serialize(invalidRows));
    const snapshot = await collectUsage({
      output,
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    const ledger = await readDurableLedger(
      resolveDurableLedgerPath({ codexHome: root }),
    );

    assert.equal(snapshot.coverage.invalidTokenRecords, 1);
    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.deepEqual(
      ledger.usageRows.map((row) => row.totalTokens),
      [100],
    );
    assert.equal(
      ledger.usageRows.some((row) => row.timestamp.startsWith("1970-")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid usage in a separate source makes weekly completeness false", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-completeness-");
  const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
  const eventTimestamp = "2026-08-18T10:00:00.000Z";
  const quotaTimestamp = "2026-08-24T10:00:00.000Z";
  const resetsAt = Date.parse("2026-08-30T00:00:00.000Z") / 1_000;
  try {
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(
        rolloutDirectory,
        "rollout-11111111-1111-4111-8111-111111111111.jsonl",
      ),
      serialize([
        ...turnStart(eventTimestamp, "turn-valid"),
        tokenCount(eventTimestamp, 100, 100),
        {
          timestamp: quotaTimestamp,
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: {
                window_minutes: 10_080,
                used_percent: 40,
                resets_at: resetsAt,
              },
              plan_type: "plus",
            },
          },
        },
      ]),
    );
    await writeFile(
      resolve(
        rolloutDirectory,
        "rollout-22222222-2222-4222-8222-222222222222.jsonl",
      ),
      serialize([
        ...turnStart(quotaTimestamp, "turn-invalid"),
        {
          timestamp: quotaTimestamp,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: "garbage",
              total_token_usage: 7,
            },
          },
        },
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });

    assert.equal(snapshot.coverage.observedTokens, 100);
    assert.equal(snapshot.quotaObservations.length, 1);
    assert.equal(snapshot.quotaObservations[0].scope, "account");
    assert.equal(snapshot.coverage.parseErrors, 0);
    assert.equal(snapshot.coverage.invalidTokenRecords, 1);
    assert.equal(snapshot.coverage.completeSinceWindowStart, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates token totals and preserves malformed breakdowns as unknown", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-token-validation-");
  const threadId = "91919191-9191-4919-8919-919191919191";
  const validThreadId = "92929292-9292-4929-8929-929292929292";
  const validUsage = {
    input_tokens: 90,
    cached_input_tokens: 500,
    output_tokens: 10,
    reasoning_output_tokens: 40,
    total_tokens: 100,
  };
  const tokenRecord = (timestamp, usage) => ({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage,
        last_token_usage: usage,
        model_context_window: 128000,
      },
    },
  });
  const invalidTotals = [
    -1,
    100.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_VALUE,
    "100",
    true,
    [100],
    { value: 100 },
  ];
  const invalidRows = [];
  for (const [index, total] of invalidTotals.entries()) {
    const timestamp = new Date(
      Date.parse("2026-08-18T10:00:00.000Z") + index * 60_000,
    ).toISOString();
    invalidRows.push(...turnStart(timestamp, `invalid-${index}`));
    invalidRows.push(
      tokenRecord(timestamp, { ...validUsage, total_tokens: total }),
    );
  }
  const validRows = [];
  const validTimestamp = "2026-08-18T20:00:00.000Z";
  validRows.push(...turnStart(validTimestamp, "valid-turn"));
  validRows.push(tokenRecord(validTimestamp, validUsage));
  const malformedBreakdownTimestamp = "2026-08-18T20:01:00.000Z";
  validRows.push(...turnStart(malformedBreakdownTimestamp, "unknown-turn"));
  validRows.push(tokenRecord(malformedBreakdownTimestamp, {
    ...validUsage,
    input_tokens: "90",
  }));

  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize(invalidRows),
    );
    await writeFile(
      resolve(rolloutDirectory, `rollout-${validThreadId}.jsonl`),
      serialize(validRows),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.coverage.invalidTokenRecords, invalidTotals.length);
    assert.equal(snapshot.coverage.observedModelCalls, 2);
    assert.equal(snapshot.coverage.observedTokens, 200);
    assert.equal(snapshot.coverage.detailedTokens, 100);
    assert.equal(snapshot.coverage.unknownBreakdownTokens, 100);
    assert.equal(snapshot.coverage.detailedPercent, 50);
    assert.equal(snapshot.events.length, 2);

    const validEvent = snapshot.events.find(
      (event) => event.breakdownAvailable === true,
    );
    const unknownEvent = snapshot.events.find(
      (event) => event.breakdownAvailable === false,
    );
    assert.equal(validEvent.cachedInputTokens, 90);
    assert.equal(validEvent.reasoningTokens, 10);
    assert.equal(validEvent.rateCardCredits !== null, true);
    assert.equal(unknownEvent.totalTokens, 100);
    assert.equal(unknownEvent.inputTokens, 0);
    assert.equal(unknownEvent.rateCardCredits, null);

    const [thread] = snapshot.threads;
    assert.equal(thread.totalTokens, 200);
    assert.equal(thread.detailedTokens, 100);
    assert.equal(thread.unknownBreakdownTokens, 100);
    assert.equal(thread.coverage, "partial");
    assert.equal(thread.rateCardCredits, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coverage preserves unknown totals after safe-counter saturation", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-saturation-");
  const threadId = "13131313-1313-4131-8131-131313131313";
  const firstTimestamp = "2026-08-18T21:00:00.000Z";
  const secondTimestamp = "2026-08-18T21:01:00.000Z";
  const thirdTimestamp = "2026-08-18T21:02:00.000Z";
  const huge = Number.MAX_SAFE_INTEGER;
  const totalOnlyRecord = (timestamp) => ({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: huge },
        last_token_usage: { total_tokens: huge },
        model_context_window: 128000,
      },
    },
  });

  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize([
        ...turnStart(firstTimestamp, "saturation-detailed"),
        tokenCount(firstTimestamp, huge, huge),
        ...turnStart(secondTimestamp, "saturation-detailed-second"),
        tokenCount(secondTimestamp, huge, huge),
        ...turnStart(thirdTimestamp, "saturation-unknown"),
        totalOnlyRecord(thirdTimestamp),
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    const [thread] = snapshot.threads;
    assert.equal(snapshot.coverage.observedTokens, huge);
    assert.ok(snapshot.coverage.detailedTokens < huge);
    assert.ok(snapshot.coverage.unknownBreakdownTokens < huge);
    assert.ok(
      Math.abs(snapshot.coverage.detailedPercent - (2 / 3) * 100) < 1e-12,
    );
    assert.equal(thread.unknownBreakdownTokens, huge);
    assert.equal(thread.coverage, "partial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quota identities follow canonical provider ids with optional metadata", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  const timestamp = "2026-08-18T10:00:00.000Z";
  const resetsAt = Date.parse("2026-08-24T00:00:00.000Z") / 1_000;
  const quotaRecord = (offset, rateLimits) => ({
    timestamp: new Date(Date.parse(timestamp) + offset * 1_000).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: rateLimits,
    },
  });
  const bucket = (usedPercent) => ({
    window_minutes: 10_080,
    used_percent: usedPercent,
    resets_at: resetsAt,
  });

  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, "rollout-scopes.jsonl"),
      serialize([
        ...turnStart(timestamp, "turn-1"),
        // Legacy snapshots may omit every optional identity/label field.
        quotaRecord(1, { primary: bucket(10) }),
        quotaRecord(2, {
          primary: bucket(20),
          limit_id: "   ",
          limit_name: "Default display",
          plan_type: null,
        }),
        quotaRecord(3, {
          primary: bucket(30),
          limit_id: "CoDeX-Secondary",
        }),
        quotaRecord(4, {
          primary: bucket(40),
          limit_id: "codex_secondary",
          limit_name: "Luna",
          plan_type: "future_plan",
        }),
        quotaRecord(5, null),
        tokenCount(timestamp, 100, 100),
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.coverage.invalidQuotaRecords, 0);
    assert.equal(snapshot.quotaObservations.length, 4);
    const account = snapshot.quotaObservations.filter(
      (quota) => quota.scope === "account",
    );
    const named = snapshot.quotaObservations.filter(
      (quota) => quota.scope === "named",
    );
    assert.equal(account.length, 2);
    assert.equal(named.length, 2);
    assert.equal(new Set(account.map((quota) => quota.limitKey)).size, 1);
    assert.equal(new Set(named.map((quota) => quota.limitKey)).size, 1);
    assert.notEqual(account[0].limitKey, named[0].limitKey);
    assert.deepEqual(
      account.map((quota) => quota.limitName),
      ["Default display", "Default display"],
    );
    assert.deepEqual(
      named.map((quota) => quota.limitName),
      ["Luna", "Luna"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed present quota identity metadata is excluded", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-quota-identity-");
  const timestamp = "2026-08-18T10:00:00.000Z";
  const resetsAt = Date.parse("2026-08-24T00:00:00.000Z") / 1_000;
  const bucket = {
    window_minutes: 10_080,
    used_percent: 25,
    resets_at: resetsAt,
  };
  const rateLimits = [
    { primary: bucket, limit_id: 7 },
    { primary: bucket, limit_name: { label: "Luna" } },
    { primary: bucket, plan_type: ["plus"] },
    { primary: bucket, plan_type: "   " },
    { primary: bucket, limit_name: "   " },
  ];
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, "rollout-invalid-identity.jsonl"),
      serialize([
        ...turnStart(timestamp, "turn-invalid-identity"),
        ...rateLimits.map((rate_limits, index) => ({
          timestamp: new Date(Date.parse(timestamp) + index * 1_000).toISOString(),
          type: "event_msg",
          payload: { type: "token_count", rate_limits },
        })),
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });

    assert.equal(snapshot.coverage.invalidQuotaRecords, 4);
    assert.equal(snapshot.quotaObservations.length, 1);
    assert.equal(snapshot.quotaObservations[0].limitName, null);
    assert.equal(snapshot.quotaObservations[0].scope, "account");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quota fields reject malformed values without fabricating durable meters", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-quota-validation-");
  const output = resolve(root, "snapshot.json");
  const timestamp = "2026-08-18T10:00:00.000Z";
  const resetsAt = Date.parse("2026-08-24T00:00:00.000Z") / 1_000;
  const validThreadId = "30303030-3030-4030-8030-303030303030";
  const invalidThreadId = "40404040-4040-4040-8040-404040404040";
  const validRateLimits = {
    primary: {
      window_minutes: 1,
      used_percent: 0,
      resets_at: 1,
    },
    secondary: {
      window_minutes: 10_080,
      used_percent: 100,
      resets_at: resetsAt,
    },
    limit_id: "boundary",
    plan_type: "plus",
  };
  const invalidBuckets = [
    { window_minutes: 10_080, resets_at: resetsAt },
    { window_minutes: 10_080, used_percent: null, resets_at: resetsAt },
    { window_minutes: 10_080, used_percent: "5", resets_at: resetsAt },
    { window_minutes: 10_080, used_percent: -1, resets_at: resetsAt },
    { window_minutes: 10_080, used_percent: 100.01, resets_at: resetsAt },
    {
      window_minutes: 10_080,
      used_percent: "__NONFINITE_PERCENT__",
      resets_at: resetsAt,
    },
    { used_percent: 5, resets_at: resetsAt },
    { window_minutes: null, used_percent: 5, resets_at: resetsAt },
    { window_minutes: "10080", used_percent: 5, resets_at: resetsAt },
    { window_minutes: 0, used_percent: 5, resets_at: resetsAt },
    { window_minutes: -1, used_percent: 5, resets_at: resetsAt },
    { window_minutes: 1.5, used_percent: 5, resets_at: resetsAt },
    { window_minutes: 10_080, used_percent: 5 },
    { window_minutes: 10_080, used_percent: 5, resets_at: null },
    { window_minutes: 10_080, used_percent: 5, resets_at: "1" },
    { window_minutes: 10_080, used_percent: 5, resets_at: 0 },
    { window_minutes: 10_080, used_percent: 5, resets_at: -1 },
    { window_minutes: 10_080, used_percent: 5, resets_at: 1.5 },
    {
      window_minutes: 10_080,
      used_percent: 5,
      resets_at: Number.MAX_VALUE,
    },
    {
      window_minutes: 10_080,
      used_percent: 5,
      resets_at: "__NONFINITE_RESET__",
    },
    "garbage",
  ];
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, `rollout-${validThreadId}.jsonl`),
      serialize([
        ...turnStart(timestamp, "turn-valid-boundaries"),
        {
          timestamp,
          type: "event_msg",
          payload: { type: "token_count", rate_limits: validRateLimits },
        },
        tokenCount(timestamp, 100, 100),
      ]),
    );
    const invalidRows = invalidBuckets.map((primary, index) => ({
      timestamp: new Date(Date.parse(timestamp) + index * 1_000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary,
          limit_id: "invalid",
          plan_type: "plus",
        },
      },
    }));
    invalidRows.push({
      timestamp,
      type: "event_msg",
      payload: { type: "token_count", rate_limits: "garbage" },
    });
    const invalidContents = serialize([
      ...turnStart(timestamp, "turn-invalid-quotas"),
      ...invalidRows,
    ])
      .replace('"__NONFINITE_PERCENT__"', "1e309")
      .replace('"__NONFINITE_RESET__"', "1e309");
    await writeFile(
      resolve(rolloutDirectory, `rollout-${invalidThreadId}.jsonl`),
      invalidContents,
    );

    const first = await collectUsage({
      output,
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    const reloaded = await collectUsage({
      output,
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    const ledger = await readDurableLedger(resolveDurableLedgerPath({ codexHome: root }));
    const expectedInvalid = invalidBuckets.length + 1;

    assert.equal(first.coverage.invalidQuotaRecords, expectedInvalid);
    assert.equal(reloaded.coverage.invalidQuotaRecords, expectedInvalid);
    assert.equal(first.coverage.completeSinceWindowStart, false);
    assert.deepEqual(
      first.quotaObservations.map((quota) => quota.usedPercent).sort(
        (left, right) => left - right,
      ),
      [0, 100],
    );
    assert.deepEqual(
      reloaded.quotaObservations.map((quota) => quota.usedPercent).sort(
        (left, right) => left - right,
      ),
      [0, 100],
    );
    assert.deepEqual(
      ledger.quotaRows.map((quota) => quota.usedPercent).sort(
        (left, right) => left - right,
      ),
      [0, 100],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collector CLI reports excluded quota records", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-quota-cli-");
  const output = resolve(root, "snapshot.json");
  const timestamp = "2026-08-18T10:00:00.000Z";
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(
        rolloutDirectory,
        "rollout-50505050-5050-4050-8050-505050505050.jsonl",
      ),
      serialize([
        ...turnStart(timestamp, "turn-invalid-quota-cli"),
        {
          timestamp,
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: {
                window_minutes: 10_080,
                used_percent: -1,
                resets_at: Date.parse("2026-08-24T00:00:00.000Z") / 1_000,
              },
            },
          },
        },
      ]),
    );
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../lib/token-ledger-importer.mjs", import.meta.url)),
        "--codex-home",
        root,
        "--output",
        output,
      ],
      {
        encoding: "utf8",
        env: process.env,
        timeout: 30_000,
      },
    );

    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /Invalid quota records excluded: 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("named-only quota observations do not establish complete history", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  const eventTimestamp = "2026-08-19T10:00:00.000Z";
  const quotaTimestamp = "2026-08-20T10:00:00.000Z";
  const resetsAt = Date.parse("2026-08-27T00:00:00.000Z") / 1_000;
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "19");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, "rollout-named-only.jsonl"),
      serialize([
        ...turnStart(eventTimestamp, "turn-1"),
        tokenCount(eventTimestamp, 100, 100),
        {
          timestamp: quotaTimestamp,
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: {
                window_minutes: 10_080,
                used_percent: 40,
                resets_at: resetsAt,
              },
              limit_id: "named-luna",
              limit_name: "Luna",
            },
          },
        },
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.quotaObservations[0].scope, "named");
    assert.equal(snapshot.coverage.completeSinceWindowStart, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged quota readings retain their full observed span", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  const threadId = "89898989-8989-4989-8989-898989898989";
  const firstSeenAt = "2026-08-23T17:59:20.000Z";
  const lastSeenAt = "2026-08-23T18:08:57.000Z";
  const resetsAt = Date.parse("2026-08-26T10:00:00.000Z") / 1_000;
  const quotaRecord = (timestamp) => ({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: {
          window_minutes: 10_080,
          used_percent: 80,
          resets_at: resetsAt,
        },
        plan_type: "plus",
      },
    },
  });

  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "23");
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      serialize([
        ...turnStart(firstSeenAt, "turn-1"),
        quotaRecord(firstSeenAt),
        quotaRecord(lastSeenAt),
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.quotaObservations.length, 1);
    assert.equal(snapshot.quotaObservations[0].timestamp, firstSeenAt);
    assert.equal(snapshot.quotaObservations[0].lastSeenAt, lastSeenAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cold scans conservatively skip irrelevant JSONL lines", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  const threadId = "abababab-abab-4bab-8bab-abababababab";
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "23");
    await mkdir(rolloutDirectory, { recursive: true });
    const timestamp = "2026-08-23T10:00:00.000Z";
    const lines = [
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "ignored" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", body: "ignored" },
      }),
      JSON.stringify({ type: "unrelated", payload: { type: "token_count" } }),
      JSON.stringify({}),
      ...turnStart(timestamp, "turn-1").map((row) => JSON.stringify(row)),
      "not-json",
      JSON.stringify(tokenCount("2026-08-23T10:00:01.000Z", 100, 100)),
    ];
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const originalParse = JSON.parse;
    let parseCount = 0;
    let snapshot;
    try {
      JSON.parse = (...args) => {
        parseCount += 1;
        return originalParse(...args);
      };
      snapshot = await collectUsageSequential({
        output: resolve(root, "snapshot.json"),
        codexHome: root,
        includeArchived: true,
        since: null,
      });
    } finally {
      JSON.parse = originalParse;
    }

    assert.equal(parseCount, 4);
    assert.equal(snapshot.coverage.parseErrors, 1);
    assert.equal(snapshot.coverage.filesScanned, 1);
    assert.equal(snapshot.events.length, 0);
    assert.equal(snapshot.coverage.observedModelCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cold scans pass escaped top-level type keys to the full parser", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  const threadId = "abababab-abab-4bab-8bab-abababababab";
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "23");
    await mkdir(rolloutDirectory, { recursive: true });
    const timestamp = "2026-08-23T10:00:00.000Z";
    const escapedTypeKey = JSON.stringify(
      tokenCount("2026-08-23T10:00:01.000Z", 100, 100),
    ).replace(
      '"type":"event_msg"',
      '"t\\u0079pe":"event_msg"',
    );
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      `${turnStart(timestamp, "turn-1").map((row) => JSON.stringify(row)).join("\n")}\n${escapedTypeKey}\n`,
    );

    const snapshot = await collectUsageSequential({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });

    assert.equal(snapshot.coverage.parseErrors, 0);
    assert.equal(snapshot.coverage.observedModelCalls, 1);
    assert.equal(snapshot.events.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded scans match the sequential reference across collector fixtures", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  const threadId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
  const parentId = "efefefef-efef-4fef-8fef-efefefefefef";
  const firstTimestamp = "2026-08-20T10:00:00.000Z";
  const duplicateTimestamp = "2026-08-20T10:00:01.000Z";
  const correctionTimestamp = "2026-08-20T10:00:02.000Z";
  const archivedTimestamp = "2026-08-23T10:00:00.000Z";
  const rateLimits = {
    primary: {
      window_minutes: 10_080,
      used_percent: 80,
      resets_at: Date.parse("2026-08-30T10:00:00.000Z") / 1_000,
    },
  };
  try {
    const sessionDirectory = resolve(root, "sessions", "2026", "08", "20");
    const archivedDirectory = resolve(
      root,
      "archived_sessions",
      "2026",
      "08",
      "23",
    );
    await mkdir(sessionDirectory, { recursive: true });
    await mkdir(archivedDirectory, { recursive: true });

    const first = tokenCount(firstTimestamp, 100, 100);
    first.payload.rate_limits = rateLimits;
    const duplicate = tokenCount(duplicateTimestamp, 100, 100);
    duplicate.payload.rate_limits = rateLimits;
    const correction = tokenCount(correctionTimestamp, 80, 80);
    const mainRows = [
      {
        timestamp: firstTimestamp,
        type: "session_meta",
        payload: { id: threadId, parent_thread_id: parentId },
      },
      ...turnStart(firstTimestamp, "turn-main"),
      first,
      duplicate,
      correction,
    ];
    await writeFile(
      resolve(sessionDirectory, `rollout-${threadId}.jsonl`),
      `${serialize(mainRows.slice(0, 5))}not-json\n${serialize(mainRows.slice(5))}`,
    );
    await writeFile(
      resolve(
        archivedDirectory,
        "rollout-11111111-1111-4111-8111-111111111111.jsonl",
      ),
      serialize([
        ...turnStart(archivedTimestamp, "turn-archived"),
        tokenCount("2026-08-23T10:00:01.000Z", 50, 50),
      ]),
    );

    function withoutGeneratedAt(snapshot) {
      const stableSnapshot = { ...snapshot };
      delete stableSnapshot.generatedAt;
      stableSnapshot.provenance = { ...stableSnapshot.provenance };
      delete stableSnapshot.provenance.sourceCutoffAt;
      stableSnapshot.metadata = { ...stableSnapshot.metadata };
      stableSnapshot.metadata.durableLedger = {
        ...stableSnapshot.metadata.durableLedger,
      };
      delete stableSnapshot.metadata.durableLedger.revision;
      return stableSnapshot;
    }

    async function collectPair(includeArchived, since, suffix) {
      const options = {
        output: resolve(root, `parallel-${suffix}.json`),
        codexHome: root,
        includeArchived,
        since,
      };
      const progress = [];
      const parallel = await collectUsage(options, ({ current }) => {
        progress.push(current);
      });
      const sequential = await collectUsageSequential({
        ...options,
        output: resolve(root, `sequential-${suffix}.json`),
      });
      assert.deepEqual(
        withoutGeneratedAt(parallel),
        withoutGeneratedAt(sequential),
      );
      return { parallel, progress };
    }

    const all = await collectPair(true, null, "all");
    assert.deepEqual(all.progress, [1, 2]);
    assert.equal(all.parallel.coverage.duplicateEventsSkipped, 0);
    assert.equal(all.parallel.coverage.correctionIntervals, 1);
    assert.equal(all.parallel.coverage.parseErrors, 1);
    assert.equal(all.parallel.quotaObservations.length, 0);
    assert.equal(all.parallel.threads[0].parentThreadId, null);
    assert.equal(all.parallel.coverage.observedModelCalls, 1);

    const withoutArchived = await collectPair(false, null, "active");
    assert.equal(withoutArchived.parallel.coverage.observedModelCalls, 0);

    const since = await collectPair(
      true,
      new Date("2026-08-23T00:00:00.000Z"),
      "since",
    );
    assert.equal(since.parallel.coverage.observedModelCalls, 1);
    assert.equal(since.parallel.quotaObservations.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruning a queued rollout mid-scan retries the collection and removes the temporary spool", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "23");
    await mkdir(rolloutDirectory, { recursive: true });
    const ignored = JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", body: "ignored" },
    });
    const largeContent = `${Array(20_000).fill(ignored).join("\n")}\n`;
    const paths = [];
    for (let index = 0; index < 5; index += 1) {
      const suffix = String(index + 1).padStart(12, "0");
      const path = resolve(
        rolloutDirectory,
        `rollout-00000000-0000-4000-8000-${suffix}.jsonl`,
      );
      paths.push(path);
      await writeFile(path, index === 0 ? `${ignored}\n` : largeContent);
    }

    const spoolPrefix = `token-ledger-import-${process.pid}-`;
    const before = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith(spoolPrefix))
      .sort();
    let removed = false;
    let privateSpoolObserved = false;
    const snapshot = await collectUsage(
      {
        output: resolve(root, "snapshot.json"),
        codexHome: root,
        includeArchived: false,
        since: null,
      },
      async ({ current }) => {
        if (current === 1 && !removed) {
          const activeSpools = (await readdir(tmpdir()))
            .filter((entry) => entry.startsWith(spoolPrefix))
            .filter((entry) => !before.includes(entry));
          assert.equal(activeSpools.length, 1);
          const spoolDirectory = resolve(tmpdir(), activeSpools[0]);
          const directoryStat = await stat(spoolDirectory);
          const databaseStat = await stat(resolve(spoolDirectory, "usage.sqlite"));
          assert.equal(directoryStat.mode & 0o777, 0o700);
          assert.equal(databaseStat.mode & 0o777, 0o600);
          assert.equal(Number(directoryStat.uid), process.getuid?.());
          privateSpoolObserved = true;
          removed = true;
          if (existsSync(paths[4])) rmSync(paths[4]);
        }
      },
    );
    const after = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith(spoolPrefix))
      .sort();
    assert.deepEqual(after, before);
    assert.equal(removed, true);
    assert.equal(privateSpoolObserved, true);
    assert.equal(snapshot.coverage.filesScanned, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deeply nested rollout records fall back to the standard parser", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "23");
    await mkdir(rolloutDirectory, { recursive: true });
    const depth = 10_000;
    const nested = `{"a":${"[".repeat(depth)}${"]".repeat(depth)}}`;
    await writeFile(
      resolve(
        rolloutDirectory,
        "rollout-00000000-0000-4000-8000-000000000001.jsonl",
      ),
      `${nested}\n`,
    );

    const snapshot = await collectUsageSequential({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: false,
      since: null,
    });
    assert.equal(snapshot.coverage.filesScanned, 1);
    assert.equal(snapshot.coverage.parseErrors, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejected async progress callbacks fail collection cleanly", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-importer-");
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "23");
    await mkdir(rolloutDirectory, { recursive: true });
    const ignored = JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", body: "ignored" },
    });
    for (let index = 0; index < 2; index += 1) {
      const suffix = String(index + 1).padStart(12, "0");
      await writeFile(
        resolve(rolloutDirectory, `rollout-00000000-0000-4000-8000-${suffix}.jsonl`),
        `${ignored}\n`,
      );
    }
    const options = {
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: false,
      since: null,
    };

    await assert.rejects(
      () =>
        collectUsage(options, async ({ current }) => {
          if (current === 1) throw new Error("progress callback failed");
        }),
      /progress callback failed/,
    );
    await assert.rejects(
      () =>
        collectUsageSequential(options, async ({ current }) => {
          if (current === 1) throw new Error("progress callback failed");
        }),
      /progress callback failed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
