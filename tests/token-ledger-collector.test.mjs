import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  collectUsage,
  latestSourceModifiedAt,
  sourceFingerprint,
  sourceState,
  writePrivateSnapshot,
} from "../lib/token-ledger-collector.mjs";

function usageRecord(timestamp, turnId, total, last, model) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: total - 10,
          cached_input_tokens: Math.min(20, total - 10),
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: total,
        },
        last_token_usage: {
          input_tokens: last - 10,
          cached_input_tokens: Math.min(20, last - 10),
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: last,
        },
        model_context_window: 128000,
      },
      rate_limits: {
        limit_id: "synthetic-weekly",
        plan_type: "synthetic",
        primary: {
          used_percent: total === 100 ? 10 : 11,
          window_minutes: 10080,
          resets_at: 1750604800,
        },
        secondary: null,
      },
    },
    model,
    turnId,
  };
}

function serialize(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function findForbiddenKeys(value, path = "root", found = []) {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    if ([
      "cwd",
      "title",
      "threadTitle",
      "gitOrigin",
      "git_origin_url",
      "repository_url",
    ].includes(key)) {
      found.push(`${path}.${key}`);
    }
    findForbiddenKeys(child, `${path}.${key}`, found);
  }
  return found;
}

test("collector de-duplicates copied history and omits titles and full paths", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-collector-"));
  try {
    const sessions = resolve(root, "sessions", "2025", "06", "15");
    await mkdir(sessions, { recursive: true });
    const database = new DatabaseSync(resolve(root, "state_5.sqlite"));
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        created_at INTEGER,
        updated_at INTEGER,
        source TEXT,
        cwd TEXT,
        title TEXT,
        tokens_used INTEGER,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        agent_role TEXT,
        model TEXT,
        reasoning_effort TEXT,
        thread_source TEXT
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT,
        child_thread_id TEXT PRIMARY KEY
      );
    `);
    const insert = database.prepare(`
      INSERT INTO threads (
        id, created_at, updated_at, source, cwd, title, tokens_used,
        git_sha, git_branch, git_origin_url, agent_role, model,
        reasoning_effort, thread_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const rootId = "11111111-1111-4111-8111-111111111111";
    const childId = "22222222-2222-4222-8222-222222222222";
    insert.run(
      rootId,
      1750000000,
      1750000100,
      "exec",
      "/workspace/synthetic-project",
      "SYNTHETIC TITLE MUST NOT EXPORT",
      100,
      null,
      "main",
      "https://example.invalid/synthetic/repo.git",
      null,
      "gpt-5.6-sol",
      "medium",
      "user",
    );
    insert.run(
      childId,
      1750000200,
      1750000300,
      '{"subagent":{"thread_spawn":{"parent_thread_id":"11111111-1111-4111-8111-111111111111"}}}',
      "/workspace/synthetic-project",
      "ANOTHER SYNTHETIC TITLE",
      150,
      null,
      "main",
      "https://example.invalid/synthetic/repo.git",
      "worker",
      "gpt-5.6-terra",
      "high",
      "subagent",
    );
    database
      .prepare("INSERT INTO thread_spawn_edges VALUES (?, ?)")
      .run(rootId, childId);
    database.close();

    await writeFile(
      resolve(root, "session_index.jsonl"),
      `${JSON.stringify({
        id: rootId,
        thread_name: "SESSION INDEX TITLE MUST NOT EXPORT",
        updated_at: "2025-06-15T15:06:40.000Z",
      })}\n`,
    );

    const rootStart = "2025-06-15T15:06:40.000Z";
    const childStart = "2025-06-15T15:10:00.000Z";
    const rootLines = [
      {
        timestamp: rootStart,
        type: "session_meta",
        payload: {
          id: rootId,
          cwd: "/workspace/synthetic-project",
          source: "exec",
          git: { repository_url: "https://example.invalid/synthetic/repo.git" },
        },
      },
      {
        timestamp: rootStart,
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "synthetic-root-turn",
          started_at: Date.parse(rootStart) / 1000,
        },
      },
      {
        timestamp: rootStart,
        type: "turn_context",
        payload: {
          turn_id: "synthetic-root-turn",
          model: "gpt-5.6-sol",
          effort: "medium",
          cwd: "/workspace/synthetic-project",
        },
      },
      usageRecord(
        "2025-06-15T15:06:42.000Z",
        "synthetic-root-turn",
        100,
        100,
        "gpt-5.6-sol",
      ),
    ];
    const childLines = [
      {
        timestamp: childStart,
        type: "session_meta",
        payload: {
          id: childId,
          cwd: "/workspace/synthetic-project",
          source: {
            subagent: {
              thread_spawn: { parent_thread_id: rootId },
            },
          },
        },
      },
      {
        timestamp: childStart,
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "synthetic-root-turn",
          started_at: Date.parse(rootStart) / 1000,
        },
      },
      usageRecord(
        "2025-06-15T15:10:01.000Z",
        "synthetic-root-turn",
        100,
        100,
        "gpt-5.6-sol",
      ),
      {
        timestamp: childStart,
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "synthetic-child-turn",
          started_at: Date.parse(childStart) / 1000,
        },
      },
      {
        timestamp: childStart,
        type: "turn_context",
        payload: {
          turn_id: "synthetic-child-turn",
          model: "gpt-5.6-terra",
          effort: "high",
          cwd: "/workspace/synthetic-project",
        },
      },
      usageRecord(
        "2025-06-15T15:10:03.000Z",
        "synthetic-child-turn",
        150,
        50,
        "gpt-5.6-terra",
      ),
    ];
    await writeFile(
      resolve(sessions, `rollout-2025-06-15-${rootId}.jsonl`),
      serialize(rootLines),
    );
    await writeFile(
      resolve(sessions, `rollout-2025-06-15-${childId}.jsonl`),
      serialize(childLines),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.events.length, 2);
    assert.equal(snapshot.coverage.observedTokens, 150);
    assert.equal(snapshot.coverage.duplicateEventsSkipped, 1);
    assert.equal(snapshot.provenance.sourceFingerprint, sourceFingerprint(root));
    assert.equal(snapshot.coverage.sourceFileCount, 3);
    assert.equal(snapshot.threads.find((thread) => thread.id === rootId)?.totalTokens, 100);
    assert.equal(snapshot.threads.find((thread) => thread.id === childId)?.totalTokens, 50);
    assert.equal(
      snapshot.threads.find((thread) => thread.id === childId)?.reportedCumulativeTokens,
      150,
    );
    assert.deepEqual(findForbiddenKeys(snapshot), []);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /SYNTHETIC TITLE MUST NOT EXPORT/);
    assert.doesNotMatch(serialized, /SESSION INDEX TITLE MUST NOT EXPORT/);
    assert.doesNotMatch(serialized, /\/workspace\//);
    assert.doesNotMatch(serialized, /repository_url|git_origin_url/);
    assert.match(serialized, /synthetic\/repo/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private snapshot writes replace atomically and enforce mode 0600", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-write-"));
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

test("source freshness ignores unused session titles and includes rollout files", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-mtime-"));
  try {
    const index = resolve(root, "session_index.jsonl");
    await writeFile(index, "{}\n");
    assert.equal(await latestSourceModifiedAt(root), 0);
    assert.deepEqual(await sourceState(root), {
      latestMtimeMs: 0,
      fileCount: 0,
    });
    const sessions = resolve(root, "sessions");
    await mkdir(sessions, { recursive: true });
    const rollout = resolve(sessions, "synthetic.jsonl");
    await writeFile(rollout, "{}\n");
    assert.ok((await latestSourceModifiedAt(root)) > 0);
    assert.equal((await sourceState(root)).fileCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collector implementation has no network client", async () => {
  const source = await readFile(
    new URL("../lib/token-ledger-collector.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /node:https|node:http|\bfetch\s*\(/);
});
