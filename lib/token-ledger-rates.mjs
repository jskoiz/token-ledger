// Purchased-credit weights are a separate attribution lens. They never scale
// raw token totals or replace OpenAI-reported plan-limit meter readings.
import {
  isValidTokenValue,
  tokenTotalsReconcile,
} from "../lib/token-ledger-usage.mjs";
import {
  API_USD_STANDARD_RATE_CARD,
  API_USD_BATCH_RATE_CARD,
  API_USD_FLEX_RATE_CARD,
  API_USD_FAST_RATE_CARD,
  API_USD_ULTRAFAST_RATE_CARD,
} from "./token-ledger-api-rates.mjs";

export const CODEX_CREDIT_RATE_CARD_AS_OF = "2026-09-29";
export const CODEX_CREDIT_RATE_CARD_URL =
  "https://learn.chatgpt.com/docs/pricing#token-rates";
export const CODEX_CREDIT_RATE_CARD_KIND = "codex-purchased-credits";
export const CODEX_CREDIT_RATE_CARD_SCOPE =
  "Estimate for eligible Codex usage paid with purchased credits; not API USD and not included plan-limit meter usage.";

export const CODEX_CREDIT_RATE_CARD = Object.freeze({
  "gpt-6-astra": Object.freeze({ input: 250, cached: 25, output: 1_250 }),
  "gpt-6.1-sol": Object.freeze({ input: 50, cached: 2.5, output: 250 }),
  "gpt-6-sol": Object.freeze({ input: 50, cached: 5, output: 250 }),
  "gpt-6-luna": Object.freeze({ input: 2.5, cached: 0.25, output: 12.5 }),
  "gpt-5.6-sol": Object.freeze({ input: 100, cached: 10, output: 500 }),
  "gpt-5.6-terra": Object.freeze({ input: 50, cached: 5, output: 300 }),
  "gpt-5.6-luna": Object.freeze({ input: 5, cached: 0.5, output: 30 }),
  "gpt-5.5": Object.freeze({ input: 125, cached: 12.5, output: 750 }),
  "daybreak-blue": Object.freeze({ input: 100, cached: 10, output: 500 }),
  "daybreak-red": Object.freeze({ input: 312.5, cached: 31.25, output: 1_875 }),
  "gpt-rosalind-research": Object.freeze({ input: 125, cached: 12.5, output: 625 }),
  // Retain the previously published credit rates for legacy Codex history.
  "gpt-5.4": Object.freeze({ input: 62.5, cached: 6.25, output: 375 }),
  "gpt-5.4-mini": Object.freeze({ input: 18.75, cached: 1.875, output: 113 }),
  "gpt-5.3-codex": Object.freeze({ input: 43.75, cached: 4.375, output: 350 }),
  "gpt-5.2": Object.freeze({ input: 43.75, cached: 4.375, output: 350 }),
});

// API-equivalent USD is a separate hypothetical lens. These values are never
// derived from purchased credits and never claim to reproduce an invoice.
export const API_USD_RATE_CARD_AS_OF = "2026-09-29";
export const API_USD_RATE_CARD_URL =
  "https://developers.openai.com/api/docs/pricing";
export const API_USD_SOL_MODEL_URL =
  "https://developers.openai.com/api/docs/models/gpt-5.6-sol";
export const API_USD_FAST_MODE_URL =
  "https://developers.openai.com/api/docs/guides/fast-mode";
export const API_USD_RATE_CARD = API_USD_STANDARD_RATE_CARD;

