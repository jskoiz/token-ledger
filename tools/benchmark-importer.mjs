#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { resolve } from "node:path";

function positiveInteger(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} requires a positive integer.`);
  }
  return value;
}

function optionalPositiveInteger(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} requires a positive integer.`);
  }
  return value;
}

function tokenCount(timestamp, cumulativeTokens) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: cumulativeTokens - 20,
          cached_input_tokens: 10,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: cumulativeTokens,
        },
        last_token_usage: {
          input_tokens: 80,
          cached_input_tokens: 10,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 100,
        },
        model_context_window: 128_000,
      },
    },
  };
}

function tokenEventRows({ fileIndex, eventIndex, timestamp }) {
  const turnId = `benchmark-${fileIndex}-${eventIndex}`;
  const models = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];
  return [
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turnId,
        started_at: Date.parse(timestamp) / 1_000,
      },
    },
    {
      timestamp,
      type: "turn_context",
      payload: {
        turn_id: turnId,
        model: models[eventIndex % models.length],
        effort: eventIndex % 2 === 0 ? "medium" : "high",
      },
    },
    tokenCount(
      new Date(Date.parse(timestamp) + 1_000).toISOString(),
      (eventIndex + 1) * 100,
    ),
  ];
}

const argv = process.argv.slice(2);
const fileCount = positiveInteger(argv, "--files", 24);
const lineCount = positiveInteger(argv, "--lines", 5_000);
const payloadBytes = positiveInteger(argv, "--payload-bytes", 650);
const tokenEvents = optionalPositiveInteger(argv, "--token-events");
const warmRuns = positiveInteger(argv, "--warm-runs", tokenEvents ? 2 : 1);
const eventAgeDays = positiveInteger(argv, "--event-age-days", 4_000);
const sequential = argv.includes("--sequential");
const root = await mkdtemp(resolve(tmpdir(), "token-ledger-benchmark-"));
const benchmarkStateRoot = resolve(root, ".token-ledger-test-state");

// The benchmark is an isolated workload. Set the existing test-state marker
// before loading the ledger modules so their module-level namespace is unique
// to this process and no benchmark refresh can write the user's live ledger.
process.env.NODE_TEST_CONTEXT = "benchmark";
process.env.TOKEN_LEDGER_TEST_STATE_NAMESPACE = String(process.pid);
process.env.TOKEN_LEDGER_TEST_STATE_ROOT = benchmarkStateRoot;

