import { readFile, writeFile } from "node:fs/promises";

import {
  aggregateProjects,
  filterDayEvents,
  weekBounds,
} from "../bin/token-ledger.mjs";
import { renderTerminal } from "../bin/token-ledger-terminal.mjs";

const fixtureUrl = new URL("../tests/fixtures/demo-snapshot.json", import.meta.url);
const outputUrl = new URL("../docs/token-ledger-demo.svg", import.meta.url);
const snapshot = JSON.parse(await readFile(fixtureUrl, "utf8"));
const bounds = weekBounds("2026-08-05", "UTC");
const events = filterDayEvents(snapshot, bounds);
const allRows = aggregateProjects(snapshot, events, { rawProjects: true });
const terminal = renderTerminal({
  options: {
    range: "week",
    plain: true,
    forceColor: true,
    ascii: false,
    static: false,
    selectedIndex: 0,
    highlight: false,
    hideHelp: true,
    compactSidebar: true,
    width: 132,
    rawProjects: true,
  },
  snapshot,
  bounds,
  events,
  rows: allRows,
  allRows,
});

const stripAnsi = (value) => String(value)
  .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

const visibleTerminal = stripAnsi(terminal);
const projectSubtitles = visibleTerminal.match(
  /\d+ threads? · \d+(?:\.\d+)?% of tokens/g,
) ?? [];
if (allRows.length < 10 || projectSubtitles.length < 10) {
  throw new Error("Synthetic demo must show at least 10 projects with usage subtitles");
}
if (!visibleTerminal.includes("Auto Review")) {
  throw new Error("Synthetic demo must show Auto Review usage");
}
if (!visibleTerminal.includes("Daybreak Blue")) {
  throw new Error("Synthetic demo must show Daybreak Blue usage");
}
if (!visibleTerminal.includes("other-model")) {
  throw new Error("Synthetic demo must show an unrecognized model by name");
}
const forbidden = [
  /\/(?:Users|home)\//i,
  /[A-Z]:\\/i,
  /@[a-z0-9.-]+/i,
  /github\.com/i,
  /token-ledger-snapshot/i,
];
for (const pattern of forbidden) {
  if (pattern.test(visibleTerminal)) {
    throw new Error(`Synthetic demo failed privacy check: ${pattern}`);
  }
}

const escapeXml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;")
  .replaceAll(" ", "&#160;");

const STANDARD_COLORS = [
  "#000000", "#800000", "#008000", "#808000",
  "#000080", "#800080", "#008080", "#c0c0c0",
  "#808080", "#ff0000", "#00ff00", "#ffff00",
  "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
];
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];
const hex = (value) => value.toString(16).padStart(2, "0");

function xtermColor(index) {
  const value = Math.max(0, Math.min(255, Number(index) || 0));
  if (value < 16) return STANDARD_COLORS[value];
  if (value < 232) {
    const offset = value - 16;
    const red = CUBE_LEVELS[Math.floor(offset / 36)];
    const green = CUBE_LEVELS[Math.floor((offset % 36) / 6)];
    const blue = CUBE_LEVELS[offset % 6];
    return `#${hex(red)}${hex(green)}${hex(blue)}`;
  }
  const level = 8 + (value - 232) * 10;
  return `#${hex(level)}${hex(level)}${hex(level)}`;
}

