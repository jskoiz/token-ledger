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
  return (
    inputTokens + outputTokens === totalTokens &&
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
  const reasoningTokens = Math.min(
    outputTokens,
    nonNegativeFinite(usage.reasoningTokens, 0),
  );
  return {
    uncachedInputTokens: inputTokens - cachedInputTokens,
    cachedInputTokens,
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
    partition.uncachedInputTokens * rate.input +
    partition.cachedInputTokens * rate.cached +
    partition.outputTokens * rate.output
  ) / 1_000_000;
  return baseCredits * multiplier;
}
