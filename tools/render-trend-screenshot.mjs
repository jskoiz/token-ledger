import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildUsageTrend,
  multiDayBounds,
} from "../bin/token-ledger-trend.mjs";
import { renderTrendCombo } from "../bin/token-ledger-trend-terminal.mjs";

const input = process.argv[2] || "/Users/jk/.token-ledger/token-ledger-snapshot.json";
const output = process.argv[3] || resolve("artifacts", "token-ledger-trend-7d.svg");
const width = Number(process.argv[4]) || 100;
const snapshot = JSON.parse(await readFile(input, "utf8"));
const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", 7);
const rendered = renderTrendCombo({
  snapshot,
  bounds,
  trend: buildUsageTrend(snapshot, bounds),
  days: 7,
  options: { width, forceColor: true },
});

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function colorFromSgr(sequence) {
  const codes = sequence.slice(2, -1).split(";").map(Number);
  const colorIndex = codes.indexOf(38);
  if (colorIndex >= 0 && codes[colorIndex + 1] === 2) {
    const [red, green, blue] = codes.slice(colorIndex + 2, colorIndex + 5);
    return `rgb(${red},${green},${blue})`;
  }
  return "#ffffff";
}

function lineSvg(line, y) {
  const parts = line.split(/(\u001b\[[0-9;]*m)/g).filter(Boolean);
  let color = "#ffffff";
  let x = 24;
  const spans = [];
  for (const part of parts) {
    if (part.startsWith("\u001b[")) {
      color = part === "\u001b[0m" ? "#ffffff" : colorFromSgr(part);
      continue;
    }
    if (!part) continue;
    spans.push(`<tspan x="${x}" fill="${color}">${escapeXml(part)}</tspan>`);
    x += [...part].length * 9.6;
  }
  return `<text y="${y}" font-family="Menlo, SFMono-Regular, Consolas, monospace" font-size="15" xml:space="preserve">${spans.join("")}</text>`;
}

const lines = rendered.split("\n");
// Leave a little horizontal breathing room for Quick Look's proportional
// thumbnail rasterizer; the terminal itself remains fixed-width.
const svgWidth = width * 11.5 + 48;
const height = lines.length * 20 + 44;
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${height}" viewBox="0 0 ${svgWidth} ${height}">`,
  `<rect width="100%" height="100%" fill="#1e1e1e"/>`,
  ...lines.map((line, index) => lineSvg(line, 28 + index * 20)),
  "</svg>",
].join("\n");

await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, svg, "utf8");
console.log(output);
