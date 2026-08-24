// Pricing weights are used only for the separate attribution lens. They are
// never used to scale or relabel the actual-token columns.
export const RATE_CARD_AS_OF = "2026-08-17";
export const RATE_CARD_URL = "https://help.openai.com/en/articles/20001106";

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

export function hasDetailedBreakdown(usage) {
  const totalTokens = Number(usage.totalTokens) || 0;
  const inputTokens = Number(usage.inputTokens) || 0;
  const outputTokens = Number(usage.outputTokens) || 0;
  if (totalTokens === 0) return true;
  return (
    inputTokens + outputTokens === totalTokens &&
    (inputTokens > 0 || outputTokens > 0)
  );
}

export function creditsForUsage(model, usage, serviceTier = null) {
  if (!hasDetailedBreakdown(usage)) return null;
  const rate = RATE_CARD[normalizeModel(model)];
  if (!rate) return null;
  const inputTokens = Math.max(0, Number(usage.inputTokens) || 0);
  const cachedInputTokens = Math.max(0, Number(usage.cachedInputTokens) || 0);
  const outputTokens = Math.max(0, Number(usage.outputTokens) || 0);
  const cached = Math.min(inputTokens, cachedInputTokens);
  const uncached = Math.max(0, inputTokens - cached);
  const baseCredits =
    (uncached * rate.input + cached * rate.cached + outputTokens * rate.output) /
    1_000_000;
  return serviceTier === "priority"
    ? baseCredits * FAST_MODE_MULTIPLIER
    : baseCredits;
}
