import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CLI_ENTRYPOINT = fileURLToPath(
  new URL("../bin/token-ledger.mjs", import.meta.url),
);
const IMAGE_MODULE_TRACE_LOADER = fileURLToPath(
  new URL("./trace-image-imports-loader.mjs", import.meta.url),
);
const PNG_SIGNATURE = [
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
];

function runCli(args, { env, loader = false } = {}) {
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(
    process.execPath,
    [
      ...(loader ? ["--loader", IMAGE_MODULE_TRACE_LOADER] : []),
      CLI_ENTRYPOINT,
      ...args,
    ],
    {
      encoding: "utf8",
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 2_000_000,
    },
  );
  return {
    ...result,
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
  };
}

function assertExit(result, expectedStatus = 0) {
  assert.ifError(result.error);
  assert.equal(
    result.status,
    expectedStatus,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function makeEvent({
  id,
  timestamp,
  project,
  threadId,
  totalTokens,
  model = "gpt-5.5",
  inputTokens = totalTokens,
  cachedInputTokens = 0,
  outputTokens = 0,
  reasoningTokens = 0,
  toolCalls = 0,
  useType = "sdk",
}) {
  return {
    id,
    timestamp,
    project,
    threadId,
    model,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    toolCalls,
    useType,
  };
}

async function writeSnapshot(root, events, generatedAt = "2026-08-20T12:00:00.000Z") {
  const snapshotPath = resolve(root, "snapshot.json");
  const threads = events
    .filter((event) => event?.threadId)
    .map((event) => ({ id: event.threadId, project: event.project }));
  await writeFile(
    snapshotPath,
    JSON.stringify({
      schemaVersion: 3,
      generatedAt,
      events,
      threads,
      quotaObservations: [],
    }),
  );
  return snapshotPath;
}

async function inTemp(prefix, callback) {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function staticSnapshotArgs(snapshotPath, command = ["day", "2026-08-20"]) {
  return [
    ...command,
    "--input",
    snapshotPath,
    "--no-refresh",
    "--static",
    "--plain",
    "--ascii",
    "--raw-projects",
    "--tz",
    "UTC",
    "--width",
    "120",
  ];
}

function assertPng(bytes) {
  assert.ok(bytes.length > 1_000, `PNG unexpectedly small: ${bytes.length} bytes`);
  assert.deepEqual([...bytes.subarray(0, PNG_SIGNATURE.length)], PNG_SIGNATURE);
}

function nonLineControlCodes(value) {
  return [...value]
    .map((character) => character.codePointAt(0))
    .filter(
      (code) =>
        ((code >= 0 && code <= 31) || (code >= 127 && code <= 159)) &&
        ![9, 10, 13].includes(code),
    );
}

test("quick help is concise and help-all exposes the full command reference", () => {
  for (const args of [[], ["--help"], ["help"]]) {
    const result = runCli(args);
    assertExit(result);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Token Ledger/);
    assert.match(result.stdout, /tledger 1d\s+Last 24 hours/);
    assert.match(result.stdout, /tledger report 7d\s+Write the 7-day PNG report/);
    assert.match(result.stdout, /--help-all\s+Show every command and option/);
    assert.doesNotMatch(result.stdout, /--codex-home|--youplot|--image-width/);
  }

  const complete = runCli(["--help-all"]);
  assertExit(complete);
  assert.equal(complete.stderr, "");
  assert.match(complete.stdout, /Token Ledger command reference/);
  assert.match(complete.stdout, /--codex-home <dir>/);
  assert.match(complete.stdout, /--since <ISO timestamp>/);
  assert.match(complete.stdout, /--youplot/);
  assert.match(complete.stdout, /--image-width <px>/);
});

test("invalid arguments are table-driven, short, and actionable", () => {
  const cases = [
    {
      args: ["day", "2026-08-20", "--width", "39"],
      error: /--width must be an integer from 40 to 200\./,
    },
    {
      args: ["cost", "1d"],
      error: /The cost command requires --basis codex-credits or --basis api-usd\./,
    },
    {
      args: ["report", "7d", "--cache-rate", "--drain"],
      error: /--cache-rate cannot be combined with --drain\./,
    },
    {
      args: ["week", "--not-a-real-option"],
      error: /Unknown option: --not-a-real-option/,
    },
  ];

  for (const { args, error } of cases) {
    const result = runCli(args);
    assertExit(result, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`Token Ledger: ${error.source}`));
    assert.match(result.stderr, /Run `tledger --help` for examples/);
    assert.match(result.stderr, /tledger --help-all/);
    assert.equal(result.stderr.trimEnd().split("\n").length, 2);
  }
});

test("non-image CLI paths keep the image renderer and Sharp graph lazy", async () => {
  await inTemp("token-ledger-cli-lazy-", async (root) => {
    const timestamp = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
    const snapshotPath = await writeSnapshot(root, [
      makeEvent({
        id: "lazy-event",
        timestamp,
        project: "Lazy project",
        threadId: "lazy-thread",
        totalTokens: 321,
        inputTokens: 300,
        outputTokens: 21,
      }),
    ], new Date().toISOString());
    const commands = [
      ["--help"],
      staticSnapshotArgs(snapshotPath, ["1d"]),
    ];

    for (const args of commands) {
      const result = runCli(args, { loader: true });
      assertExit(result);
      assert.doesNotMatch(result.stderr, /TOKEN_LEDGER_IMAGE_GRAPH/);
    }
  });
});

test("1d static output reports synthetic project rows and the exact total", async () => {
  await inTemp("token-ledger-cli-1d-", async (root) => {
    const now = Date.now();
    const snapshotPath = await writeSnapshot(root, [
      makeEvent({
        id: "one-day-alpha",
        timestamp: new Date(now - 2 * 60 * 60 * 1_000).toISOString(),
        project: "Alpha project",
        threadId: "alpha-thread",
        totalTokens: 1_200,
        inputTokens: 1_000,
        cachedInputTokens: 200,
        outputTokens: 200,
      }),
      makeEvent({
        id: "one-day-beta",
        timestamp: new Date(now - 3 * 60 * 60 * 1_000).toISOString(),
        project: "Beta project",
        threadId: "beta-thread",
        model: "gpt-5.6-luna",
        totalTokens: 800,
        inputTokens: 700,
        cachedInputTokens: 100,
        outputTokens: 100,
      }),
    ], new Date(now).toISOString());
    const result = runCli(staticSnapshotArgs(snapshotPath, ["1d"]));
    assertExit(result);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Alpha project/);
    assert.match(result.stdout, /Beta project/);
    assert.match(result.stdout, /2\.00K TOKENS/);
    assert.match(result.stdout, /1\.20K/);
    assert.match(result.stdout, /800/);
    assert.doesNotMatch(result.stdout, /Gamma|5\.80K/);
  });
});

