import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { eventCredits } from "../bin/token-ledger-trend.mjs";
import { collectUsage } from "../lib/token-ledger-importer.mjs";
import {
  API_USD_LONG_CONTEXT_THRESHOLD_TOKENS,
  API_USD_RATE_CARD,
  API_USD_RATE_CARD_AS_OF,
  API_USD_RATE_CARD_URL,
  apiUsdForUsage,
  calculateCodexPurchasedCredits,
  CODEX_CREDIT_RATE_CARD,
  CODEX_CREDIT_RATE_CARD_AS_OF,
  CODEX_CREDIT_RATE_CARD_KIND,
  CODEX_CREDIT_RATE_CARD_URL,
  codexCreditMultiplier,
  hasDetailedTokenBreakdown,
  isFastServiceTier,
  normalizeCodexCreditModel,
  partitionTokenUsage,
} from "../lib/token-ledger-rates.mjs";

const USAGE = {
  totalTokens: 3_000_000,
  inputTokens: 1_000_000,
  cachedInputTokens: 250_000,
  outputTokens: 2_000_000,
};

test("the purchased-credit card prices every production model", () => {
  for (const [model, rate] of Object.entries(CODEX_CREDIT_RATE_CARD)) {
    const expected =
      (750_000 * rate.input +
        250_000 * rate.cached +
        2_000_000 * rate.output) /
      1_000_000;
    assert.equal(
      calculateCodexPurchasedCredits({ model, usage: USAGE }),
      expected,
      model,
    );
  }
});

test("the purchased-credit normalizer keeps exact aliases explicit", () => {
  const aliases = [
    ["gpt-5.5-cyber-preview", "daybreak-red"],
    ["gpt-5.6-cyber", "daybreak-red"],
    ["gpt-daybreak-red-latest", "daybreak-red"],
    ["gpt-daybreak-blue", "daybreak-blue"],
    ["gpt-5.5-daybreak-blue-latest", "daybreak-blue"],
  ];
  for (const [alias, expected] of aliases) {
    assert.equal(normalizeCodexCreditModel(alias), expected, alias);
    assert.equal(
      calculateCodexPurchasedCredits({ model: alias, usage: USAGE }),
      calculateCodexPurchasedCredits({ model: expected, usage: USAGE }),
      alias,
    );
  }

  for (const unknown of ["gpt-4o", "", "   ", null]) {
    const expected = unknown
      ? String(unknown).trim().toLowerCase() || "unknown"
      : "unknown";
    assert.equal(normalizeCodexCreditModel(unknown), expected);
    assert.equal(
      calculateCodexPurchasedCredits({ model: unknown, usage: USAGE }),
      null,
      String(unknown),
    );
  }
});