const API_USD_SERVICE_RATE_CARDS = Object.freeze({
  standard: API_USD_STANDARD_RATE_CARD,
  batch: API_USD_BATCH_RATE_CARD,
  flex: API_USD_FLEX_RATE_CARD,
  fast: API_USD_FAST_RATE_CARD,
  ultrafast: API_USD_ULTRAFAST_RATE_CARD,
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

// Purchased-credit prices use 2x for Fast and 6x for Astra Ultrafast.
// Included subscription usage uses different multipliers and is never inferred.
const CREDIT_FAST_MODELS = new Set([
  "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
  "daybreak-blue", "daybreak-red", "gpt-5.4", "gpt-5.4-mini",
  "gpt-5.3-codex", "gpt-5.2",
]);

function normalizedIdentifier(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

function rateForModel(card, model) {
  return Object.hasOwn(card, model) ? card[model] : null;
}

export function normalizeCodexCreditModel(model) {
  const value = normalizedIdentifier(model);
  if (Object.hasOwn(CODEX_CREDIT_RATE_CARD, value)) return value;
  return MODEL_ALIASES.get(value) ?? (value || "unknown");
}

export function isFastServiceTier(serviceTier) {
  const tier = normalizedIdentifier(serviceTier);
  return tier === "priority" || tier === "fast" || tier === "ultrafast";
}

export function isMissingServiceTier(serviceTier) {
  return normalizedIdentifier(serviceTier) === "";
}

export function codexCreditMultiplier(model, serviceTier) {
  const tier = normalizedIdentifier(serviceTier);
  const normalizedModel = normalizeCodexCreditModel(model);
  if (!tier || tier === "default" || tier === "standard") return 1;
  if (tier === "ultrafast") return normalizedModel === "gpt-6-astra" ? 6 : null;
  if (tier === "fast" || tier === "priority") {
    return CREDIT_FAST_MODELS.has(normalizedModel) ? 2 : null;
  }
  return null;
}

function normalizeApiModel(model) {
  const identifier = normalizedIdentifier(model);
  if (Object.hasOwn(API_USD_RATE_CARD, identifier)) return identifier;
  const canonical = normalizeCodexCreditModel(identifier);
  if (canonical === "daybreak-blue") return "gpt-5.6-sol";
  if (canonical === "daybreak-red") {
    return identifier === "gpt-5.5-cyber-preview" ||
        identifier === "gpt-5.5-daybreak-red-latest"
      ? "gpt-5.5-cyber"
      : "gpt-5.6-cyber";
  }
  return canonical;
}

function nonNegativeFinite(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

export function hasDetailedTokenBreakdown(usage) {
  if (usage === null || usage === undefined) return false;
  const allowFractional = usage.rangeAllocationEstimated === true;
  const totalTokens = isValidTokenValue(usage.totalTokens, {
    allowFractional,
  })
    ? usage.totalTokens
    : null;
  if (totalTokens === null) return false;
  if (totalTokens === 0) {
    return usage.breakdownAvailable !== false && usage.componentsValid !== false;
  }
  const optionalToken = (value) =>
    value === undefined
      ? 0
      : isValidTokenValue(value, { allowFractional })
        ? value
        : null;
  const cachedToken = (value) =>
    value === undefined
      ? 0
      : isValidTokenValue(value, { allowFractional })
        ? value
        : Number.isFinite(value) && value < 0
          ? 0
          : null;
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return false;
  }
  const inputTokens = optionalToken(usage.inputTokens);
  const cachedInputTokens = cachedToken(usage.cachedInputTokens);
  const cacheWriteInputTokens = optionalToken(usage.cacheWriteInputTokens);
  const outputTokens = optionalToken(usage.outputTokens);
  const reasoningTokens = optionalToken(usage.reasoningTokens);
  if (
    totalTokens === null ||
    inputTokens === null ||
    cachedInputTokens === null ||
    cacheWriteInputTokens === null ||
    outputTokens === null ||
    reasoningTokens === null ||
    usage.breakdownAvailable === false ||
    usage.componentsValid === false
  ) {
    return false;
  }
  return (
    tokenTotalsReconcile(
      totalTokens,
      inputTokens,
      outputTokens,
      allowFractional,
    ) &&
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
  const rate = rateForModel(CODEX_CREDIT_RATE_CARD, normalizeCodexCreditModel(model));
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
  if (tier === "batch" || tier === "flex") return tier;
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
    assumedStandardTokens: 0,
    reasons: [reason],
    partition: null,
  };
}

function billingIntervalForUsage(event, usage) {
  const timestamp = event?.timestamp ?? usage?.timestamp;
  const startMs = Date.parse(event?.startAt ?? usage?.startAt ?? timestamp ?? "");
  const endMs = Date.parse(event?.endAt ?? usage?.endAt ?? timestamp ?? "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }
  const origin = event?.rangeAllocationOrigin ?? usage?.rangeAllocationOrigin;
  const originStartMs = Date.parse(origin?.startAt ?? new Date(startMs).toISOString());
  const originEndMs = Date.parse(origin?.endAt ?? new Date(endMs).toISOString());
  if (
    !Number.isFinite(originStartMs) || !Number.isFinite(originEndMs) ||
    originEndMs < originStartMs
  ) {
    return null;
  }
  return {
    startMs: Math.min(startMs, originStartMs),
    endMs: Math.max(endMs, originEndMs),
  };
}

export function apiUsdForUsage(event) {
  const usage = event?.usage ?? event;
  const model = event?.rateCardModel ?? usage?.rateCardModel ??
    event?.model ?? usage?.model;
  const serviceTier = event?.serviceTier ?? usage?.serviceTier;
  const assumedStandardTier = isMissingServiceTier(serviceTier);
  const normalizedModel = normalizeApiModel(model);
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
      callCount !== 1 || assumedStandardTier
  );

  const standardRate = rateForModel(API_USD_RATE_CARD, normalizedModel);
  if (!standardRate) return apiUnratedResult(usage, "unknown-model", estimated);
  if (!partition) {
    return apiUnratedResult(usage, "incomplete-token-breakdown", estimated);
  }

  const tier = apiServiceTier(serviceTier);
  if (tier === "unsupported") {
    return apiUnratedResult(usage, "unsupported-api-service-tier", estimated);
  }
  let rate = rateForModel(API_USD_SERVICE_RATE_CARDS[tier], normalizedModel);
  if (!rate) {
    return apiUnratedResult(usage, `unsupported-api-${tier}-tier`, estimated);
  }

  const inputTokens = partition.uncachedInputTokens +
    partition.cachedInputTokens + partition.cacheWriteInputTokens;
  const originInputTokens = nonNegativeFinite(
    usage?.rangeAllocationOrigin?.inputTokens,
  );
  const hasLongContextPrice = standardRate.longContext !== null;
  const proportionalLongContext = hasLongContextPrice &&
    usage?.rangeAllocationEstimated === true &&
    originInputTokens !== null &&
    originInputTokens > API_USD_LONG_CONTEXT_THRESHOLD_TOKENS;
  const longContext = hasLongContextPrice &&
    (inputTokens > API_USD_LONG_CONTEXT_THRESHOLD_TOKENS ||
      proportionalLongContext);
  if (longContext && (callCount !== 1 || proportionalLongContext)) {
    return apiUnratedResult(
      usage,
      "compacted-long-context-ambiguous",
      true,
    );
  }

  if (longContext) {
    if (!rate.longContext) {
      return apiUnratedResult(usage, "unsupported-api-long-context-tier", estimated);
    }
    rate = rate.longContext;
  }

  // Rosalind's published API billing starts October 5. Only an observation
  // entirely before that boundary is known to be free. Compacted or allocated
  // history spanning the boundary cannot establish which calls were billable.
  if (normalizedModel === "gpt-rosalind-research") {
    const interval = billingIntervalForUsage(event, usage);
    const billingStartMs = Date.parse("2026-10-05T00:00:00Z");
    if (!interval) {
      return apiUnratedResult(usage, "billing-start-date-unknown", estimated);
    }
    if (interval.startMs < billingStartMs && interval.endMs >= billingStartMs) {
      return apiUnratedResult(usage, "compacted-billing-start-ambiguous", true);
    }
    if (interval.endMs < billingStartMs) {
      return {
        amount: 0, currency: "USD", ratedTokens: usage.totalTokens,
        unratedTokens: 0, complete: true, estimated, reasons: [], partition,
        assumedStandardTokens: 0,
      };
    }
  }

  const reasons = [];
  let ratedTokens = partition.uncachedInputTokens + partition.outputTokens;
  let unratedTokens = 0;
  let amount = (
    partition.uncachedInputTokens * rate.input +
    partition.outputTokens * rate.output
  ) / 1_000_000;

  for (const [tokens, price, reason] of [
    [partition.cachedInputTokens, rate.cached, "unsupported-cached-input-price"],
    [partition.cacheWriteInputTokens, rate.cacheWrite, "unsupported-cache-write-price"],
  ]) {
    if (tokens <= 0) continue;
    if (price !== null) {
      ratedTokens += tokens;
      amount += tokens * price / 1_000_000;
    } else {
      unratedTokens += tokens;
      reasons.push(reason);
    }
  }

  return {
    amount: ratedTokens > 0 ? amount : null,
    currency: "USD",
    ratedTokens,
    unratedTokens,
    complete: unratedTokens === 0,
    estimated,
    assumedStandardTokens: assumedStandardTier ? ratedTokens : 0,
    reasons,
    partition,
  };
}
