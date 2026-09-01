import assert from "node:assert/strict";
import test from "node:test";

import {
  API_USD_RATE_CARD,
  apiUsdForUsage,
  calculateCodexPurchasedCredits,
  CODEX_CREDIT_RATE_CARD,
  hasDetailedTokenBreakdown,
  normalizeCodexCreditModel,
  partitionTokenUsage,
} from "../lib/token-ledger-rates.mjs";

const USAGE = {
  totalTokens: 210_000,
  inputTokens: 200_000,
  cachedInputTokens: 50_000,
  cacheWriteInputTokens: 25_000,
  outputTokens: 10_000,
  reasoningTokens: 5_000,
};

test("canonical models and explicit aliases resolve to known rate-card keys", () => {
  const aliases = [
    ["gpt-5.5-cyber", "daybreak-red"],
    ["gpt-5.5-cyber-preview", "daybreak-red"],
    ["gpt-5.6-cyber", "daybreak-red"],
    ["gpt-daybreak-red", "daybreak-red"],
    ["gpt-5.5-daybreak-red-latest", "daybreak-red"],
    ["gpt-daybreak-red-latest", "daybreak-red"],
    ["gpt-daybreak-blue", "daybreak-blue"],
    ["gpt-5.5-daybreak-blue-latest", "daybreak-blue"],
    ["gpt-daybreak-blue-latest", "daybreak-blue"],
  ];
  const cases = [
    ...Object.keys(CODEX_CREDIT_RATE_CARD).map((model) => [model, model]),
    ...aliases,
  ];

  for (const [input, expected] of cases) {
    assert.equal(normalizeCodexCreditModel(input), expected, input);
    assert.ok(Object.hasOwn(CODEX_CREDIT_RATE_CARD, expected), input);
    assert.ok(Object.hasOwn(API_USD_RATE_CARD, expected), input);
  }
});

test("purchased-credit calculation uses the partition and service multiplier", () => {
  assert.deepEqual(partitionTokenUsage(USAGE), {
    uncachedInputTokens: 125_000,
    cachedInputTokens: 50_000,
    cacheWriteInputTokens: 25_000,
    outputTokens: 10_000,
    reasoningTokens: 5_000,
  });

  const cases = [
    {
      name: "standard Luna",
      model: "gpt-5.6-luna",
      expected: 1.075,
    },
    {
      name: "priority Luna",
      model: "gpt-5.6-luna",
      serviceTier: "priority",
      expected: 2.6875,
    },
    {
      name: "fast Sol",
      model: "gpt-5.6-sol",
      serviceTier: "fast",
      expected: 51.25,
    },
    {
      name: "fast Terra",
      model: "gpt-5.6-terra",
      serviceTier: "fast",
      expected: 26.875,
    },
    {
      name: "fast Daybreak Red",
      model: "daybreak-red",
      serviceTier: "fast",
      expected: 167.96875,
    },
    {
      name: "fast GPT-5.4",
      model: "gpt-5.4",
      serviceTier: "fast",
      expected: 26.875,
    },
    {
      name: "cache input is clamped",
      model: "gpt-5.6-luna",
      usage: { ...USAGE, cachedInputTokens: 500_000 },
      expected: 0.4,
    },
  ];

  for (const testCase of cases) {
    const actual = calculateCodexPurchasedCredits({
      model: testCase.model,
      serviceTier: testCase.serviceTier,
      usage: testCase.usage ?? USAGE,
    });
    assert.equal(actual, testCase.expected, testCase.name);
  }

  assert.equal(
    calculateCodexPurchasedCredits({
      model: "gpt-daybreak-red-latest",
      serviceTier: "fast",
      usage: USAGE,
    }),
    null,
    "unsupported latest fast aliases must not inherit a canonical rate",
  );
});

test("API USD calculation keeps input partitions and purchased credits separate", () => {
  const api = apiUsdForUsage({
    ...USAGE,
    model: "gpt-5.6-sol",
    callCount: 1,
    serviceTier: "standard",
  });
  const credits = calculateCodexPurchasedCredits({
    model: "gpt-5.6-sol",
    usage: USAGE,
  });

  assert.equal(api.amount, 0.845);
  assert.equal(api.currency, "USD");
  assert.equal(api.ratedTokens, USAGE.totalTokens);
  assert.equal(api.unratedTokens, 0);
  assert.equal(api.complete, true);
  assert.deepEqual(api.partition, partitionTokenUsage(USAGE));
  assert.equal(credits, 20.5);
  assert.notEqual(api.amount, credits);

  const preservedOccurrence = apiUsdForUsage({
    ...USAGE,
    model: "gpt-5.6-luna",
    rateCardModel: "gpt-5.6-sol",
    callCount: 1,
  });
  assert.equal(preservedOccurrence.amount, api.amount);
});

test("unknown models and malformed usage remain explicitly unrated", () => {
  const cases = [
    {
      name: "unknown model",
      usage: {
        model: "gpt-4o",
        totalTokens: 10,
        inputTokens: 10,
        outputTokens: 0,
      },
      breakdownValid: true,
      reason: "unknown-model",
    },
    {
      name: "incomplete breakdown",
      usage: {
        model: "gpt-5.6-sol",
        totalTokens: 10,
        inputTokens: 10,
      },
      breakdownValid: false,
      reason: "incomplete-token-breakdown",
    },
    {
      name: "mismatched totals",
      usage: {
        model: "gpt-5.6-sol",
        totalTokens: 99,
        inputTokens: 100,
        outputTokens: 0,
      },
      breakdownValid: false,
      reason: "incomplete-token-breakdown",
    },
  ];

  for (const testCase of cases) {
    assert.equal(
      hasDetailedTokenBreakdown(testCase.usage),
      testCase.breakdownValid,
      testCase.name,
    );
    assert.equal(
      calculateCodexPurchasedCredits({
        model: testCase.usage.model,
        usage: testCase.usage,
      }),
      null,
      testCase.name,
    );
    const rated = apiUsdForUsage(testCase.usage);
    assert.equal(rated.amount, null, testCase.name);
    assert.equal(rated.ratedTokens, 0, testCase.name);
    assert.equal(rated.complete, false, testCase.name);
    assert.equal(rated.reasons[0], testCase.reason, testCase.name);
  }
});
