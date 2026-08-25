#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  collectUsage,
  collectUsageSequential,
} from "../lib/token-ledger-importer.mjs";

function positiveInteger(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} requires a positive integer.`);
  }
  return value;
}

const argv = process.argv.slice(2);
const fileCount = positiveInteger(argv, "--files", 24);
const lineCount = positiveInteger(argv, "--lines", 5_000);
const payloadBytes = positiveInteger(argv, "--payload-bytes", 650);
const sequential = argv.includes("--sequential");
const root = await mkdtemp(resolve(tmpdir(), "token-ledger-benchmark-"));

try {
  const directory = resolve(root, "sessions", "2026", "08", "23");
  await mkdir(directory, { recursive: true });
  const newline = String.fromCharCode(10);
  const record = JSON.stringify({
    type: "response_item",
    payload: { type: "message", body: "x".repeat(payloadBytes) },
  });
  const content = `${Array(lineCount).fill(record).join(newline)}${newline}`;
  for (let index = 0; index < fileCount; index += 1) {
    const suffix = String(index + 1).padStart(12, "0");
    await writeFile(
      resolve(directory, `rollout-00000000-0000-4000-8000-${suffix}.jsonl`),
      content,
    );
  }

  const before = process.resourceUsage().maxRSS;
  const started = performance.now();
  const snapshot = await (sequential ? collectUsageSequential : collectUsage)({
    output: resolve(root, "snapshot.json"),
    codexHome: root,
    includeArchived: false,
    since: null,
  });
  const elapsedMs = performance.now() - started;
  const after = process.resourceUsage().maxRSS;
  const bytes = Buffer.byteLength(content) * fileCount;
  console.log(
    JSON.stringify(
      {
        mode: sequential ? "sequential" : "bounded-parallel",
        workers: sequential ? 1 : 4,
        files: fileCount,
        linesPerFile: lineCount,
        totalLines: fileCount * lineCount,
        bytes,
        wallTimeMs: Number(elapsedMs.toFixed(1)),
        peakRssKb: Math.max(before, after),
        peakRssDeltaKb: Math.max(0, after - before),
        parsedOutputEvents: snapshot.coverage.observedModelCalls,
        parseErrors: snapshot.coverage.parseErrors,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
