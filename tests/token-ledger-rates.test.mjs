import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { eventCredits } from "../bin/token-ledger-trend.mjs";
import { collectUsage } from "../lib/token-ledger-importer.mjs";
import {
  creditsForUsage,
  FAST_MODE_MULTIPLIER,
  hasDetailedBreakdown,
  normalizeModel,
  RATE_CARD,
  RATE_CARD_AS_OF,
  RATE_CARD_URL,
} from "../lib/token-ledger-rates.mjs";

const USAGE = {
  totalTokens: 3_000_000,
  inputTokens: 1_000_000,
  cachedInputTokens: 250_000,
  outputTokens: 2_000_000,
};

test("the shared rate card prices every production model", () => {
  for (const [model, rate] of Object.entries(RATE_CARD)) {
    const expected =
      (750_000 * rate.input +
        250_000 * rate.cached +
        2_000_000 * rate.output) /
      1_000_000;
    assert.equal(creditsForUsage(model, USAGE), expected, model);
  }
});

test("the shared normalizer handles model aliases and unknowns", () => {
  const aliases = [
    ["GPT_5.6_SOL_preview", "gpt-5.6-sol"],
    ["gpt-5.6 terra preview", "gpt-5.6-terra"],
    ["gpt-5.6_luna_preview", "gpt-5.6-luna"],
    ["gpt-5.5-cyber-preview", "gpt-5.5-cyber"],
    ["gpt 5.5", "gpt-5.5"],
    ["gpt-5.4 mini", "gpt-5.4-mini"],
    ["gpt_5.3_codex_preview", "gpt-5.3-codex"],
    ["gpt-5.2-preview", "gpt-5.2"],
  ];
  for (const [alias, expected] of aliases) {
    assert.equal(normalizeModel(alias), expected, alias);
    assert.equal(
      creditsForUsage(alias, USAGE),
      creditsForUsage(expected, USAGE),
      alias,
    );
  }

  for (const unknown of ["gpt-4o", "", "   ", null]) {
    const expected = unknown
      ? String(unknown).trim().toLowerCase() || "unknown"
      : "unknown";
    assert.equal(normalizeModel(unknown), expected);
    assert.equal(creditsForUsage(unknown, USAGE), null, String(unknown));
  }
});

test("the shared calculator clamps cache input and applies priority multiplication", () => {
  const baseUsage = {
    totalTokens: 1_000_000,
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  const base = creditsForUsage("gpt-5.5", baseUsage);
  assert.equal(
    creditsForUsage("gpt-5.5", { ...baseUsage, cachedInputTokens: 2_000_000 }),
    creditsForUsage("gpt-5.5", { ...baseUsage, cachedInputTokens: 1_000_000 }),
  );
  assert.equal(
    creditsForUsage("gpt-5.5", { ...baseUsage, cachedInputTokens: -1 }),
    base,
  );
  assert.equal(
    creditsForUsage("gpt-5.5", baseUsage, "priority"),
    base * FAST_MODE_MULTIPLIER,
  );
});

test("the shared breakdown validator rejects incomplete usage", () => {
  const incomplete = [
    { totalTokens: 99, inputTokens: 100, outputTokens: 0 },
    { totalTokens: 100, inputTokens: 0, outputTokens: 0 },
  ];
  for (const usage of incomplete) {
    assert.equal(hasDetailedBreakdown(usage), false);
    assert.equal(creditsForUsage("gpt-5.5", usage), null);
  }
  assert.equal(hasDetailedBreakdown({ totalTokens: 0 }), true);
  assert.equal(creditsForUsage("gpt-5.5", { totalTokens: 0 }), 0);
});

test("collector snapshots and report attribution use identical shared credits", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "token-ledger-rates-"));
  const threadId = "44444444-4444-4444-8444-444444444444";
  const timestamp = "2026-08-23T09:00:00.000Z";
  const rolloutDirectory = resolve(root, "sessions", "2026", "08", "23");
  const tokenUsage = {
    input_tokens: 90,
    cached_input_tokens: 10,
    output_tokens: 10,
    reasoning_output_tokens: 4,
    total_tokens: 100,
  };
  const records = [
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-1",
        started_at: Date.parse(timestamp) / 1_000,
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: {
          model: "gpt-5.4 mini",
          reasoning_effort: "medium",
          service_tier: "priority",
        },
      },
    },
    {
      timestamp,
      type: "turn_context",
      payload: { turn_id: "turn-1", model: "gpt-5.4 mini", effort: "medium" },
    },
    {
      timestamp: "2026-08-23T09:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: tokenUsage,
          last_token_usage: tokenUsage,
          model_context_window: 128_000,
        },
      },
    },
  ];
  try {
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      resolve(rolloutDirectory, `rollout-${threadId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const snapshot = await collectUsage({
      output: resolve(root, "snapshot.json"),
      codexHome: root,
      includeArchived: true,
      since: null,
    });
    assert.equal(snapshot.provenance.rateCardAsOf, RATE_CARD_AS_OF);
    assert.equal(snapshot.provenance.rateCardUrl, RATE_CARD_URL);
    assert.equal(snapshot.events.length, 1);
    const event = snapshot.events[0];
    assert.equal(event.serviceTier, "priority");
    assert.equal(
      event.rateCardCredits,
      creditsForUsage(event.model, event, event.serviceTier),
    );
    assert.equal(
      eventCredits({ ...event, rateCardCredits: null }),
      event.rateCardCredits,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
