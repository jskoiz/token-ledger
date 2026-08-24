// Purchased-credit weights are a separate attribution lens. They never scale
// raw token totals or replace OpenAI-reported plan-limit meter readings.
export const CODEX_CREDIT_RATE_CARD_AS_OF = "2026-08-23";
export const CODEX_CREDIT_RATE_CARD_URL =
  "https://help.openai.com/en/articles/11481834";
export const CODEX_CREDIT_RATE_CARD_KIND = "codex-purchased-credits";
export const CODEX_CREDIT_RATE_CARD_SCOPE =
  "Estimate for eligible Codex usage paid with purchased credits; not API USD and not included plan-limit meter usage.";

export const CODEX_CREDIT_RATE_CARD = Object.freeze({
  "gpt-5.6-sol": Object.freeze({ input: 100, cached: 10, output: 500 }),
  "gpt-5.6-terra": Object.freeze({ input: 50, cached: 5, output: 300 }),
  "gpt-5.6-luna": Object.freeze({ input: 5, cached: 0.5, output: 30 }),
  "gpt-5.5": Object.freeze({ input: 125, cached: 12.5, output: 750 }),
  "daybreak-blue": Object.freeze({ input: 100, cached: 10, output: 500 }),
  "daybreak-red": Object.freeze({ input: 312.5, cached: 31.25, output: 1_875 }),
  "gpt-5.4": Object.freeze({ input: 62.5, cached: 6.25, output: 375 }),
  "gpt-5.4-mini": Object.freeze({ input: 18.75, cached: 1.875, output: 113 }),
  "gpt-5.3-codex": Object.freeze({ input: 43.75, cached: 4.375, output: 350 }),
  "gpt-5.2": Object.freeze({ input: 43.75, cached: 4.375, output: 350 }),
});

// API-equivalent USD is a separate hypothetical lens. These values are never
// derived from purchased credits and never claim to reproduce an invoice.
export const API_USD_RATE_CARD_AS_OF = "2026-08-23";
export const API_USD_RATE_CARD_URL =
  "https://help.openai.com/en/articles/20001415";
export const API_USD_SOL_MODEL_URL =
  "https://developers.openai.com/api/docs/models/gpt-5.6-sol";
export const API_USD_FAST_MODE_URL =
  "https://developers.openai.com/api/docs/guides/fast-mode";
export const API_USD_RATE_CARD = Object.freeze({
  "gpt-5.6-sol": Object.freeze({ input: 4, cached: 0.4, output: 20, cacheWrite: 1.25 }),
  "gpt-5.6-terra": Object.freeze({ input: 2, cached: 0.2, output: 12, cacheWrite: 1.25 }),
  "gpt-5.6-luna": Object.freeze({ input: 0.2, cached: 0.02, output: 1.2, cacheWrite: 1.25 }),
  "gpt-5.5": Object.freeze({ input: 5, cached: 0.5, output: 30 }),
  "daybreak-blue": Object.freeze({ input: 4, cached: 0.4, output: 20, cacheWrite: 1.25 }),
  "daybreak-red": Object.freeze({ input: 12.5, cached: 1.25, output: 75, cacheWrite: 1.25 }),
  "gpt-5.4": Object.freeze({ input: 2.5, cached: 0.25, output: 15 }),
  "gpt-5.4-mini": Object.freeze({ input: 0.75, cached: 0.075, output: 4.5 }),
  "gpt-5.3-codex": Object.freeze({ input: 1.75, cached: 0.175, output: 14 }),
  "gpt-5.2": Object.freeze({ input: 1.75, cached: 0.175, output: 14 }),
});

export const API_USD_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

// These are exact identifiers observed in current Codex metadata. Keep this
// list explicit so a future model name cannot silently inherit an old price.
const MODEL_ALIASES = new Map([
  ["gpt-5.5-cyber", "daybreak-red"],
  ["gpt-5.5-cyber-preview", "daybreak-red"],
  ["gpt-5.6-cyber", "daybreak-red"],
  ["gpt-daybreak-red", "daybreak-red"],
  ["gpt-5.5-daybreak-red-latest", "daybreak-red"],
  ["gpt-daybreak-red-latest", "daybreak-red"],
  ["gpt-daybreak-blue", "daybreak-blue"],
  ["gpt-5.5-daybreak-blue-latest", "daybreak-blue"],
  ["gpt-daybreak-blue-latest", "daybreak-blue"],
]);

