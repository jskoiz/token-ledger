import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildUsageTrend, multiDayBounds } from "../bin/token-ledger-trend.mjs";
import { buildActualTokenBins } from "../bin/token-ledger-trend-terminal.mjs";

const input = process.argv[2] || "/Users/jk/.token-ledger/token-ledger-snapshot.json";
const output = process.argv[3] || resolve("artifacts", "token-ledger-trend-youplot-7d.svg");
const rawOutput = output.replace(/\.svg$/i, ".txt");
const width = Number(process.argv[4]) || 82;

const snapshot = JSON.parse(await readFile(input, "utf8"));

function localDateString(timestampMs) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Pacific/Honolulu",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

const latestTimestamp = (snapshot.events ?? [])
  .map((event) => new Date(event.timestamp).getTime())
  .filter(Number.isFinite)
  .reduce((latest, timestampMs) => Math.max(latest, timestampMs), 0);
const endDate = process.argv[5] || localDateString(latestTimestamp);
const bounds = multiDayBounds(endDate, "Pacific/Honolulu", 7);
const trend = buildUsageTrend(snapshot, bounds);
const { bins } = buildActualTokenBins(snapshot, bounds, 7, width);

function runYouPlot(command, inputText, args) {
  const result = spawnSync("youplot", [
    command,
    "-H",
    "-o",
    "-",
    "-w",
    String(width),
    "-C",
    ...args,
  ], {
    input: `${inputText.trimEnd()}\n`,
    encoding: "utf8",
    maxBuffer: 2_000_000,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("YouPlot is not installed or is not on PATH.");
  }
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `YouPlot ${command} failed.`);
  }
  return result.stdout.trimEnd();
}

function billions(value) {
  return (Math.max(0, Number(value) || 0) / 1_000_000_000).toFixed(3);
}

const modelBarTsv = [
  "day_model\ttokens_billion",
  ...bins.flatMap((bin) => {
    const luna = bin.values.get("Luna") ?? 0;
    const sol = bin.values.get("Sol") ?? 0;
    const other = Math.max(0, bin.totalTokens - luna - sol);
    return [
      `${bin.startDateString.slice(5)} Luna\t${billions(luna)}`,
      `${bin.startDateString.slice(5)} Sol\t${billions(sol)}`,
      `${bin.startDateString.slice(5)} Other\t${billions(other)}`,
    ];
  }),
].join("\n");

function xPosition(timestampMs) {
  const span = bounds.end.getTime() - bounds.start.getTime();
  return 1 + ((timestampMs - bounds.start.getTime()) / span) * 6;
}

const quotaRows = [["x", "remaining"]];
for (const point of trend.points.filter((point) => point.timestampMs >= bounds.start.getTime())) {
  const x = xPosition(point.timestampMs);
  const reset = trend.resets.find(
    (marker) => Math.abs(marker.observedAtMs - point.timestampMs) < 60_000,
  );
  if (reset) quotaRows.push([x, 100]);
  quotaRows.push([x, point.remainingPercent]);
}
const quotaTsv = quotaRows
  .map((row) => row.join("\t"))
  .join("\n");

const modelBars = runYouPlot("bar", modelBarTsv, [
  "-t",
  "Actual token quantity by model (billions) · YouPlot bars",
  "--symbol",
  "█",
  "-c",
  "blue",
]);
const quotaLine = runYouPlot("line", quotaTsv, [
  "-t",
  "Observed weekly quota remaining (%) · YouPlot line",
  "--canvas",
  "braille",
  "--xlim",
  "1,7",
  "--ylim",
  "0,100",
  "-c",
  "yellow",
]);

const dateKey = bins
  .map((bin, index) => `${index + 1}=${bin.startDateString}`)
  .join("  ");
const rendered = [
  "Token Ledger · YouPlot 0.5.0 trial · 7 calendar days",
  `Snapshot: ${input}`,
  `Range: ${bounds.startDateString} through ${bounds.endDateString} (${bounds.timeZone})`,
  `Model quantities use token units; quota is observed remaining percentage. They are separate plots, not one shared axis.`,
  "",
  modelBars,
  "Model labels are grouped by day; YouPlot cannot stack these bars into calendar columns.",
  "",
  quotaLine,
  `Date key: ${dateKey}`,
  "",
  "YouPlot trial limitation: bar is horizontal; model bars are not stacked; quota is not overlaid or dual-axis.",
].join("\n");

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const ansiColors = {
  30: "#000000",
  31: "#e06c75",
  32: "#98c379",
  33: "#e5c07b",
  34: "#61afef",
  35: "#c678dd",
  36: "#56b6c2",
  37: "#dcdfe4",
  90: "#7f848e",
  91: "#e06c75",
  92: "#98c379",
  93: "#e5c07b",
  94: "#61afef",
  95: "#c678dd",
  96: "#56b6c2",
  97: "#ffffff",
};

function colorFromSgr(sequence, current) {
  const codes = sequence.slice(2, -1).split(";").map(Number);
  const rgbIndex = codes.indexOf(38);
  if (rgbIndex >= 0 && codes[rgbIndex + 1] === 2) {
    const [red, green, blue] = codes.slice(rgbIndex + 2, rgbIndex + 5);
    return `rgb(${red},${green},${blue})`;
  }
  return ansiColors[codes.find((code) => ansiColors[code])] ?? current;
}

function svgLine(line, y) {
  const parts = line.split(/(\u001b\[[0-9;]*m)/g).filter(Boolean);
  let color = "#f0f0f0";
  let x = 24;
  const spans = [];
  for (const part of parts) {
    if (part.startsWith("\u001b[")) {
      color = part === "\u001b[0m" ? "#f0f0f0" : colorFromSgr(part, color);
      continue;
    }
    spans.push(`<tspan x="${x}" fill="${color}">${escapeXml(part)}</tspan>`);
    x += [...part].length * 9.6;
  }
  return `<text y="${y}" font-family="Menlo, SFMono-Regular, Consolas, monospace" font-size="15" xml:space="preserve">${spans.join("")}</text>`;
}

const lines = rendered.split("\n");
const svgWidth = width * 11.5 + 48;
const svgHeight = lines.length * 20 + 44;
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">`,
  `<rect width="100%" height="100%" fill="#1e1e1e"/>`,
  ...lines.map((line, index) => svgLine(line, 28 + index * 20)),
  "</svg>",
].join("\n");

await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(rawOutput, `${rendered}\n`, "utf8");
await writeFile(output, svg, "utf8");
console.log(output);
