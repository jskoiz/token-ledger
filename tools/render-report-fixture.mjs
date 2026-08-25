// Regenerates docs/token-ledger-report-7-day.png from anonymized, internally
// consistent fixture data. Nothing here is read from the local machine, so
// the documentation screenshot never contains real project names or titles.
//
//   node tools/render-report-fixture.mjs [output.png] [width]

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { multiDayBounds, buildUsageTrend } from "../bin/token-ledger-trend.mjs";
import {
  renderTrendImage,
  writeTrendPng,
} from "../bin/token-ledger-trend-image.mjs";

const output = resolve(process.argv[2] ?? "docs/token-ledger-report-7-day.png");
const width = Number(process.argv[3]) || 1_280;

const TZ = "Pacific/Honolulu";
const bounds = multiDayBounds("2026-08-23", TZ, 7);
const iso = (day, hour, minute = 0) =>
  new Date(Date.UTC(2026, 7, day, hour + 10, minute)).toISOString();

const projects = [
  "workspace-alpha",
  "agent-rooms",
  "automations",
  ...Array.from({ length: 23 }, (_, index) =>
    `project-${String(index + 1).padStart(2, "0")}`,
  ),
];

const events = [];
let sequence = 0;
function addEvent(day, hour, model, totalTokens, { fast = false, cacheRate = 0.94 } = {}) {
  const inputTokens = Math.round(totalTokens * 0.985);
  sequence += 1;
  events.push({
    id: `evt-${sequence}`,
    timestamp: iso(day, hour, (sequence * 7) % 60),
    model,
    project: projects[sequence % projects.length],
    totalTokens,
    inputTokens,
    cachedInputTokens: Math.round(inputTokens * cacheRate),
    outputTokens: totalTokens - inputTokens,
    reasoningTokens: 0,
    serviceTier: fast ? "priority" : null,
    breakdownAvailable: true,
  });
}

// Daily volumes in millions of tokens, with a partial final day.
const days = [
  { day: 17, luna: 300, sol: 38, fastShare: 0 },
  { day: 18, luna: 130, sol: 21, fastShare: 0 },
  { day: 19, luna: 1_030, sol: 305, fastShare: 0.35 },
  { day: 20, luna: 517, sol: 34, fastShare: 0.2 },
  { day: 21, luna: 1_400, sol: 395, fastShare: 0.45 },
  { day: 22, luna: 810, sol: 384, fastShare: 0.5 },
  { day: 23, luna: 1_530, sol: 859, fastShare: 0.6 },
];
for (const { day, luna, sol, fastShare } of days) {
  for (let piece = 0; piece < 8; piece += 1) {
    const hour = Math.floor(1 + piece * (day === 23 ? 1.3 : 2.6));
    if (day === 23 && hour > 12) continue;
    addEvent(day, hour, "gpt-5.6-luna", Math.round((luna * 1_000_000) / 8), {
      fast: piece / 8 < fastShare,
      cacheRate: 0.93 + (piece % 3) * 0.02,
    });
    addEvent(day, hour, "gpt-5.6-sol", Math.round((sol * 1_000_000) / 8), {
      fast: piece / 8 < fastShare * 0.6,
      cacheRate: 0.97,
    });
  }
  addEvent(day, 9, "auto-review", 14_700_000, { cacheRate: 0.7 });
}
// A quieter prior week gives the equivalent-period delta a real baseline.
for (const { day, luna, sol } of days) {
  addEvent(day - 7, 10, "gpt-5.6-luna", Math.round(luna * 0.86 * 1_000_000), {});
  addEvent(day - 7, 12, "gpt-5.6-sol", Math.round(sol * 0.88 * 1_000_000), {});
}

// Sampled weekly-limit observations: the old cycle expires Wednesday morning
// and the fresh cycle drains to 0% by the partial Sunday.
const resetAt = Math.floor(Date.UTC(2026, 7, 19, 18) / 1_000);
const nextResetAt = resetAt + 10_080 * 60;
const quotaObservations = [];
function observe(day, hour, usedPercent, resetsAt) {
  quotaObservations.push({
    timestamp: iso(day, hour),
    usedPercent,
    windowMinutes: 10_080,
    resetsAt,
  });
}
observe(17, 1, 88, resetAt);
observe(17, 8, 88, resetAt);
observe(17, 14, 89, resetAt);
observe(18, 3, 90, resetAt);
observe(18, 12, 90.5, resetAt);
observe(19, 5, 92, resetAt);
observe(19, 9, 5, nextResetAt);
observe(19, 20, 8, nextResetAt);
observe(20, 8, 13, nextResetAt);
observe(20, 18, 13, nextResetAt);
observe(21, 6, 22, nextResetAt);
observe(21, 15, 30, nextResetAt);
observe(22, 4, 42, nextResetAt);
observe(22, 13, 55, nextResetAt);
observe(22, 22, 71, nextResetAt);
observe(23, 5, 84, nextResetAt);
observe(23, 9, 96, nextResetAt);
observe(23, 11, 100, nextResetAt);
observe(23, 12, 100, nextResetAt);

const snapshot = {
  schemaVersion: 9,
  generatedAt: iso(23, 12, 9),
  label: "Fixture snapshot",
  provenance: { kind: "codex-local-metadata", rateCardAsOf: "2026-08-17" },
  coverage: { parseErrors: 0 },
  events,
  threads: [],
  quotaObservations,
};

const svg = renderTrendImage({
  snapshot,
  bounds,
  trend: buildUsageTrend(snapshot, bounds),
  days: 7,
  options: { imageWidth: width },
  reportTimeMs: Date.UTC(2026, 7, 23, 22, 9),
  sourceStatus: "verified-current",
});
await mkdir(dirname(output), { recursive: true });
await writeTrendPng(svg, output);
process.stdout.write(`Wrote ${output}\n`);
