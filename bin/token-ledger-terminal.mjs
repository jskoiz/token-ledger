const RESET = "\u001b[0m";
const DIM = [38, 5, 245];
const TEAL = [38, 5, 80];
export const MODEL_COLORS = {
  sol: [38, 5, 67],
  luna: [38, 5, 80],
  terra: [38, 5, 179],
  gpt: [38, 5, 176],
  other: [38, 5, 60],
};
const TEXT_STYLE = [38, 5, 255];
const TITLE_STYLE = [1, 38, 5, 255];
const SUBTITLE_STYLE = [38, 5, 245];

function colorsEnabled(options) {
  return options.forceColor ?? (!options.plain && !process.env.NO_COLOR && Boolean(process.stdout.isTTY));
}

function colorize(value, code, enabled) {
  const codes = Array.isArray(code) ? code.join(";") : code;
  return enabled ? `\u001b[${codes}m${value}${RESET}` : value;
}

function stripAnsi(value) {
  return String(value)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function sanitizeText(value) {
  return stripAnsi(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  for (const [divisor, suffix] of units) {
    if (absolute >= divisor) {
      const scaled = value / divisor;
      const precision = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return `${scaled.toFixed(precision)}${suffix}`;
    }
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
  const model = sanitizeText(value) || "Unknown model";
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
  const words = (sanitizeText(value) || "unknown")
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
  return sanitizeText(row.displayProject || row.project) || "Unlabelled activity";
}

function dateLabel(bounds, range = "day") {
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
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: bounds.timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).formatToParts(bounds.start);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.weekday} ${values.day} ${values.month} ${values.year}`.toUpperCase();
}

function modelTotals(events) {
  const totals = new Map();
  for (const event of events) {
    const model = modelLabel(event.model);
    totals.set(model, (totals.get(model) ?? 0) + (Number(event.totalTokens) || 0));
  }
  return [...totals.entries()]
    .map(([model, totalTokens]) => ({ model, totalTokens }))
    .sort((left, right) => right.totalTokens - left.totalTokens);
}

function usageTypeTotals(events) {
  const totals = new Map();
  for (const event of events) {
    const key = String(event.useType || "unknown").trim().toLowerCase() || "unknown";
    totals.set(key, (totals.get(key) ?? 0) + (Number(event.totalTokens) || 0));
  }
  return [...totals.entries()]
    .map(([key, totalTokens]) => ({
      key,
      label: usageTypeLabel(key),
      totalTokens,
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens);
}

function latestWeeklyQuotaObservation(observations) {
  const weekly = (observations ?? []).filter(
    (item) => Number(item.windowMinutes) === 10_080,
  );
  const accountWide = weekly.filter((item) => item.scope !== "named");
  const candidates = accountWide.length ? accountWide : weekly;
  return [...candidates]
    .sort(
      (left, right) =>
        new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
    )
    .at(-1) ?? null;
}

export function quotaCycleSummary(snapshot = {}, displayedEvents = []) {
  const observation = latestWeeklyQuotaObservation(snapshot.quotaObservations);
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

  const inObservedCycle = (event) => {
    const eventMs = new Date(event.timestamp).getTime();
    return (
      Number.isFinite(eventMs) &&
      eventMs >= windowStartMs &&
      eventMs <= observedThroughMs
    );
  };
  const sumTokens = (events) =>
    events.reduce((sum, event) => sum + (Number(event.totalTokens) || 0), 0);
  const cycleTokens = sumTokens((snapshot.events ?? []).filter(inObservedCycle));
  const displayedTokens = sumTokens(displayedEvents.filter(inObservedCycle));
  const usedPercent = Math.min(100, Math.max(0, Number(observation.usedPercent) || 0));
  const displayedSharePercent = cycleTokens
    ? (displayedTokens / cycleTokens) * 100
    : null;

  return {
    available: true,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    cycleTokens,
    displayedTokens,
    displayedSharePercent,
    estimatedDisplayedBurnPercent:
      displayedSharePercent === null
        ? null
        : (usedPercent * displayedSharePercent) / 100,
  };
}

function summary(events) {
  const totalTokens = events.reduce(
    (sum, event) => sum + (Number(event.totalTokens) || 0),
    0,
  );
  const calls = events.length;
  const threadIds = new Set(events.map((event) => event.threadId).filter(Boolean));
  const outputTokens = events.reduce(
    (sum, event) => sum + (Number(event.outputTokens) || 0),
    0,
  );
  const inputTokens = events.reduce(
    (sum, event) => sum + (Number(event.inputTokens) || 0),
    0,
  );
  const cachedInputTokens = events.reduce((sum, event) => {
    const input = Math.max(0, Number(event.inputTokens) || 0);
    const cached = Math.max(0, Number(event.cachedInputTokens) || 0);
    return sum + Math.min(input, cached);
  }, 0);
  return {
    totalTokens,
    calls,
    threads: threadIds.size,
    outputTokens,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
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
    DIM,
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
  const lines = [];
  const heading = colorize("TOKENS BY PROJECT", TEAL, enabled);
  const barHeaderWidth = barWidth;
  const maximumLabel = compactMode ? `${compact(maxTokens)} max` : `${compact(maxTokens)} (max)`;
  const axisLabel = barHeaderWidth >= maximumLabel.length + 2 ? maximumLabel : compact(maxTokens);
  const axisText = barHeaderWidth >= axisLabel.length + 2
    ? `0${" ".repeat(barHeaderWidth - axisLabel.length - 1)}${axisLabel}`
    : truncateText(axisLabel, barHeaderWidth);
  lines.push(
    `${fit(heading, labelWidth)}${fit(axisText, barHeaderWidth)}${fit("TOKENS", totalWidth, "right")}${fit("SHARE", shareWidth, "right")}${" ".repeat(rightPadding)}`,
  );
  lines.push(colorize("─".repeat(panelWidth), DIM, enabled));

  for (const [index, row] of rows.entries()) {
    const share = totalTokens > 0 ? (row.totalTokens / totalTokens) * 100 : 0;
    const selected = !options.static && index === (options.selectedIndex ?? 0);
    const caretValue = selected ? (options.ascii ? ">" : "▶") : " ";
    const prefix = `${caretValue} ${index + 1}. `;
    const projectText = truncateText(displayProject(row), labelWidth - prefix.length);
    const caret = selected ? colorize(caretValue, [1, ...TEAL], enabled) : caretValue;
    const rank = colorize(`${index + 1}.`, TITLE_STYLE, enabled);
    const title = `${caret} ${rank} ${colorize(projectText, TITLE_STYLE, enabled)}`;
    const label = fit(title, labelWidth);
    const metrics = `${fit(compact(row.totalTokens), totalWidth, "right")}${fit(percent(share), shareWidth, "right")}${" ".repeat(rightPadding)}`;
    const bar = stackedBar(row, barWidth, maxTokens, options, enabled);
    const rowLine = `${label}${bar} ${metrics}`;
    const detail = plural(row.threads, "thread");
    const detailText = truncateText(detail, labelWidth - 4);
    const subtitle = colorize(detailText, SUBTITLE_STYLE, enabled);
    const detailLine = `${fit(`    ${subtitle}`, labelWidth)}${" ".repeat(barWidth + 1 + totalWidth + shareWidth + rightPadding)}`;
    if (selected && enabled && options.highlight !== false) {
      lines.push(`\u001b[48;5;236m${fit(rowLine, panelWidth)}${RESET}`);
      lines.push(`\u001b[48;5;236m${fit(detailLine, panelWidth)}${RESET}`);
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
  const divider = () => push(colorize("─".repeat(contentWidth), DIM, enabled));
  const heading = (value) => colorize(value, TEAL, enabled);
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
            .reduce((sum, item) => sum + item.totalTokens, 0),
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
  const top = `${glyphs.tl}${glyphs.h.repeat(leftWidth)}${rightLines ? glyphs.tm : glyphs.tr}${rightLines ? glyphs.h.repeat(rightWidth) + glyphs.tr : ""}`;
  const body = [];
  for (let index = 0; index < rows; index += 1) {
    const left = fit(leftLines[index] ?? "", leftWidth);
    if (rightLines) {
      const right = fit(rightLines[index] ?? "", rightWidth);
      body.push(`${glyphs.v}${left}${glyphs.v}${right}${glyphs.v}`);
    } else {
      body.push(`${glyphs.v}${left}${glyphs.v}`);
    }
  }
  const bottom = `${glyphs.bl}${glyphs.h.repeat(leftWidth)}${rightLines ? glyphs.bm : glyphs.br}${rightLines ? glyphs.h.repeat(rightWidth) + glyphs.br : ""}`;
  return [top, ...body, bottom];
}

function headerLines(stats, bounds, frameWidth, options, enabled) {
  const left = colorize("TOKEN LEDGER", TITLE_STYLE, enabled);
  const date = colorize(dateLabel(bounds, options.range), TEXT_STYLE, enabled);
  const mode = colorize(options.range === "week" ? "7 DAYS" : "DAY", [1, ...TEAL], enabled);
  const metric = (value, label) =>
    `${colorize(String(value), TITLE_STYLE, enabled)} ${colorize(label, DIM, enabled)}`;
  const separator = colorize("·", DIM, enabled);
  const join = ` ${separator} `;
  const alignHeader = (line) => fit(` ${line}`, frameWidth);
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
    return [alignHeader(fullLine)];
  }

  const compactDate = dateLabel(bounds, options.range)
    .replace(/ 20\d{2}$/, "")
    .replace(" – ", "–");
  const compactMode = options.range === "week" ? "7D" : "DAY";
  const compactLine = [
    left,
    colorize(compactDate, TEXT_STYLE, enabled),
    colorize(compactMode, [1, ...TEAL], enabled),
    metric(`${compact(stats.totalTokens)}`, "T"),
    metric(stats.calls.toLocaleString("en-US"), "C"),
    metric(stats.threads.toLocaleString("en-US"), "TH"),
    metric(stats.projectCount.toLocaleString("en-US"), "P"),
  ].join(join);
  if (visibleLength(compactLine) < frameWidth) {
    return [alignHeader(compactLine)];
  }

  const minimalTitle = colorize(frameWidth >= 45 ? "LEDGER" : "L", TITLE_STYLE, enabled);
  const minimalLine = [
    minimalTitle,
    colorize(compactDate.replaceAll(" ", ""), TEXT_STYLE, enabled),
    colorize(compactMode, [1, ...TEAL], enabled),
    compact(stats.totalTokens),
    compact(stats.calls),
    compact(stats.threads),
    compact(stats.projectCount),
  ].join(" ");
  return [alignHeader(minimalLine)];
}

export function renderTerminal({ options, snapshot, bounds, events, rows, allRows }) {
  const enabled = colorsEnabled(options);
  const stats = summary(events);
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
    ...headerLines(stats, bounds, frameWidth, options, enabled),
    ...panel(left, right, leftWidth, sideWidth, enabled, options.ascii),
  ];
  if (!sideBySide) {
    lines.push("");
    lines.push(...sidebarLines(stats, frameWidth, enabled, options, quota));
  }
  if (!options.static && !options.hideHelp) {
    lines.push("");
    lines.push(
      colorize(
        options.ascii
          ? "[j/k] select   [q/esc] quit"
          : "[↑↓ or j/k] select   [q/esc] quit",
        DIM,
        enabled,
      ),
    );
  }
  return lines.join("\n");
}

export const SCREEN_BASE = "\u001b[38;5;255m\u001b[48;2;16;16;18m";
const PANEL_BASE = "\u001b[38;5;255m\u001b[48;2;5;5;6m";

function paintFullscreenLine(line, width, background, enabled) {
  const fitted = fit(line, width);
  if (!enabled) return fitted;
  const restored = fitted.replaceAll(RESET, `${RESET}${background}`);
  return `${background}${restored}${RESET}`;
}

export function renderFullscreen({ options, snapshot, bounds, events, rows, allRows, width, height }) {
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
      hideHelp: true,
      width: frameWidth + 2,
    },
    snapshot,
    bounds,
    events,
    rows,
    allRows,
  });
  const staticLines = staticOutput.split("\n");
  if (staticLines.at(-1) === "") staticLines.pop();
  const summaryLine = staticLines.shift() ?? "";
  const help = colorize("↑/↓ move   •   j/k move   •   q/esc quit", DIM, enabled);
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
