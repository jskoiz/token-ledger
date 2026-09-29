import assert from "node:assert/strict";
import test from "node:test";
import { splitUsageBucketsAtBoundaries } from "../lib/token-ledger-usage.mjs";

import {
  API_USD_RATE_CARD,
  API_USD_LONG_CONTEXT_THRESHOLD_TOKENS,
  apiUsdForUsage,
  calculateCodexPurchasedCredits,
  codexCreditMultiplier,
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
    assert.ok(apiUsdForUsage({
      ...USAGE, model: input, timestamp: "2026-10-06T00:00:00Z",
    }).amount > 0, input);
  }
});

function assertClose(actual, expected, name) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${name}: ${actual} != ${expected}`);
}

test("current GPT-6 models have distinct verified credit and API prices", () => {
  const cases = [
    ["gpt-6-astra", 51.25, 2.1125],
    ["gpt-6.1-sol", 10.125, 0.4175],
    ["gpt-6-sol", 10.25, 0.4225],
    ["gpt-6-luna", 0.5125, 0.021125],
  ];
  for (const [model, credits, usd] of cases) {
    assert.ok(Object.hasOwn(API_USD_RATE_CARD, model));
    for (const [serviceTier, multiplier] of [["default", 1], ["priority", 2]]) {
      assertClose(calculateCodexPurchasedCredits({
        model, serviceTier, usage: USAGE,
      }), credits * multiplier, `${model} credits ${serviceTier}`);
      const estimate = apiUsdForUsage({ ...USAGE, model, serviceTier });
      assertClose(estimate.amount, usd * multiplier, `${model} USD ${serviceTier}`);
      assert.equal(estimate.ratedTokens, USAGE.totalTokens);
      assert.equal(estimate.unratedTokens, 0);
    }
  }
});

test("Astra Ultrafast is priced separately and unsupported credit tiers stay unrated", () => {
  assert.equal(codexCreditMultiplier("gpt-6-astra", "ultrafast"), 6);
  assert.equal(calculateCodexPurchasedCredits({
    model: "gpt-6-astra", serviceTier: "ultrafast", usage: USAGE,
  }), 307.5);
  assertClose(apiUsdForUsage({
    ...USAGE, model: "gpt-6-astra", serviceTier: "ultrafast",
  }).amount, 12.675, "Astra Ultrafast USD");
  for (const tier of ["ultrafast", "flex", "future-tier"]) {
    assert.equal(calculateCodexPurchasedCredits({
      model: "gpt-6.1-sol", serviceTier: tier, usage: USAGE,
    }), null, tier);
  }
  assert.equal(apiUsdForUsage({
    ...USAGE, model: "gpt-6.1-sol", serviceTier: "ultrafast",
  }).reasons[0], "unsupported-api-ultrafast-tier");
});

test("published API text models and supported tiers do not inherit credit multipliers", () => {
  const usage = { ...USAGE, cacheWriteInputTokens: 0 };
  const cases = [
    ["gpt-5.4-nano", "default", 0.0435],
    ["gpt-4o", "default", 0.5375],
    ["gpt-4.1", "fast", 0.70875],
    ["gpt-5-mini", "priority", 0.10575],
    ["gpt-6.1-sol", "batch", 0.20875],
    ["gpt-6.1-sol", "flex", 0.20875],
    ["gpt-5.6-terra", "fast", 0.885],
    ["gpt-5.5", "fast", 2.6875],
    ["gpt-5.3-codex", "fast", 0.8225],
  ];
  for (const [model, serviceTier, expected] of cases) {
    const estimate = apiUsdForUsage({
      ...(model.startsWith("gpt-6") || model === "gpt-5.6-terra" ? USAGE : usage),
      model, serviceTier,
    });
    assertClose(estimate.amount, expected, `${model} ${serviceTier}`);
  }
  assert.equal(apiUsdForUsage({ ...USAGE, model: "gpt-reserve" }).amount, null);
  assert.equal(apiUsdForUsage({ ...USAGE, model: "gpt-6.2-sol" }).amount, null);
  assert.equal(apiUsdForUsage({ ...USAGE, model: "gpt-image-2.5-flare" }).amount, null);
  assert.equal(apiUsdForUsage({ ...USAGE, model: "constructor" }).amount, null);
  assert.equal(calculateCodexPurchasedCredits({
    usage: USAGE, model: "constructor",
  }), null);
});

test("long-context pricing applies to the full call for every eligible current model", () => {
  const cases = [
    ["gpt-6-astra", 5.975],
    ["gpt-6.1-sol", 1.185],
    ["gpt-6-sol", 1.195],
    ["gpt-6-luna", 0.05975],
    ["gpt-5.6-sol", 2.39],
    ["gpt-5.6-terra", 1.225],
    ["gpt-5.6-luna", 0.1225],
  ];
  for (const [model, expected] of cases) {
    const usage = { ...USAGE, inputTokens: 300_000, totalTokens: 310_000, model };
    assertClose(apiUsdForUsage(usage).amount, expected, model);
    assert.equal(apiUsdForUsage({ ...usage, callCount: 2 }).reasons[0],
      "compacted-long-context-ambiguous");
    assert.equal(apiUsdForUsage({
      ...USAGE, model, rangeAllocationEstimated: true,
      rangeAllocationOrigin: { inputTokens: 300_000 },
    }).reasons[0], "compacted-long-context-ambiguous");
  }
  const boundary = API_USD_LONG_CONTEXT_THRESHOLD_TOKENS;
  const event = { model: "gpt-6.1-sol", inputTokens: boundary, outputTokens: 0,
    totalTokens: boundary };
  assertClose(apiUsdForUsage(event).amount, 0.544, "short context at 272K");
  assertClose(apiUsdForUsage({ ...event, inputTokens: boundary + 1,
    totalTokens: boundary + 1 }).amount, 1.088004, "long context above 272K");
  assert.equal(apiUsdForUsage({ model: "gpt-5.5", serviceTier: "fast",
    inputTokens: 300_000, outputTokens: 0, totalTokens: 300_000,
  }).reasons[0], "unsupported-api-long-context-tier");
});

test("missing cache prices are partial coverage and old Cyber cache writes remain unrated", () => {
  const oldCyber = apiUsdForUsage({ ...USAGE, model: "gpt-5.5-cyber" });
  assert.equal(oldCyber.ratedTokens, 185_000);
  assert.equal(oldCyber.unratedTokens, 25_000);
  assert.deepEqual(oldCyber.reasons, ["unsupported-cache-write-price"]);
  const currentCyber = apiUsdForUsage({ ...USAGE, model: "gpt-daybreak-red-latest" });
  assert.equal(currentCyber.ratedTokens, USAGE.totalTokens);
  assertClose(currentCyber.amount, 2.765625, "Daybreak Red cache writes");
  const pro = apiUsdForUsage({ ...USAGE, cacheWriteInputTokens: 0, model: "gpt-5.5-pro" });
  assert.equal(pro.unratedTokens, 50_000);
  assert.deepEqual(pro.reasons, ["unsupported-cached-input-price"]);
});

test("unsupported-price reasons retain each unrated token partition", () => {
  const estimate = apiUsdForUsage({ ...USAGE, model: "gpt-5.5-pro", serviceTier: "standard" });
  assert.equal(estimate.unratedTokens, 75_000);
  assert.deepEqual(estimate.unratedTokensByReason, {
    "unsupported-cached-input-price": 50_000,
    "unsupported-cache-write-price": 25_000,
  });
  assert.equal(Object.values(estimate.unratedTokensByReason).reduce((sum, count) => sum + count, 0),
    estimate.unratedTokens);
  const unknown = apiUsdForUsage({ ...USAGE, model: "unknown-model" });
  assert.deepEqual(unknown.unratedTokensByReason, { "unknown-model": USAGE.totalTokens });
  const rated = apiUsdForUsage({ ...USAGE, model: "gpt-6-astra", serviceTier: "standard" });
  assert.deepEqual(rated.unratedTokensByReason, {});
});

test("Rosalind API estimates respect the published billing start date", () => {
  const usage = { ...USAGE, cacheWriteInputTokens: 0, model: "gpt-rosalind-research" };
  assert.equal(apiUsdForUsage({ ...usage, timestamp: "2026-09-29T12:00:00Z" }).amount, 0);
  assertClose(apiUsdForUsage({ ...usage, timestamp: "2026-10-05T12:00:00Z" }).amount,
    1.025, "Rosalind after billing starts");
  assert.equal(apiUsdForUsage(usage).reasons[0], "billing-start-date-unknown");
});

test("missing speed tiers expose Standard-price assumptions only for rated tokens", () => {
  for (const serviceTier of [undefined, null, "", "   "]) {
    const estimate = apiUsdForUsage({ ...USAGE, model: "gpt-6-astra", serviceTier });
    assertClose(estimate.amount, 2.1125, "assumed Standard Astra price");
    assert.equal(estimate.estimated, true);
    assert.equal(estimate.assumedStandardTokens, USAGE.totalTokens);
  }
  const known = apiUsdForUsage({ ...USAGE, model: "gpt-6-astra", serviceTier: "default" });
  assert.equal(known.estimated, false);
  assert.equal(known.assumedStandardTokens, 0);
  const partial = apiUsdForUsage({ ...USAGE, model: "gpt-5.5" });
  assert.equal(partial.assumedStandardTokens, 185_000);
  assert.equal(partial.unratedTokens, 25_000);
  const unsupported = apiUsdForUsage({ ...USAGE, model: "gpt-6-astra", serviceTier: "future-tier" });
  assert.equal(unsupported.assumedStandardTokens, 0);
  assert.equal(unsupported.amount, null);
});

test("Rosalind compacted and allocated history cannot turn billable calls into free usage", () => {
  const billingStartMs = Date.parse("2026-10-05T00:00:00Z");
  const before = {
    timestamp: "2026-10-04T23:00:00Z", model: "gpt-rosalind-research",
    serviceTier: "standard", inputTokens: 1_000, outputTokens: 0,
    totalTokens: 1_000, callCount: 1,
  };
  const after = { ...before, timestamp: "2026-10-05T01:00:00Z" };
  assertClose(apiUsdForUsage(before).amount + apiUsdForUsage(after).amount,
    0.005, "exact calls around billing start");
  const bucket = {
    ...before, startAt: before.timestamp, endAt: after.timestamp,
    inputTokens: 2_000, totalTokens: 2_000, callCount: 2,
    resolutionSeconds: 86_400, rangeAllocationEstimated: true,
  };
  for (const event of [bucket, ...splitUsageBucketsAtBoundaries([bucket], [billingStartMs])]) {
    const estimate = apiUsdForUsage(event);
    assert.equal(estimate.amount, null);
    assert.equal(estimate.ratedTokens, 0);
    assert.equal(estimate.unratedTokens, event.totalTokens);
    assert.deepEqual(estimate.reasons, ["compacted-billing-start-ambiguous"]);
  }
  const whollyBefore = { ...bucket, endAt: "2026-10-04T23:59:59Z" };
  assert.equal(apiUsdForUsage(whollyBefore).amount, 0);
  const whollyAfter = {
    ...bucket, timestamp: after.timestamp,
    startAt: after.timestamp, endAt: "2026-10-05T02:00:00Z",
  };
  assertClose(apiUsdForUsage(whollyAfter).amount, 0.01, "compacted billed usage");
  assert.equal(apiUsdForUsage({
    ...before, startAt: "bad date", endAt: before.timestamp,
  }).reasons[0], "billing-start-date-unknown");
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
      expected: 2.15,
    },
    {
      name: "fast Sol",
      model: "gpt-5.6-sol",
      serviceTier: "fast",
      expected: 41,
    },
    {
      name: "fast Terra",
      model: "gpt-5.6-terra",
      serviceTier: "fast",
      expected: 21.5,
    },
    {
      name: "fast Daybreak Red",
      model: "daybreak-red",
      serviceTier: "fast",
      expected: 134.375,
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
    134.375,
    "current documented Daybreak aliases use the published purchased-credit rate",
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
        model: "gpt-future-unknown",
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
