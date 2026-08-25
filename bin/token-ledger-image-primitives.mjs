// Shared, dependency-neutral values and SVG helpers used by image reports.

export const TREND_IMAGE_MODEL_COLORS = {
  Luna: "#3b82f6",
  Sol: "#10a394",
  Terra: "#8b7cf6",
  "GPT-5.5": "#d55181",
  "GPT-5.4": "#0891b2",
  Daybreak: "#16a34a",
  "Auto review": "#e5484d",
  Other: "#64748b",
  Unknown: "#64748b",
  Unattributed: "#475569",
};

export const TREND_IMAGE_COLORS = {
  background: "#0e1420",
  panel: "#151d2c",
  panelBorder: "#273246",
  meterPanel: "#1b1712",
  meterPanelBorder: "rgba(246,183,60,.4)",
  ink: "#f2f5fa",
  secondary: "#aeb8c9",
  muted: "#77839a",
  grid: "#1c2534",
  baseline: "#33405a",
  rule: "rgba(255,255,255,.1)",
  track: "rgba(255,255,255,.09)",
  projectTrack: "rgba(255,255,255,.07)",
  line: "#f6b73c",
  meterAxis: "#cf9a37",
  chipFill: "#151d2c",
  leftAxis: "#7ea2f0",
  deltaUp: "#7fb37a",
  deltaUpFill: "rgba(127,179,122,.14)",
  deltaDown: "#e08a86",
  deltaDownFill: "rgba(217,83,79,.16)",
  remainderBar: "#475569",
  onFill: "rgba(255,255,255,.82)",
  cached: "#2ec4a1",
  uncached: "#d88362",
  weighted: "#c7d2e8",
  cacheTrack: "#202a3a",
};

export const CACHE_IMAGE_COLORS = {
  background: "#0e1420",
  ink: "#f2f5fa",
  secondary: "#aeb8c9",
  muted: "#77839a",
  grid: "#1c2534",
  baseline: "#33405a",
  track: "#202a3a",
  cached: "#2ec4a1",
  uncached: "#d88362",
  volume: "#64748b",
  weighted: "#c7d2e8",
  rule: "rgba(255,255,255,.1)",
};

export const IMAGE_FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', sans-serif";
export const IMAGE_MONO_FAMILY = "ui-monospace, Menlo, monospace";
export const FAST_MODE_LABEL_COLOR = "#a78bfa";

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function compact(value, digits = 2) {
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
    const precision = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : digits;
    // Values that round to 1000 of a unit belong to the next unit up
    // (999,999 → 1.00M, not 1000K).
    if (index > 0 && Number(magnitude.toFixed(precision)) >= 1_000) {
      return compact(Math.sign(value) * divisor * 1_000, digits);
    }
    return `${scaled.toFixed(precision)}${suffix}`;
  }
  return Math.round(value).toLocaleString("en-US");
}

// Darker step of the same hue, used for the fast-mode share of a segment.
export function fastShade(hexColor) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hexColor));
  if (!match) return hexColor;
  const channels = [0, 2, 4].map((offset) =>
    Math.round(parseInt(match[1].slice(offset, offset + 2), 16) * 0.62),
  );
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function shiftCalendarDate(dateString, amount) {
  const [year, month, day] = String(dateString).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((value, index) =>
      index === 0 ? String(value) : String(value).padStart(2, "0"),
    )
    .join("-");
}

// Rough sans-serif advance widths in em units, for placing inline runs
// (value + chip, legend items, pace rows). SVG has no flow layout.
export function textWidth(text, size, weight = 400) {
  let units = 0;
  for (const character of String(text)) {
    if (/[il.,:;'|!]/.test(character)) units += 0.3;
    else if (/[Ijtfr\-()[\] ]/.test(character)) units += 0.37;
    else if (/[mwMW@%]/.test(character)) units += 0.92;
    else if (/[A-Z]/.test(character)) units += 0.7;
    else if (/[0-9+±×−]/.test(character)) units += 0.58;
    else units += 0.55;
  }
  return units * size * (weight >= 700 ? 1.05 : 1);
}

export function truncateText(text, maxWidth, size, weight = 400) {
  let value = String(text ?? "").replace(/\.{3,}/g, "…");
  if (!(maxWidth > 0) || textWidth(value, size, weight) <= maxWidth) return value;
  if (value.includes("…")) {
    const leading = `${value.split("…", 1)[0].trimEnd()}…`;
    if (textWidth(leading, size, weight) <= maxWidth) return leading;
    value = leading;
  }
  const ellipsis = "…";
  const ellipsisWidth = textWidth(ellipsis, size, weight);
  if (ellipsisWidth >= maxWidth) return ellipsis;

  const characters = [...value];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("")}${ellipsis}`;
    if (textWidth(candidate, size, weight) <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join("").trimEnd()}${ellipsis}`;
}

export function svgText({
  x,
  y,
  value,
  fill = TREND_IMAGE_COLORS.ink,
  size = 12,
  weight = 400,
  anchor = "start",
  spacing = null,
  opacity = null,
  mono = false,
}) {
  const spacingAttr = spacing ? ` letter-spacing="${spacing}"` : "";
  const opacityAttr = opacity !== null ? ` opacity="${opacity}"` : "";
  const family = mono ? IMAGE_MONO_FAMILY : IMAGE_FONT_FAMILY;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}px" font-weight="${weight}" text-anchor="${anchor}"${spacingAttr}${opacityAttr}>${escapeXml(value)}</text>`;
}

export function svgRect(x, y, width, height, attrs = {}) {
  const pieces = [
    `x="${Number(x).toFixed(2)}"`,
    `y="${Number(y).toFixed(2)}"`,
    `width="${Math.max(0, Number(width)).toFixed(2)}"`,
    `height="${Math.max(0, Number(height)).toFixed(2)}"`,
  ];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    pieces.push(`${key}="${value}"`);
  }
  return `<rect ${pieces.join(" ")}/>`;
}
