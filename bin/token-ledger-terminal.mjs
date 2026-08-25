import {
  eventCredits,
  normalizeQuotaTimeline,
  weeklyQuotaObservations,
} from "./token-ledger-trend.mjs";
import {
  INTERACTIVE_FOOTER,
  INTERACTIVE_HELP,
} from "./token-ledger-controls.mjs";
import {
  MAX_SAFE_TOKEN_COUNT,
  checkedFiniteAdd,
  checkedTokenAdd,
  tokenValue,
  usageBucketsInRange,
  usageCallCount,
  usageThreadIds,
} from "../lib/token-ledger-usage.mjs";
import { calendarDateParts } from "../lib/token-ledger-calendar.mjs";
import { sanitizeTerminalText } from "../lib/token-ledger-terminal-text.mjs";
import { historyScopeLabel } from "../lib/token-ledger-collection.mjs";

const RESET = "\u001b[0m";
const PRIMARY_STYLE = [38, 2, 255, 255, 255];
const SECONDARY_STYLE = [38, 2, 155, 155, 155];
const ACCENT_STYLE = [38, 2, 51, 156, 255];
const BORDER_STYLE = [38, 2, 88, 88, 88];
const TRACK_STYLE = [38, 2, 59, 59, 59];
export const MODEL_COLORS = {
  sol: [38, 2, 120, 185, 242],
  luna: ACCENT_STYLE,
  terra: [38, 2, 214, 168, 95],
  gpt: [38, 2, 174, 139, 219],
  other: [38, 2, 116, 125, 144],
};
const TEXT_STYLE = PRIMARY_STYLE;
const TITLE_STYLE = [1, ...PRIMARY_STYLE];
const SUBTITLE_STYLE = SECONDARY_STYLE;
const SELECTED_BACKGROUND = "\u001b[48;2;42;42;42m";

function colorsEnabled(options) {
  return options.forceColor ?? (!options.plain && !process.env.NO_COLOR && Boolean(process.stdout.isTTY));
}

function colorize(value, code, enabled) {
  const codes = Array.isArray(code) ? code.join(";") : code;
  return enabled ? `\u001b[${codes}m${value}${RESET}` : value;
}