function parseAnsiLine(line) {
  const cells = [];
  const style = { fill: "#d7d7dc", bold: false };
  let column = 0;
  let cursor = 0;
  const sgr = /\u001b\[([0-9;]*)m/g;
  let match;

  const append = (value) => {
    for (const character of value) {
      cells.push({ character, column, ...style });
      column += 1;
    }
  };

  while ((match = sgr.exec(line)) !== null) {
    append(line.slice(cursor, match.index));
    const codes = (match[1] || "0").split(";").map(Number);
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index];
      if (code === 0) {
        style.fill = "#d7d7dc";
        style.bold = false;
      } else if (code === 1) {
        style.bold = true;
      } else if (code === 22) {
        style.bold = false;
      } else if (code === 39) {
        style.fill = "#d7d7dc";
      } else if (code >= 30 && code <= 37) {
        style.fill = STANDARD_COLORS[code - 30];
      } else if (code >= 90 && code <= 97) {
        style.fill = STANDARD_COLORS[code - 90 + 8];
      } else if (code === 38 && codes[index + 1] === 5) {
        style.fill = xtermColor(codes[index + 2]);
        index += 2;
      } else if (code === 38 && codes[index + 1] === 2) {
        style.fill = `#${hex(codes[index + 2])}${hex(codes[index + 3])}${hex(codes[index + 4])}`;
        index += 4;
      } else if (code === 48 && (codes[index + 1] === 5 || codes[index + 1] === 2)) {
        index += codes[index + 1] === 5 ? 2 : 4;
      }
    }
    cursor = sgr.lastIndex;
  }
  append(line.slice(cursor));
  return cells;
}

const lines = terminal.split("\n").map(parseAnsiLine);
const lineHeight = 19;
const cellWidth = 7.8;
const width = Math.ceil(56 + Math.max(...lines.map((line) => line.length)) * cellWidth);
const height = 78 + lines.length * lineHeight + 26;
const textRows = lines.map((line, index) => {
  const y = 70 + index * lineHeight;
  const glyphs = line.map(({ character, column, fill, bold }) => {
    if (character === " ") return "";
    const x = (28 + column * cellWidth).toFixed(2);
    const weight = bold ? ' font-weight="700"' : "";
    return `    <text x="${x}" y="${y}" fill="${fill}"${weight}>${escapeXml(character)}</text>`;
  }).filter(Boolean).join("\n");
  return `  <g class="terminal-line">\n${glyphs}\n  </g>`;
}).join("\n");

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc" xml:space="preserve">
  <title id="title">Token Ledger synthetic terminal demo</title>
  <desc id="desc">A Token Ledger weekly terminal view generated entirely from synthetic usage data.</desc>
  <style>
    .terminal-line { font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; white-space: pre; }
    .chrome-label { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 12px; letter-spacing: 0.12em; }
  </style>
  <rect width="${width}" height="${height}" rx="16" fill="#101012"/>
  <rect width="${width}" height="42" rx="16" fill="#1b1b1f"/>
  <rect y="28" width="${width}" height="14" fill="#1b1b1f"/>
  <circle cx="22" cy="21" r="6" fill="#ff5f57"/>
  <circle cx="42" cy="21" r="6" fill="#febc2e"/>
  <circle cx="62" cy="21" r="6" fill="#28c840"/>
  <text x="${width / 2}" y="25" text-anchor="middle" fill="#8f8f98" class="chrome-label">TOKEN LEDGER</text>
${textRows}
</svg>
`;

for (const modelColor of ["#5fd7d7", "#5f87af", "#d7af5f", "#d787d7", "#5f87ff", "#afd7ff", "#5f5f87"]) {
  if (!svg.includes(`fill="${modelColor}"`)) {
    throw new Error(`Synthetic demo is missing model color ${modelColor}`);
  }
}
if (!svg.includes(">TOKEN LEDGER</text>") || svg.includes("SYNTHETIC DEMO")) {
  throw new Error("Synthetic demo window title must be TOKEN LEDGER");
}
if (/\u001b/.test(svg)) {
  throw new Error("Synthetic demo SVG contains an unparsed ANSI escape");
}

if (process.argv.includes("--check")) {
  const committed = await readFile(outputUrl, "utf8");
  if (committed !== svg) {
    throw new Error("Synthetic demo is out of date. Run npm run demo.");
  }
  process.stdout.write("Synthetic demo is current.\n");
} else {
  await writeFile(outputUrl, svg, "utf8");
  process.stdout.write(`Generated ${outputUrl.pathname}\n`);
}
