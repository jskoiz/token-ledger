import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  collectUsage,
  writePrivateSnapshot,
} from "../lib/token-ledger-importer.mjs";

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

test("empty thread settings reset the service tier for the next turn", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-importer-"));
  const threadId = "11111111-1111-4111-8111-111111111111";
  try {
    const rolloutDirectory = resolve(root, "sessions", "2026", "08", "18");
    await mkdir(rolloutDirectory, { recursive: true });
    const firstTimestamp = "2026-08-18T10:00:00.000Z";
    const secondTimestamp = "2026-08-18T10:01:00.000Z";
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
      ]),
    );

    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.events.length, 2);
    assert.equal(snapshot.events[0].serviceTier, "priority");
    assert.equal(snapshot.events[1].serviceTier, null);
    assert.ok(
      Math.abs(
        snapshot.events[0].rateCardCredits -
          snapshot.events[1].rateCardCredits * 1.5,
      ) < 0.000001,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports clamp token subsets and price whitespace model names", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-importer-"));
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
