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
    ascii: false,
    static: true,
    width: 108,
    rawProjects: true,
  },
  snapshot,
  bounds,
  events,
  rows: allRows,
  allRows,
});

const forbidden = [
  /\/(?:Users|home)\//i,
  /[A-Z]:\\/i,
  /@[a-z0-9.-]+/i,
  /github\.com/i,
  /token-ledger-snapshot/i,
  /\u001b/,
];
for (const pattern of forbidden) {
  if (pattern.test(terminal)) {
    throw new Error(`Synthetic demo failed privacy check: ${pattern}`);
  }
}

const escapeXml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll(" ", "&#160;");
const lines = terminal.split("\n");
const lineHeight = 19;
const cellWidth = 7.8;
const width = Math.ceil(56 + Math.max(...lines.map((line) => [...line].length)) * cellWidth);
const height = 78 + lines.length * lineHeight + 26;
const textRows = lines.map((line, index) => {
  const y = 70 + index * lineHeight;
  const fill = index === 0
    ? "#f7f7f8"
    : /TOKENS BY PROJECT|MODEL MIX|USAGE TYPE|CACHE · INPUT|RESET CYCLE/.test(line)
      ? "#57d99a"
      : "#d7d7dc";
  const glyphs = [...line].map((character, column) => {
    if (character === " ") return "";
    const x = (28 + column * cellWidth).toFixed(2);
    return `    <text x="${x}" y="${y}">${escapeXml(character)}</text>`;
  }).filter(Boolean).join("\n");
  return `  <g fill="${fill}" class="terminal-line">\n${glyphs}\n  </g>`;
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
  <text x="${width / 2}" y="25" text-anchor="middle" fill="#8f8f98" class="chrome-label">SYNTHETIC DEMO</text>
${textRows}
</svg>
`;

await writeFile(outputUrl, svg, "utf8");
process.stdout.write(`Generated ${outputUrl.pathname}\n`);
