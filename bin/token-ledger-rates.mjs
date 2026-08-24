import {
  isValidTokenValue,
  tokenValue,
} from "../lib/token-ledger-usage.mjs";

// Pricing weights are used only for the separate attribution lens. They are
// never used to scale or relabel the actual-token columns.
export const RATE_CARD_AS_OF = "2026-08-17";

// Fast mode (service tier "priority") debits the plan limit at a higher rate.
export const FAST_MODE_MULTIPLIER = 1.5;

export const RATE_CARD = {
  "gpt-5.6-sol": { input: 125, cached: 12.5, output: 750 },
  "gpt-5.6-terra": { input: 50, cached: 5, output: 300 },
  "gpt-5.6-luna": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.5": { input: 125, cached: 12.5, output: 750 },
  "gpt-5.5-cyber": { input: 500, cached: 50, output: 3_000 },
  "gpt-5.4": { input: 62.5, cached: 6.25, output: 375 },
  "gpt-5.4-mini": { input: 18.75, cached: 1.875, output: 113 },
  "gpt-5.3-codex": { input: 43.75, cached: 4.375, output: 350 },
  "gpt-5.2": { input: 43.75, cached: 4.375, output: 350 },
};

export function normalizeModel(model) {
  // Collapse underscore and whitespace separators to dashes so variants like
  // "gpt-5.4 mini" resolve to their own rate-card entry. Keep in lockstep
  // with normalizeModel in lib/token-ledger-importer.mjs.
  const value = String(model || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (RATE_CARD[value]) return value;
  if (value.startsWith("gpt-5.6-sol")) return "gpt-5.6-sol";
  if (value.startsWith("gpt-5.6-terra")) return "gpt-5.6-terra";
  if (value.startsWith("gpt-5.6-luna")) return "gpt-5.6-luna";
  if (value.startsWith("gpt-5.5-cyber")) return "gpt-5.5-cyber";
  if (value.startsWith("gpt-5.5")) return "gpt-5.5";
  if (value.startsWith("gpt-5.4-mini")) return "gpt-5.4-mini";
  if (value.startsWith("gpt-5.4")) return "gpt-5.4";
  if (value.startsWith("gpt-5.3-codex")) return "gpt-5.3-codex";
  if (value.startsWith("gpt-5.2")) return "gpt-5.2";
  return value || "unknown";
}

function hasDetailedBreakdown(usage) {
  const allowFractional = usage.rangeAllocationEstimated === true;
  const optionalToken = (value) =>
    value === undefined
      ? 0
      : isValidTokenValue(value, { allowFractional })
        ? value
        : null;
  const totalTokens = isValidTokenValue(usage.totalTokens, {
    allowFractional,
  })
    ? usage.totalTokens
    : null;
  const inputTokens = optionalToken(usage.inputTokens);
  const cachedInputTokens = optionalToken(usage.cachedInputTokens);
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
    usage.breakdownAvailable === false
  ) {
    return false;
  }
  if (totalTokens === 0) return true;
  const componentTotal = inputTokens + outputTokens;
  return (
    Number.isFinite(componentTotal) &&
    componentTotal <= Number.MAX_SAFE_INTEGER &&
    componentTotal === totalTokens &&
    (inputTokens > 0 || outputTokens > 0)
  );
}

export function creditsForUsage(model, usage) {
  if (!hasDetailedBreakdown(usage)) return null;
  const rate = RATE_CARD[normalizeModel(model)];
  if (!rate) return null;
  const allowFractional = usage.rangeAllocationEstimated === true;
  const inputTokens = tokenValue(usage.inputTokens, { allowFractional });
  const cachedInputCount = tokenValue(usage.cachedInputTokens, {
    allowFractional,
  });
  const outputTokens = tokenValue(usage.outputTokens, { allowFractional });
  const cached = Math.min(inputTokens, cachedInputCount);
  const uncached = Math.max(0, inputTokens - cached);
  const credits = (
    (uncached * rate.input + cached * rate.cached + outputTokens * rate.output) /
    1_000_000
  );
  return Number.isFinite(credits) ? credits : null;
}