test("week and trend views aggregate one small fixture across calendar days", async () => {
  await inTemp("token-ledger-cli-range-", async (root) => {
    const snapshotPath = await writeSnapshot(root, [
      makeEvent({
        id: "range-alpha-early",
        timestamp: "2026-08-14T12:00:00.000Z",
        project: "Alpha project",
        threadId: "alpha-early",
        totalTokens: 1_000,
        inputTokens: 800,
        outputTokens: 200,
      }),
      makeEvent({
        id: "range-beta",
        timestamp: "2026-08-18T12:00:00.000Z",
        project: "Beta project",
        threadId: "beta-range",
        model: "gpt-5.6-luna",
        totalTokens: 2_000,
        inputTokens: 1_600,
        outputTokens: 400,
      }),
      makeEvent({
        id: "range-alpha-late",
        timestamp: "2026-08-20T12:00:00.000Z",
        project: "Alpha project",
        threadId: "alpha-late",
        totalTokens: 3_000,
        inputTokens: 2_400,
        outputTokens: 600,
      }),
    ]);
    const week = runCli(staticSnapshotArgs(snapshotPath, ["week", "2026-08-20"]));
    assertExit(week);
    assert.equal(week.stderr, "");
    assert.match(week.stdout, /Alpha project/);
    assert.match(week.stdout, /Beta project/);
    assert.match(week.stdout, /6\.00K TOKENS/);
    assert.match(week.stdout, /4\.00K/);
    assert.match(week.stdout, /2\.00K/);

    const trend = runCli(staticSnapshotArgs(snapshotPath, ["trend", "7d", "--date", "2026-08-20"]));
    assertExit(trend);
    assert.equal(trend.stderr, "");
    assert.match(trend.stdout, /ACTUAL TOKENS/);
    assert.match(trend.stdout, /AUG 14/);
    assert.match(trend.stdout, /AUG 20/);
    assert.match(trend.stdout, /GPT-5\.5/);
    assert.match(trend.stdout, /Luna/);
  });
});