// Fast multipliers stay keyed to exact identifiers whose generation is
// explicit in the identifier or documented by the current Daybreak FAQ.
const FAST_MULTIPLIER_BY_IDENTIFIER = new Map([
  ["gpt-5.6-sol", 2.5],
  ["gpt-5.6-terra", 2.5],
  ["gpt-5.6-luna", 2.5],
  ["gpt-5.6-cyber", 2.5],
  ["daybreak-blue", 2.5],
  ["daybreak-red", 2.5],
  ["gpt-daybreak-blue", 2.5],
  ["gpt-daybreak-red", 2.5],
  ["gpt-5.5", 2.5],
  ["gpt-5.5-cyber", 2.5],
  ["gpt-5.5-cyber-preview", 2.5],
  ["gpt-5.4", 2],
]);

function normalizedIdentifier(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

export function normalizeCodexCreditModel(model) {
  const value = normalizedIdentifier(model);
  if (Object.hasOwn(CODEX_CREDIT_RATE_CARD, value)) return value;
  return MODEL_ALIASES.get(value) ?? (value || "unknown");
}

export function isFastServiceTier(serviceTier) {
  const tier = normalizedIdentifier(serviceTier);
  return tier === "priority" || tier === "fast";
}

export function codexCreditMultiplier(model, serviceTier) {
  if (!isFastServiceTier(serviceTier)) return 1;
  return FAST_MULTIPLIER_BY_IDENTIFIER.get(normalizedIdentifier(model)) ?? null;
}

function nonNegativeFinite(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

export function hasDetailedTokenBreakdown(usage) {
  if (usage === null || usage === undefined) return false;
  const totalTokens = nonNegativeFinite(usage.totalTokens);
  const inputTokens = nonNegativeFinite(usage.inputTokens);
  const outputTokens = nonNegativeFinite(usage.outputTokens);
  if (
    totalTokens === null ||
    inputTokens === null ||
    outputTokens === null
  ) {
    return false;
  }
  if (totalTokens === 0) return inputTokens === 0 && outputTokens === 0;
  const reconciliationDifference = Math.abs(
    inputTokens + outputTokens - totalTokens,
  );
  const reconciliationTolerance = Number.EPSILON * 16 * Math.max(
    1,
    inputTokens,
    outputTokens,
    totalTokens,
  );
  return (
    reconciliationDifference <= reconciliationTolerance &&
    (inputTokens > 0 || outputTokens > 0)
  );
}

export function partitionTokenUsage(usage) {
  if (!hasDetailedTokenBreakdown(usage)) return null;
  const inputTokens = nonNegativeFinite(usage.inputTokens, 0);
  const outputTokens = nonNegativeFinite(usage.outputTokens, 0);
  const cachedInputTokens = Math.min(
    inputTokens,
    nonNegativeFinite(usage.cachedInputTokens, 0),
  );
  const cacheWriteInputTokens = Math.min(
    inputTokens - cachedInputTokens,
    nonNegativeFinite(usage.cacheWriteInputTokens, 0),
  );
  const reasoningTokens = Math.min(
    outputTokens,
    nonNegativeFinite(usage.reasoningTokens, 0),
  );
  return {
    uncachedInputTokens: inputTokens - cachedInputTokens - cacheWriteInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningTokens,
  };
}

export function calculateCodexPurchasedCredits({ model, serviceTier, usage }) {
  const rate = CODEX_CREDIT_RATE_CARD[normalizeCodexCreditModel(model)];
  const partition = partitionTokenUsage(usage);
  const multiplier = codexCreditMultiplier(model, serviceTier);
  if (!rate || !partition || multiplier === null) return null;
  const baseCredits = (
    (partition.uncachedInputTokens + partition.cacheWriteInputTokens) * rate.input +
    partition.cachedInputTokens * rate.cached +
    partition.outputTokens * rate.output
  ) / 1_000_000;
  return baseCredits * multiplier;
}

function apiServiceTier(serviceTier) {
  const tier = normalizedIdentifier(serviceTier);
  if (!tier || tier === "default" || tier === "standard") return "standard";
  if (tier === "fast" || tier === "priority") return "fast";
  if (tier === "ultrafast") return "ultrafast";
  return "unsupported";
}

function apiCallCount(value, compacted) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  return compacted ? null : 1;
}

function apiUnratedResult(usage, reason, estimated = false) {
  return {
    amount: null,
    currency: "USD",
    ratedTokens: 0,
    unratedTokens: nonNegativeFinite(usage?.totalTokens, 0),
    complete: false,
    estimated,
    reasons: [reason],
    partition: null,
  };
}

export function apiUsdForUsage(event) {
  const usage = event?.usage ?? event;
  const model = event?.model ?? usage?.model;
  const serviceTier = event?.serviceTier ?? usage?.serviceTier;
  const normalizedModel = normalizeCodexCreditModel(model);
  const rate = API_USD_RATE_CARD[normalizedModel];
  const partition = partitionTokenUsage(usage);
  const resolutionSeconds = nonNegativeFinite(
    event?.resolutionSeconds ?? usage?.resolutionSeconds,
    0,
  );
  const compacted = Boolean(
    event?.rangeAllocationEstimated === true ||
      usage?.rangeAllocationEstimated === true ||
      resolutionSeconds > 0
  );
  const callCount = apiCallCount(
    event?.callCount ?? usage?.callCount,
    compacted,
  );
  const estimated = Boolean(
    compacted ||
      callCount !== 1
  );

  if (!rate) return apiUnratedResult(usage, "unknown-model", estimated);
  if (!partition) {
    return apiUnratedResult(usage, "incomplete-token-breakdown", estimated);
  }

  const tier = apiServiceTier(serviceTier);
  if (tier === "ultrafast") {
    return apiUnratedResult(usage, "ultrafast-unrated", estimated);
  }
  if (tier === "unsupported") {
    return apiUnratedResult(usage, "unsupported-api-service-tier", estimated);
  }
  if (tier === "fast" && normalizedModel !== "gpt-5.6-sol") {
    return apiUnratedResult(usage, "unsupported-api-fast-tier", estimated);
  }

  const inputTokens = partition.uncachedInputTokens +
    partition.cachedInputTokens + partition.cacheWriteInputTokens;
  const longContext = normalizedModel === "gpt-5.6-sol" &&
    inputTokens > API_USD_LONG_CONTEXT_THRESHOLD_TOKENS;
  if (longContext && callCount !== 1) {
    return apiUnratedResult(
      usage,
      "compacted-long-context-ambiguous",
      true,
    );
  }

  const fastMultiplier = tier === "fast" ? 2 : 1;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const reasons = [];
  let ratedTokens = partition.uncachedInputTokens +
    partition.cachedInputTokens + partition.outputTokens;
  let unratedTokens = 0;
  let amount = (
    partition.uncachedInputTokens * rate.input * inputMultiplier +
    partition.cachedInputTokens * rate.cached * inputMultiplier +
    partition.outputTokens * rate.output * outputMultiplier
  ) * fastMultiplier / 1_000_000;

  if (partition.cacheWriteInputTokens > 0) {
    if (rate.cacheWrite) {
      ratedTokens += partition.cacheWriteInputTokens;
      amount += partition.cacheWriteInputTokens * rate.input * rate.cacheWrite *
        inputMultiplier * fastMultiplier / 1_000_000;
    } else {
      unratedTokens += partition.cacheWriteInputTokens;
      reasons.push("unsupported-cache-write-price");
    }
  }

  return {
    amount: ratedTokens > 0 ? amount : null,
    currency: "USD",
    ratedTokens,
    unratedTokens,
    complete: unratedTokens === 0,
    estimated,
    reasons,
    partition,
  };
}