function stripAnsi(value) {
  return sanitizeTerminalText(value);
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function truncateText(value, width) {
  const text = String(value);
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";

  const available = width - 1;
  const prefix = text.slice(0, available);
  const breakAt = prefix.lastIndexOf(" ");
  const cleanPrefix = breakAt >= Math.floor(available * 0.6)
    ? prefix.slice(0, breakAt)
    : prefix;
  return `${cleanPrefix.replace(/\s+$/, "")}…`;
}

function fit(value, width, alignment = "left") {
  const text = String(value);
  const length = visibleLength(text);
  if (length > width) return truncateText(stripAnsi(text), width);
  const padding = " ".repeat(width - length);
  if (alignment === "right") return `${padding}${text}`;
  if (alignment === "center") {
    const left = Math.floor(padding.length / 2);
    return `${" ".repeat(left)}${text}${" ".repeat(padding.length - left)}`;
  }
  return `${text}${padding}`;
}

function compact(value) {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const units = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (let index = 0; index < units.length; index += 1) {
    const [divisor, suffix] = units[index];
    if (absolute < divisor) continue;
    const scaled = value / divisor;
    const magnitude = Math.abs(scaled);
    const precision = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
    // Values that round to 1000 of a unit belong to the next unit up
    // (999,999 → 1.00M, not 1000K).
    if (index > 0 && Number(magnitude.toFixed(precision)) >= 1_000) {
      return compact(Math.sign(value) * divisor * 1_000);
    }
    return `${scaled.toFixed(precision)}${suffix}`;
  }
  return Math.round(value).toLocaleString("en-US");
}

function percent(value) {
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function plural(value, singular, pluralForm = `${singular}s`) {
  return `${value.toLocaleString("en-US")} ${value === 1 ? singular : pluralForm}`;
}

function modelLabel(value) {
  const model = String(value || "Unknown model");
  const lower = model.toLowerCase();
  if (lower.includes("sol")) return "Sol";
  if (lower.includes("luna")) return "Luna";
  if (lower.includes("terra")) return "Terra";
  if (lower.includes("gpt-5.5") || lower.includes("gpt-5.4")) return "GPT";
  return "Other";
}

function modelColor(model) {
  const key = String(model || "").toLowerCase();
  return MODEL_COLORS[key] ?? MODEL_COLORS.other;
}

function usageTypeLabel(value) {
  const words = sanitizeTerminalText(value || "unknown")
    .trim()
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "Unknown";
  return words
    .map((word) => {
      const lower = word.toLowerCase();
      if (["api", "cli", "sdk", "ui"].includes(lower)) return lower.toUpperCase();
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function displayProject(row) {
  const label = sanitizeTerminalText(
    row.displayProject || row.project || "Unlabelled activity",
  )
    .replace(/\s+/g, " ")
    .trim();
  return label || "Unlabelled activity";
}

function isRollingRange(range) {
  return range === "rolling24h" || range === "rolling";
}

function dateLabel(bounds, range = "day", rollingLabel = "1 day") {
  if (range === "rolling24h") return "LAST 24 HOURS";
  if (range === "rolling") return `LAST ${rollingLabel.toUpperCase()}`;
  if (range === "week" && bounds.startDateString && bounds.endDateString) {
    const startParts = bounds.startDateString.split("-").map(Number);
    const endParts = bounds.endDateString.split("-").map(Number);
    const monthNames = [
      "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
      "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
    ];
    const start = `${monthNames[startParts[1] - 1]} ${String(startParts[2]).padStart(2, "0")}`;
    const end = `${monthNames[endParts[1] - 1]} ${String(endParts[2]).padStart(2, "0")}`;
    return `${start} – ${end} ${endParts[0]}`;
  }
  const values = calendarDateParts(bounds.dateString, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  return `${values.weekday} ${values.day} ${values.month} ${values.year}`.toUpperCase();
}

function modelTotals(events) {
  const totals = new Map();
  let scale = 1;
  let totalTokens = 0;
  for (const event of events) {
    if (event?.invalidTokenRecord === true) continue;
    const model = modelLabel(event.model);
    const allowFractional = event.rangeAllocationEstimated === true;
    const tokens = tokenValue(event.totalTokens, { allowFractional });
    const scaledTokens = tokens / scale;
    totalTokens += scaledTokens;
    totals.set(
      model,
      (totals.get(model) ?? 0) + scaledTokens,
    );
    const scaleFactor = Math.max(1, totalTokens / MAX_SAFE_TOKEN_COUNT);
    if (scaleFactor === 1) continue;
    for (const [modelName, value] of totals) {
      totals.set(modelName, value / scaleFactor);
    }
    totalTokens = MAX_SAFE_TOKEN_COUNT;
    scale *= scaleFactor;
  }
  return [...totals.entries()]
    .map(([model, totalTokens]) => ({ model, totalTokens }))
    .sort((left, right) => right.totalTokens - left.totalTokens);
}

function usageTypeTotals(events) {
  const totals = new Map();
  let scale = 1;
  let totalTokens = 0;
  for (const event of events) {
    if (event?.invalidTokenRecord === true) continue;
    const key = sanitizeTerminalText(event.useType || "unknown")
      .trim()
      .toLowerCase() || "unknown";
    const allowFractional = event.rangeAllocationEstimated === true;
    const tokens = tokenValue(event.totalTokens, { allowFractional });
    const scaledTokens = tokens / scale;
    totalTokens += scaledTokens;
    totals.set(
      key,
      (totals.get(key) ?? 0) + scaledTokens,
    );
    const scaleFactor = Math.max(1, totalTokens / MAX_SAFE_TOKEN_COUNT);
    if (scaleFactor === 1) continue;
    for (const [usageType, value] of totals) {
      totals.set(usageType, value / scaleFactor);
    }
    totalTokens = MAX_SAFE_TOKEN_COUNT;
    scale *= scaleFactor;
  }
  return [...totals.entries()]
    .map(([key, totalTokens]) => ({
      key,
      label: usageTypeLabel(key),
      totalTokens,
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens);
}

function addCacheTotals(state, inputTokens, cachedInputTokens) {
  const nextInput = state.inputTokens + inputTokens / state.scale;
  const nextCached = state.cachedInputTokens + cachedInputTokens / state.scale;
  const scaleFactor = Math.max(
    1,
    nextInput / MAX_SAFE_TOKEN_COUNT,
    nextCached / MAX_SAFE_TOKEN_COUNT,
  );
  state.inputTokens = nextInput / scaleFactor;
  state.cachedInputTokens = nextCached / scaleFactor;
  state.scale *= scaleFactor;
}

function latestWeeklyQuotaObservation(snapshot) {
  // The epoch-keyed timeline drops stale readings from superseded windows,
  // so the last entry is the newest reading of the currently-live window.
  const normalized = normalizeQuotaTimeline(weeklyQuotaObservations(snapshot));
  const latest = normalized.at(-1);
  if (!latest) return null;
  return { ...latest, usedPercent: latest.normalizedUsedPercent };
}

export function quotaCycleSummary(snapshot = {}, displayedEvents = []) {
  const observation = latestWeeklyQuotaObservation(snapshot);
  if (!observation) {
    return {
      available: false,
      usedPercent: null,
      remainingPercent: null,
      cycleTokens: 0,
      displayedTokens: 0,
      displayedSharePercent: null,
      estimatedDisplayedBurnPercent: null,
    };
  }

  const windowStartMs =
    (Number(observation.resetsAt) - Number(observation.windowMinutes) * 60) * 1_000;
  const resetAtMs = Number(observation.resetsAt) * 1_000;
  const observedThroughMs = Math.min(
    resetAtMs,
    new Date(observation.eventCutoffAt ?? observation.timestamp).getTime(),
  );
  if (
    !Number.isFinite(windowStartMs) ||
    !Number.isFinite(resetAtMs) ||
    !Number.isFinite(observedThroughMs) ||
    observedThroughMs < windowStartMs
  ) {
    return {
      available: false,
      usedPercent: null,
      remainingPercent: null,
      cycleTokens: 0,
      displayedTokens: 0,
      displayedSharePercent: null,
      estimatedDisplayedBurnPercent: null,
    };
  }

  const sumUsage = (events, initialScale = 1) => {
    const acc = {
      tokens: 0,
      credits: 0,
      ratedTokens: 0,
      hasUnrated: false,
      scale: Number.isFinite(initialScale) && initialScale >= 1
        ? initialScale
        : 1,
    };
    for (const event of events) {
      if (event?.invalidTokenRecord === true) continue;
      const allowFractional = event.rangeAllocationEstimated === true;
      const tokens = tokenValue(event.totalTokens, { allowFractional });
      const contribution = tokens / acc.scale;
      const nextTokens = acc.tokens + contribution;
      const scaleFactor = Math.max(
        1,
        nextTokens / MAX_SAFE_TOKEN_COUNT,
      );
      if (scaleFactor > 1) {
        acc.tokens /= scaleFactor;
        acc.ratedTokens /= scaleFactor;
        acc.scale *= scaleFactor;
      }
      const scaledContribution = contribution / scaleFactor;
      acc.tokens += scaledContribution;
      const credits = eventCredits(event);
      if (Number.isFinite(credits) && credits >= 0) {
        acc.credits = checkedFiniteAdd(acc.credits, credits);
        acc.ratedTokens += scaledContribution;
      } else if (tokens > 0) {
        acc.hasUnrated = true;
      }
    }
    return acc;
  };
  const cycleEndMs = observedThroughMs + 1;
  const cycle = sumUsage(
    usageBucketsInRange(snapshot, windowStartMs, cycleEndMs),
  );
  const displayed = sumUsage(
    usageBucketsInRange(
      { events: displayedEvents },
      windowStartMs,
      cycleEndMs,
    ),
    cycle.scale,
  );
  const usedPercent = Math.min(100, Math.max(0, Number(observation.usedPercent) || 0));
  // The weekly meter weights usage by model, token type, and fast mode;
  // rate-card credits carry those weights. Allocate burn by credit share
  // when every event in the cycle is rated, and fall back to raw token
  // share otherwise.
  const creditsUsable =
    !cycle.hasUnrated &&
    cycle.tokens > 0 &&
    cycle.ratedTokens === cycle.tokens &&
    cycle.credits > 0;
  const displayedSharePercent = creditsUsable
    ? (displayed.credits / cycle.credits) * 100
    : cycle.tokens
      ? (displayed.tokens / cycle.tokens) * 100
      : null;

  return {
    available: true,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    cycleTokens: cycle.tokens,
    displayedTokens: displayed.tokens,
    displayedSharePercent,
    shareBasis: creditsUsable ? "credits" : "tokens",
    estimatedDisplayedBurnPercent:
      displayedSharePercent === null
        ? null
        : (usedPercent * displayedSharePercent) / 100,
  };
}

function summary(events, projectRows) {
  const totalTokens = projectRows.reduce(
    (sum, row) => sum + row.totalTokens,
    0,
  );
  const calls = events.reduce(
    (sum, event) => {
      const allowFractional = event?.rangeAllocationEstimated === true;
      return checkedTokenAdd(sum, usageCallCount(event), { allowFractional });
    },
    0,
  );
  const threadIds = new Set(
    events.flatMap((event) => usageThreadIds(event)),
  );
  const outputTokens = events.reduce(
    (sum, event) => {
      if (event?.invalidTokenRecord === true) return sum;
      const allowFractional = event.rangeAllocationEstimated === true;
      return checkedTokenAdd(
        sum,
        tokenValue(event.outputTokens, { allowFractional }),
        { allowFractional },
      );
    },
    0,
  );
  const cacheTotals = { inputTokens: 0, cachedInputTokens: 0, scale: 1 };
  for (const event of events) {
    if (event?.invalidTokenRecord === true) continue;
    const allowFractional = event.rangeAllocationEstimated === true;
    const input = tokenValue(event.inputTokens, { allowFractional });
    const cached = Math.min(
      input,
      tokenValue(event.cachedInputTokens, { allowFractional }),
    );
    addCacheTotals(cacheTotals, input, cached);
  }
  return {
    totalTokens,
    calls,
    threads: threadIds.size,
    outputTokens,
    inputTokens: cacheTotals.inputTokens,
    cachedInputTokens: cacheTotals.cachedInputTokens,
    uncachedInputTokens: Math.max(
      0,
      cacheTotals.inputTokens - cacheTotals.cachedInputTokens,
    ),
    models: modelTotals(events),
    usageTypes: usageTypeTotals(events),
  };
}

function modelLegendItems(models, totalTokens) {
  const known = new Map();
  for (const model of models) {
    const key = ["Sol", "Luna", "Terra", "GPT"].includes(model.model)
      ? model.model
      : "Other";
    known.set(key, (known.get(key) ?? 0) + model.totalTokens);
  }
  return ["Luna", "Sol", "Terra", "GPT", "Other"]
    .map((model) => ({
      model,
      totalTokens: known.get(model) ?? 0,
      share: totalTokens > 0 ? ((known.get(model) ?? 0) / totalTokens) * 100 : 0,
    }));
}

function stackedBar(row, width, maximumTokens, options, enabled) {
  const symbol = options.ascii ? "#" : "█";
  const trackSymbol = options.ascii ? "." : "░";
  const models = row.models.filter((model) => model.totalTokens > 0);
  const total = row.totalTokens || 1;
  const fillWidth = maximumTokens > 0
    ? Math.min(width, Math.max(1, Math.round((row.totalTokens / maximumTokens) * width)))
    : 0;
  const widths = models.length && fillWidth > 0
    ? models.map((model) => (model.totalTokens / total) * fillWidth)
    : [];
  const allocated = widths.map((value) => Math.floor(value));
  let remainder = models.length
    ? fillWidth - allocated.reduce((sum, value) => sum + value, 0)
    : 0;
  const fractionalOrder = widths
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction);
  for (let index = 0; index < remainder; index += 1) {
    allocated[fractionalOrder[index % fractionalOrder.length]?.index ?? 0] += 1;
  }
  const filled = models
    .map((model, index) => {
      const label = modelLabel(model.model);
      return colorize(symbol.repeat(allocated[index]), modelColor(label), enabled);
    })
    .join("");
  const blank = colorize(
    trackSymbol.repeat(Math.max(0, width - visibleLength(filled))),
    TRACK_STYLE,
    enabled,
  );
  return `${filled}${blank}`;
}

function panelLines(rows, allRows, totalTokens, panelWidth, options, enabled) {
  const compactMode = panelWidth < 82;
  const narrowMode = panelWidth < 60;
  const shareWidth = narrowMode ? 6 : compactMode ? 7 : 8;
  const totalWidth = narrowMode ? 8 : compactMode ? 9 : 10;
  const minimumBarWidth = narrowMode ? 4 : 8;
  const rightPadding = 2;
  const preferredLabelWidth = compactMode ? 38 : 40;
  const minimumLabelWidth = narrowMode ? 17 : 24;
  const maximumLabelWidth = panelWidth - minimumBarWidth - shareWidth - totalWidth - 1 - rightPadding;
  const labelWidth = Math.max(minimumLabelWidth, Math.min(preferredLabelWidth, maximumLabelWidth));
  const barWidth = Math.max(
    minimumBarWidth,
    panelWidth - labelWidth - shareWidth - totalWidth - 1 - rightPadding,
  );
  const maxTokens = allRows[0]?.totalTokens ?? 0;
  const totalCredits = allRows.reduce(
    (sum, item) => checkedFiniteAdd(sum, item.rateCardCredits),
    0,
  ) || 1;
  const selectedIndex = Math.min(
    Math.max(0, Math.trunc(Number(options.selectedIndex) || 0)),
    Math.max(0, rows.length - 1),
  );
  const lines = [];
  const heading = colorize("TOKENS BY PROJECT", ACCENT_STYLE, enabled);
  const barHeaderWidth = barWidth;
  const maximumLabel = compactMode ? `${compact(maxTokens)} max` : `${compact(maxTokens)} (max)`;
  const axisLabel = barHeaderWidth >= maximumLabel.length + 2 ? maximumLabel : compact(maxTokens);
  const axisText = barHeaderWidth >= axisLabel.length + 2
    ? `0${" ".repeat(barHeaderWidth - axisLabel.length - 1)}${axisLabel}`
    : truncateText(axisLabel, barHeaderWidth);
  lines.push(
    `${fit(heading, labelWidth)}${fit(axisText, barHeaderWidth)}${fit("TOKENS", totalWidth, "right")}${fit("SHARE", shareWidth, "right")}${" ".repeat(rightPadding)}`,
  );
  lines.push(colorize("─".repeat(panelWidth), BORDER_STYLE, enabled));

  for (const [index, row] of rows.entries()) {
    const share = totalTokens > 0 ? (row.totalTokens / totalTokens) * 100 : 0;
    const selected = index === selectedIndex;
    const caretValue = selected ? (options.ascii ? ">" : "▶") : " ";
    const prefix = `${caretValue} ${index + 1}. `;
    const projectText = truncateText(displayProject(row), labelWidth - prefix.length);
    const caret = selected ? colorize(caretValue, [1, ...ACCENT_STYLE], enabled) : caretValue;
    const rank = colorize(`${index + 1}.`, TITLE_STYLE, enabled);
    const title = `${caret} ${rank} ${colorize(projectText, TITLE_STYLE, enabled)}`;
    const label = fit(title, labelWidth);
    const metrics = `${fit(compact(row.totalTokens), totalWidth, "right")}${fit(percent(share), shareWidth, "right")}${" ".repeat(rightPadding)}`;
    const bar = stackedBar(row, barWidth, maxTokens, options, enabled);
    const rowLine = `${label}${bar} ${metrics}`;
    const creditShare = row.rateCardCredits > 0 && row.rateCardCredits <= Number.MAX_SAFE_INTEGER
      ? row.rateCardCredits
      : 0;
    const detail = `${plural(row.threads, "thread")} · ${percent(
      creditShare > 0 ? (creditShare / totalCredits) * 100 : 0,
    )}${labelWidth >= 35 ? " credits" : ""}`;
    const detailText = truncateText(detail, labelWidth - 4);
    const subtitle = colorize(detailText, SUBTITLE_STYLE, enabled);
    const detailLine = `${fit(`    ${subtitle}`, labelWidth)}${" ".repeat(barWidth + 1 + totalWidth + shareWidth + rightPadding)}`;
    if (selected && enabled && options.highlight !== false) {
      lines.push(`${SELECTED_BACKGROUND}${fit(rowLine, panelWidth)}${RESET}`);
      lines.push(`${SELECTED_BACKGROUND}${fit(detailLine, panelWidth)}${RESET}`);
    } else {
      lines.push(rowLine);
      lines.push(detailLine);
    }
  }
  return lines.map((line) => fit(line, panelWidth));
}

function sidebarLines(stats, panelWidth, enabled, options = {}, quota = null) {
  const lines = [];
  const compactSidebar = options.compactSidebar === true;
  const inset = panelWidth >= 20 ? 2 : 1;
  const contentWidth = Math.max(1, panelWidth - inset * 2);
  const push = (line = "") => {
    lines.push(`${" ".repeat(inset)}${fit(line, contentWidth)}${" ".repeat(inset)}`);
  };
  const divider = () => push(colorize("─".repeat(contentWidth), BORDER_STYLE, enabled));
  const heading = (value) => colorize(value, ACCENT_STYLE, enabled);
  push(heading("MODEL MIX"));
  if (!compactSidebar) push();
  for (const item of modelLegendItems(stats.models, stats.totalTokens)) {
    const swatch = colorize("■", modelColor(item.model), enabled);
    push(`${swatch} ${fit(item.model, Math.max(1, contentWidth - 10))}${fit(percent(item.share), 8, "right")}`);
  }
  push();
  divider();
  push(heading("USAGE TYPE · TOKENS"));
  if (!compactSidebar) push();
  const usageItems = stats.usageTypes.length > 5
    ? [
        ...stats.usageTypes.slice(0, 4),
        {
          key: "other",
          label: "Other",
          totalTokens: stats.usageTypes
            .slice(4)
            .reduce(
              (sum, item) => checkedTokenAdd(sum, item.totalTokens, {
                allowFractional: true,
              }),
              0,
            ),
        },
      ]
    : stats.usageTypes;
  for (const item of usageItems) {
    const swatch = "■";
    const share = stats.totalTokens > 0 ? (item.totalTokens / stats.totalTokens) * 100 : 0;
    push(`${swatch} ${fit(item.label, Math.max(1, contentWidth - 10))}${fit(percent(share), 8, "right")}`);
  }
  push();
  divider();
  push(heading("CACHE · INPUT"));
  if (!compactSidebar) push();
  const cacheRows = [
    { label: "Cached", totalTokens: stats.cachedInputTokens },
    { label: "Uncached", totalTokens: stats.uncachedInputTokens },
  ];
  for (const item of cacheRows) {
    const swatch = "■";
    const share = stats.inputTokens > 0 ? (item.totalTokens / stats.inputTokens) * 100 : 0;
    push(`${swatch} ${fit(item.label, Math.max(1, contentWidth - 10))}${fit(percent(share), 8, "right")}`);
  }
  if (quota?.available) {
    push();
    divider();
    push(heading("RESET CYCLE"));
    if (!compactSidebar) push();
    push("Used" + fit(percent(quota.usedPercent), 8, "right"));
    push("Remaining" + fit(percent(quota.remainingPercent), 8, "right"));
    if (quota.estimatedDisplayedBurnPercent !== null) {
      const burn = "~" + percent(quota.estimatedDisplayedBurnPercent).replace("%", "") + " pts";
      push("View burn" + fit(burn, 10, "right"));
    }
  }
  if (!compactSidebar) push();
  return lines.map((line) => fit(line, panelWidth));
}

function panel(leftLines, rightLines, leftWidth, rightWidth, enabled, ascii) {
  const glyphs = ascii
    ? { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", tm: "+", bm: "+" }
    : { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", tm: "┬", bm: "┴" };
  const rows = Math.max(leftLines.length, rightLines?.length ?? 0);
  const border = (value) => colorize(value, BORDER_STYLE, enabled);
  const top = border(`${glyphs.tl}${glyphs.h.repeat(leftWidth)}${rightLines ? glyphs.tm : glyphs.tr}${rightLines ? glyphs.h.repeat(rightWidth) + glyphs.tr : ""}`);
  const body = [];
  for (let index = 0; index < rows; index += 1) {
    const left = fit(leftLines[index] ?? "", leftWidth);
    if (rightLines) {
      const right = fit(rightLines[index] ?? "", rightWidth);
      body.push(`${border(glyphs.v)}${left}${border(glyphs.v)}${right}${border(glyphs.v)}`);
    } else {
      body.push(`${border(glyphs.v)}${left}${border(glyphs.v)}`);
    }
  }
  const bottom = border(`${glyphs.bl}${glyphs.h.repeat(leftWidth)}${rightLines ? glyphs.bm : glyphs.br}${rightLines ? glyphs.h.repeat(rightWidth) + glyphs.br : ""}`);
  return [top, ...body, bottom];
}

function snapshotLine(freshness, enabled) {
  const detail = freshness?.status === "fresh" || freshness?.status === "stale"
    ? `${freshness.status} · ${freshness.ageLabel}`
    : "age unknown";
  return `${colorize("SNAPSHOT", ACCENT_STYLE, enabled)} ${colorize("·", SECONDARY_STYLE, enabled)} ${colorize(detail, SECONDARY_STYLE, enabled)}`;
}

function headerLines(stats, bounds, frameWidth, options, enabled, freshness, snapshot) {
  const left = colorize("TOKEN LEDGER", TITLE_STYLE, enabled);
  const date = colorize(
    dateLabel(bounds, options.range, options.rollingLabel),
    TEXT_STYLE,
    enabled,
  );
  const modeLabel = options.range === "rolling24h"
    ? "24 HOURS"
    : options.range === "rolling"
      ? options.rollingLabel.toUpperCase()
    : options.range === "week"
      ? "7 DAYS"
      : "DAY";
  const mode = colorize(modeLabel, [1, ...ACCENT_STYLE], enabled);
  const metric = (value, label) =>
    `${colorize(String(value), TITLE_STYLE, enabled)} ${colorize(label, SECONDARY_STYLE, enabled)}`;
  const separator = colorize("·", SECONDARY_STYLE, enabled);
  const join = ` ${separator} `;
  const alignHeader = (line) => fit(` ${line}`, frameWidth);
  const history = historyScopeLabel(snapshot);
  const appendHistory = (lines) => history
    ? [...lines, alignHeader(colorize(history, SECONDARY_STYLE, enabled))]
    : lines;
  const fullLine = [
    left,
    date,
    mode,
    metric(compact(stats.totalTokens), "TOKENS"),
    metric(stats.calls.toLocaleString("en-US"), "CALLS"),
    metric(stats.threads.toLocaleString("en-US"), "THREADS"),
    metric(stats.projectCount.toLocaleString("en-US"), "PROJECTS"),
  ].join(join);
  if (visibleLength(fullLine) < frameWidth) {
    const lines = [alignHeader(fullLine)];
    if (isRollingRange(options.range)) lines.push(alignHeader(snapshotLine(freshness, enabled)));
    return appendHistory(lines);
  }

  const compactDate = dateLabel(bounds, options.range, options.rollingLabel)
    .replace(/ 20\d{2}$/, "")
    .replace(" – ", "–");
  const compactMode = options.range === "rolling24h"
    ? "24H"
    : options.range === "rolling"
      ? `${options.rollingAmount}${options.rollingUnit.toUpperCase()}`
    : options.range === "week"
      ? "7D"
      : "DAY";
  const compactLine = [
    left,
    colorize(compactDate, TEXT_STYLE, enabled),
    colorize(compactMode, [1, ...ACCENT_STYLE], enabled),
    metric(`${compact(stats.totalTokens)}`, "T"),
    metric(stats.calls.toLocaleString("en-US"), "C"),
    metric(stats.threads.toLocaleString("en-US"), "TH"),
    metric(stats.projectCount.toLocaleString("en-US"), "P"),
  ].join(join);
  if (visibleLength(compactLine) < frameWidth) {
    const lines = [alignHeader(compactLine)];
    if (isRollingRange(options.range)) lines.push(alignHeader(snapshotLine(freshness, enabled)));
    return appendHistory(lines);
  }

  const minimalTitle = colorize(frameWidth >= 45 ? "LEDGER" : "L", TITLE_STYLE, enabled);
  const minimalLine = [
    minimalTitle,
    colorize(compactDate.replaceAll(" ", ""), TEXT_STYLE, enabled),
    colorize(compactMode, [1, ...ACCENT_STYLE], enabled),
    compact(stats.totalTokens),
    compact(stats.calls),
    compact(stats.threads),
    compact(stats.projectCount),
  ].join(" ");
  const lines = [alignHeader(minimalLine)];
  if (isRollingRange(options.range)) lines.push(alignHeader(snapshotLine(freshness, enabled)));
  return appendHistory(lines);
}

export function renderTerminal({
  options,
  snapshot,
  snapshotFreshness,
  bounds,
  events,
  rows,
  allRows,
}) {
  const enabled = colorsEnabled(options);
  const stats = summary(events, allRows);
  const quota = quotaCycleSummary(snapshot, events);
  stats.projectCount = allRows.length;
  const columns = options.width ?? (Number(process.stdout.columns) || 120);
  const frameWidth = Math.max(38, Math.min(158, columns - 2));
  const sideBySide = options.forceSideBySide ?? frameWidth >= 100;
  const sideWidth = sideBySide ? 26 : 0;
  const leftWidth = sideBySide ? frameWidth - sideWidth - 1 : frameWidth;
  const left = panelLines(rows, allRows, stats.totalTokens, leftWidth, options, enabled);
  const right = sideBySide ? sidebarLines(stats, sideWidth, enabled, options, quota) : null;
  const lines = [
    ...headerLines(stats, bounds, frameWidth, options, enabled, snapshotFreshness, snapshot),
    ...panel(left, right, leftWidth, sideWidth, enabled, options.ascii),
  ];
  if (!sideBySide) {
    lines.push("");
    lines.push(...sidebarLines(stats, frameWidth, enabled, options, quota));
  }
  if (events.some((event) => event.rangeAllocationEstimated === true)) {
    lines.push("");
    lines.push(colorize(
      "≈ Boundary-spanning compact history is allocated proportionally.",
      SECONDARY_STYLE,
      enabled,
    ));
  }
  lines.push("");
  lines.push(
    colorize(
      options.ascii ? INTERACTIVE_FOOTER.ascii : INTERACTIVE_FOOTER.unicode,
      SECONDARY_STYLE,
      enabled,
    ),
  );
  return lines.join("\n");
}

export const SCREEN_BASE = "\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m";
const PANEL_BASE = "\u001b[38;2;255;255;255m\u001b[48;2;24;24;24m";

function paintFullscreenLine(line, width, background, enabled) {
  const fitted = fit(line, width);
  if (!enabled) return fitted;
  const restored = fitted.replaceAll(RESET, `${RESET}${background}`);
  return `${background}${restored}${RESET}`;
}

export function renderFullscreen({
  options,
  snapshot,
  snapshotFreshness,
  bounds,
  events,
  rows,
  allRows,
  width,
  height,
}) {
  const enabled = options.forceColor ?? colorsEnabled(options);
  const columns = Math.max(40, Number(width) || Number(process.stdout.columns) || 120);
  const screenHeight = Math.max(1, Number(height) || Number(process.stdout.rows) || 32);
  const frameWidth = Math.max(38, Math.min(158, columns - 4));
  const staticOutput = renderTerminal({
    options: {
      ...options,
      forceColor: enabled,
      forceSideBySide: frameWidth >= 84,
      highlight: false,
      compactSidebar: true,
      width: frameWidth + 2,
    },
    snapshot,
    snapshotFreshness,
    bounds,
    events,
    rows,
    allRows,
  });
  const staticLines = staticOutput.split("\n");
  staticLines.pop();
  if (staticLines.at(-1) === "") staticLines.pop();
  const summaryLine = staticLines.shift() ?? "";
  const help = colorize(INTERACTIVE_HELP, SECONDARY_STYLE, enabled);
  const content = [
    { line: summaryLine, background: SCREEN_BASE },
    ...staticLines.map((line) => ({ line, background: PANEL_BASE })),
    { line: "", background: SCREEN_BASE },
    { line: help, background: SCREEN_BASE },
  ];
  const topPadding = Math.max(0, Math.floor((screenHeight - content.length) / 2));
  const screenLines = [
    ...Array.from({ length: topPadding }, () => ({ line: "", background: SCREEN_BASE })),
    ...content,
  ].slice(0, screenHeight);
  while (screenLines.length < screenHeight) {
    screenLines.push({ line: "", background: SCREEN_BASE });
  }
  return screenLines
    .map(({ line, background }) => paintFullscreenLine(line, columns, background, enabled))
    .join("\n");
}