test("standard report writes a valid PNG and reports its completion", async () => {
  await inTemp("token-ledger-cli-report-", async (root) => {
    const snapshotPath = await writeSnapshot(root, [
      makeEvent({
        id: "report-event",
        timestamp: "2026-08-20T12:00:00.000Z",
        project: "Report project",
        threadId: "report-thread",
        totalTokens: 2_000,
        inputTokens: 1_500,
        cachedInputTokens: 500,
        outputTokens: 500,
      }),
    ]);
    const outputPath = resolve(root, "report.png");
    const result = runCli([
      "report",
      "7d",
      "--date",
      "2026-08-20",
      "--input",
      snapshotPath,
      "--no-refresh",
      "--no-open",
      "--image-output",
      outputPath,
      "--tz",
      "UTC",
    ]);
    assertExit(result);
    assert.match(result.stdout, /Wrote report:/);
    assert.match(result.stdout, /Range: 2026-08-14 through 2026-08-20 \(UTC\)/);
    assert.match(result.stderr, /generating report PNG/);
    assert.match(result.stderr, /finished report PNG/);
    assertPng(await readFile(outputPath));
    assert.ok((await stat(outputPath)).size > 1_000);
  });
});

test("cache-rate report writes a separate valid PNG artifact", async () => {
  await inTemp("token-ledger-cli-cache-report-", async (root) => {
    const snapshotPath = await writeSnapshot(root, [
      makeEvent({
        id: "cache-report-event",
        timestamp: "2026-08-20T12:00:00.000Z",
        project: "Cache project",
        threadId: "cache-thread",
        totalTokens: 4_000,
        inputTokens: 3_000,
        cachedInputTokens: 2_000,
        outputTokens: 1_000,
      }),
    ]);
    const outputPath = resolve(root, "cache-report.png");
    const result = runCli([
      "report",
      "7d",
      "--date",
      "2026-08-20",
      "--cache-rate",
      "--input",
      snapshotPath,
      "--no-refresh",
      "--no-open",
      "--image-output",
      outputPath,
      "--tz",
      "UTC",
    ]);
    assertExit(result);
    assert.match(result.stdout, /Wrote cache report:/);
    assert.match(result.stdout, /Range: 2026-08-14 through 2026-08-20 \(UTC\)/);
    assert.match(result.stderr, /generating cache report PNG/);
    assert.match(result.stderr, /finished cache report PNG/);
    assertPng(await readFile(outputPath));
  });
});

test("terminal metadata sanitization removes OSC, CSI, and control bytes", async () => {
  await inTemp("token-ledger-cli-sanitize-", async (root) => {
    const snapshotPath = await writeSnapshot(root, [
      makeEvent({
        id: "sanitize-event",
        timestamp: "2026-08-20T12:00:00.000Z",
        project: "Control project \u001b]0;do-not-run\u0007",
        threadId: "sanitize-thread",
        totalTokens: 900,
        inputTokens: 800,
        outputTokens: 100,
        useType: "\u001b[31mSDK\u001b[0m\u0000",
      }),
    ]);
    const result = runCli(staticSnapshotArgs(snapshotPath));
    assertExit(result);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Control project/);
    assert.match(result.stdout, /SDK\s+100\.0%/);
    assert.doesNotMatch(result.stdout, /do-not-run|\u001b/);
    assert.deepEqual(nonLineControlCodes(result.stdout), []);
  });
});