test("the purchased-credit calculator clamps cache input and fast tiers", () => {
  const baseUsage = {
    totalTokens: 1_000_000,
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  const base = calculateCodexPurchasedCredits({
    model: "gpt-5.5",
    usage: baseUsage,
  });
  assert.equal(
    calculateCodexPurchasedCredits({
      model: "gpt-5.5",
      usage: { ...baseUsage, cachedInputTokens: 2_000_000 },
    }),
    calculateCodexPurchasedCredits({
      model: "gpt-5.5",
      usage: { ...baseUsage, cachedInputTokens: 1_000_000 },
    }),
  );
  assert.equal(
    calculateCodexPurchasedCredits({
      model: "gpt-5.5",
      usage: { ...baseUsage, cachedInputTokens: -1 },
    }),
    base,
  );
  assert.equal(
    calculateCodexPurchasedCredits({
      model: "gpt-5.5",
      serviceTier: "priority",
      usage: baseUsage,
    }),
    base * 2.5,
  );
  assert.equal(codexCreditMultiplier("gpt-5.6-luna", "priority"), 2.5);
  assert.equal(codexCreditMultiplier("gpt-5.4", "fast"), 2);
  assert.equal(codexCreditMultiplier("gpt-5.4-mini", "fast"), null);
  for (const tier of ["priority", " Priority ", "fast", "FAST"]) {
    assert.equal(isFastServiceTier(tier), true);
  }
});

test("breakdown validation rejects incomplete or malformed usage", () => {
  for (const usage of [
    { totalTokens: 99, inputTokens: 100, outputTokens: 0 },
    { totalTokens: 100, inputTokens: 0, outputTokens: 0 },
    {
      totalTokens: 100,
      inputTokens: 100,
      outputTokens: 0,
      componentsValid: false,
    },
  ]) {
    assert.equal(hasDetailedTokenBreakdown(usage), false);
    assert.equal(
      calculateCodexPurchasedCredits({ model: "gpt-5.5", usage }),
      null,
    );
  }
  assert.equal(hasDetailedTokenBreakdown({ totalTokens: 0 }), true);
  assert.equal(
    calculateCodexPurchasedCredits({ model: "gpt-5.5", usage: { totalTokens: 0 } }),
    0,
  );

  const estimated = {
    totalTokens: 2,
    inputTokens: 1 / 3,
    cachedInputTokens: 0,
    outputTokens: 5 / 3,
    rangeAllocationEstimated: true,
    breakdownAvailable: true,
  };
  assert.equal(hasDetailedTokenBreakdown(estimated), true);
  const estimatedCredits = calculateCodexPurchasedCredits({
    model: "gpt-5.6-luna",
    usage: estimated,
  });
  assert.ok(
    Math.abs(estimatedCredits - ((1 / 3 * 5 + 5 / 3 * 30) / 1_000_000)) < 1e-12,
  );
});

test("API USD partitions input and remains separate from purchased credits", () => {
  const usage = {
    model: "gpt-5.6-sol",
    totalTokens: 210_000,
    inputTokens: 200_000,
    cachedInputTokens: 50_000,
    cacheWriteInputTokens: 25_000,
    outputTokens: 10_000,
    reasoningTokens: 5_000,
    callCount: 1,
  };
  assert.deepEqual(partitionTokenUsage(usage), {
    uncachedInputTokens: 125_000,
    cachedInputTokens: 50_000,
    cacheWriteInputTokens: 25_000,
    outputTokens: 10_000,
    reasoningTokens: 5_000,
  });
  const api = apiUsdForUsage(usage);
  const credits = calculateCodexPurchasedCredits({ model: usage.model, usage });
  assert.equal(api.amount, 0.845);
  assert.equal(api.currency, "USD");
  assert.equal(api.ratedTokens, usage.totalTokens);
  assert.equal(api.unratedTokens, 0);
  assert.equal(api.complete, true);
  assert.equal(credits, 20.5);
  assert.notEqual(api.amount, credits);
});

test("API USD exposes dated independent card metadata", () => {
  assert.equal(API_USD_RATE_CARD_AS_OF, "2026-08-23");
  assert.match(API_USD_RATE_CARD_URL, /^https:\/\//);
  assert.ok(Object.hasOwn(API_USD_RATE_CARD, "gpt-5.6-sol"));
  assert.equal(API_USD_LONG_CONTEXT_THRESHOLD_TOKENS, 272_000);
});

test("collector snapshots and trend attribution share the purchased-credit card", async () => {
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
    assert.equal(snapshot.provenance.rateCardKind, CODEX_CREDIT_RATE_CARD_KIND);
    assert.equal(snapshot.provenance.rateCardAsOf, CODEX_CREDIT_RATE_CARD_AS_OF);
    assert.equal(snapshot.provenance.rateCardUrl, CODEX_CREDIT_RATE_CARD_URL);
    assert.equal(snapshot.events.length, 1);
    const event = snapshot.events[0];
    assert.equal(event.serviceTier, "priority");
    assert.equal(
      event.rateCardCredits,
      calculateCodexPurchasedCredits({
        model: event.rateCardModel ?? event.model,
        serviceTier: event.serviceTier,
        usage: event,
      }),
    );
    assert.equal(
      eventCredits({ ...event, rateCardCredits: null }),
      event.rateCardCredits,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