try {
  const { collectUsage, collectUsageSequential } = await import(
    "../lib/token-ledger-importer.mjs"
  );
  const {
    DURABLE_LEDGER_FILENAME,
    DURABLE_LEDGER_RETENTION_DAYS,
    readDurableLedger,
    resolveDurableLedgerPath,
  } = await import("../lib/token-ledger-ledger.mjs");
  const directory = resolve(root, "sessions", "2026", "08", "23");
  await mkdir(directory, { recursive: true });
  const newline = String.fromCharCode(10);
  const record = JSON.stringify({
    type: "response_item",
    payload: { type: "message", body: "x".repeat(payloadBytes) },
  });
  const fallbackContent = `${Array(lineCount).fill(record).join(newline)}${newline}`;
  const contents = [];
  const tokenEventsPerFile = tokenEvents ? Math.ceil(tokenEvents / fileCount) : 0;
  const baseTimestampMs = Date.now() - eventAgeDays * 24 * 60 * 60 * 1_000;
  for (let index = 0; index < fileCount; index += 1) {
    const suffix = String(index + 1).padStart(12, "0");
    const threadId = `00000000-0000-4000-8000-${suffix}`;
    let content = fallbackContent;
    if (tokenEvents) {
      const firstEvent = index * tokenEventsPerFile;
      const lastEvent = Math.min(tokenEvents, firstEvent + tokenEventsPerFile);
      const rows = [{
        timestamp: new Date(baseTimestampMs).toISOString(),
        type: "session_meta",
        payload: {
          id: threadId,
          cwd: `/benchmark/project-${index + 1}`,
          git: { repository_url: `https://example.invalid/benchmark/project-${index + 1}.git` },
          source: "exec",
        },
      }];
      for (let eventIndex = firstEvent; eventIndex < lastEvent; eventIndex += 1) {
        rows.push(...tokenEventRows({
          fileIndex: index,
          eventIndex,
          timestamp: new Date(
            baseTimestampMs + eventIndex * 15 * 60 * 1_000,
          ).toISOString(),
        }));
      }
      content = `${rows.map((row) => JSON.stringify(row)).join(newline)}${newline}`;
    }
    contents.push(content);
    await writeFile(
      resolve(directory, `rollout-${threadId}.jsonl`),
      content,
    );
  }

  const before = process.resourceUsage().maxRSS;
  const runWallTimeMs = [];
  const runCoverage = [];
  const output = resolve(root, "snapshot.json");
  const durableLedgerPath = resolveDurableLedgerPath({ codexHome: root, output });
  const normalLedgerPath = resolve(
    userInfo().homedir,
    ".token-ledger",
    DURABLE_LEDGER_FILENAME,
  );
  if (durableLedgerPath === normalLedgerPath) {
    throw new Error(
      "Benchmark durable state is not isolated from the live Token Ledger ledger.",
    );
  }
  let snapshot;
  for (let run = 0; run < warmRuns; run += 1) {
    const started = performance.now();
    snapshot = await (sequential ? collectUsageSequential : collectUsage)({
      output,
      codexHome: root,
      includeArchived: false,
      since: null,
    });
    runWallTimeMs.push(Number((performance.now() - started).toFixed(1)));
    runCoverage.push({
      filesScanned: snapshot.coverage.filesScanned,
      filesReused: snapshot.coverage.filesReused,
      bytesScanned: snapshot.coverage.bytesScanned,
      bytesReused: snapshot.coverage.bytesReused,
    });
  }
  const ledger = await readDurableLedger(
    durableLedgerPath,
  );
  const durableTotalTokens = ledger.usageRows.reduce(
    (sum, row) => sum + Number(row.totalTokens || 0),
    0,
  );
  if (tokenEvents && durableTotalTokens !== tokenEvents * 100) {
    throw new Error(
      `Durable benchmark total mismatch: ${durableTotalTokens} vs ${tokenEvents * 100}.`,
    );
  }
  if (
    tokenEvents &&
    eventAgeDays > DURABLE_LEDGER_RETENTION_DAYS &&
    ledger.compactedUsageRows === 0
  ) {
    throw new Error("Durable benchmark did not compact its old token events.");
  }
  if (ledger.revision !== warmRuns) {
    throw new Error(
      `Durable benchmark revision mismatch: ${ledger.revision} vs ${warmRuns}.`,
    );
  }
  const after = process.resourceUsage().maxRSS;
  const warmSamples = runWallTimeMs.slice(1).sort((left, right) => left - right);
  const warmMedianWallTimeMs = warmSamples.length === 0
    ? null
    : warmSamples.length % 2 === 1
      ? warmSamples[Math.floor(warmSamples.length / 2)]
      : Number((
          (warmSamples[warmSamples.length / 2 - 1] +
            warmSamples[warmSamples.length / 2]) / 2
        ).toFixed(1));
  const bytes = contents.reduce(
    (sum, content) => sum + Buffer.byteLength(content),
    0,
  );
  console.log(
    JSON.stringify(
      {
        mode: sequential ? "sequential" : "bounded-parallel",
        workers: sequential ? 1 : 4,
        files: fileCount,
        linesPerFile: tokenEvents ? null : lineCount,
        totalLines: tokenEvents ? null : fileCount * lineCount,
        tokenEvents: tokenEvents ?? 0,
        warmRuns,
        eventAgeDays: tokenEvents ? eventAgeDays : null,
        bytes,
        runWallTimeMs,
        runCoverage,
        coldWallTimeMs: runWallTimeMs[0],
        warmMedianWallTimeMs,
        peakRssKb: Math.max(before, after),
        peakRssDeltaKb: Math.max(0, after - before),
        parsedOutputEvents: snapshot.coverage.observedModelCalls,
        durableRevision: ledger.revision,
        durableCompactedBuckets: ledger.compactedUsageRows,
        durableTotalTokens,
        parseErrors: snapshot.coverage.parseErrors,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(benchmarkStateRoot, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