test("CLI failures redact absolute local paths while retaining safe labels", async () => {
  await inTemp("token-ledger-cli-paths-", async (root) => {
    const missingSnapshot = resolve(root, "missing-snapshot.json");
    const missingSnapshotResult = runCli([
      "day",
      "2026-08-20",
      "--input",
      missingSnapshot,
      "--no-refresh",
      "--static",
      "--plain",
      "--tz",
      "UTC",
    ], { env: { HOME: root } });
    assertExit(missingSnapshotResult, 1);
    assert.equal(missingSnapshotResult.stdout, "");
    assert.match(missingSnapshotResult.stderr, /Snapshot not found: missing-snapshot\.json/);
    assert.doesNotMatch(missingSnapshotResult.stderr, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const missingCodexHome = resolve(root, "missing-codex-home");
    const refreshResult = runCli([
      "week",
      "2026-08-20",
      "--refresh",
      "--codex-home",
      missingCodexHome,
      "--static",
      "--plain",
      "--tz",
      "UTC",
    ], { env: { HOME: root } });
    assertExit(refreshResult, 1);
    assert.match(refreshResult.stderr, /Codex data directory not found: missing-codex-home/);
    assert.doesNotMatch(refreshResult.stderr, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("refresh publishes a local cache that a no-refresh run can read", async () => {
  await inTemp("token-ledger-cli-refresh-", async (root) => {
    const codexHome = resolve(root, "codex-home");
    const rolloutDirectory = resolve(codexHome, "sessions", "2026", "08", "20");
    await mkdir(rolloutDirectory, { recursive: true });
    const threadId = "11111111-1111-4111-8111-111111111111";
    const timestamp = "2026-08-20T12:00:00.000Z";
    const usage = {
      input_tokens: 1_500,
      cached_input_tokens: 500,
      output_tokens: 300,
      reasoning_output_tokens: 100,
      total_tokens: 1_800,
    };
    const rolloutPath = resolve(rolloutDirectory, `rollout-${threadId}.jsonl`);
    const rows = [
      {
        timestamp,
        type: "session_meta",
        payload: {
          id: threadId,
          cwd: "/private/tmp/refresh-project",
          git: { repository_url: "https://github.com/acme/refresh-project.git" },
          source: "vscode",
        },
      },
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: {
            model: "gpt-5.5",
            reasoning_effort: "high",
            service_tier: "standard",
          },
        },
      },
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "refresh-turn",
          started_at: Date.parse(timestamp) / 1_000,
        },
      },
      {
        timestamp,
        type: "turn_context",
        payload: {
          turn_id: "refresh-turn",
          model: "gpt-5.5",
          effort: "high",
          cwd: "/private/tmp/refresh-project",
        },
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "refresh-call",
        },
      },
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: usage,
            last_token_usage: usage,
            model_context_window: 128_000,
          },
        },
      },
    ];
    await writeFile(rolloutPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const env = { HOME: root };
    const refresh = runCli([
      "day",
      "2026-08-20",
      "--refresh",
      "--codex-home",
      codexHome,
      "--static",
      "--plain",
      "--ascii",
      "--raw-projects",
      "--tz",
      "UTC",
    ], { env });
    assertExit(refresh);
    assert.match(refresh.stderr, /refreshing local snapshot/);
    assert.match(refresh.stdout, /1\.80K TOKENS/);
    assert.match(refresh.stdout, /refresh-project/);

    const cachePath = resolve(root, ".token-ledger", "token-ledger-snapshot-v3.json.gz");
    assert.ok((await stat(cachePath)).size > 100);
    const cached = runCli([
      "day",
      "2026-08-20",
      "--no-refresh",
      "--static",
      "--plain",
      "--ascii",
      "--raw-projects",
      "--tz",
      "UTC",
    ], { env });
    assertExit(cached);
    assert.match(cached.stdout, /1\.80K TOKENS/);
    assert.match(cached.stdout, /refresh-project/);
    assert.equal(cached.stderr, "");
  });
});
