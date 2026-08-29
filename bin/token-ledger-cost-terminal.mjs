import {
  API_USD_RATE_CARD_AS_OF,
  CODEX_CREDIT_RATE_CARD,
  CODEX_CREDIT_RATE_CARD_AS_OF,
  apiUsdForUsage,
  calculateCodexPurchasedCredits,
  codexCreditMultiplier,
  hasDetailedTokenBreakdown,
  normalizeCodexCreditModel,
} from "../lib/token-ledger-rates.mjs";
import { sanitizeTerminalText } from "../lib/token-ledger-terminal-text.mjs";
import {
  snapshotFreshnessDetail,
  sourceStatusLine,
} from "./token-ledger-source-status.mjs";

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function compact(value) {
  const number = nonNegative(value);
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return Math.round(number).toLocaleString("en-US");
}

function percent(numerator, denominator) {
  if (!(denominator > 0)) return "0.0%";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

// Snapshot model identifiers are unbounded input; padding every row to an
// unbounded column width would amplify one long label across the whole table.
const MODEL_LABEL_MAX_WIDTH = 40;

function modelLabel(model) {
  const normalized = normalizeCodexCreditModel(model);
  const labels = {
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "gpt-5.6-terra": "GPT-5.6 Terra",
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "gpt-5.5": "GPT-5.5",
    "daybreak-blue": "Daybreak Blue",
    "daybreak-red": "Daybreak Red",
    "gpt-5.4": "GPT-5.4",
    "gpt-5.4-mini": "GPT-5.4 mini",
    "gpt-5.3-codex": "GPT-5.3 Codex",
    "gpt-5.2": "GPT-5.2",
  };
  const label = sanitizeTerminalText(
    labels[normalized] ?? String(model ?? "Unknown model"),
  );
  return label.length > MODEL_LABEL_MAX_WIDTH
    ? `${label.slice(0, MODEL_LABEL_MAX_WIDTH - 1)}…`
    : label;
}

function creditReason(event) {
  const model = normalizeCodexCreditModel(
    event?.rateCardModel ?? event?.model,
  );
  if (!CODEX_CREDIT_RATE_CARD[model]) return "unknown-model";
  if (!hasDetailedTokenBreakdown(event)) return "incomplete-token-breakdown";
  if (
    codexCreditMultiplier(
      event?.rateCardModel ?? event?.model,
      event?.serviceTier,
    ) === null
  ) {
    return "unsupported-credit-fast-tier";
  }
  return "unrated-credit-usage";
}

function eventEstimate(event, basis) {
  if (basis === "api-usd") return apiUsdForUsage(event);
  const amount = calculateCodexPurchasedCredits({
    model: event?.rateCardModel ?? event?.model,
    serviceTier: event?.serviceTier,
    usage: event,
  });
  const totalTokens = nonNegative(event?.totalTokens);
  if (amount === null) {
    return {
      amount: null,
      ratedTokens: 0,
      unratedTokens: totalTokens,
      reasons: [creditReason(event)],
    };
  }
  return {
    amount,
    ratedTokens: totalTokens,
    unratedTokens: 0,
    reasons: [],
  };
}

function aggregate(events, basis) {
  const models = new Map();
  const reasons = new Map();
  let amount = 0;
  let amountKnown = false;
  let ratedTokens = 0;
  let unratedTokens = 0;

  for (const event of events) {
    const key = normalizeCodexCreditModel(event?.model);
    const row = models.get(key) ?? {
      model: modelLabel(event?.model),
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      amount: 0,
      amountKnown: false,
      ratedTokens: 0,
      unratedTokens: 0,
    };
    row.inputTokens += nonNegative(event?.inputTokens);
    row.cachedInputTokens += Math.min(
      nonNegative(event?.inputTokens),
      nonNegative(event?.cachedInputTokens),
    );
    row.outputTokens += nonNegative(event?.outputTokens);
    const estimate = eventEstimate(event, basis);
    row.ratedTokens += estimate.ratedTokens;
    row.unratedTokens += estimate.unratedTokens;
    ratedTokens += estimate.ratedTokens;
    unratedTokens += estimate.unratedTokens;
    if (estimate.amount !== null) {
      row.amount += estimate.amount;
      row.amountKnown = true;
      amount += estimate.amount;
      amountKnown = true;
    }
    for (const reason of estimate.reasons) {
      reasons.set(reason, (reasons.get(reason) ?? 0) + estimate.unratedTokens);
    }
    models.set(key, row);
  }

  return {
    models: [...models.values()].sort((a, b) =>
      b.ratedTokens + b.unratedTokens - (a.ratedTokens + a.unratedTokens)
    ),
    amount: amountKnown ? amount : null,
    ratedTokens,
    unratedTokens,
    reasons,
  };
}

function formatAmount(amount, basis) {
  if (amount === null) return "—";
  if (basis === "api-usd") {
    return amount >= 0.01 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(6)}`;
  }
  return `${amount.toFixed(3)} credits`;
}

function pad(value, width, align = "left") {
  const text = String(value);
  if (text.length >= width) return text;
  const spaces = " ".repeat(width - text.length);
  return align === "right" ? `${spaces}${text}` : `${text}${spaces}`;
}

export function renderCostTerminal({
  events,
  bounds,
  basis,
  snapshotFreshness = null,
  sourceStatus = "unchecked-cache",
}) {
  const report = aggregate(events, basis);
  const heading = basis === "api-usd"
    ? "Hypothetical API-equivalent cost (USD)"
    : "Codex purchased-credit estimate";
  const amountLabel = basis === "api-usd" ? "USD" : "Credits";
  const modelWidth = Math.max(
    12,
    ...report.models.map((row) => row.model.length),
  );
  const rows = report.models.map((row) => {
    const rowTokens = row.ratedTokens + row.unratedTokens;
    return [
      pad(row.model, modelWidth),
      pad(compact(row.inputTokens), 9, "right"),
      pad(compact(row.cachedInputTokens), 9, "right"),
      pad(compact(row.outputTokens), 9, "right"),
      pad(formatAmount(row.amountKnown ? row.amount : null, basis), 16, "right"),
      pad(percent(row.ratedTokens, rowTokens), 9, "right"),
    ].join("  ");
  });
  const totalTokens = report.ratedTokens + report.unratedTokens;
  const reasonLines = [...report.reasons.entries()]
    .map(([reason, tokens]) => `${reason} (${compact(tokens)} tokens)`);
  const cardDate = basis === "api-usd"
    ? API_USD_RATE_CARD_AS_OF
    : CODEX_CREDIT_RATE_CARD_AS_OF;
  const footer = basis === "api-usd"
    ? "Local history is incomplete account evidence; unsupported API charges are excluded. This is not an actual bill."
    : "Purchased-credit rates do not infer included-plan or five-hour/weekly meter usage.";

  return [
    heading,
    `Range: ${bounds.startDateString ?? bounds.start.toISOString()} through ${bounds.endDateString ?? bounds.end.toISOString()} (${bounds.timeZone})`,
    `Snapshot: ${snapshotFreshnessDetail(snapshotFreshness)}`,
    sourceStatusLine(sourceStatus),
    "",
    [
      pad("Model", modelWidth),
      pad("Input", 9, "right"),
      pad("Cached", 9, "right"),
      pad("Output", 9, "right"),
      pad(amountLabel, 16, "right"),
      pad("Coverage", 9, "right"),
    ].join("  "),
    ...rows,
    "",
    `Total rated amount: ${formatAmount(report.amount, basis)}`,
    `Rated token coverage: ${percent(report.ratedTokens, totalTokens)}`,
    `Unrated tokens: ${compact(report.unratedTokens)}`,
    `Rate card as of: ${cardDate}`,
    `Reasons: ${reasonLines.length > 0 ? reasonLines.join(", ") : "none"}`,
    footer,
  ].join("\n");
}
