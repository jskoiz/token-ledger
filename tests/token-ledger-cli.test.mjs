import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import assert from "node:assert/strict";
import { homedir, tmpdir, userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readPrivateSnapshot,
  stagePrivateSnapshot,
  writePrivateSnapshot,
} from "../lib/token-ledger-snapshot.mjs";
import {
  aggregateProjects,
  dayBounds,
  filterDayEvents,
  loadSnapshot,
  parseArgs,
  redactLocalPaths,
  refreshedSnapshotSourceStatus,
  refreshFailureAllowsStaleFallback,
  rolling24hBounds,
  rollingDurationBounds,
  run,
  sanitizeTerminalText,
  DEFAULT_SNAPSHOT,
  snapshotCacheIsFresh,
  snapshotFreshness,
  shouldCheckSourceFreshness,
  weekBounds,
} from "../bin/token-ledger.mjs";
import {
  collectUsage,
  SOURCE_WATERMARK_VERSION,
  sourceInventory,
  sourceWatermarksEqual,
} from "../lib/token-ledger-importer.mjs";
import {
  codexHomeFingerprint,
  readDurableLedgerRevision,
  resolveDurableLedgerPath,
} from "../lib/token-ledger-ledger.mjs";

import {
  quotaCycleSummary,
  renderFullscreen,
  renderTerminal,
} from "../bin/token-ledger-terminal.mjs";
import {
  buildBurnDayBins,
  buildRangeAnalysis,
  buildUsageTrend,
  eventCredits,
  multiDayBounds,
  normalizeQuotaTimeline,
  priorPeriodBounds,
  weeklyQuotaObservations,
} from "../bin/token-ledger-trend.mjs";
import {
  API_USD_LONG_CONTEXT_THRESHOLD_TOKENS,
  apiUsdForUsage,
  calculateCodexPurchasedCredits,
  codexCreditMultiplier,
  hasDetailedTokenBreakdown,
  isFastServiceTier,
  normalizeCodexCreditModel,
  partitionTokenUsage,
} from "../lib/token-ledger-rates.mjs";
import { renderCostTerminal } from "../bin/token-ledger-cost-terminal.mjs";
import {
  renderTrendImage,
  writeTrendPng,
} from "../bin/token-ledger-trend-image.mjs";
import { buildTrendReportViewModel } from "../bin/token-ledger-report-data.mjs";
import {
  buildCacheReportData,
  priorPeriodSummary,
} from "../bin/token-ledger-cache-data.mjs";
import { renderCacheReportImage } from "../bin/token-ledger-cache-image.mjs";
import {
  MAX_SAFE_TOKEN_COUNT,
  scaledOutputTokens,
  splitUsageBucketsAtBoundaries,
} from "../lib/token-ledger-usage.mjs";
import {
  textWidth,
  truncateText,
} from "../bin/token-ledger-image-primitives.mjs";
import {
  INTERACTIVE_FOOTER,
  INTERACTIVE_HELP,
  INTERACTIVE_KEY_INPUTS,
} from "../bin/token-ledger-controls.mjs";
import { actionFor } from "../bin/token-ledger-tui.mjs";
import {
  buildActualTokenBins,
  renderTrendPlain,
} from "../bin/token-ledger-trend-terminal.mjs";
import {
  snapshotFreshnessDetail,
  SOURCE_STATUSES,
  sourceStatusLabel,
  sourceStatusLine,
} from "../bin/token-ledger-source-status.mjs";
import {
  ACCOUNT_QUOTA_LIMIT_KEY,
  QUOTA_IDENTITY_CONTRACT_VERSION,
} from "../lib/token-ledger-quota-contract.mjs";

const TEST_LEDGER_STATE_ROOT = resolve(
  userInfo().homedir,
  ".token-ledger",
  "test-state",
  String(process.pid),
);

test.after(async () => {
  await rm(TEST_LEDGER_STATE_ROOT, { recursive: true, force: true });
});

async function createPrivateFixtureRoot(prefix) {
  return mkdtemp(resolve(tmpdir(), prefix));
}

const CURRENT_QUOTA_METADATA = Object.freeze({
  durableLedger: Object.freeze({
    quotaIdentityContract: QUOTA_IDENTITY_CONTRACT_VERSION,
  }),
});
const NAMED_QUOTA_LIMIT_KEY = "0000000000000000";

const ROLLING_24H_FIXTURE = fileURLToPath(
  new URL("./fixtures/rolling-24h-projects.json", import.meta.url),
);
const CLI_ENTRYPOINT = fileURLToPath(
  new URL("../bin/token-ledger.mjs", import.meta.url),
);
const IMAGE_MODULE_TRACE_LOADER = fileURLToPath(
  new URL("./trace-image-imports-loader.mjs", import.meta.url),
);

test("non-image CLI paths do not load image renderers or Sharp", () => {
  const commands = [
    ["--help"],
    [
      "1d",
      "--input",
      ROLLING_24H_FIXTURE,
      "--no-refresh",
      "--static",
      "--plain",
      "--tz",
      "UTC",
    ],
  ];

  for (const args of commands) {
    const result = spawnSync(
      process.execPath,
      ["--loader", IMAGE_MODULE_TRACE_LOADER, CLI_ENTRYPOINT, ...args],
      { encoding: "utf8" },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /TOKEN_LEDGER_IMAGE_GRAPH/);
  }
});

function nonLineControlCodes(value) {
  return [...value]
    .map((character) => character.codePointAt(0))
    .filter(
      (code) =>
        ((code >= 0 && code <= 31) || (code >= 127 && code <= 159)) &&
        ![9, 10, 13].includes(code),
    );
}

function stripGeneratedSgr(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function lifecycleJsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function lifecycleTokenCount(timestamp, totalTokens) {
  const usage = {
    input_tokens: totalTokens - 200,
    cached_input_tokens: 200,
    output_tokens: 200,
    reasoning_output_tokens: 50,
    total_tokens: totalTokens,
  };
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: {
          window_minutes: 10_080,
          used_percent: 42,
          resets_at: Date.parse("2026-08-27T00:00:00.000Z") / 1_000,
        },
        secondary: {
          window_minutes: 60,
          used_percent: 12,
          resets_at: Date.parse("2026-08-20T13:00:00.000Z") / 1_000,
        },
        plan_type: "pro",
        limit_name: "minute",
      },
      info: {
        total_token_usage: usage,
        last_token_usage: usage,
        model_context_window: 128_000,
      },
    },
  };
}

async function writeLifecycleRollout(
  codexHome,
  threadId,
  timestamp,
  totalTokens,
  {
    archived = false,
    parentThreadId = null,
    repositoryUrl = "https://github.com/acme/metadata-project.git",
  } = {},
) {
  const directory = resolve(
    codexHome,
    archived ? "archived_sessions" : "sessions",
    "2026",
    "08",
    "20",
  );
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `rollout-${threadId}.jsonl`);
  const startedAt = Date.parse(timestamp) / 1_000;
  const turnId = `lifecycle-turn-${threadId.slice(0, 8)}`;
  const callId = `lifecycle-call-${threadId.slice(0, 8)}`;
  const sessionMeta = {
    id: threadId,
    cwd: "/private/tmp/rollout-project",
    git: { repository_url: repositoryUrl },
    source: "vscode",
  };
  if (parentThreadId) sessionMeta.parent_thread_id = parentThreadId;
  await writeFile(
    path,
    lifecycleJsonl([
      {
        timestamp,
        type: "session_meta",
        payload: sessionMeta,
      },
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: {
            model: "gpt-5.6-luna",
            reasoning_effort: "high",
            service_tier: "priority",
          },
        },
      },
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: turnId,
          started_at: startedAt,
        },
      },
      {
        timestamp,
        type: "turn_context",
        payload: {
          turn_id: turnId,
          model: "gpt-5.6-luna",
          effort: "high",
        },
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: callId,
        },
      },
      lifecycleTokenCount(timestamp, totalTokens),
    ]),
  );
  return path;
}

async function writeLifecycleIndex(codexHome, threadId, title, updatedAt) {
  const path = resolve(codexHome, "session_index.jsonl");
  await writeFile(
    path,
    lifecycleJsonl([{ id: threadId, thread_name: title, updated_at: updatedAt }]),
  );
  return path;
}

function writeLifecycleStateDatabase(
  path,
  {
    threadId,
    parentThreadId,
    threadSource,
    tokensUsed,
    title = "SQLite title",
    model = "gpt-5.5",
    effort = "low",
  },
) {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        created_at INTEGER,
        updated_at INTEGER,
        source TEXT,
        cwd TEXT,
        title TEXT,
        name TEXT,
        tokens_used INTEGER,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        agent_nickname TEXT,
        agent_role TEXT,
        model TEXT,
        reasoning_effort TEXT,
        thread_source TEXT
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT,
        child_thread_id TEXT
      );
    `);
    database.prepare(`
      INSERT INTO threads (
        id, created_at, updated_at, source, cwd, title, name, tokens_used,
        git_sha, git_branch, git_origin_url, agent_nickname, agent_role,
        model, reasoning_effort, thread_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      threadId,
      Date.parse("2026-08-20T11:59:00.000Z") / 1_000,
      Date.parse("2026-08-20T12:01:00.000Z") / 1_000,
      "exec",
      "/private/tmp/sqlite-project",
      title,
      "SQLite fallback name",
      tokensUsed,
      "deadbeef",
      "main",
      "https://github.com/acme/sqlite-project.git",
      "metadata-agent",
      "worker",
      model,
      effort,
      threadSource,
    );
    database.prepare(
      "INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id) VALUES (?, ?)",
    ).run(parentThreadId, threadId);
  } finally {
    database.close();
  }
}

function updateLifecycleStateDatabase(path, threadSource, tokensUsed) {
  const database = new DatabaseSync(path);
  try {
    database.prepare(
      "UPDATE threads SET thread_source = ?, tokens_used = ?",
    ).run(threadSource, tokensUsed);
  } finally {
    database.close();
  }
}

function lifecycleRun(codexHome, cachePath, includeArchived = true) {
  const argv = [
    "day",
    "2026-08-20",
    "--codex-home",
    codexHome,
    "--input",
    cachePath,
    "--static",
    "--plain",
    "--ascii",
    "--raw-projects",
    "--tz",
    "UTC",
  ];
  if (!includeArchived) argv.push("--no-archived");
  const options = parseArgs(argv);
  // Keep the parsed option in automatic-refresh mode while redirecting the
  // default private cache into the hermetic fixture.
  options.input = cachePath;
  options.inputExplicit = false;
  return run(options);
}

async function ageLifecycleCache(cachePath) {
  const cacheTimeMs = Date.now() - 2 * 60 * 60 * 1_000;
  const cacheDate = new Date(cacheTimeMs);
  await utimes(cachePath, cacheDate, cacheDate);
  return cacheTimeMs;
}

async function setLifecycleSourceNewer(sourcePath, cacheTimeMs) {
  const newer = new Date(cacheTimeMs + 1_000);
  await utimes(sourcePath, newer, newer);
}

test("successful metadata-backed refresh lifecycle remains hermetic", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-refresh-lifecycle-");
  const codexHome = resolve(root, "codex-home");
  const cachePath = resolve(root, "cache", "token-ledger-snapshot-v3.json.gz");
  const noArchivedCachePath = resolve(
    root,
    "cache-no-archived",
    "token-ledger-snapshot-v3.json.gz",
  );
  const activeThreadId = "11111111-1111-4111-8111-111111111111";
  const parentThreadId = "22222222-2222-4222-8222-222222222222";
  const archivedThreadId = "33333333-3333-4333-8333-333333333333";
  const timestamp = "2026-08-20T12:00:00.000Z";
  const activeRolloutPath = await writeLifecycleRollout(
    codexHome,
    activeThreadId,
    timestamp,
    1_000,
    { parentThreadId },
  );
  await writeLifecycleRollout(
    codexHome,
    archivedThreadId,
    timestamp,
    500,
    {
      archived: true,
      repositoryUrl: "https://github.com/acme/archived-project.git",
    },
  );
  const indexPath = await writeLifecycleIndex(
    codexHome,
    activeThreadId,
    "Indexed metadata title",
    timestamp,
  );
  const currentStatePath = resolve(codexHome, "state_5.sqlite");
  try {
    await mkdir(codexHome, { recursive: true });
    writeLifecycleStateDatabase(currentStatePath, {
      threadId: activeThreadId,
      parentThreadId,
      threadSource: "automation",
      tokensUsed: 9_999,
    });

    const firstOutput = await lifecycleRun(codexHome, cachePath);
    const firstSnapshot = await readPrivateSnapshot(cachePath);
    assert.match(firstOutput, /metadata-project/);
    assert.match(firstOutput, /1\.00K/);
    assert.equal(firstSnapshot.coverage.filesScanned, 2);
    assert.equal(firstSnapshot.coverage.observedTokens, 1_500);
    assert.equal(firstSnapshot.coverage.observedModelCalls, 2);

    const activeThread = firstSnapshot.threads.find(
      (thread) => thread.id === activeThreadId,
    );
    assert.deepEqual(
      {
        title: activeThread.title,
        project: activeThread.project,
        model: activeThread.model,
        effort: activeThread.effort,
        source: activeThread.source,
        useType: activeThread.useType,
        parentThreadId: activeThread.parentThreadId,
        reportedCumulativeTokens: activeThread.reportedCumulativeTokens,
      },
      {
        title: "Indexed metadata title",
        project: "acme/metadata-project",
        model: "gpt-5.6-luna",
        effort: "high",
        source: "automation",
        useType: "automation",
        parentThreadId,
        reportedCumulativeTokens: 9_999,
      },
    );
    const activeEvent = firstSnapshot.events.find((event) =>
      event.threadIds.includes(activeThreadId),
    );
    assert.deepEqual(
      {
        inputTokens: activeEvent.inputTokens,
        cachedInputTokens: activeEvent.cachedInputTokens,
        outputTokens: activeEvent.outputTokens,
        totalTokens: activeEvent.totalTokens,
        toolCalls: activeEvent.toolCalls,
        serviceTier: activeEvent.serviceTier,
      },
      {
        inputTokens: 800,
        cachedInputTokens: 200,
        outputTokens: 200,
        totalTokens: 1_000,
        toolCalls: 1,
        serviceTier: "priority",
      },
    );
    assert.equal(firstSnapshot.quotaObservations.length, 2);
    assert.equal(
      firstSnapshot.quotaObservations.find(
        (quota) => quota.windowMinutes === 10_080,
      ).usedPercent,
      42,
    );
    assert.equal(
      firstSnapshot.quotaObservations.find(
        (quota) => quota.windowMinutes === 60,
      ).usedPercent,
      12,
    );
    assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
    assert.deepEqual(
      [...(await readFile(cachePath)).subarray(0, 2)],
      [0x1f, 0x8b],
    );

    const initialCache = await readFile(cachePath);
    const unchangedCacheTimeMs = await ageLifecycleCache(cachePath);
    await lifecycleRun(codexHome, cachePath);
    assert.equal(
      (await readPrivateSnapshot(cachePath)).coverage.observedTokens,
      firstSnapshot.coverage.observedTokens,
    );
    assert.deepEqual(await readFile(cachePath), initialCache);

    await writeLifecycleRollout(
      codexHome,
      activeThreadId,
      timestamp,
      1_500,
      { parentThreadId },
    );
    await setLifecycleSourceNewer(activeRolloutPath, unchangedCacheTimeMs);
    await lifecycleRun(codexHome, cachePath);
    let refreshedSnapshot = await readPrivateSnapshot(cachePath);
    assert.equal(
      refreshedSnapshot.events.find((event) =>
        event.threadIds.includes(activeThreadId),
      ).totalTokens,
      1_500,
    );

    const indexCacheTimeMs = await ageLifecycleCache(cachePath);
    await writeLifecycleIndex(
      codexHome,
      activeThreadId,
      "Fresh indexed metadata title",
      "2026-08-20T12:05:00.000Z",
    );
    await setLifecycleSourceNewer(indexPath, indexCacheTimeMs);
    await lifecycleRun(codexHome, cachePath);
    refreshedSnapshot = await readPrivateSnapshot(cachePath);
    assert.equal(
      refreshedSnapshot.threads.find((thread) => thread.id === activeThreadId)
        .title,
      "Fresh indexed metadata title",
    );

    const currentStateCacheTimeMs = await ageLifecycleCache(cachePath);
    updateLifecycleStateDatabase(currentStatePath, "realtime_voice", 12_345);
    await setLifecycleSourceNewer(currentStatePath, currentStateCacheTimeMs);
    await lifecycleRun(codexHome, cachePath);
    refreshedSnapshot = await readPrivateSnapshot(cachePath);
    const refreshedCurrentThread = refreshedSnapshot.threads.find(
      (thread) => thread.id === activeThreadId,
    );
    assert.equal(refreshedCurrentThread.source, "voice");
    assert.equal(refreshedCurrentThread.useType, "voice");
    assert.equal(refreshedCurrentThread.reportedCumulativeTokens, 12_345);

    await rm(currentStatePath);
    const legacyStatePath = resolve(codexHome, "sqlite", "state_5.sqlite");
    await mkdir(resolve(codexHome, "sqlite"), { recursive: true });
    writeLifecycleStateDatabase(legacyStatePath, {
      threadId: activeThreadId,
      parentThreadId,
      threadSource: "subagent",
      tokensUsed: 22_222,
      title: "Legacy SQLite title",
    });
    const legacyCacheTimeMs = await ageLifecycleCache(cachePath);
    await setLifecycleSourceNewer(legacyStatePath, legacyCacheTimeMs);
    await lifecycleRun(codexHome, cachePath);
    refreshedSnapshot = await readPrivateSnapshot(cachePath);
    const refreshedLegacyThread = refreshedSnapshot.threads.find(
      (thread) => thread.id === activeThreadId,
    );
    assert.equal(refreshedLegacyThread.source, "subagent");
    assert.equal(refreshedLegacyThread.useType, "subagent");
    assert.equal(refreshedLegacyThread.reportedCumulativeTokens, 22_222);

    const noArchivedOutput = await lifecycleRun(
      codexHome,
      noArchivedCachePath,
      false,
    );
    const noArchivedSnapshot = await readPrivateSnapshot(noArchivedCachePath);
    assert.match(noArchivedOutput, /metadata-project/);
    assert.doesNotMatch(noArchivedOutput, /archived-project/);
    assert.equal(noArchivedSnapshot.coverage.filesScanned, 1);
    assert.equal(noArchivedSnapshot.coverage.observedTokens, 1_500);
    assert.equal(noArchivedSnapshot.events.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sourceRolloutRows(total, turnId, timestamp) {
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
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: total,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: total,
          },
          last_token_usage: {
            input_tokens: total,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: total,
          },
          model_context_window: 128_000,
        },
      },
    },
  ];
}

function sourceRolloutRowsWithQuota(total, turnId, timestamp, usedPercent) {
  const rows = sourceRolloutRows(total, turnId, timestamp);
  rows.at(-1).payload.rate_limits = {
    limit_id: "codex",
    limit_name: "Default display",
    plan_type: "plus",
    primary: {
      window_minutes: 10_080,
      used_percent: usedPercent,
      resets_at: Date.parse("2026-08-30T10:00:00.000Z") / 1_000,
    },
  };
  return rows;
}

function serializeRows(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

test(
  "CLI entrypoint supports direct shebang execution",
  { skip: process.platform === "win32" },
  () => {
    const result = spawnSync(CLI_ENTRYPOINT, ["--help"], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--help/);
    assert.match(result.stdout, /cost 7d --basis api-usd/);

    const costHelp = spawnSync(CLI_ENTRYPOINT, ["cost", "--help"], {
      encoding: "utf8",
    });
    assert.equal(costHelp.status, 0, costHelp.stderr);
    assert.match(costHelp.stdout, /cost 7d --basis api-usd/);
  },
);

test("bare CLI shows the concise quick guide", () => {
  const result = spawnSync(process.execPath, [CLI_ENTRYPOINT], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /tledger 1d\s+Last 24 hours/);
  assert.match(result.stdout, /tledger report 7d\s+Write the 7-day PNG report/);
  assert.match(result.stdout, /--help-all\s+Show every command and option/);
  assert.match(result.stdout, /--since <ISO timestamp>/);
  assert.doesNotMatch(result.stdout, /--codex-home|--youplot|npm run/);
});

test("--help-all shows the complete command reference", () => {
  const result = spawnSync(process.execPath, [CLI_ENTRYPOINT, "--help-all"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Token Ledger command reference/);
  assert.match(result.stdout, /--codex-home <dir>/);
  assert.match(result.stdout, /--since <ISO timestamp>/);
  assert.match(result.stdout, /--youplot/);
  assert.match(result.stdout, /--image-width <px>/);
});

test("CLI errors stay short and point to both help levels", () => {
  const result = spawnSync(
    process.execPath,
    [CLI_ENTRYPOINT, "week", "--not-a-real-option"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Token Ledger: Unknown option: --not-a-real-option/);
  assert.match(result.stderr, /tledger --help/);
  assert.match(result.stderr, /tledger --help-all/);
  assert.doesNotMatch(result.stderr, /Common options:|Data and refresh:/);
  assert.equal(result.stderr.trimEnd().split("\n").length, 2);
});

test("dayBounds uses local calendar midnights for an explicit timezone", () => {
  const bounds = dayBounds("2026-08-01", "Pacific/Honolulu");
  assert.equal(bounds.start.toISOString(), "2026-08-01T10:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-08-02T10:00:00.000Z");
});

test("weekBounds covers seven local calendar days ending on the selected day", () => {
  const bounds = weekBounds("2026-08-03", "Pacific/Honolulu");
  assert.equal(bounds.startDateString, "2026-07-28");
  assert.equal(bounds.endDateString, "2026-08-03");
  assert.equal(bounds.start.toISOString(), "2026-07-28T10:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-08-04T10:00:00.000Z");
  assert.equal(bounds.rangeDays, 7);
});

test("rolling24hBounds covers the exact preceding 24 hours", () => {
  const end = new Date("2026-08-19T22:15:30.000Z");
  const bounds = rolling24hBounds(end, "Pacific/Honolulu");
  assert.equal(bounds.start.toISOString(), "2026-08-18T22:15:30.000Z");
  assert.equal(bounds.end.toISOString(), "2026-08-19T22:15:30.000Z");
  assert.equal(bounds.rangeHours, 24);
  assert.equal(bounds.timeZone, "Pacific/Honolulu");
});

test("rollingDurationBounds covers arbitrary day windows ending at the supplied time", () => {
  const end = new Date("2026-08-19T22:15:30.000Z");
  const bounds = rollingDurationBounds(end, "Pacific/Honolulu", 3);
  assert.equal(bounds.start.toISOString(), "2026-08-16T22:15:30.000Z");
  assert.equal(bounds.end.toISOString(), "2026-08-19T22:15:30.000Z");
  assert.equal(bounds.rangeHours, 72);
  assert.equal(bounds.rangeDays, 3);
  assert.equal(bounds.timeZone, "Pacific/Honolulu");
});

test("filterDayEvents keeps the start and excludes the end boundary", () => {
  const snapshot = {
    events: [
      null,
      { id: "hostile", timestamp: { toString: null, valueOf: null } },
      { id: "before", timestamp: "2026-08-01T09:59:59.999Z" },
      {
        id: "start",
        timestamp: "2026-08-01T10:00:00.000Z",
        totalTokens: 1,
        inputTokens: 1,
        outputTokens: 0,
      },
      {
        id: "inside",
        timestamp: "2026-08-01T20:00:00.000Z",
        totalTokens: 1,
        inputTokens: 1,
        outputTokens: 0,
      },
      { id: "end", timestamp: "2026-08-02T10:00:00.000Z" },
    ],
  };
  const events = filterDayEvents(snapshot, dayBounds("2026-08-01", "Pacific/Honolulu"));
  assert.deepEqual(events.map((event) => event.id), ["start", "inside"]);
});

test("filterDayEvents allocates a compacted bucket across local-day boundaries", () => {
  const snapshot = {
    events: [{
      timestamp: "2025-06-01T12:00:00.000Z",
      startAt: "2025-06-01T06:00:00.000Z",
      endAt: "2025-06-01T18:00:00.000Z",
      resolutionSeconds: 86_400,
      project: "boundary-history",
      model: "gpt-5.6-luna",
      totalTokens: 150,
      callCount: 2,
      breakdownAvailable: false,
    }],
  };
  const previous = filterDayEvents(
    snapshot,
    dayBounds("2025-05-31", "America/Los_Angeles"),
  );
  const current = filterDayEvents(
    snapshot,
    dayBounds("2025-06-01", "America/Los_Angeles"),
  );
  const previousTokens = previous.reduce(
    (sum, event) => sum + event.totalTokens,
    0,
  );
  const currentTokens = current.reduce(
    (sum, event) => sum + event.totalTokens,
    0,
  );

  assert.ok(previousTokens > 0 && previousTokens < 150);
  assert.ok(currentTokens > 0 && currentTokens < 150);
  assert.ok(Math.abs(previousTokens + currentTokens - 150) < 1e-9);
  assert.ok([...previous, ...current].every(
    (event) => event.rangeAllocationEstimated === true,
  ));
});

test("aggregateProjects sorts by tokens and retains model mix", () => {
  const snapshot = {
    events: [],
    threads: [
      { id: "alpha-1", project: "alpha" },
      { id: "alpha-2", project: "alpha" },
      { id: "beta-1", project: "beta" },
    ],
  };
  const events = [
    {
      project: "alpha",
      threadId: "alpha-1",
      model: "gpt-5.6-sol",
      totalTokens: 900,
      outputTokens: 90,
      toolCalls: 2,
      rateCardCredits: 4,
    },
    {
      project: "alpha",
      threadId: "alpha-2",
      model: "gpt-5.6-luna",
      totalTokens: 100,
      outputTokens: 10,
      toolCalls: 1,
      rateCardCredits: 1,
    },
    {
      project: "beta",
      threadId: "beta-1",
      model: "gpt-5.5",
      totalTokens: 500,
      outputTokens: 50,
      toolCalls: 1,
      rateCardCredits: null,
    },
  ];
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  assert.deepEqual(rows.map((row) => row.project), ["alpha", "beta"]);
  assert.equal(rows[0].threads, 2);
  assert.deepEqual(
    rows[0].models.map((model) => model.model),
    ["Sol", "Luna"],
  );
  assert.equal(rows[0].totalTokens, 1_000);
});

test("ordinary terminal credit shares use the current rate card", () => {
  const events = [
    {
      project: "alpha",
      model: "gpt-5.6-sol",
      totalTokens: 1_000_000,
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      rateCardCredits: 9_999,
    },
    {
      project: "beta",
      model: "gpt-5.6-luna",
      totalTokens: 1_000_000,
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      rateCardCredits: 0.001,
    },
  ];
  const rows = aggregateProjects({ events: [], threads: [] }, events, {
    rawProjects: true,
  });

  assert.equal(rows[0].rateCardCredits, 100);
  assert.equal(rows[1].rateCardCredits, 5);
  assert.equal(rows[0].knownCreditTokens, 1_000_000);
  assert.equal(rows[1].knownCreditTokens, 1_000_000);

  const output = renderTerminal({
    options: { plain: true, ascii: true, width: 100 },
    snapshot: { events: [], threads: [] },
    bounds: dayBounds("2026-08-01", "UTC"),
    events,
    rows,
    allRows: rows,
  });
  assert.match(output, /95\.2% credits/);
  assert.match(output, /4\.76% credits/);
});

test("aggregateProjects keeps capped project shares proportional", () => {
  const huge = Number.MAX_SAFE_INTEGER;
  const events = [
    {
      project: "alpha",
      model: "gpt-5.6-luna",
      totalTokens: huge,
    },
    {
      project: "beta",
      model: "gpt-5.6-sol",
      totalTokens: huge,
    },
  ];
  const snapshot = { events: [], threads: [] };
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });

  assert.deepEqual(rows.map((row) => row.project), ["alpha", "beta"]);
  assert.ok(rows.every((row) => row.totalTokens < huge));
  assert.ok(
    Math.abs(rows[0].totalTokens - huge / 2) < Number.EPSILON * huge,
  );
  assert.equal(rows[0].totalTokens + rows[1].totalTokens, huge);

  const output = renderTerminal({
    options: { plain: true, ascii: true, width: 100 },
    snapshot,
    bounds: dayBounds("2026-08-01", "UTC"),
    events,
    rows,
    allRows: rows,
  });
  assert.match(output, /alpha.*50\.0%/);
  assert.match(output, /beta.*50\.0%/);
});

test("aggregateProjects preserves compacted call and thread counts", () => {
  const rows = aggregateProjects(
    { events: [], threads: [] },
    [{
      project: "alpha",
      threadIds: ["alpha-1", "alpha-2"],
      model: "gpt-5.6-luna",
      totalTokens: 300,
      outputTokens: 30,
      toolCalls: 4,
      callCount: 3,
      rateCardCredits: 1,
    }],
    { rawProjects: true },
  );

  assert.equal(rows[0].events, 3);
  assert.equal(rows[0].threads, 2);
  assert.equal(rows[0].models[0].events, 3);
});

test("fractional compacted call counts survive terminal aggregation", () => {
  const bounds = multiDayBounds("2026-08-01", "UTC", 7);
  const event = {
    timestamp: "2026-08-02T00:00:00.000Z",
    project: "fractional-history",
    model: "gpt-5.6-luna",
    totalTokens: 150.5,
    outputTokens: 0,
    toolCalls: 0,
    callCount: 0.5,
    rangeAllocationEstimated: true,
  };
  const rows = aggregateProjects({ events: [], threads: [] }, [event], {
    rawProjects: true,
  });
  assert.equal(rows[0].events, 0.5);
  assert.equal(rows[0].models[0].events, 0.5);
  assert.equal(rows[0].estimated, true);
  assert.equal(rows[0].models[0].estimated, true);

  const output = renderTerminal({
    options: { plain: true, ascii: true, width: 100 },
    snapshot: { events: [], threads: [] },
    snapshotFreshness: null,
    bounds,
    events: [event],
    rows,
    allRows: rows,
  });
  assert.match(output, /0\.5 CALLS/);
});

test("zero-token boundary fragments do not mark project totals estimated", () => {
  const rows = aggregateProjects(
    { events: [], threads: [] },
    [{
      project: "boundary-only",
      model: "gpt-5.6-luna",
      totalTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      callCount: 0,
      rangeAllocationEstimated: true,
    }],
    { rawProjects: true },
  );

  assert.equal(rows[0].estimated, false);
  assert.equal(rows[0].models[0].estimated, false);
});

test("project labels remove terminal control sequences before rendering", () => {
  const project = "\u001b]8;;https://example.test\u0007\u001b[31msecret\u001b[0m\u0000";
  const rows = aggregateProjects(
    { events: [], threads: [{ id: "thread-1", project }] },
    [{ project, threadId: "thread-1", totalTokens: 1 }],
    { rawProjects: true },
  );

  assert.equal(sanitizeTerminalText(project), "secret ");
  assert.equal(rows[0].project, "secret");
  assert.equal(rows[0].displayProject, "secret");
});

test("terminal text sanitizer handles OSC, CSI, controls, and Unicode", () => {
  const belOsc = "\u001b]8;;https://example.test\u0007";
  const stOsc = "\u001b]8;;https://example.test\u001b\\";
  const hostile = `${belOsc}旅館${stOsc}\u001b[2J\u009b31m\u0000\u0085`;
  const sanitized = sanitizeTerminalText(hostile);

  assert.equal(sanitized.trim(), "旅館");
  assert.deepEqual(nonLineControlCodes(sanitized), []);
});

test("terminal renderers sanitize use types before grouping and layout", () => {
  const belOsc = "\u001b]0;title\u0007";
  const stOsc = "\u001b]0;title\u001b\\";
  const events = [
    {
      project: "旅館 🐈",
      threadId: "thread-1",
      model: "gpt-5.5",
      useType: `${belOsc}sdk\u001b[2J\u009b31m\u0000`,
      totalTokens: 1,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 0,
      rateCardCredits: 1,
    },
    {
      project: "旅館 🐈",
      threadId: "thread-2",
      model: "gpt-5.5",
      useType: `${stOsc}sdk`,
      totalTokens: 1,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 0,
      rateCardCredits: 1,
    },
  ];
  const snapshot = {
    events: [],
    threads: [
      { id: "thread-1", project: "旅館 🐈" },
      { id: "thread-2", project: "旅館 🐈" },
    ],
  };
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  const bounds = dayBounds("2026-08-20", "UTC");
  const renderArgs = {
    snapshot,
    bounds,
    events,
    rows,
    allRows: rows,
  };

  const plain = renderTerminal({
    ...renderArgs,
    options: { plain: true, ascii: true, width: 120, forceColor: false },
  });
  const color = renderTerminal({
    ...renderArgs,
    options: { plain: false, ascii: true, width: 120, forceColor: true },
  });
  const fullscreen = renderFullscreen({
    ...renderArgs,
    options: { plain: true, ascii: true, forceColor: false },
    width: 120,
    height: 40,
  });

  assert.match(plain, /旅館 🐈/);
  assert.match(plain, /SDK\s+100\.0%/);
  assert.deepEqual(nonLineControlCodes(plain), []);
  assert.deepEqual(nonLineControlCodes(stripGeneratedSgr(color)), []);
  assert.deepEqual(nonLineControlCodes(fullscreen), []);
});

test("explicit snapshots sanitize labels in static output", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-terminal-text-");
  const snapshotPath = resolve(root, "explicit-snapshot.json");
  try {
    await writeFile(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 3,
        generatedAt: "2026-08-20T12:00:00.000Z",
        events: [{
          timestamp: "2026-08-20T12:00:00.000Z",
          project: "explicit 🐈",
          threadId: "explicit-thread",
          model: "gpt-5.5",
          useType: "\u001b]0;title\u0007sdk\u001b[2J\u009b31m\u0000",
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 0,
          totalTokens: 1,
          rateCardCredits: 1,
        }],
        threads: [{ id: "explicit-thread", project: "explicit 🐈" }],
        quotaObservations: [],
      }),
    );

    const output = await run(parseArgs([
      "day",
      "2026-08-20",
      "--input",
      snapshotPath,
      "--no-refresh",
      "--static",
      "--plain",
      "--ascii",
      "--raw-projects",
      "--tz",
      "UTC",
    ]));

    assert.match(output, /explicit 🐈/);
    assert.match(output, /SDK\s+100\.0%/);
    assert.match(output, /PROVENANCE · EXPLICIT SNAPSHOT/);
    assert.deepEqual(nonLineControlCodes(output), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy project output keeps snapshot age separate from provenance", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-legacy-provenance-");
  const snapshotPath = resolve(root, "snapshot.json");
  const fakeYouPlot = resolve(root, "uplot");
  const previousPath = process.env.PATH;
  try {
    await writeFile(fakeYouPlot, "#!/bin/sh\nprintf 'chart output\\n'\n", {
      mode: 0o755,
    });
    await chmod(fakeYouPlot, 0o755);
    await writeFile(snapshotPath, JSON.stringify({
      schemaVersion: 3,
      generatedAt: "2026-08-20T12:00:00.000Z",
      events: [{
        timestamp: "2026-08-20T12:00:00.000Z",
        project: "legacy",
        threadId: "legacy-thread",
        model: "gpt-5.5",
        totalTokens: 1,
        outputTokens: 0,
      }],
      threads: [{ id: "legacy-thread", project: "legacy" }],
      quotaObservations: [],
    }));
    process.env.PATH = root;

    const output = await run(parseArgs([
      "day",
      "2026-08-20",
      "--input",
      snapshotPath,
      "--no-refresh",
      "--static",
      "--plain",
      "--youplot",
      "--tz",
      "UTC",
    ]), { nowMs: Date.parse("2026-08-20T12:12:00.000Z") });

    assert.match(output, /Snapshot: fresh · 12m old/);
    assert.match(output, /PROVENANCE · EXPLICIT SNAPSHOT/);
    assert.match(output, /chart output/);
    assert.ok(!output.includes(root));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("parseArgs accepts the day subcommand and date option", () => {
  const options = parseArgs([
    "day",
    "--date",
    "2026-08-01",
    "--top",
    "5",
    "--raw-projects",
  ]);
  assert.equal(options.date, "2026-08-01");
  assert.equal(options.top, 5);
  assert.equal(options.rawProjects, true);
});

test("parseArgs normalizes and validates the collection cutoff", () => {
  const options = parseArgs([
    "day",
    "--date",
    "2026-08-20",
    "--since",
    "2026-08-20T07:00:00-05:00",
    "--no-archived",
  ]);
  assert.equal(options.since.toISOString(), "2026-08-20T12:00:00.000Z");
  assert.equal(options.includeArchived, false);
  assert.throws(
    () => parseArgs(["day", "2026-08-20", "--since"]),
    /--since requires a value/,
  );
  assert.throws(
    () => parseArgs(["day", "2026-08-20", "--since", "not-a-date"]),
    /--since requires a valid ISO timestamp/,
  );
  assert.throws(
    () => parseArgs(["day", "2026-08-20", "--since", "01/02/2026"]),
    /--since requires a valid ISO timestamp/,
  );
  assert.throws(
    () => parseArgs(["day", "2026-08-20", "--since", "2026-02-30T00:00:00Z"]),
    /--since requires a valid ISO timestamp/,
  );
});

test("parseArgs treats an empty command and help aliases as help", () => {
  assert.equal(parseArgs([]).help, true);
  assert.equal(parseArgs(["help"]).help, true);
  assert.equal(parseArgs(["--help"]).help, true);

  const complete = parseArgs(["--help-all"]);
  assert.equal(complete.help, true);
  assert.equal(complete.helpAll, true);
});

test("parseArgs defaults the week end day to today", () => {
  const options = parseArgs(["week", "--top", "5"]);
  assert.equal(options.range, "week");
  assert.equal(options.date, "today");
  assert.equal(options.top, 5);
  assert.equal(options.autoRefresh, true);
  assert.equal(options.inputExplicit, false);
  assert.equal(
    options.timeZone,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  assert.equal(
    options.input,
    resolve(homedir(), ".token-ledger", "token-ledger-snapshot-v3.json.gz"),
  );
  assert.equal(options.input, DEFAULT_SNAPSHOT);
});

test("parseArgs accepts the bare 1d rolling project view", () => {
  const options = parseArgs(["1d", "--static", "--top", "5"]);
  assert.equal(options.range, "rolling24h");
  assert.equal(options.rolling24h, true);
  assert.equal(options.view, "projects");
  assert.equal(options.date, null);
  assert.equal(options.static, true);
  assert.equal(options.top, 5);

  const explicit = parseArgs(["day", "1d"]);
  assert.equal(explicit.range, "rolling24h");
  assert.equal(explicit.rolling24h, true);
  assert.throws(
    () => parseArgs(["week", "1d"]),
    /1d alias is only available as `tledger 1d` or `tledger day 1d`/,
  );
  assert.throws(
    () => parseArgs(["1d", "--date", "today"]),
    /does not accept --date/,
  );
});

test("parseArgs accepts rolling day and week duration aliases", () => {
  const twoDays = parseArgs(["2d", "--static"]);
  assert.equal(twoDays.range, "rolling");
  assert.equal(twoDays.rollingDuration, true);
  assert.equal(twoDays.rollingDays, 2);
  assert.equal(twoDays.rollingLabel, "2 days");
  assert.equal(twoDays.view, "projects");
  assert.equal(twoDays.date, null);

  const threeWeeks = parseArgs(["3w"]);
  assert.equal(threeWeeks.range, "rolling");
  assert.equal(threeWeeks.rollingDays, 21);
  assert.equal(threeWeeks.rollingLabel, "3 weeks");
  assert.throws(
    () => parseArgs(["2d", "today"]),
    /does not accept --date/,
  );
});

test("parseArgs requires an explicit basis for cost ranges", () => {
  const oneDay = parseArgs(["cost", "1d", "--basis", "api-usd"]);
  assert.equal(oneDay.view, "cost");
  assert.equal(oneDay.range, "rolling24h");
  assert.equal(oneDay.basis, "api-usd");
  assert.equal(oneDay.static, true);

  const twoWeeks = parseArgs(["cost", "2w", "--basis", "codex-credits"]);
  assert.equal(twoWeeks.range, "rolling");
  assert.equal(twoWeeks.rollingDays, 14);
  assert.equal(twoWeeks.basis, "codex-credits");

  const week = parseArgs(["cost", "week", "--basis", "api-usd"]);
  assert.equal(week.range, "week");
  assert.equal(week.date, "today");

  assert.throws(
    () => parseArgs(["cost", "7d"]),
    /requires --basis codex-credits or --basis api-usd/,
  );
  assert.throws(
    () => parseArgs(["cost", "month", "--basis", "api-usd"]),
    /Cost range must be 1d, Nd, Nw, or week/,
  );
  assert.throws(
    () => parseArgs(["cost", "7d", "--basis", "credits"]),
    /--basis must be codex-credits or api-usd/,
  );
  assert.throws(
    () => parseArgs(["week", "--basis", "api-usd"]),
    /--basis is only available with the cost command/,
  );
});

test("parseArgs rejects cost-incompatible report and interactive flags", () => {
  const base = ["cost", "7d", "--basis", "api-usd"];
  const rejections = new Map([
    ["--drain", /--drain is only available for the trend view/],
    ["--cache-rate", /--cache-rate is only available with the report command/],
    ["--image", /--image is only available for the trend view/],
    ["--no-open", /--no-open is only available for the trend view/],
    ["--youplot", /--youplot is not available with the cost command/],
    ["--raw-projects", /--raw-projects is not available with the cost command/],
    ["--top", /--top is not available with the cost command/],
    ["--width", /--width is not available with the cost command/],
    ["--ascii", /--ascii is not available with the cost command/],
  ]);
  for (const [flag, message] of rejections) {
    const args = flag === "--top"
      ? [...base, flag, "5"]
      : flag === "--width"
        ? [...base, flag, "80"]
        : [...base, flag];
    assert.throws(() => parseArgs(args), message);
  }
});

test("parseArgs accepts --no-open for trend images and rejects it elsewhere", () => {
  const options = parseArgs(["trend", "--image", "--no-open"]);
  assert.equal(options.image, true);
  assert.equal(options.openImage, false);
  assert.equal(parseArgs(["report"]).openImage, true);
  assert.throws(
    () => parseArgs(["week", "--no-open"]),
    /--no-open is only available for the trend view/,
  );
});

test("rolling view describes an empty range as the last 24 hours", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-rolling-empty-");
  const snapshotPath = resolve(root, "snapshot.json");
  try {
    await writeFile(
      snapshotPath,
      JSON.stringify({ schemaVersion: 3, events: [], threads: [] }),
    );
    const output = await run(parseArgs([
      "1d",
      "--input",
      snapshotPath,
      "--no-refresh",
      "--static",
      "--plain",
    ]));
    assert.match(output, /No model-call events found for the last 24 hours \(/);
    assert.match(output, /Snapshot: age unknown/);
    assert.match(output, /PROVENANCE · EXPLICIT SNAPSHOT/);
    assert.match(output, /Source: snapshot\.json/);
    assert.ok(!output.includes(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redactLocalPaths redacts detected UNC path forms", () => {
  const backslashPath = "\\\\server\\share\\private\\snapshot.json";
  const normalizedPath = "//server/share/private/snapshot.json";
  const message =
    "unc=" +
    backslashPath +
    '; normalized="' +
    normalizedPath +
    '"';

  const redacted = redactLocalPaths(message);

  assert.equal(redacted, 'unc=[local path]; normalized="[local path]"');
  assert.ok(!redacted.includes("server"));
  assert.ok(!redacted.includes("share"));
});

test("redactLocalPaths preserves safe basenames for explicit UNC paths", () => {
  const backslashPath = "\\\\server\\share\\private\\snapshot.json";
  const normalizedPath = "//server/share/private/snapshot.json";

  assert.equal(
    redactLocalPaths("missing " + backslashPath, [backslashPath]),
    "missing snapshot.json",
  );
  assert.equal(
    redactLocalPaths("missing " + normalizedPath, [normalizedPath]),
    "missing snapshot.json",
  );
});

test("redactLocalPaths preserves URL schemes while redacting UNC paths", () => {
  const redacted = redactLocalPaths(
    "url=https://registry.npmjs.org/sharp; unc=//server/share/private/snapshot.json",
  );

  assert.equal(
    redacted,
    "url=https://registry.npmjs.org/sharp; unc=[local path]",
  );
});

test("snapshot errors retain safe labels without absolute paths", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-privacy-");
  const missingPath = resolve(root, "missing-snapshot.json");
  const malformedPath = resolve(root, "malformed-snapshot.json");
  const malformedGzipPath = resolve(root, "malformed-snapshot.json.gz");
  const unreadablePath = resolve(root, "unreadable-snapshot.json");
  try {
    await assert.rejects(
      () => run(parseArgs([
        "day",
        "2026-08-20",
        "--input",
        missingPath,
        "--no-refresh",
        "--static",
      ])),
      (error) => {
        assert.match(error.message, /Snapshot not found: missing-snapshot\.json/);
        assert.ok(!error.message.includes(root));
        return true;
      },
    );

    await writeFile(malformedPath, JSON.stringify({ threads: [] }));
    await assert.rejects(
      () => run(parseArgs([
        "day",
        "2026-08-20",
        "--input",
        malformedPath,
        "--no-refresh",
        "--static",
      ])),
      (error) => {
        assert.match(
          error.message,
          /Snapshot uses an unsupported schema: malformed-snapshot\.json/,
        );
        assert.ok(!error.message.includes(root));
        return true;
      },
    );

    await writeFile(malformedGzipPath, "not a gzip stream");
    await assert.rejects(
      () => run(parseArgs([
        "day",
        "2026-08-20",
        "--input",
        malformedGzipPath,
        "--no-refresh",
        "--static",
      ])),
      (error) => {
        assert.match(
          error.message,
          /Could not read snapshot malformed-snapshot\.json\.gz/,
        );
        assert.ok(!error.message.includes(root));
        return true;
      },
    );

    await mkdir(unreadablePath);
    await assert.rejects(
      () => run(parseArgs([
        "day",
        "2026-08-20",
        "--input",
        unreadablePath,
        "--no-refresh",
        "--static",
      ])),
      (error) => {
        assert.match(
          error.message,
          /Could not read snapshot unreadable-snapshot\.json/,
        );
        assert.match(error.message, /EISDIR|directory|read/);
        assert.ok(!error.message.includes(root));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI reads an explicit gzip-compressed snapshot", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-gzip-input-");
  const snapshotPath = resolve(root, "snapshot.json.gz");
  try {
    await writePrivateSnapshot(snapshotPath, {
      schemaVersion: 3,
      generatedAt: "2026-08-20T12:00:00.000Z",
      events: [{
        id: "gzip-event",
        timestamp: "2026-08-20T12:00:00.000Z",
        project: "Compressed Project",
        threadId: "gzip-thread",
        model: "gpt-5.6-luna",
        totalTokens: 1_200,
        inputTokens: 1_000,
        cachedInputTokens: 500,
        outputTokens: 200,
      }],
      threads: [{ id: "gzip-thread", project: "Compressed Project" }],
      quotaObservations: [],
    });

    const output = await run(parseArgs([
      "day",
      "2026-08-20",
      "--input",
      snapshotPath,
      "--no-refresh",
      "--static",
      "--plain",
      "--ascii",
      "--raw-projects",
      "--tz",
      "UTC",
    ]));

    assert.match(output, /Compressed Project/);
    assert.match(output, /1\.20K/);
    assert.ok(!output.includes(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit and unchecked old-contract snapshots keep tokens but no meter", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-old-contract-");
  const snapshotPath = resolve(root, "snapshot.json.gz");
  try {
    await writePrivateSnapshot(snapshotPath, {
      schemaVersion: 3,
      generatedAt: "2026-08-20T12:00:00.000Z",
      provenance: {
        collection: { since: null, includeArchived: true },
      },
      metadata: {
        durableLedger: {
          quotaIdentityContract: "codex-limit-id-v1",
        },
      },
      coverage: { observedTokens: 100 },
      events: [{
        timestamp: "2026-08-20T12:00:00.000Z",
        model: "gpt-5.5",
        totalTokens: 100,
        inputTokens: 100,
        outputTokens: 0,
      }],
      quotaObservations: [{
        timestamp: "2026-08-20T12:00:00.000Z",
        usedPercent: 37,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt: Date.parse("2026-08-27T12:00:00.000Z") / 1_000,
      }],
    });

    const modes = [
      {
        sourceStatus: "explicit-snapshot",
        options: {
          ...parseArgs(["week", "--no-refresh"]),
          input: snapshotPath,
          inputExplicit: true,
        },
      },
      {
        sourceStatus: "unchecked-cache",
        options: {
          ...parseArgs(["week", "--no-refresh"]),
          input: snapshotPath,
          inputExplicit: false,
        },
      },
    ];
    for (const mode of modes) {
      const loaded = await loadSnapshot(mode.options);
      assert.equal(loaded.sourceStatus, mode.sourceStatus);
      assert.equal(loaded.snapshot.events[0].totalTokens, 100);
      assert.equal(loaded.snapshot.quotaObservations.length, 1);
      assert.deepEqual(weeklyQuotaObservations(loaded.snapshot), []);
      assert.equal(
        quotaCycleSummary(loaded.snapshot, loaded.snapshot.events).available,
        false,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects legacy snapshots before repricing aliases", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-legacy-rate-card-");
  const snapshotPath = resolve(root, "snapshot.json");
  try {
    await writeFile(snapshotPath, JSON.stringify({
      schemaVersion: 2,
      generatedAt: "2026-08-20T12:00:00.000Z",
      events: [{
        timestamp: "2026-08-20T12:00:00.000Z",
        model: "gpt-5.5",
        serviceTier: "fast",
        totalTokens: 1_000,
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 0,
      }],
      threads: [],
    }));

    await assert.rejects(
      () => run(parseArgs([
        "cost",
        "1d",
        "--input",
        snapshotPath,
        "--no-refresh",
        "--basis",
        "codex-credits",
      ])),
      /Snapshot uses an unsupported schema: snapshot\.json\. Rebuild it with --refresh\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh and source failures retain context without absolute paths", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-source-privacy-");
  const missingCodexHome = resolve(root, "missing-codex-home");
  const staleSnapshotPath = resolve(root, "stale-snapshot.json");
  const codexHome = resolve(root, "codex-home");
  try {
    await assert.rejects(
      () => run(parseArgs([
        "week",
        "--refresh",
        "--codex-home",
        missingCodexHome,
      ])),
      (error) => {
        assert.match(
          error.message,
          /Codex data directory not found: missing-codex-home/,
        );
        assert.ok(!error.message.includes(root));
        return true;
      },
    );

    await mkdir(codexHome);
    await writeFile(resolve(codexHome, "sessions"), "not a directory");
    await writeFile(
      staleSnapshotPath,
      JSON.stringify({ schemaVersion: 3, events: [] }),
    );
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    await utimes(staleSnapshotPath, staleTime, staleTime);

    const options = parseArgs(["week"]);
    options.input = staleSnapshotPath;
    options.inputExplicit = false;
    options.codexHome = codexHome;
    await assert.rejects(
      () => run(options),
      (error) => {
        assert.match(error.message, /Could not inspect local Codex source/);
        assert.match(error.message, /ENOTDIR|not a directory|scandir/);
        assert.ok(!error.message.includes(root));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("1d renders deterministic project totals from a rolling 24-hour fixture", async () => {
  const nowMs = Date.parse("2026-08-20T00:00:00.000Z");
  const output = await run(parseArgs([
    "1d",
    "--input",
    ROLLING_24H_FIXTURE,
    "--no-refresh",
    "--static",
    "--plain",
    "--ascii",
    "--tz",
    "Pacific/Honolulu",
    "--width",
    "120",
  ]), { nowMs });

  assert.match(output, /LAST 24 HOURS/);
  assert.match(output, /24 HOURS/);
  assert.match(output, /TOKENS BY PROJECT/);
  assert.match(output, /Alpha.*1\.20K/);
  assert.match(output, /Beta.*800/);
  assert.match(output, /2\.00K TOKENS/);
  assert.match(output, /SNAPSHOT · fresh · 15m old/);
  assert.doesNotMatch(output, /Gamma|Delta|5\.80K|10\.20K/);
  assert.ok(!output.includes(ROLLING_24H_FIXTURE));
});

test("static freshness uses the wall clock after snapshot loading", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-post-load-time-");
  const snapshotPath = resolve(root, "snapshot.json");
  const beforeLoadMs = Date.parse("2026-08-20T00:00:00.000Z");
  const afterLoadMs = beforeLoadMs + 1_000;
  try {
    await writeFile(snapshotPath, JSON.stringify({
      schemaVersion: 3,
      generatedAt: new Date(afterLoadMs).toISOString(),
      events: [{
        project: "alpha",
        threadId: "alpha-1",
        model: "gpt-5.5",
        timestamp: "2026-08-19T12:00:00.000Z",
        totalTokens: 1,
        outputTokens: 0,
        toolCalls: 0,
        rateCardCredits: 1,
      }],
      threads: [{ id: "alpha-1", project: "alpha" }],
    }));

    const originalDateNow = Date.now;
    let nowCalls = 0;
    Date.now = () => {
      nowCalls += 1;
      return nowCalls === 1 ? beforeLoadMs : afterLoadMs;
    };
    try {
      const output = await run(parseArgs([
        "1d",
        "--input",
        snapshotPath,
        "--no-refresh",
        "--static",
        "--plain",
        "--ascii",
        "--tz",
        "UTC",
      ]));

      assert.match(output, /SNAPSHOT · fresh · now/);
      assert.equal(nowCalls, 2);
    } finally {
      Date.now = originalDateNow;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseArgs supports day and week trend windows", () => {
  const positional = parseArgs(["trend", "14d", "--static"]);
  assert.equal(positional.view, "trend");
  assert.equal(positional.range, "trend");
  assert.equal(positional.trendDays, 14);
  assert.equal(positional.date, "today");

  const option = parseArgs(["trend", "--period", "30d", "--date", "2026-08-15"]);
  assert.equal(option.trendDays, 30);
  assert.equal(option.date, "2026-08-15");
  assert.equal(parseArgs(["trend", "2w"]).trendDays, 14);
  assert.equal(parseArgs(["trend", "10d"]).trendDays, 10);
  assert.throws(
    () => parseArgs(["trend", "0d"]),
    /Duration must be between 1d and/,
  );
  assert.throws(
    () => parseArgs(["trend", "7d", "--period", "14d"]),
    /only be specified once/,
  );
  assert.throws(
    () => parseArgs(["week", "--period", "14d"]),
    /only available for the trend view/,
  );

  const image = parseArgs([
    "trend",
    "7d",
    "--image",
    "--image-output",
    "artifacts/trend.png",
    "--image-width",
    "1400",
  ]);
  assert.equal(image.image, true);
  assert.equal(image.imageOutput, resolve("artifacts/trend.png"));
  assert.equal(image.imageWidth, 1400);
  assert.throws(
    () => parseArgs(["day", "2026-08-15", "--image"]),
    /only available for the trend view/,
  );
  assert.throws(
    () => parseArgs(["trend", "7d", "--image-output", "trend.svg"]),
    /must end in .png/,
  );
});

test("parseArgs supports static output mode", () => {
  const options = parseArgs(["week", "--static"]);
  assert.equal(options.static, true);
});

test("parseArgs supports opting out of the automatic JSONL freshness check", () => {
  const options = parseArgs(["week", "--no-refresh"]);
  assert.equal(options.autoRefresh, false);
  assert.throws(
    () => parseArgs(["week", "--refresh", "--no-refresh"]),
    /cannot be combined/,
  );
});

test("parseArgs rejects refresh requests that target an explicit snapshot", () => {
  assert.throws(
    () => parseArgs([
      "day",
      "2026-08-18",
      "--input",
      "custom-snapshot.json",
      "--refresh",
    ]),
    /--refresh cannot be combined with --input/,
  );
});

test("source watermarks detect changes independent of cache mtime", () => {
  const original = {
    version: SOURCE_WATERMARK_VERSION,
    fingerprint: "original",
    sourceCount: 1,
    latestModifiedAt: 200,
  };
  assert.equal(sourceWatermarksEqual(original, original), true);
  assert.equal(
    sourceWatermarksEqual(original, {
      ...original,
      fingerprint: "changed",
      latestModifiedAt: 100,
    }),
    false,
  );
  assert.equal(
    sourceWatermarksEqual(original, {
      ...original,
      sourceCount: 2,
    }),
    false,
  );
  assert.equal(sourceWatermarksEqual(original, null), false);
});

test("refresh applies the normalized cutoff and records its collection scope", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-since-refresh-");
  const codexHome = resolve(root, "codex-home");
  const sessionDirectory = resolve(codexHome, "sessions", "2026", "08", "20");
  const outputPath = resolve(root, "snapshot.json");
  const threadId = "12121212-1212-4121-8121-121212121212";
  const tokenCount = (timestamp, turnId, total, last) => [
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
      payload: { turn_id: turnId, model: "gpt-5.6-luna", effort: "medium" },
    },
    {
      timestamp: new Date(Date.parse(timestamp) + 1_000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: total - 10,
            cached_input_tokens: 10,
            output_tokens: 10,
            total_tokens: total,
          },
          last_token_usage: {
            input_tokens: last - 10,
            cached_input_tokens: 10,
            output_tokens: 10,
            total_tokens: last,
          },
          model_context_window: 128_000,
        },
      },
    },
  ];
  try {
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      resolve(sessionDirectory, `rollout-${threadId}.jsonl`),
      [...tokenCount("2026-08-20T10:00:00.000Z", "turn-old", 100, 100),
        ...tokenCount("2026-08-20T18:00:00.000Z", "turn-new", 200, 100)]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );

    const options = parseArgs([
      "day",
      "2026-08-20",
      "--refresh",
      "--since",
      "2026-08-20T12:00:00-05:00",
      "--static",
      "--plain",
      "--ascii",
      "--tz",
      "UTC",
    ]);
    options.input = outputPath;
    options.codexHome = codexHome;
    const output = await run(options);
    const snapshot = JSON.parse(await readFile(outputPath, "utf8"));

    assert.match(output, /100 TOKENS/);
    assert.equal(snapshot.coverage.observedModelCalls, 1);
    assert.deepEqual(snapshot.provenance.collection, {
      since: "2026-08-20T17:00:00.000Z",
      includeArchived: true,
    });

    const unfilteredOptions = parseArgs([
      "day",
      "2026-08-20",
      "--static",
      "--plain",
      "--ascii",
      "--tz",
      "UTC",
    ]);
    unfilteredOptions.input = outputPath;
    unfilteredOptions.codexHome = codexHome;
    const unfilteredOutput = await run(unfilteredOptions);
    const rebuilt = JSON.parse(await readFile(outputPath, "utf8"));
    assert.match(unfilteredOutput, /200 TOKENS/);
    assert.equal(rebuilt.coverage.observedModelCalls, 2);
    assert.deepEqual(rebuilt.provenance.collection, {
      since: null,
      includeArchived: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unfiltered reads reject a cache with a filtered collection scope", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-scope-cache-");
  const snapshotPath = resolve(root, "filtered-snapshot.json");
  try {
    await writePrivateSnapshot(snapshotPath, {
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      provenance: {
        collection: {
          since: "2026-08-20T12:00:00.000Z",
          includeArchived: true,
        },
      },
      events: [{
        timestamp: "2026-08-20T13:00:00.000Z",
        project: "filtered",
        threadId: "filtered-1",
        model: "gpt-5.6-luna",
        totalTokens: 100,
        inputTokens: 90,
        cachedInputTokens: 10,
        outputTokens: 10,
        rateCardCredits: 1,
      }],
      threads: [{ id: "filtered-1", project: "filtered" }],
    });

    await assert.rejects(
      () => run(parseArgs([
        "day",
        "2026-08-20",
        "--input",
        snapshotPath,
        "--no-refresh",
        "--static",
        "--plain",
        "--ascii",
        "--tz",
        "UTC",
      ])),
      (error) => {
        assert.match(error.message, /Snapshot collection scope does not match the requested filters/);
        assert.match(error.message, /For --input, supply matching --since\/--no-archived filters/);
        assert.match(error.message, /--refresh cannot be combined with --input/);
        return true;
      },
    );
    await assert.rejects(
      () => run(parseArgs([
        "day",
        "2026-08-20",
        "--input",
        snapshotPath,
        "--no-refresh",
        "--since",
        "2026-08-21T00:00:00.000Z",
        "--static",
        "--plain",
        "--ascii",
        "--tz",
        "UTC",
      ])),
      /Snapshot collection scope does not match the requested filters/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic loads check source watermarks regardless of cache age", () => {
  const now = 1_000_000;
  assert.equal(snapshotCacheIsFresh(now, now), true);
  assert.equal(snapshotCacheIsFresh(now - 60 * 60 * 1000 + 1, now), true);
  assert.equal(snapshotCacheIsFresh(now - 60 * 60 * 1000, now), false);
  assert.equal(snapshotCacheIsFresh(now - 60 * 60 * 1000 - 1, now), false);
  assert.equal(snapshotCacheIsFresh(now + 1, now), false);
  assert.equal(
    shouldCheckSourceFreshness({ view: "terminal" }, now, now),
    true,
  );
  assert.equal(
    shouldCheckSourceFreshness({ view: "trend", image: true }, now, now),
    true,
  );
  assert.equal(
    shouldCheckSourceFreshness(
      { view: "terminal", autoRefresh: false },
    ),
    false,
  );
});

test("automatic refresh ignores a newer cache mtime when the source watermark changes", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-watermark-load-");
  const codexHome = resolve(root, "codex-home");
  const sourceDirectory = resolve(codexHome, "sessions", "2026", "08");
  const sourceFile = resolve(
    sourceDirectory,
    "rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
  );
  const snapshotPath = resolve(root, "snapshot.json.gz");
  try {
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      sourceFile,
      serializeRows(sourceRolloutRows(
        100,
        "turn-1",
        "2026-08-23T10:00:00.000Z",
      )),
    );
    const initial = await collectUsage({
      output: snapshotPath,
      codexHome,
      includeArchived: true,
      since: null,
    });

    await appendFile(
      sourceFile,
      serializeRows(sourceRolloutRows(
        200,
        "turn-2",
        "2026-08-23T10:00:01.000Z",
      )),
    );
    const changedSource = await sourceInventory(codexHome, true);
    await writePrivateSnapshot(snapshotPath, initial);
    const newerCacheTime = new Date(Date.now() + 1_000);
    await utimes(snapshotPath, newerCacheTime, newerCacheTime);
    assert.ok(
      (await stat(snapshotPath)).mtimeMs > changedSource.watermark.latestModifiedAt,
    );
    assert.equal(
      sourceWatermarksEqual(initial.sourceWatermark, changedSource.watermark),
      false,
    );

    const options = parseArgs([
      "day",
      "2026-08-23",
      "--static",
      "--plain",
      "--ascii",
      "--tz",
      "UTC",
    ]);
    options.codexHome = codexHome;
    options.input = snapshotPath;
    options.inputExplicit = false;
    const output = await run(options);
    const refreshed = await readPrivateSnapshot(snapshotPath);

    assert.match(output, /300 TOKENS/);
    assert.equal(refreshed.coverage.observedTokens, 300);
    assert.ok(sourceWatermarksEqual(
      refreshed.sourceWatermark,
      changedSource.watermark,
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic cache validation rejects a different Codex home", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-home-cache-");
  const codexHomeA = resolve(root, "codex-home-a");
  const codexHomeB = resolve(root, "codex-home-b");
  const snapshotPath = resolve(root, "snapshot.json.gz");
  try {
    await mkdir(codexHomeA, { recursive: true });
    await mkdir(codexHomeB, { recursive: true });
    const snapshot = await collectUsage({
      output: snapshotPath,
      codexHome: codexHomeA,
      includeArchived: true,
      since: null,
    });
    await writePrivateSnapshot(snapshotPath, snapshot);

    const options = parseArgs([
      "day",
      "2026-08-23",
      "--static",
      "--plain",
      "--ascii",
      "--tz",
      "UTC",
    ]);
    options.codexHome = codexHomeB;
    options.input = snapshotPath;
    options.inputExplicit = false;

    await assert.rejects(
      () => loadSnapshot(options),
      (error) =>
        error?.code === "ERR_DURABLE_LEDGER_CODEX_HOME" &&
        /different Codex data directory/i.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic cache validation rebuilds a missing or behind ledger", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-revision-cache-");
  const codexHome = resolve(root, "codex-home");
  const snapshotPath = resolve(root, "snapshot.json.gz");
  let ledgerPath;
  try {
    await mkdir(codexHome, { recursive: true });
    await collectUsage({
      output: snapshotPath,
      codexHome,
      includeArchived: true,
      since: null,
    });
    const cached = await collectUsage({
      output: snapshotPath,
      codexHome,
      includeArchived: true,
      since: null,
    });
    ledgerPath = resolveDurableLedgerPath({ codexHome, output: snapshotPath });
    await writePrivateSnapshot(snapshotPath, cached);
    const database = new DatabaseSync(ledgerPath);
    database.prepare(
      "UPDATE ledger_meta SET value = '0' WHERE key = 'revision'",
    ).run();
    database.close();

    const options = parseArgs([
      "day",
      "2026-08-23",
      "--static",
      "--plain",
      "--ascii",
      "--tz",
      "UTC",
    ]);
    options.codexHome = codexHome;
    options.input = snapshotPath;
    options.inputExplicit = false;

    const behind = await loadSnapshot(options);
    assert.equal(behind.sourceStatus, "verified-current");
    assert.equal(behind.snapshot.metadata.durableLedger.revision, 1);
    assert.equal(await readDurableLedgerRevision(ledgerPath), 1);

    await rm(ledgerPath);
    const missing = await loadSnapshot(options);
    assert.equal(missing.sourceStatus, "verified-current");
    assert.equal(missing.snapshot.metadata.durableLedger.revision, 1);
    assert.equal(await readDurableLedgerRevision(ledgerPath), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("matching cache refreshes when either quota contract is missing", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-contract-cache-");
  const codexHome = resolve(root, "codex-home");
  const sourceDirectory = resolve(codexHome, "sessions", "2026", "08");
  const sourceFile = resolve(
    sourceDirectory,
    "rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
  );
  const snapshotPath = resolve(root, "snapshot.json.gz");
  const ledgerPath = resolveDurableLedgerPath({ codexHome, output: snapshotPath });
  let database;
  try {
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      sourceFile,
      serializeRows(sourceRolloutRowsWithQuota(
        100,
        "turn-1",
        "2026-08-23T10:00:00.000Z",
        37,
      )),
    );
    const initial = await collectUsage({
      output: snapshotPath,
      codexHome,
      includeArchived: true,
      since: null,
    });
    await writePrivateSnapshot(snapshotPath, initial);
    assert.equal(initial.metadata.durableLedger.revision, 1);
    assert.equal(initial.quotaObservations.length, 1);

    database = new DatabaseSync(ledgerPath);
    database.prepare(
      "DELETE FROM ledger_meta WHERE key = 'quota_identity_contract'",
    ).run();
    database.close();
    database = null;

    const options = parseArgs([
      "day",
      "2026-08-23",
      "--static",
      "--plain",
      "--ascii",
      "--tz",
      "UTC",
    ]);
    options.codexHome = codexHome;
    options.input = snapshotPath;
    options.inputExplicit = false;

    const ledgerRefreshed = await loadSnapshot(options);
    assert.equal(ledgerRefreshed.sourceStatus, "verified-current");
    assert.equal(ledgerRefreshed.snapshot.metadata.durableLedger.revision, 2);
    assert.equal(ledgerRefreshed.snapshot.quotaObservations.length, 1);

    const markerlessCache = {
      ...ledgerRefreshed.snapshot,
      metadata: {
        ...ledgerRefreshed.snapshot.metadata,
        durableLedger: {
          ...ledgerRefreshed.snapshot.metadata.durableLedger,
        },
      },
    };
    delete markerlessCache.metadata.durableLedger.quotaIdentityContract;
    await writePrivateSnapshot(snapshotPath, markerlessCache);
    const cacheRefreshed = await loadSnapshot(options);
    assert.equal(cacheRefreshed.sourceStatus, "verified-current");
    assert.equal(cacheRefreshed.snapshot.metadata.durableLedger.revision, 3);
    assert.equal(
      cacheRefreshed.snapshot.metadata.durableLedger.quotaIdentityContract,
      QUOTA_IDENTITY_CONTRACT_VERSION,
    );
    assert.equal(cacheRefreshed.snapshot.quotaObservations.length, 1);

    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare(`
      SELECT value
        FROM ledger_meta
       WHERE key = 'quota_identity_contract'
    `).get().value, QUOTA_IDENTITY_CONTRACT_VERSION);
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic cache validation propagates unscoped ledger migration failures", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-migration-cache-");
  const codexHome = resolve(root, "codex-home");
  const sourceDirectory = resolve(codexHome, "sessions", "2026", "08");
  const sourceFile = resolve(
    sourceDirectory,
    "rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
  );
  const snapshotPath = resolve(root, "snapshot.json.gz");
  const ledgerPath = resolveDurableLedgerPath({ codexHome, output: snapshotPath });
  let database;
  try {
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      sourceFile,
      serializeRows(sourceRolloutRows(
        100,
        "turn-1",
        "2026-08-23T10:00:00.000Z",
      )),
    );
    const initial = await collectUsage({
      output: snapshotPath,
      codexHome,
      includeArchived: true,
      since: null,
    });
    await writePrivateSnapshot(snapshotPath, initial);
    assert.equal(initial.metadata.durableLedger.revision, 1);

    database = new DatabaseSync(ledgerPath);
    database.exec(`
      DROP TABLE migration_runs;
      CREATE TABLE migration_runs (
        migration_key TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL,
        source_label TEXT NOT NULL,
        generated_at TEXT,
        migrated_at TEXT NOT NULL,
        usage_rows INTEGER NOT NULL,
        quota_rows INTEGER NOT NULL
      ) WITHOUT ROWID;
      INSERT INTO migration_runs (
        migration_key, source_fingerprint, source_label, generated_at,
        migrated_at, usage_rows, quota_rows
      ) VALUES (
        'snapshot-v3-default', 'legacy-fingerprint', 'legacy-snapshot',
        '2026-08-20T12:00:00.000Z', '2026-08-20T12:00:00.000Z', 1, 0
      );
      PRAGMA user_version = 1;
    `);
    database.close();
    database = null;
    const ledgerBefore = await readFile(ledgerPath);
    const snapshotBefore = await readFile(snapshotPath);

    const options = parseArgs([
      "day",
      "2026-08-23",
      "--static",
      "--plain",
      "--ascii",
      "--tz",
      "UTC",
    ]);
    options.codexHome = codexHome;
    options.input = snapshotPath;
    options.inputExplicit = false;

    await assert.rejects(
      () => loadSnapshot(options),
      (error) => {
        assert.equal(error?.code, "ERR_DURABLE_LEDGER_MIGRATION_SCOPE");
        assert.match(error.message, /ledger was left untouched/i);
        return true;
      },
    );
    assert.deepEqual(await readFile(snapshotPath), snapshotBefore);
    assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
    database = new DatabaseSync(ledgerPath, { readOnly: true });
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM migration_runs").get().count,
      1,
    );
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stale refresh fallback only accepts bounded transient failures", () => {
  for (const code of [
    "ERR_SNAPSHOT_SIZE_LIMIT",
    "ERR_SOURCE_CHANGED_DURING_COLLECTION",
    "SQLITE_BUSY",
    "SQLITE_LOCKED",
  ]) {
    assert.equal(
      refreshFailureAllowsStaleFallback(Object.assign(new Error(code), { code })),
      true,
      code,
    );
  }

  const sqliteBusy = Object.assign(new Error("database is busy"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
    errstr: "SQLITE_BUSY",
  });
  const wrappedBusy = Object.assign(
    new Error("Could not refresh local snapshot", { cause: sqliteBusy }),
    { code: "ERR_SQLITE_ERROR" },
  );
  assert.equal(refreshFailureAllowsStaleFallback(wrappedBusy), true);

  for (const code of [
    "ERR_DURABLE_LEDGER_CODEX_HOME",
    "ERR_DURABLE_LEDGER_LEGACY_SNAPSHOT",
    "ERR_DURABLE_LEDGER_MIGRATION_SCOPE",
    "ERR_DURABLE_LEDGER_SCHEMA",
    "ERR_SNAPSHOT_NOT_REGULAR",
    "ERR_BUFFER_TOO_LARGE",
    "SQLITE_CORRUPT",
    "SQLITE_NOTADB",
    "EIO",
  ]) {
    assert.equal(
      refreshFailureAllowsStaleFallback(Object.assign(new Error(code), { code })),
      false,
      code,
    );
  }

  for (const [errcode, errstr] of [
    [11, "SQLITE_CORRUPT"],
    [26, "SQLITE_NOTADB"],
  ]) {
    const sqliteCorruption = Object.assign(new Error(errstr), {
      code: "ERR_SQLITE_ERROR",
      errcode,
      errstr,
    });
    const wrappedCorruption = Object.assign(
      new Error("Could not refresh local snapshot", {
        cause: sqliteCorruption,
      }),
      { code: "ERR_SQLITE_ERROR" },
    );
    assert.equal(
      refreshFailureAllowsStaleFallback(wrappedCorruption),
      false,
      errstr,
    );
  }
});

test("snapshot size fallback stays stale and does not advance ledger revisions", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-size-fallback-");
  const codexHome = resolve(root, "codex-home");
  const sourceDirectory = resolve(codexHome, "sessions", "2026", "08");
  const sourceFile = resolve(
    sourceDirectory,
    "rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
  );
  const snapshotPath = resolve(root, "snapshot.json.gz");
  const ledgerPath = resolveDurableLedgerPath({ codexHome, output: snapshotPath });
  try {
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      sourceFile,
      serializeRows(sourceRolloutRows(
        100,
        "turn-1",
        "2026-08-23T10:00:00.000Z",
      )),
    );
    const initial = await collectUsage({
      output: snapshotPath,
      codexHome,
      includeArchived: true,
      since: null,
    });
    await writePrivateSnapshot(snapshotPath, initial);
    assert.equal(initial.metadata.durableLedger.revision, 1);
    assert.equal(await readDurableLedgerRevision(ledgerPath), 1);

    await appendFile(
      sourceFile,
      serializeRows(sourceRolloutRows(
        200,
        "turn-2",
        "2026-08-23T10:01:00.000Z",
      )),
    );
    const options = parseArgs([
      "day",
      "2026-08-23",
      "--static",
      "--plain",
      "--ascii",
      "--tz",
      "UTC",
    ]);
    options.codexHome = codexHome;
    options.input = snapshotPath;
    options.inputExplicit = false;
    options.snapshotWriteOptions = { maxBytes: 1, targetBytes: 1 };

    const firstFallback = await loadSnapshot(options);
    const secondFallback = await loadSnapshot(options);
    const stored = await readPrivateSnapshot(snapshotPath);

    for (const fallback of [firstFallback, secondFallback]) {
      assert.equal(fallback.sourceStatus, "stale-fallback");
      assert.equal(fallback.snapshot.coverage.observedTokens, 100);
      assert.equal(fallback.snapshot.metadata.durableLedger.revision, 1);
    }
    assert.equal(await readDurableLedgerRevision(ledgerPath), 1);
    assert.equal(stored.coverage.observedTokens, 100);
    assert.equal(stored.metadata.durableLedger.revision, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("old quota contracts make every stale-fallback path meterless", async () => {
  const cases = [
    {
      name: "old-ledger-auto",
      ledgerContract: "codex-limit-id-v1",
      snapshotContract: QUOTA_IDENTITY_CONTRACT_VERSION,
      refresh: false,
    },
    {
      name: "old-cache-auto",
      ledgerContract: QUOTA_IDENTITY_CONTRACT_VERSION,
      snapshotContract: null,
      refresh: false,
    },
    {
      name: "old-ledger-explicit-refresh",
      ledgerContract: "codex-limit-id-v1",
      snapshotContract: QUOTA_IDENTITY_CONTRACT_VERSION,
      refresh: true,
    },
  ];
  for (const entry of cases) {
    const root = await createPrivateFixtureRoot(
      `token-ledger-contract-fallback-${entry.name}-`,
    );
    const codexHome = resolve(root, "codex-home");
    const sourceDirectory = resolve(codexHome, "sessions", "2026", "08");
    const sourceFile = resolve(
      sourceDirectory,
      "rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
    );
    const snapshotPath = resolve(root, "snapshot.json.gz");
    const ledgerPath = resolveDurableLedgerPath({ codexHome, output: snapshotPath });
    let database;
    try {
      await mkdir(sourceDirectory, { recursive: true });
      await writeFile(
        sourceFile,
        serializeRows(sourceRolloutRowsWithQuota(
          100,
          "turn-1",
          "2026-08-23T10:00:00.000Z",
          37,
        )),
      );
      const initial = await collectUsage({
        output: snapshotPath,
        codexHome,
        includeArchived: true,
        since: null,
      });
      const cached = {
        ...initial,
        metadata: {
          ...initial.metadata,
          durableLedger: { ...initial.metadata.durableLedger },
        },
      };
      if (entry.snapshotContract === null) {
        delete cached.metadata.durableLedger.quotaIdentityContract;
      } else {
        cached.metadata.durableLedger.quotaIdentityContract =
          entry.snapshotContract;
      }
      await writePrivateSnapshot(snapshotPath, cached);

      database = new DatabaseSync(ledgerPath);
      database.prepare(`
        UPDATE ledger_meta
           SET value = ?
         WHERE key = 'quota_identity_contract'
      `).run(entry.ledgerContract);
      database.close();
      database = null;

      const loadOptions = parseArgs([
        "day",
        "2026-08-23",
        "--static",
        "--plain",
        "--ascii",
        "--tz",
        "UTC",
      ]);
      loadOptions.codexHome = codexHome;
      loadOptions.input = snapshotPath;
      loadOptions.inputExplicit = false;
      loadOptions.refresh = entry.refresh;
      loadOptions.snapshotWriteOptions = { maxBytes: 1, targetBytes: 1 };

      const fallback = await loadSnapshot(loadOptions);
      assert.equal(fallback.sourceStatus, "stale-fallback", entry.name);
      assert.equal(fallback.snapshot.coverage.observedTokens, 100, entry.name);
      assert.equal(fallback.snapshot.quotaObservations.length, 0, entry.name);
      assert.equal(
        fallback.snapshot.coverage.quotaMeterUnavailableReason,
        "quota-contract-unverified",
        entry.name,
      );
      assert.deepEqual(
        weeklyQuotaObservations(fallback.snapshot),
        [],
        entry.name,
      );

      database = new DatabaseSync(ledgerPath, { readOnly: true });
      assert.equal(database.prepare(`
        SELECT value
          FROM ledger_meta
         WHERE key = 'quota_identity_contract'
      `).get().value, entry.ledgerContract, entry.name);
      assert.equal(database.prepare(`
        SELECT value
          FROM ledger_meta
         WHERE key = 'revision'
      `).get().value, "1", entry.name);
    } finally {
      database?.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("snapshot size fallback requires exact scope and Codex-home provenance", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-fallback-gate-");
  const requestedCodexHome = resolve(root, "requested-codex-home");
  const otherCodexHome = resolve(root, "other-codex-home");
  const generatedAt = "2026-08-23T10:00:00.000Z";
  try {
    await mkdir(requestedCodexHome, { recursive: true });
    await mkdir(otherCodexHome, { recursive: true });

    const assertRejectedFallback = async (name, previous) => {
      const snapshotPath = resolve(root, `${name}.json.gz`);
      await writePrivateSnapshot(snapshotPath, previous);
      const options = parseArgs([
        "day",
        "2026-08-23",
        "--static",
        "--plain",
        "--ascii",
        "--tz",
        "UTC",
      ]);
      options.codexHome = requestedCodexHome;
      options.input = snapshotPath;
      options.inputExplicit = false;
      options.snapshotWriteOptions = { maxBytes: 1, targetBytes: 1 };

      await assert.rejects(
        () => loadSnapshot(options),
        (error) => {
          assert.equal(error?.code, "ERR_SNAPSHOT_SIZE_LIMIT");
          return true;
        },
      );
      assert.equal(
        (await readPrivateSnapshot(snapshotPath)).metadata.durableLedger
          .codexHomeFingerprint,
        previous.metadata.durableLedger.codexHomeFingerprint,
      );
    };

    const scopedSnapshot = {
      schemaVersion: 3,
      generatedAt,
      provenance: {
        collection: { since: null, includeArchived: true },
      },
      metadata: {
        durableLedger: {
          codexHomeFingerprint: codexHomeFingerprint(otherCodexHome),
          revision: 0,
        },
      },
      events: [],
    };
    await assertRejectedFallback("different-home", scopedSnapshot);
    await assertRejectedFallback("unknown-scope", {
      ...scopedSnapshot,
      provenance: undefined,
      metadata: {
        durableLedger: {
          codexHomeFingerprint: codexHomeFingerprint(requestedCodexHome),
          revision: 0,
        },
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exhausted source retries never publish an uncommitted snapshot", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-staged-retry-");
  const codexHome = resolve(root, "codex-home");
  const sourceDirectory = resolve(codexHome, "sessions", "2026", "08");
  const sourceFile = resolve(
    sourceDirectory,
    "rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
  );
  const snapshotPath = resolve(root, "snapshot.json.gz");
  const ledgerPath = resolveDurableLedgerPath({ codexHome, output: snapshotPath });
  let mutation = 0;
  try {
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      sourceFile,
      serializeRows(sourceRolloutRows(
        100,
        "turn-initial",
        "2026-08-23T10:00:00.000Z",
      )),
    );
    const initial = await collectUsage({
      output: snapshotPath,
      codexHome,
      includeArchived: true,
      since: null,
    });
    await writePrivateSnapshot(snapshotPath, initial);
    await appendFile(
      sourceFile,
      serializeRows(sourceRolloutRows(
        200,
        "turn-pending",
        "2026-08-23T10:01:00.000Z",
      )),
    );

    await assert.rejects(
      () => collectUsage({
        output: snapshotPath,
        codexHome,
        includeArchived: true,
        since: null,
        stageSnapshot: (candidate) =>
          stagePrivateSnapshot(snapshotPath, candidate),
        faultInjector: async ({ point }) => {
          if (point !== "after-validation") return;
          mutation += 1;
          const rows = Array.from({ length: mutation + 1 }, (_, index) =>
            sourceRolloutRows(
              300 + mutation * 100 + index,
              `turn-mutation-${mutation}-${index}`,
              new Date(
                Date.parse("2026-08-23T11:00:00.000Z") +
                  (mutation * 10 + index) * 60_000,
              ).toISOString(),
            )
          ).flat();
          await writeFile(sourceFile, serializeRows(rows));
        },
      }),
      (error) => error?.code === "ERR_SOURCE_CHANGED_DURING_COLLECTION",
    );

    const stored = await readPrivateSnapshot(snapshotPath);
    assert.equal(mutation, 3);
    assert.equal(stored.coverage.observedTokens, 100);
    assert.equal(stored.metadata.durableLedger.revision, 1);
    assert.equal(await readDurableLedgerRevision(ledgerPath), 1);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot freshness labels the one-hour cache age without exposing paths", () => {
  const now = Date.parse("2026-08-20T00:00:00.000Z");
  assert.deepEqual(
    snapshotFreshness({ generatedAt: "2026-08-19T23:45:00.000Z" }, now),
    { status: "fresh", ageLabel: "15m old" },
  );
  assert.deepEqual(
    snapshotFreshness({ generatedAt: "2026-08-19T23:00:00.000Z" }, now),
    { status: "stale", ageLabel: "1h old" },
  );
  assert.deepEqual(snapshotFreshness({}, now), {
    status: "unknown",
    ageLabel: "age unknown",
  });
  assert.deepEqual(
    snapshotFreshness({ generatedAt: "not-a-date" }, now),
    { status: "unknown", ageLabel: "age unknown" },
  );
  for (const generatedAt of [0, {}, { toString: null, valueOf: null }]) {
    assert.deepEqual(snapshotFreshness({ generatedAt }, now), {
      status: "unknown",
      ageLabel: "age unknown",
    });
  }
});

test("source provenance labels cover every cache trust state", () => {
  assert.deepEqual(SOURCE_STATUSES, [
    "verified-current",
    "explicit-snapshot",
    "unchecked-cache",
    "stale-fallback",
  ]);
  assert.equal(sourceStatusLabel("verified-current"), "VERIFIED CURRENT");
  assert.equal(sourceStatusLine("stale-fallback"), "PROVENANCE · STALE FALLBACK");
  assert.equal(sourceStatusLine("unchecked-cache"), "PROVENANCE · UNCHECKED CACHE");
  assert.equal(sourceStatusLine("explicit-snapshot"), "PROVENANCE · EXPLICIT SNAPSHOT");
  assert.equal(
    snapshotFreshnessDetail({ status: "fresh", ageLabel: "12m old" }),
    "fresh · 12m old",
  );
  assert.throws(() => sourceStatusLabel("invented"), /Unknown report source status/);
});

test("a refreshed append-only cutoff is not verified current", () => {
  const equal = (left, right) => left.fingerprint === right.fingerprint;
  assert.equal(
    refreshedSnapshotSourceStatus(
      { fingerprint: "accepted-byte-cutoff" },
      { fingerprint: "later-append" },
      equal,
    ),
    "unchecked-cache",
  );
  assert.equal(
    refreshedSnapshotSourceStatus(
      { fingerprint: "same" },
      { fingerprint: "same" },
      equal,
    ),
    "verified-current",
  );
});

test("interactive controls stay aligned with rendered and documented help", async () => {
  for (const input of INTERACTIVE_KEY_INPUTS.up) assert.equal(actionFor(input), "up");
  for (const input of INTERACTIVE_KEY_INPUTS.down) assert.equal(actionFor(input), "down");
  for (const input of INTERACTIVE_KEY_INPUTS.quit) assert.equal(actionFor(input), "quit");
  for (const input of ["\r", "\n", "d", "w", "m"]) {
    assert.equal(actionFor(input), null);
  }

  const snapshot = {
    events: [],
    threads: [{ id: "alpha-1", project: "alpha" }],
  };
  const events = [{
    project: "alpha",
    threadId: "alpha-1",
    model: "gpt-5.5",
    totalTokens: 1,
    outputTokens: 0,
    toolCalls: 0,
    rateCardCredits: 1,
  }];
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  const bounds = dayBounds("2026-08-01", "Pacific/Honolulu");
  const footerOutput = renderTerminal({
    options: { plain: true, ascii: true, width: 80 },
    snapshot,
    bounds,
    events,
    rows,
    allRows: rows,
  });
  assert.ok(footerOutput.includes(INTERACTIVE_FOOTER.ascii));
  assert.doesNotMatch(footerOutput, /inspect|range/);

  const fullscreenOutput = renderFullscreen({
    options: { plain: true, ascii: true, forceColor: false },
    snapshot,
    bounds,
    events,
    rows,
    allRows: rows,
    width: 120,
    height: 32,
  });
  assert.ok(fullscreenOutput.includes(INTERACTIVE_HELP));
  assert.doesNotMatch(fullscreenOutput, /inspect|range/);

  const readme = await readFile(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  );
  assert.match(readme, /`q`, `Q`, `Esc`, or\s+`Ctrl-C` exits\./);
  assert.match(readme, /Enter does not inspect a project/);
  assert.match(readme, /`d` \/ `w` \/ `m` do not\s+change the range/);
});

test("terminal renderer produces the dashboard layout and scaled bars", () => {
  const snapshot = {
    events: [],
    threads: [
      { id: "alpha-1", project: "alpha" },
      { id: "alpha-2", project: "alpha" },
    ],
  };
  const events = [
    {
      project: "alpha",
      threadId: "alpha-1",
      model: "gpt-5.6-sol",
      inputTokens: 900,
      cachedInputTokens: 450,
      totalTokens: 1_000,
      outputTokens: 100,
      toolCalls: 1,
      useType: "sdk",
      rateCardCredits: 2,
    },
    {
      project: "alpha",
      threadId: "alpha-2",
      model: "gpt-5.6-luna",
      inputTokens: 200,
      cachedInputTokens: 100,
      totalTokens: 250,
      outputTokens: 25,
      toolCalls: 1,
      useType: "tool",
      rateCardCredits: 1,
    },
  ];
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  const output = renderTerminal({
    options: { plain: true, ascii: true, width: 80 },
    bounds: dayBounds("2026-08-01", "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
  });
  assert.match(output, /TOKENS BY PROJECT/);
  assert.match(output, /MODEL MIX/);
  assert.match(output, /USAGE TYPE · TOKENS/);
  assert.match(output, /SDK\s+80\.0%/);
  assert.match(output, /Tool\s+20\.0%/);
  assert.match(output, /CACHE · INPUT/);
  assert.match(output, /Cached\s+50\.0%/);
  assert.match(output, /Uncached\s+50\.0%/);
  assert.doesNotMatch(output, /THIS WINDOW|TOP 3 SHARE|CREDIT LEADER|BUSIEST PROJECT/);
  assert.match(output, /alpha\s+#+\s+1\.25K/);
  assert.doesNotMatch(output, /\|#+\|/);
  assert.match(output, /\[j\/k\] select/);
  assert.match(output, /2 threads · 100\.0% credits/);
  assert.doesNotMatch(output, /2 threads · 2 calls/);
  const compactHeader = output.split("\n")[0];
  assert.match(compactHeader, /TOKEN LEDGER · SAT 01 AUG · DAY · 1\.25K T · 2 C · 2 TH · 1 P/);
  assert.match(output.split("\n")[1], /PROVENANCE · UNCHECKED CACHE/);
  assert.match(output.split("\n")[2], /^\+/);

  const weekOutput = renderTerminal({
    options: { plain: true, ascii: true, width: 80, range: "week" },
    bounds: weekBounds("2026-08-03", "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
  });
  assert.match(weekOutput, /JUL 28–AUG 03/);
  assert.match(weekOutput, /7D/);
  const weekHeader = weekOutput.split("\n")[0];
  assert.match(weekHeader, /TOKEN LEDGER · JUL 28–AUG 03 · 7D · 1\.25K T · 2 C · 2 TH · 1 P/);

  const rollingSnapshot = {
    ...snapshot,
    generatedAt: "2026-08-19T23:45:00.000Z",
  };
  const rollingFreshness = snapshotFreshness(
    rollingSnapshot,
    Date.parse("2026-08-20T00:00:00.000Z"),
  );
  const rollingOutput = renderTerminal({
    options: { plain: true, ascii: true, width: 120, range: "rolling24h" },
    snapshot: rollingSnapshot,
    snapshotFreshness: rollingFreshness,
    sourceStatus: "stale-fallback",
    bounds: rolling24hBounds(new Date("2026-08-19T22:15:30.000Z"), "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
  });
  assert.match(
    rollingOutput.split("\n")[0],
    /TOKEN LEDGER · LAST 24 HOURS · 24 HOURS · 1\.25K TOKENS · 2 CALLS · 2 THREADS · 1 PROJECTS/,
  );
  assert.match(rollingOutput, /SNAPSHOT · fresh · 15m old/);
  assert.match(rollingOutput, /PROVENANCE · STALE FALLBACK/);
  assert.doesNotMatch(rollingOutput, /token-ledger-snapshot\.json|\/Users\//);

  const fullscreenRollingOutput = renderFullscreen({
    options: {
      range: "rolling24h",
      plain: true,
      ascii: true,
      forceColor: false,
    },
    snapshot: rollingSnapshot,
    snapshotFreshness: rollingFreshness,
    sourceStatus: "stale-fallback",
    bounds: rolling24hBounds(new Date("2026-08-19T22:15:30.000Z"), "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
    width: 100,
    height: 30,
  });
  assert.match(fullscreenRollingOutput, /SNAPSHOT · fresh · 15m old/);
  assert.match(fullscreenRollingOutput, /PROVENANCE · STALE FALLBACK/);

  const narrowOutput = renderTerminal({
    options: { plain: true, ascii: true, width: 64 },
    bounds: dayBounds("2026-08-01", "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
  });
  assert.ok(narrowOutput.split("\n").every((line) => line.length <= 64));
  assert.match(narrowOutput, /0\s+1\.25K/);
});

test("terminal shares preserve model and cache proportions when totals saturate", () => {
  const huge = Number.MAX_SAFE_INTEGER;
  const events = [
    {
      project: "alpha",
      model: "gpt-5.6-luna",
      totalTokens: huge,
      inputTokens: huge,
      cachedInputTokens: huge,
      outputTokens: 0,
      useType: "sdk",
    },
    {
      project: "beta",
      model: "gpt-5.6-sol",
      totalTokens: huge,
      inputTokens: huge,
      cachedInputTokens: 0,
      outputTokens: 0,
      useType: "tool",
    },
  ];
  const rows = aggregateProjects({ events, threads: [] }, events, {
    rawProjects: true,
  });
  const output = renderTerminal({
    options: { plain: true, ascii: true, width: 80 },
    bounds: dayBounds("2026-08-01", "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
  });
  assert.match(output, /Luna\s+50\.0%/);
  assert.match(output, /Sol\s+50\.0%/);
  assert.match(output, /Cached\s+50\.0%/);
  assert.match(output, /Uncached\s+50\.0%/);
  assert.match(output, /SDK\s+50\.0%/);
  assert.match(output, /Tool\s+50\.0%/);
});

test("filtered collection scope is visible in terminal and PNG renderers", () => {
  const snapshot = {
    generatedAt: "2026-08-20T20:00:00.000Z",
    provenance: {
      collection: {
        since: "2026-08-20T12:00:00.000Z",
        includeArchived: false,
      },
    },
    events: [{
      timestamp: "2026-08-20T13:00:00.000Z",
      project: "scoped",
      threadId: "scoped-1",
      model: "gpt-5.6-luna",
      inputTokens: 90,
      cachedInputTokens: 10,
      totalTokens: 100,
      outputTokens: 10,
      toolCalls: 0,
      rateCardCredits: 1,
    }],
    threads: [{ id: "scoped-1", project: "scoped" }],
    quotaObservations: [],
  };
  const events = snapshot.events;
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  const bounds = multiDayBounds("2026-08-20", "UTC", 7);
  const terminal = renderTerminal({
    options: { plain: true, ascii: true, width: 120 },
    snapshot,
    bounds: dayBounds("2026-08-20", "UTC"),
    events,
    rows,
    allRows: rows,
  });
  assert.match(
    terminal,
    /TRUNCATED HISTORY · before 2026-08-20T12:00:00\.000Z · archived sessions excluded/,
  );

  const trend = renderTrendPlain({
    snapshot,
    bounds,
    options: { plain: true, width: 120 },
  });
  assert.match(trend, /TRUNCATED HISTORY/);

  const trendSvg = renderTrendImage({
    snapshot,
    bounds,
    options: { imageWidth: 900 },
    projectRows: rows,
  });
  assert.match(trendSvg, /TRUNCATED HISTORY/);
  assert.match(trendSvg, /<text[^>]*y="68"[^>]*>[^<]*TRUNCATED HISTORY/);

  const cacheSvg = renderCacheReportImage({
    snapshot,
    bounds,
    options: { imageWidth: 900 },
  });
  assert.match(cacheSvg, /TRUNCATED HISTORY/);
});

test("empty ranges with uncollected history are reported as not collected", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-since-empty-");
  const snapshotPath = resolve(root, "scoped-snapshot.json");
  try {
    await writePrivateSnapshot(snapshotPath, {
      schemaVersion: 3,
      generatedAt: "2026-08-20T20:00:00.000Z",
      provenance: {
        collection: {
          since: "2026-08-20T12:00:00.000Z",
          includeArchived: true,
        },
      },
      events: [],
      threads: [],
    });
    const runEmptyDay = (date) => run(parseArgs([
      "day",
      date,
      "--input",
      snapshotPath,
      "--no-refresh",
      "--since",
      "2026-08-20T12:00:00.000Z",
      "--static",
      "--plain",
      "--ascii",
      "--tz",
      "UTC",
    ]));
    const output = await runEmptyDay("2026-08-19");
    assert.match(output, /not a verified zero/);
    assert.match(output, /History: TRUNCATED HISTORY · before 2026-08-20T12:00:00\.000Z/);
    const partialOutput = await runEmptyDay("2026-08-20");
    assert.match(partialOutput, /not a verified zero/);
    assert.doesNotMatch(partialOutput, /No model-call events found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal renderer moves the selected project cursor", () => {
  const events = [
    {
      project: "alpha",
      threadId: "alpha-1",
      model: "gpt-5.6-luna",
      inputTokens: 100,
      cachedInputTokens: 0,
      totalTokens: 100,
      outputTokens: 0,
      useType: "sdk",
      rateCardCredits: 1,
    },
    {
      project: "beta",
      threadId: "beta-1",
      model: "gpt-5.6-sol",
      inputTokens: 50,
      cachedInputTokens: 0,
      totalTokens: 50,
      outputTokens: 0,
      useType: "sdk",
      rateCardCredits: 1,
    },
  ];
  const snapshot = { events, threads: [] };
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  const output = renderTerminal({
    options: {
      plain: true,
      ascii: true,
      width: 102,
      selectedIndex: 1,
    },
    snapshot,
    bounds: dayBounds("2026-08-01", "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
  });

  assert.match(output, /\|  1\. alpha/);
  assert.match(output, /\|> 2\. beta/);
});

test("quota context maps the selected range to reset-cycle burn", () => {
  const observation = {
    timestamp: "2026-08-02T00:00:00.000Z",
    usedPercent: 25,
    scope: "account",
    limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
    windowMinutes: 10_080,
    resetsAt: Date.parse("2026-08-07T00:00:00.000Z") / 1_000,
  };
  const events = [
    { timestamp: "2026-08-01T00:00:00.000Z", totalTokens: 800 },
    { timestamp: "2026-08-01T12:00:00.000Z", totalTokens: 200 },
    { timestamp: "2026-08-03T00:00:00.000Z", totalTokens: 1_000 },
  ];
  const snapshot = {
    events,
    metadata: CURRENT_QUOTA_METADATA,
    quotaObservations: [observation],
  };
  const quota = quotaCycleSummary(snapshot, [events[0]]);

  assert.equal(quota.usedPercent, 25);
  assert.equal(quota.remainingPercent, 75);
  assert.equal(quota.cycleTokens, 1_000);
  assert.equal(quota.displayedTokens, 800);
  assert.equal(quota.displayedSharePercent, 80);
  assert.equal(quota.estimatedDisplayedBurnPercent, 20);

  const rows = [{
    project: "alpha",
    displayProject: "alpha",
    totalTokens: 800,
    outputTokens: 0,
    reasoningTokens: 0,
    toolCalls: 0,
    events: 1,
    threadIds: new Set(["alpha-1"]),
    threads: 1,
    rateCardCredits: 0,
    knownCreditTokens: 0,
    models: [],
  }];
  const output = renderTerminal({
    options: { plain: true, ascii: true, width: 102 },
    snapshot,
    bounds: weekBounds("2026-08-03", "Pacific/Honolulu"),
    events: [events[0]],
    rows,
    allRows: rows,
  });
  assert.match(output, /RESET CYCLE/);
  assert.match(output, /Used\s+25\.0%/);
  assert.match(output, /Remaining\s+75\.0%/);
  assert.match(output, /View burn\s+~20\.0 pts/);
});

test("quota burn recomputes current card credits when every cycle event is rated", () => {
  const observation = {
    timestamp: "2026-08-02T00:00:00.000Z",
    usedPercent: 20,
    scope: "account",
    limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
    windowMinutes: 10_080,
    resetsAt: Date.parse("2026-08-07T00:00:00.000Z") / 1_000,
  };
  const displayed = {
    timestamp: "2026-08-01T00:00:00.000Z",
    model: "gpt-5.6-luna",
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
    rateCardCredits: 1,
  };
  const other = {
    timestamp: "2026-08-01T12:00:00.000Z",
    model: "gpt-5.6-sol",
    inputTokens: 120_000,
    outputTokens: 0,
    totalTokens: 120_000,
    rateCardCredits: 99,
  };
  const quota = quotaCycleSummary(
    {
      events: [displayed, other],
      metadata: CURRENT_QUOTA_METADATA,
      quotaObservations: [observation],
    },
    [displayed],
  );
  assert.equal(quota.shareBasis, "credits");
  assert.ok(
    Math.abs(quota.displayedSharePercent - (5 / 17) * 100) < 1e-12,
  );
  assert.ok(
    Math.abs(quota.estimatedDisplayedBurnPercent - (5 / 17) * 20) < 1e-12,
  );

  const fallbackDisplayed = {
    timestamp: "2026-08-01T00:00:00.000Z",
    totalTokens: 1_000,
    rateCardCredits: 10,
  };
  const fallbackOther = {
    timestamp: "2026-08-01T12:00:00.000Z",
    totalTokens: 1_000,
    rateCardCredits: null,
  };
  const fallback = quotaCycleSummary(
    {
      events: [fallbackDisplayed, fallbackOther],
      metadata: CURRENT_QUOTA_METADATA,
      quotaObservations: [observation],
    },
    [fallbackDisplayed],
  );
  assert.equal(fallback.shareBasis, "tokens");
  assert.equal(fallback.displayedSharePercent, 50);
  assert.equal(fallback.estimatedDisplayedBurnPercent, 10);
});

test("quota burn keeps unrated usage out of credit-share mode after saturation", () => {
  const observation = {
    timestamp: "2026-08-02T00:00:00.000Z",
    usedPercent: 20,
    scope: "account",
    limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
    windowMinutes: 10_080,
    resetsAt: Date.parse("2026-08-07T00:00:00.000Z") / 1_000,
  };
  const huge = Number.MAX_SAFE_INTEGER;
  const ratedEvent = (timestamp) => ({
    timestamp,
    model: "gpt-5.6-luna",
    inputTokens: huge,
    outputTokens: 0,
    totalTokens: huge,
  });
  const displayed = ratedEvent("2026-08-01T00:00:00.000Z");
  const otherRated = ratedEvent("2026-08-01T06:00:00.000Z");
  const unrated = {
    timestamp: "2026-08-01T12:00:00.000Z",
    totalTokens: huge,
    rateCardCredits: null,
  };

  const quota = quotaCycleSummary(
    {
      events: [displayed, otherRated, unrated],
      metadata: CURRENT_QUOTA_METADATA,
      quotaObservations: [observation],
    },
    [displayed],
  );

  assert.equal(quota.shareBasis, "tokens");
  assert.ok(Math.abs(quota.displayedSharePercent - 100 / 3) < 1e-12);
  assert.ok(Math.abs(quota.estimatedDisplayedBurnPercent - 20 / 3) < 1e-12);
});

test("trend burn keeps rated token and credit scales aligned", () => {
  const huge = Number.MAX_SAFE_INTEGER;
  const bounds = multiDayBounds("2026-08-02", "UTC", 2);
  const snapshot = {
    metadata: CURRENT_QUOTA_METADATA,
    events: [
      {
        timestamp: "2026-08-01T01:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: huge,
        inputTokens: huge,
        cachedInputTokens: 0,
        outputTokens: 0,
        rateCardCredits: 1,
      },
      {
        timestamp: "2026-08-01T02:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: huge,
        inputTokens: huge,
        cachedInputTokens: 0,
        outputTokens: 0,
        rateCardCredits: 1,
      },
      {
        timestamp: "2026-08-01T03:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: huge,
        rateCardCredits: null,
      },
    ],
    quotaObservations: [
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        usedPercent: 30,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt: Date.parse("2026-08-08T00:00:00.000Z") / 1_000,
      },
    ],
  };

  const interval = buildUsageTrend(snapshot, bounds).burnIntervals[0];
  assert.equal(interval.method, "mixed");
  assert.equal(interval.contributions.Luna, 20);
  assert.equal(interval.contributions.Sol, 10);
});

test("trend model attribution preserves shared token proportions", () => {
  const huge = Number.MAX_SAFE_INTEGER;
  const bounds = multiDayBounds("2026-08-02", "UTC", 2);
  const snapshot = {
    metadata: CURRENT_QUOTA_METADATA,
    events: [
      {
        timestamp: "2026-08-01T01:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: huge,
        rateCardCredits: 1,
      },
      {
        timestamp: "2026-08-01T02:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: huge,
        rateCardCredits: 1,
      },
      {
        timestamp: "2026-08-01T03:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: huge,
        rateCardCredits: null,
      },
    ],
    quotaObservations: [{
      timestamp: "2026-08-02T00:00:00.000Z",
      usedPercent: 30,
      scope: "account",
      limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
      windowMinutes: 10_080,
      resetsAt: Date.parse("2026-08-08T00:00:00.000Z") / 1_000,
    }],
  };

  const models = buildUsageTrend(snapshot, bounds).models;
  const luna = models.find((model) => model.model === "Luna");
  const sol = models.find((model) => model.model === "Sol");
  assert.ok(luna && sol);
  assert.ok(
    Math.abs(luna.tokensPerBurnPoint - sol.tokensPerBurnPoint) < 1e-9,
  );
});

test("compact totals promote values that round to 1000 of a unit", () => {
  const events = [
    {
      project: "alpha",
      threadId: "alpha-1",
      model: "gpt-5.6-sol",
      inputTokens: 900_000,
      cachedInputTokens: 0,
      totalTokens: 999_999,
      outputTokens: 99_999,
      useType: "sdk",
      rateCardCredits: 1,
    },
  ];
  const snapshot = { events, threads: [] };
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  const output = renderTerminal({
    options: { plain: true, ascii: true, width: 102 },
    snapshot,
    bounds: dayBounds("2026-08-01", "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
  });
  assert.match(output, /1\.00M/);
  assert.doesNotMatch(output, /1000K/);
});

test("purchased-credit rates normalize exact current model identifiers", () => {
  const usage = {
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 1_000_000,
  };
  const credits = (model, serviceTier = null) =>
    calculateCodexPurchasedCredits({ model, serviceTier, usage });
  const spaced = credits("gpt-5.4 mini");
  assert.equal(spaced, credits("gpt-5.4-mini"));
  assert.notEqual(spaced, credits("gpt-5.4"));
  assert.equal(normalizeCodexCreditModel("gpt-5.5-cyber"), "daybreak-red");
  assert.equal(
    normalizeCodexCreditModel("gpt-daybreak-red-latest"),
    "daybreak-red",
  );
  for (const model of [
    "gpt-daybreak-red",
    "gpt-5.6-cyber",
    "gpt-5.5-cyber-preview",
  ]) {
    assert.equal(normalizeCodexCreditModel(model), "daybreak-red");
  }
  assert.equal(normalizeCodexCreditModel("gpt-daybreak-blue"), "daybreak-blue");
  assert.equal(codexCreditMultiplier("daybreak-red", "fast"), 2.5);
  assert.equal(codexCreditMultiplier("daybreak-red", "priority"), 2.5);
  assert.equal(codexCreditMultiplier("daybreak-blue", "fast"), 2.5);
  assert.equal(codexCreditMultiplier("daybreak-blue", "priority"), 2.5);
  assert.equal(codexCreditMultiplier("gpt-daybreak-red", "fast"), 2.5);
  assert.equal(codexCreditMultiplier("gpt-daybreak-blue", "fast"), 2.5);
  assert.equal(codexCreditMultiplier("gpt-daybreak-red-latest", "fast"), null);
});

test("proportional fragments retain detailed token breakdowns through reconciliation noise", () => {
  const fraction = 1 / 101;
  const usage = {
    inputTokens: fraction,
    cachedInputTokens: 0,
    outputTokens: 5 * fraction,
    totalTokens: 6 * fraction,
    rangeAllocationEstimated: true,
  };

  assert.notEqual(usage.inputTokens + usage.outputTokens, usage.totalTokens);
  assert.equal(hasDetailedTokenBreakdown(usage), true);
  assert.ok(Number.isFinite(calculateCodexPurchasedCredits({
    model: "gpt-5.6-luna",
    serviceTier: null,
    usage,
  })));
  assert.equal(
    hasDetailedTokenBreakdown({ ...usage, totalTokens: 7 * fraction }),
    false,
  );
});

test("quota normalization is monotone inside cycles and marks resets", () => {
  const resetOne = Date.parse("2026-08-11T10:00:00.000Z") / 1_000;
  const observations = normalizeQuotaTimeline([
    {
      timestampMs: Date.parse("2026-08-09T12:00:00.000Z"),
      resetsAt: resetOne,
      usedPercent: 20,
    },
    {
      timestampMs: Date.parse("2026-08-10T12:00:00.000Z"),
      resetsAt: resetOne,
      usedPercent: 30,
    },
    {
      timestampMs: Date.parse("2026-08-11T12:00:00.000Z"),
      resetsAt: resetOne,
      usedPercent: 24,
    },
    {
      timestampMs: Date.parse("2026-08-12T12:00:00.000Z"),
      resetsAt: resetOne + 10_080 * 60,
      usedPercent: 5,
    },
  ]);
  assert.deepEqual(
    observations.map((observation) => observation.normalizedUsedPercent),
    [20, 30, 30, 5],
  );
  assert.deepEqual(
    observations.map((observation) => observation.reset),
    [false, false, false, true],
  );
  assert.deepEqual(
    observations.map((observation) => observation.cycle),
    [0, 0, 0, 1],
  );
});

test("combo trend bins actual tokens and overlays an explicit reset marker", () => {
  const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", 7);
  const resetOne = Date.parse("2026-08-11T10:00:00.000Z") / 1_000;
  const snapshot = {
    metadata: CURRENT_QUOTA_METADATA,
    events: [
      {
        timestamp: "2026-08-09T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 1_000,
        inputTokens: 900,
        outputTokens: 100,
      },
      {
        timestamp: "2026-08-10T12:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: 2_000,
        inputTokens: 1_800,
        outputTokens: 200,
      },
    ],
    quotaObservations: [
      {
        timestamp: "2026-08-09T12:00:00.000Z",
        usedPercent: 20,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt: resetOne,
      },
      {
        timestamp: "2026-08-10T12:00:00.000Z",
        usedPercent: 30,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt: resetOne,
      },
      {
        timestamp: "2026-08-12T12:00:00.000Z",
        usedPercent: 5,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt: resetOne + 10_080 * 60,
      },
    ],
  };
  const bins = buildActualTokenBins(snapshot, bounds, 7, 96);
  assert.equal(bins.binSize, 1);
  assert.equal(bins.bins[0].totalTokens, 1_000);
  assert.equal(bins.bins[1].totalTokens, 2_000);
  assert.equal(bins.totals.get("Luna"), 1_000);
  assert.equal(bins.totals.get("Sol"), 2_000);

  const trend = buildUsageTrend(snapshot, bounds);
  const output = renderTrendPlain({
    snapshot,
    bounds,
    trend,
    days: 7,
    options: { width: 96 },
  });
  assert.match(output, /ACTUAL TOKENS \+ WEEKLY QUOTA/);
  assert.match(output, /-% row = observed drain/);
  assert.match(output, /LEFT AXIS/);
  assert.match(output, /RIGHT AXIS/);
  assert.match(output, /CALENDAR DAY · -% = OBSERVED METER DROP/);
  assert.match(output, /■ Luna 1\.00K/);
  assert.match(output, /■ Sol 2\.00K/);
  assert.match(output, /-20%~/);
  assert.match(output, /-10%/);
  assert.match(output, /-5%/);
  assert.doesNotMatch(output, /-0%/);
  assert.match(output, /↟ reset marker returns the line to 100%/);
  assert.ok(output.split("\n").every((line) => line.length <= 96));

  const drainOutput = renderTrendPlain({
    snapshot,
    bounds,
    trend,
    days: 7,
    options: { width: 96, drain: true },
  });
  assert.match(drainOutput, /OBSERVED LIMIT DRAIN \+ WEEKLY METER/);
  assert.match(drainOutput, /one percent scale/);
  assert.match(drainOutput, /■ Luna 20\.0% of limit · 1\.00K tok/);
  assert.match(drainOutput, /■ Sol 10\.0% of limit · 2\.00K tok/);
  assert.match(drainOutput, /■ Unattributed 5\.00% of limit/);
  assert.match(drainOutput, /Columns sum to observed meter drops/);
});

test("trend token bins share one overflow scale across calendar days", () => {
  const huge = Number.MAX_SAFE_INTEGER;
  const bounds = multiDayBounds("2026-08-15", "UTC", 3);
  const bins = buildActualTokenBins(
    {
      events: [
        {
          timestamp: "2026-08-13T01:00:00.000Z",
          model: "gpt-5.6-luna",
          totalTokens: huge,
        },
        {
          timestamp: "2026-08-13T02:00:00.000Z",
          model: "gpt-5.6-luna",
          totalTokens: huge,
        },
        {
          timestamp: "2026-08-14T01:00:00.000Z",
          model: "gpt-5.6-luna",
          totalTokens: huge,
        },
      ],
    },
    bounds,
    3,
    96,
    { binSize: 1 },
  );
  const firstDay = bins.bins[0].totalTokens;
  const secondDay = bins.bins[1].totalTokens;
  assert.ok(firstDay > secondDay);
  assert.ok(Math.abs(firstDay / secondDay - 2) < 1e-12);
  assert.ok(
    Math.abs(firstDay + secondDay - huge) <=
      Number.EPSILON * huge * 8,
  );
  assert.ok(
    Math.abs(bins.totals.get("Luna") - huge) <=
      Number.EPSILON * huge * 8,
  );
});

test("image trend deltas reconcile independently scaled periods", () => {
  const huge = Number.MAX_SAFE_INTEGER;
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const snapshot = {
    events: [
      {
        timestamp: "2026-08-08T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: huge,
      },
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: huge,
      },
      {
        timestamp: "2026-08-15T13:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: huge,
      },
    ],
  };

  const svg = renderTrendImage({
    snapshot,
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
  });
  assert.match(svg, /\+100\.0%/);
});

test("all report renderers consume one immutable range analysis", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const priorBounds = priorPeriodBounds(bounds, 7);
  const resetAt = Date.parse("2026-08-16T00:00:00.000Z") / 1_000;
  const sourceEvents = [
    {
      timestamp: "2026-08-09T12:00:00.000Z",
      startAt: "2026-08-08T12:00:00.000Z",
      endAt: "2026-08-10T12:00:00.000Z",
      project: "compacted",
      threadId: "compacted-thread",
      model: "gpt-5.6-luna",
      totalTokens: 3_000,
      inputTokens: 2_400,
      cachedInputTokens: 1_200,
      outputTokens: 600,
      callCount: 2,
    },
    {
      timestamp: "2026-08-12T12:00:00.000Z",
      project: "priority",
      threadId: "priority-thread",
      model: "gpt-5.6-sol",
      totalTokens: 2_000,
      inputTokens: 1_000,
      cachedInputTokens: 700,
      outputTokens: 1_000,
      serviceTier: "priority",
    },
    {
      timestamp: "2026-08-14T12:00:00.000Z",
      project: "standard",
      threadId: "standard-thread",
      model: "gpt-5.5",
      totalTokens: 1_000,
      inputTokens: 800,
      cachedInputTokens: 0,
      outputTokens: 200,
    },
    {
      timestamp: "2026-08-05T12:00:00.000Z",
      project: "prior",
      threadId: "prior-thread",
      model: "gpt-5.6-sol",
      totalTokens: 700,
      inputTokens: 500,
      cachedInputTokens: 250,
      outputTokens: 200,
    },
  ];
  let rawPasses = 0;
  const events = new Proxy(sourceEvents, {
    get(target, property) {
      if (property === Symbol.iterator) {
        return function* trackedIterator() {
          rawPasses += 1;
          yield* target;
        };
      }
      return target[property];
    },
  });
  const snapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    metadata: CURRENT_QUOTA_METADATA,
    events,
    quotaObservations: [
      {
        timestamp: "2026-08-10T12:00:00.000Z",
        usedPercent: 20,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt: resetAt,
      },
      {
        timestamp: "2026-08-14T12:00:00.000Z",
        usedPercent: 35,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt: resetAt,
      },
    ],
  };
  const analysis = buildRangeAnalysis(snapshot, bounds, { priorBounds });
  assert.equal(Object.isFrozen(analysis), true);
  assert.equal(Object.isFrozen(analysis.currentEvents), true);
  assert.equal(Object.isFrozen(analysis.priorEvents), true);
  assert.equal(analysis.trend.available, true);
  assert.ok(analysis.boundaryCount >= 4);

  const currentEvents = filterDayEvents(snapshot, bounds, analysis);
  const rows = aggregateProjects(snapshot, currentEvents, { rawProjects: true }, analysis);
  const trend = buildUsageTrend(snapshot, bounds, { analysis });
  const actual = buildActualTokenBins(
    snapshot,
    bounds,
    7,
    110,
    { events: analysis.currentEvents },
  );
  const cache = buildCacheReportData(
    snapshot,
    bounds,
    7,
    110,
    actual.binSize,
    analysis.currentEvents,
  );
  const plain = renderTrendPlain({
    snapshot,
    bounds,
    trend,
    days: 7,
    options: { width: 96 },
    analysis,
  });
  const image = renderTrendImage({
    snapshot,
    bounds,
    trend,
    days: 7,
    options: { imageWidth: 900 },
    projectRows: rows,
    analysis,
  });
  const cacheImage = renderCacheReportImage({
    snapshot,
    bounds,
    days: 7,
    options: { imageWidth: 900 },
    analysis,
  });

  const total = (items) =>
    items.reduce((sum, event) => sum + (Number(event.totalTokens) || 0), 0);
  const rowTotal = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  const modelTotal = trend.models.reduce((sum, row) => sum + row.tokens, 0);
  const binTotal = [...actual.totals.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(total(currentEvents), rowTotal);
  assert.equal(rowTotal, modelTotal);
  assert.equal(modelTotal, binTotal);
  assert.equal(binTotal, cache.totalTokens);
  assert.equal(total(analysis.currentEvents), total(currentEvents));
  assert.ok(Math.abs(total(analysis.priorEvents) - (3_000 / 4 + 700)) < 0.01);
  assert.match(plain, /ACTUAL TOKENS \+ WEEKLY QUOTA/);
  assert.match(image, /Token Ledger · 7-day trend/);
  assert.match(cacheImage, /Token Ledger · 7-day cache report/);
  assert.equal(rawPasses, 1);
});

test("future quota observations do not alter historical range splits", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const event = {
    timestamp: "2026-08-18T12:00:00.000Z",
    startAt: "2026-08-14T12:00:00.000Z",
    endAt: "2026-08-25T12:00:00.000Z",
    project: "historical",
    model: "gpt-5.6-luna",
    totalTokens: 1_000,
    callCount: 10,
  };
  const baseline = buildRangeAnalysis(
    { events: [event], quotaObservations: [] },
    bounds,
    { includeTrend: false },
  );
  const withFutureQuota = buildRangeAnalysis(
    {
      events: [event],
      metadata: CURRENT_QUOTA_METADATA,
      quotaObservations: [{
        timestamp: "2026-08-23T00:00:00.000Z",
        usedPercent: 20,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt: Date.parse("2026-08-24T00:00:00.000Z") / 1_000,
      }],
    },
    bounds,
    { includeTrend: false },
  );

  assert.equal(withFutureQuota.boundaryCount, baseline.boundaryCount);
  assert.deepEqual(withFutureQuota.currentEvents, baseline.currentEvents);
  assert.equal(withFutureQuota.trend, null);
});

test("trend reports display Terra usage and meter attribution", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 1);
  const resetsAt = Date.parse("2026-08-16T00:00:00.000Z") / 1_000;
  const snapshot = {
    generatedAt: "2026-08-15T18:00:00.000Z",
    metadata: CURRENT_QUOTA_METADATA,
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        model: "gpt-5.6-terra",
        totalTokens: 1_000,
        inputTokens: 900,
        cachedInputTokens: 450,
        outputTokens: 100,
      },
    ],
    quotaObservations: [
      {
        timestamp: "2026-08-15T06:00:00.000Z",
        usedPercent: 0,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt,
      },
      {
        timestamp: "2026-08-15T18:00:00.000Z",
        usedPercent: 10,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt,
      },
    ],
  };
  const trend = buildUsageTrend(snapshot, bounds);

  const output = renderTrendPlain({
    snapshot,
    bounds,
    trend,
    days: 1,
    options: { width: 82 },
  });
  assert.match(output, /■ Terra 1\.00K/);
  assert.match(output, /Terra 100 T\/p · 10\.0 pts/);
  assert.ok(output.split("\n").every((line) => line.length <= 82));

  const drainOutput = renderTrendPlain({
    snapshot,
    bounds,
    trend,
    days: 1,
    options: { width: 82, drain: true },
  });
  assert.match(drainOutput, /■ Terra 10\.0% of limit · 1\.00K tok/);
  assert.match(drainOutput, /Terra 100 tok\/1%/);
  assert.ok(drainOutput.split("\n").every((line) => line.length <= 82));
});

test("image fallback project rows share one overflow scale", () => {
  const huge = Number.MAX_SAFE_INTEGER;
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const snapshot = {
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        project: "alpha",
        model: "gpt-5.6-luna",
        totalTokens: huge,
      },
      {
        timestamp: "2026-08-15T13:00:00.000Z",
        project: "beta",
        model: "gpt-5.6-sol",
        totalTokens: huge,
      },
    ],
  };

  const svg = renderTrendImage({
    snapshot,
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
  });
  const projectShares = svg.match(/>50\.0%<\/text>/g) ?? [];
  assert.ok(projectShares.length >= 2);
});

test("image trend renderer emits stacked model bars and a quota line", () => {
  const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", 7);
  const resetOne = Date.parse("2026-08-11T10:00:00.000Z") / 1_000;
  const snapshot = {
    metadata: CURRENT_QUOTA_METADATA,
    events: [
      {
        timestamp: "2026-08-09T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 1_000,
      },
      {
        timestamp: "2026-08-10T12:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: 2_000,
        serviceTier: "priority",
      },
      {
        timestamp: "2026-08-11T12:00:00.000Z",
        model: "auto-review",
        totalTokens: 500,
      },
    ],
    quotaObservations: [
      {
        timestamp: "2026-08-09T12:00:00.000Z",
        usedPercent: 20,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt: resetOne,
      },
      {
        timestamp: "2026-08-10T12:00:00.000Z",
        usedPercent: 30,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt: resetOne,
      },
      {
        timestamp: "2026-08-12T12:00:00.000Z",
        usedPercent: 5,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt: resetOne + 10_080 * 60,
      },
    ],
  };
  const svg = renderTrendImage({
    snapshot,
    bounds,
    trend: buildUsageTrend(snapshot, bounds),
    days: 7,
    options: { imageWidth: 1_000 },
  });
  assert.match(svg, /<title[^>]*>Token Ledger · 7-day trend<\/title>/);
  assert.match(svg, /fill="#3b82f6"/);
  assert.match(svg, /fill="#10a394"/);
  assert.match(svg, /TOTAL USAGE/);
  assert.match(svg, /CACHE EFFICIENCY/);
  assert.match(svg, /FAST MODE USAGE/);
  assert.match(svg, /PROJECTS/);
  assert.match(svg, /WEEKLY LIMIT/);
  assert.match(svg, /MODEL MIX/);
  assert.match(svg, /DAILY TOKEN VOLUME/);
  assert.match(svg, /stroke="#f6b73c"/);
  assert.match(svg, /Luna/);
  assert.match(svg, /Sol/);
  // The fixture's second window follows a genuine weekly expiry, so the
  // dashed reset break appears with its callout.
  assert.match(svg, />RESET<\/text>/);
  // Fast mode renders as a hatch overlay inside the model segment, never as
  // its own pseudo-model, and the KPI reports actual fast tokens.
  assert.match(svg, /fast-mode-hatch/);
  assert.match(svg, /url\(#fast-mode-hatch\)/);
  assert.match(svg, /of usage/);
  assert.doesNotMatch(svg, /1\.50× rate/);
  // The lower analysis sections remain, without the redundant provenance footer.
  assert.match(svg, /WHERE IT WENT · TOP PROJECTS/);
  assert.match(svg, /CACHE EFFICIENCY BY DAY/);
  assert.match(svg, /CACHE EFFICIENCY BY MODEL/);
  assert.doesNotMatch(
    svg,
    />DATA SOURCES<\/text>|>COVERAGE<\/text>|>BREAKDOWN<\/text>|>HISTORY<\/text>|>RATE CARD<\/text>/,
  );
  assert.ok((svg.match(/<rect /g) ?? []).length >= 4);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);

  const drainSvg = renderTrendImage({
    snapshot,
    bounds,
    trend: buildUsageTrend(snapshot, bounds),
    days: 7,
    options: { imageWidth: 1_000, drain: true },
  });
  assert.match(drainSvg, /OBSERVED LIMIT DRAIN/);
  assert.match(drainSvg, /meter percent by model/);
});

test("malformed snapshots keep terminal, bucket, and image totals bounded", async () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const large = 5_000_000_000_000_000;
  const snapshot = {
    generatedAt: "2026-08-15T15:00:00.000Z",
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        project: "overflow",
        model: "gpt-5.6-luna",
        totalTokens: large,
        inputTokens: large - 10,
        cachedInputTokens: large - 20,
        outputTokens: 10,
        reasoningTokens: 5,
        toolCalls: 2,
        callCount: 1,
        rateCardCredits: 1,
        breakdownAvailable: true,
        threadIds: ["overflow-thread"],
      },
      {
        timestamp: "2026-08-15T13:00:00.000Z",
        project: "overflow",
        model: "gpt-5.6-luna",
        totalTokens: large,
        inputTokens: "malformed",
        cachedInputTokens: { bad: true },
        outputTokens: 10,
        reasoningTokens: true,
        toolCalls: [2],
        callCount: 1,
        rateCardCredits: null,
        breakdownAvailable: true,
        threadIds: ["overflow-thread"],
      },
      {
        timestamp: "2026-08-15T14:00:00.000Z",
        project: "invalid-total",
        model: "gpt-5.6-sol",
        totalTokens: "100",
        inputTokens: 90,
        outputTokens: 10,
      },
    ],
    threads: [],
  };
  const events = filterDayEvents(snapshot, bounds);
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  const actual = buildActualTokenBins(snapshot, bounds, 7, 1_100);
  const cache = buildCacheReportData(snapshot, bounds, 7, 1_100);
  const trend = buildUsageTrend(snapshot, bounds);
  const terminal = renderTerminal({
    options: { plain: true, ascii: true, width: 120 },
    snapshot,
    bounds,
    events,
    rows,
    allRows: rows,
  });
  const svg = renderTrendImage({
    snapshot,
    bounds,
    trend,
    days: 7,
    options: { imageWidth: 1_000 },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(actual.totals.get("Luna"), Number.MAX_SAFE_INTEGER);
  assert.equal(actual.bins.at(-1).totalTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(cache.totalTokens, Number.MAX_SAFE_INTEGER);
  assert.ok(cache.detailedTokens < large);
  assert.ok(cache.unknownBreakdownTokens < large);
  assert.equal(cache.eventCount, 2);
  assert.equal(cache.detailedEventCount, 1);
  assert.equal(
    cache.measurementCoveragePercent,
    50,
  );
  assert.doesNotMatch(terminal, /NaN|Infinity|undefined|null/);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined|null/);

  const root = await createPrivateFixtureRoot("token-ledger-bounded-png-");
  try {
    const output = resolve(root, "bounded.png");
    await writeTrendPng(svg, output);
    const bytes = await readFile(output);
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trend meter stops at its last sample and marks report time", () => {
  const bounds = multiDayBounds("2026-08-23", "UTC", 7);
  const observedThrough = "2026-08-23T08:08:57.000Z";
  const generatedAt = "2026-08-23T08:30:00.000Z";
  const reportTimeMs = Date.parse("2026-08-23T10:08:57.000Z");
  const resetsAt = Date.parse("2026-08-26T10:00:00.000Z") / 1_000;
  const snapshot = {
    generatedAt,
    metadata: CURRENT_QUOTA_METADATA,
    events: [{
      timestamp: "2026-08-23T08:08:30.000Z",
      model: "gpt-5.6-luna",
      totalTokens: 1_000,
      inputTokens: 800,
      cachedInputTokens: 600,
      outputTokens: 200,
    }],
    quotaObservations: [
      {
        timestamp: "2026-08-22T12:00:00.000Z",
        lastSeenAt: "2026-08-22T12:00:00.000Z",
        usedPercent: 70,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt,
      },
      {
        timestamp: "2026-08-23T07:59:20.000Z",
        lastSeenAt: observedThrough,
        usedPercent: 80,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt,
      },
    ],
  };
  const trend = buildUsageTrend(snapshot, bounds);
  const endMs = bounds.end.getTime();
  const observedThroughMs = Date.parse(observedThrough);
  assert.equal(trend.observedThroughMs, observedThroughMs);
  assert.equal(trend.points.at(-1).timestampMs, observedThroughMs);
  assert.equal(trend.points.at(-1).confirmation, true);
  assert.ok(trend.points.every((point) => point.timestampMs < endMs));

  const svg = renderTrendImage({
    snapshot,
    bounds,
    trend,
    days: 7,
    options: { imageWidth: 1_280, reportTimeMs },
  });
  // The meter overlay never extends past the last reading; the report cutoff
  // is carried by the header line and the partial final day.
  const meterEndXs = [...svg.matchAll(
    /<line [^>]*x2="([\d.]+)"[^>]*data-series="weekly-meter"/g,
  )].map((match) => Number(match[1]));
  const plotRight = 1_280 - 28 - 66;
  assert.ok(meterEndXs.length > 0);
  assert.ok(Math.max(...meterEndXs) < plotRight);
  assert.doesNotMatch(svg, /r="3.8"/);
  assert.match(svg, /Report through Aug 23, 10:08 AM/);
  assert.match(svg, /Meter last observed Aug 23, 7:59 AM/);
  assert.match(svg, />PARTIAL</);
  assert.match(svg, />THROUGH 10:08 AM</);
});

test("trend report truncates project names to the measured label column", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const longProjectName =
    "bd8dca09-b808-4a31-acdfbdf79fdc-with-an-even-longer-project-suffix";
  const clipped = truncateText(longProjectName, 190, 15, 700);
  assert.notEqual(clipped, longProjectName);
  assert.match(clipped, /…$/);
  assert.ok(textWidth(clipped, 15, 700) <= 190);

  const snapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: [{
      timestamp: "2026-08-15T12:00:00.000Z",
      model: "gpt-5.6-luna",
      totalTokens: 1_000,
      inputTokens: 800,
      cachedInputTokens: 600,
      outputTokens: 200,
    }],
    quotaObservations: [],
  };
  const svg = renderTrendImage({
    snapshot,
    bounds,
    trend: buildUsageTrend(snapshot, bounds),
    days: 7,
    options: { imageWidth: 1_280 },
    projectRows: [{
      project: longProjectName,
      displayProject: longProjectName,
      totalTokens: 1_000,
    }],
  });

  assert.doesNotMatch(svg, new RegExp(`>${longProjectName}<`));
  const rendered = svg.match(/>(bd8dca09[^<]*…)<\/text>/)?.[1];
  assert.ok(rendered);
  assert.ok(rendered.length < longProjectName.length);
});

test("trend report limits reset labels in dense windows", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 30);
  const cycleStarts = [
    "2026-07-20T00:00:00.000Z",
    "2026-07-23T00:00:00.000Z",
    "2026-07-26T00:00:00.000Z",
    "2026-07-29T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
    "2026-08-04T00:00:00.000Z",
    "2026-08-07T00:00:00.000Z",
  ];
  const snapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    metadata: CURRENT_QUOTA_METADATA,
    events: [],
    quotaObservations: cycleStarts.map((timestamp, index) => ({
      timestamp,
      usedPercent: 10 + index,
      scope: "account",
      limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
      windowMinutes: 10_080,
      resetsAt: Date.parse(timestamp) / 1_000 + 10_080 * 60,
    })),
  };
  const svg = renderTrendImage({
    snapshot,
    bounds,
    trend: buildUsageTrend(snapshot, bounds),
    days: 30,
    options: { imageWidth: 1_280 },
  });
  const resetLines = svg.match(
    /stroke="rgba\(246,183,60,\.5\)"/g,
  ) ?? [];
  const resetLabels = svg.match(/>RESTART<\/text>/g) ?? [];
  assert.equal(resetLines.length, cycleStarts.length - 1);
  assert.equal(resetLabels.length, 4);
});

test("cache report aggregation reuses one local date formatter", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const snapshot = {
    events: [
      "2026-08-13T12:00:00.000Z",
      "2026-08-14T12:00:00.000Z",
      "2026-08-15T12:00:00.000Z",
    ].map((timestamp) => ({
      timestamp,
      model: "gpt-5.6-luna",
      totalTokens: 1_000,
      inputTokens: 900,
      cachedInputTokens: 450,
      outputTokens: 100,
    })),
  };
  const descriptor = Object.getOwnPropertyDescriptor(Intl, "DateTimeFormat");
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  let constructorCalls = 0;

  Object.defineProperty(Intl, "DateTimeFormat", {
    ...descriptor,
    value: function DateTimeFormat(...args) {
      constructorCalls += 1;
      return new OriginalDateTimeFormat(...args);
    },
  });
  try {
    buildCacheReportData(snapshot, bounds, 7, 1_100);
  } finally {
    Object.defineProperty(Intl, "DateTimeFormat", descriptor);
  }

  assert.equal(constructorCalls, 1);
});

test("cache report weights cached input, clamps event values, and keeps models secondary", () => {
  const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", 7);
  const snapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: [
      {
        timestamp: "2026-08-09T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 1_200,
        inputTokens: 1_000,
        cachedInputTokens: 800,
        outputTokens: 200,
      },
      {
        timestamp: "2026-08-10T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 1_100,
        inputTokens: 1_000,
        cachedInputTokens: 100,
        outputTokens: 100,
      },
      {
        timestamp: "2026-08-11T12:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: 600,
        inputTokens: 500,
        cachedInputTokens: 900,
        outputTokens: 100,
      },
      {
        timestamp: "2026-08-12T12:00:00.000Z",
        model: "gpt-5.5",
        totalTokens: 300,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        breakdownAvailable: false,
      },
      {
        timestamp: "2026-08-02T12:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: 1_100,
        inputTokens: 1_000,
        cachedInputTokens: 250,
        outputTokens: 100,
      },
    ],
  };

  const data = buildCacheReportData(snapshot, bounds, 7, 1_100);
  assert.equal(data.inputTokens, 2_500);
  assert.equal(data.cachedInputTokens, 1_400);
  assert.equal(data.uncachedInputTokens, 1_100);
  assert.ok(Math.abs(data.rate - 56) < 0.0001);
  assert.equal(data.measurementCoveragePercent, 90.625);
  assert.equal(data.inputEventCount, 3);
  assert.equal(data.bins[0].rate, 80);
  assert.equal(data.bins[1].rate, 10);
  assert.equal(data.bins[2].rate, 100);
  assert.deepEqual(
    data.models.map((model) => [model.model, model.rate]),
    [["Luna", 45], ["Sol", 100]],
  );

  const svg = renderCacheReportImage({
    snapshot,
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
    sourceStatus: "stale-fallback",
  });
  assert.match(svg, /Token Ledger · 7-day cache report/);
  assert.match(svg, /56\.0% cached/);
  assert.match(svg, /Prior 25\.0% · \+31\.0 pp/);
  assert.match(svg, /CACHE RATE BY PERIOD/);
  assert.match(svg, />MODEL<\/text>/);
  assert.match(svg, /Luna/);
  assert.match(svg, /Sol/);
  assert.match(svg, /MEASUREMENT COVERAGE/);
  assert.match(svg, /cached input ÷ measured input/);
  assert.match(svg, /3 measured input-bearing calls/);
  assert.match(svg, /PROVENANCE · STALE FALLBACK/);
  assert.doesNotMatch(svg, /WHERE IT WENT|WEEKLY METER|NaN/);
});

test("cache report contains non-finite snapshot token values", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const snapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 1_100,
        inputTokens: 1_000,
        cachedInputTokens: 600,
        outputTokens: 100,
        breakdownAvailable: true,
      },
      {
        timestamp: "2026-08-14T12:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: "1e999",
        inputTokens: "Infinity",
        cachedInputTokens: "Infinity",
        outputTokens: "Infinity",
        breakdownAvailable: true,
      },
    ],
  };

  const data = buildCacheReportData(snapshot, bounds, 7, 1_100);
  assert.equal(data.totalTokens, 1_100);
  assert.equal(data.inputTokens, 1_000);
  assert.equal(data.cachedInputTokens, 600);
  assert.equal(data.rate, 60);
  const svg = renderCacheReportImage({ snapshot, bounds, days: 7 });
  assert.match(svg, /60\.0% cached/);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
});

test("cache report caps safe token sums before rendering", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const huge = Number.MAX_SAFE_INTEGER;
  const eventFor = (model, includeReportedTotal = true) => {
    const event = {
      timestamp: "2026-08-15T12:00:00.000Z",
      model,
      inputTokens: huge,
      cachedInputTokens: huge,
      outputTokens: 0,
      breakdownAvailable: true,
    };
    if (includeReportedTotal) event.totalTokens = huge;
    return event;
  };
  const snapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: [
      eventFor("gpt-5.6-luna", false),
      eventFor("gpt-5.6-luna"),
      eventFor("gpt-5.6-sol"),
      eventFor("gpt-5.6-terra"),
      eventFor("gpt-5.5"),
      eventFor("gpt-5.4"),
      eventFor("gpt-5.5-daybreak-blue-latest"),
      eventFor("gpt-5.5-auto-review"),
    ],
  };

  const data = buildCacheReportData(snapshot, bounds, 7, 1_100);
  assert.ok(Number.isFinite(data.totalTokens) && data.totalTokens > 0);
  assert.ok(Number.isFinite(data.detailedTokens) && data.detailedTokens > 0);
  assert.ok(Number.isFinite(data.inputTokens) && data.inputTokens > 0);
  assert.ok(Number.isFinite(data.cachedInputTokens) && data.cachedInputTokens > 0);
  assert.equal(data.uncachedInputTokens, 0);
  assert.equal(data.rate, 100);
  assert.ok(Number.isFinite(data.bins.at(-1).totalTokens));
  assert.ok(Number.isFinite(data.bins.at(-1).inputTokens));
  assert.ok(data.models.every((model) => Number.isFinite(model.inputTokens)));

  const svg = renderCacheReportImage({ snapshot, bounds, days: 7 });
  assert.match(svg, /Other models/);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
  assert.doesNotMatch(svg, /(?:width|height|x|y)="NaN/);

  const control = buildCacheReportData({
    events: [{
      timestamp: "2026-08-15T12:00:00.000Z",
      model: "gpt-5.6-luna",
      totalTokens: 12,
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 2,
      breakdownAvailable: true,
    }],
  }, bounds, 7, 1_100);
  assert.equal(control.totalTokens, 12);
  assert.equal(control.inputTokens, 10);
  assert.equal(control.cachedInputTokens, 4);
  assert.equal(control.rate, 40);

  const inferredOverflow = buildCacheReportData({
    events: [{
      timestamp: "2026-08-15T12:00:00.000Z",
      totalTokens: "1e999",
      inputTokens: huge,
      cachedInputTokens: huge,
      outputTokens: 0,
    }],
  }, bounds, 7, 1_100);
  assert.equal(inferredOverflow.eventCount, 0);
  assert.equal(inferredOverflow.totalTokens, 0);
});

test("cache report preserves ratios across capped input totals", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const first = Number.MAX_SAFE_INTEGER;
  const second = first;
  const eventFor = (inputTokens, cachedInputTokens) => ({
    timestamp: "2026-08-15T12:00:00.000Z",
    model: "gpt-5.6-luna",
    totalTokens: inputTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens: 0,
    breakdownAvailable: true,
  });
  const snapshot = {
    events: [eventFor(first, first), eventFor(second, 0)],
  };

  const data = buildCacheReportData(snapshot, bounds, 7, 1_100);
  for (const aggregate of [data, ...data.bins, ...data.models]) {
    for (const key of [
      "totalTokens",
      "detailedTokens",
      "inputTokens",
      "cachedInputTokens",
      "uncachedInputTokens",
    ]) {
      if (key in aggregate) assert.ok(Number.isFinite(aggregate[key]), `${key} overflowed`);
    }
  }
  assert.ok(Math.abs(data.rate - 50) < 0.000_000_1);
  for (const aggregate of [data, ...data.bins, ...data.models]) {
    if (!(aggregate.inputTokens > 0)) continue;
    assert.ok(Math.abs(aggregate.rate - 50) < 0.000_000_1);
  }
  assert.equal(
    data.cachedInputTokens + data.uncachedInputTokens,
    data.inputTokens,
  );
  assert.equal(data.measurementCoveragePercent, 100);

  const svg = renderCacheReportImage({ snapshot, bounds, days: 7 });
  assert.match(svg, />50\.0% cached</);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
});

test("cache model shares use the summary overflow scale", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const huge = Number.MAX_SAFE_INTEGER;
  const eventFor = (model) => ({
    timestamp: "2026-08-15T12:00:00.000Z",
    model,
    totalTokens: huge,
    inputTokens: huge,
    cachedInputTokens: 0,
    outputTokens: 0,
    breakdownAvailable: true,
  });
  const data = buildCacheReportData({
    events: [
      eventFor("gpt-5.6-luna"),
      eventFor("gpt-5.6-luna"),
      eventFor("gpt-5.6-sol"),
    ],
  }, bounds, 7, 1_100);

  assert.deepEqual(data.models.map((model) => model.model), ["Luna", "Sol"]);
  const total = data.inputTokens;
  assert.ok(Math.abs((data.models[0].inputTokens / total) * 100 - 66.6666667) < 0.0001);
  assert.ok(Math.abs((data.models[1].inputTokens / total) * 100 - 33.3333333) < 0.0001);
  assert.ok(data.models[0].inputTokens > data.models[1].inputTokens);
});

test("cache report bins use the summary overflow scale", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 3);
  const huge = Number.MAX_SAFE_INTEGER;
  const eventFor = (timestamp) => ({
    timestamp,
    model: "gpt-5.6-luna",
    totalTokens: huge,
    inputTokens: huge,
    cachedInputTokens: 0,
    outputTokens: 0,
    breakdownAvailable: true,
  });
  const data = buildCacheReportData(
    {
      events: [
        eventFor("2026-08-13T01:00:00.000Z"),
        eventFor("2026-08-13T02:00:00.000Z"),
        eventFor("2026-08-14T01:00:00.000Z"),
      ],
    },
    bounds,
    3,
    1_100,
    1,
  );
  const firstDay = data.bins[0].inputTokens;
  const secondDay = data.bins[1].inputTokens;
  assert.ok(firstDay > secondDay);
  assert.ok(Math.abs(firstDay / secondDay - 2) < 1e-12);
  assert.ok(
    Math.abs(firstDay + secondDay - data.inputTokens) <=
      Number.EPSILON * huge * 8,
  );
});

test("cache report preserves unknown coverage when token sums saturate", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const huge = Number.MAX_SAFE_INTEGER;
  const snapshot = {
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: huge,
        inputTokens: huge,
        cachedInputTokens: huge,
        outputTokens: 0,
        breakdownAvailable: true,
      },
      {
        timestamp: "2026-08-15T13:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: huge,
        breakdownAvailable: false,
      },
    ],
  };

  const data = buildCacheReportData(snapshot, bounds, 7, 1_100);
  assert.equal(data.totalTokens, huge);
  assert.ok(data.detailedTokens < huge);
  assert.ok(data.unknownBreakdownTokens < huge);
  assert.equal(data.measurementCoveragePercent, 50);
  assert.equal(data.bins.at(-1).measurementCoveragePercent, 50);
});

test("trend image preserves the cache rate in a capped remainder", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const huge = Number.MAX_SAFE_INTEGER;
  const eventFor = (model, cachedInputTokens) => ({
    timestamp: "2026-08-15T12:00:00.000Z",
    model,
    totalTokens: huge,
    inputTokens: huge,
    cachedInputTokens,
    outputTokens: 0,
    breakdownAvailable: true,
  });
  const small = (model, cachedInputTokens) => ({
    ...eventFor(model, cachedInputTokens),
    totalTokens: huge / 2,
    inputTokens: huge / 2,
    cachedInputTokens: Math.min(cachedInputTokens, huge / 2),
  });
  const snapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: [
      eventFor("gpt-5.5", huge),
      eventFor("gpt-5.6-luna", huge),
      eventFor("gpt-5.6-sol", huge),
      eventFor("gpt-5.4", huge),
      small("gpt-5.6-terra", 0),
      small("daybreak-blue", huge),
    ],
  };

  const svg = renderTrendImage({
    snapshot,
    bounds,
    days: 7,
    options: { imageWidth: 900 },
  });

  assert.equal((svg.match(/>50\.0%</g) ?? []).length, 1);
});

test("trend bars partition capped model segments", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const huge = Number.MAX_SAFE_INTEGER;
  const snapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: huge,
      },
      {
        timestamp: "2026-08-15T13:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: huge,
      },
    ],
  };

  const actual = buildActualTokenBins(snapshot, bounds, 7, 1_100);
  assert.equal(actual.bins.at(-1).totalTokens, huge);
  assert.equal(actual.bins.at(-1).values.get("Luna"), huge / 2);
  assert.equal(actual.bins.at(-1).values.get("Sol"), huge / 2);
  assert.equal(actual.totals.get("Luna"), huge / 2);
  assert.equal(actual.totals.get("Sol"), huge / 2);

  const terminal = renderTrendPlain({
    snapshot,
    bounds,
    days: 7,
    options: { ascii: true, width: 120 },
    snapshotFreshness: { status: "fresh", ageLabel: "12m old" },
    sourceStatus: "stale-fallback",
  });
  assert.match(terminal, /SNAPSHOT · fresh · 12m old/);
  assert.match(terminal, /PROVENANCE · STALE FALLBACK/);
  const chartRows = terminal.split("\n").slice(6, 17);
  assert.equal(chartRows.filter((line) => line.includes("█")).length, 9);

  const image = renderTrendImage({
    snapshot,
    bounds,
    days: 7,
    options: { imageWidth: 900 },
  });
  const usageHeights = [...image.matchAll(
    /<rect [^>]*height="([\d.]+)"[^>]*data-series="usage-bars"/g,
  )].map((match) => Number(match[1]));
  assert.equal(usageHeights.length, 2);
  assert.ok(Math.abs(usageHeights[0] - usageHeights[1]) < 0.01);
  assert.ok(usageHeights[0] > 0);
});

test("trend legend totals preserve unequal capped model shares", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const huge = Number.MAX_SAFE_INTEGER;
  const eventFor = (model) => ({
    timestamp: "2026-08-15T12:00:00.000Z",
    model,
    totalTokens: huge,
  });
  const snapshot = {
    events: [
      eventFor("gpt-5.6-luna"),
      eventFor("gpt-5.6-luna"),
      eventFor("gpt-5.6-sol"),
    ],
  };

  const actual = buildActualTokenBins(snapshot, bounds, 7, 1_100);
  const total = [...actual.totals.values()].reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs((actual.totals.get("Luna") / total) * 100 - 66.6666667) < 0.0001);
  assert.ok(Math.abs((actual.totals.get("Sol") / total) * 100 - 33.3333333) < 0.0001);

  const output = renderTrendPlain({
    snapshot,
    bounds,
    days: 7,
    options: { ascii: true, width: 120 },
  });
  assert.match(output, /Luna [^\n]*\(66\.7%\)/);
  assert.match(output, /Sol [^\n]*\(33\.3%\)/);
});

test("cache report preserves proportions when token sums are normalized", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const token = 1e15;
  const eventFor = (cachedInputTokens, measured = true) => ({
    timestamp: "2026-08-15T12:00:00.000Z",
    model: "gpt-5.6-luna",
    totalTokens: token,
    inputTokens: token,
    cachedInputTokens: measured ? cachedInputTokens : token,
    outputTokens: 0,
    breakdownAvailable: measured,
  });
  const snapshot = {
    events: [
      eventFor(token),
      eventFor(0),
      eventFor(0),
      eventFor(0, false),
    ],
  };

  const data = buildCacheReportData(snapshot, bounds, 7, 1_100);
  assert.ok(Math.abs(data.rate - 100 / 3) < 0.000_000_1);
  assert.equal(
    data.cachedInputTokens + data.uncachedInputTokens,
    data.inputTokens,
  );
  assert.ok(Math.abs(data.measurementCoveragePercent - 75) < 0.000_000_1);
  assert.ok(Number.isFinite(data.totalTokens));
  assert.ok(Number.isFinite(data.detailedTokens));

  const svg = renderCacheReportImage({ snapshot, bounds, days: 7 });
  assert.match(svg, /33\.3% cached/);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
});

test("cache report coverage requires valid event totals", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const snapshot = {
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        totalTokens: 1_000,
        inputTokens: 900,
        cachedInputTokens: 450,
        outputTokens: 100,
      },
      {
        timestamp: "2026-08-14T12:00:00.000Z",
        totalTokens: 1_000,
        breakdownAvailable: false,
      },
    ],
  };

  const data = buildCacheReportData(snapshot, bounds, 7, 1_100);
  assert.equal(data.totalTokens, 2_000);
  assert.equal(data.detailedTokens, 1_000);
  assert.equal(data.measurementCoveragePercent, 50);
  assert.equal(data.bins.at(-1).totalTokens, 1_000);
  assert.equal(data.bins.at(-1).detailedTokens, 1_000);
  assert.equal(data.bins.at(-1).measurementCoveragePercent, 100);
});

test("cache report validates explicit breakdown markers against components", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const snapshot = {
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        totalTokens: 1_000,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        breakdownAvailable: true,
      },
      {
        timestamp: "2026-08-15T13:00:00.000Z",
        totalTokens: 1_000,
        inputTokens: 900,
        cachedInputTokens: 450,
        outputTokens: 0,
        breakdownAvailable: true,
      },
      {
        timestamp: "2026-08-15T14:00:00.000Z",
        totalTokens: 1_000,
        inputTokens: 900,
        cachedInputTokens: 450,
        outputTokens: 100,
        breakdownAvailable: true,
      },
    ],
  };

  const data = buildCacheReportData(snapshot, bounds, 7, 1_100);
  assert.equal(data.eventCount, 3);
  assert.equal(data.detailedEventCount, 1);
  assert.equal(data.totalTokens, 3_000);
  assert.equal(data.detailedTokens, 1_000);
  assert.equal(data.inputTokens, 900);
  assert.equal(data.cachedInputTokens, 450);
  assert.equal(data.inputEventCount, 1);
  assert.ok(Math.abs(data.measurementCoveragePercent - 100 / 3) < 0.000_000_1);
});

test("cache report preserves explicit reconciled zero-token breakdowns", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const snapshot = {
    events: [{
      timestamp: "2026-08-15T12:00:00.000Z",
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      breakdownAvailable: true,
    }],
  };

  const data = buildCacheReportData(snapshot, bounds, 7, 1_100);
  assert.equal(data.eventCount, 1);
  assert.equal(data.detailedEventCount, 1);
  assert.equal(data.totalTokens, 0);
  assert.equal(data.detailedTokens, 0);
  assert.equal(data.inputEventCount, 0);
  assert.equal(data.measurementCoveragePercent, 100);

  const svg = renderCacheReportImage({ snapshot, bounds, days: 7 });
  assert.match(svg, /100\.0% of calls/);
  assert.match(svg, /1 of 1 calls/);
});

test("cache report excludes blank token totals", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const snapshot = {
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        totalTokens: "",
        inputTokens: "",
        cachedInputTokens: "",
        outputTokens: "",
        breakdownAvailable: true,
      },
      {
        timestamp: "2026-08-15T13:00:00.000Z",
        totalTokens: " \t",
        inputTokens: " \t",
        cachedInputTokens: " \t",
        outputTokens: " \t",
        breakdownAvailable: true,
      },
    ],
  };

  const data = buildCacheReportData(snapshot, bounds, 7, 1_100);
  assert.equal(data.eventCount, 0);
  assert.equal(data.detailedEventCount, 0);
  assert.equal(data.totalTokens, 0);
  assert.equal(data.inputTokens, 0);
  assert.equal(data.measurementCoveragePercent, null);

  const svg = renderCacheReportImage({ snapshot, bounds, days: 7 });
  assert.match(svg, /unknown/);
  assert.match(svg, /No measured input/);
  assert.match(svg, /0 measured input-bearing calls/);
});

test("cache report contains hostile object-shaped snapshot fields", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const hostileValue = () => ({ toString: null, valueOf: null });
  const snapshot = {
    generatedAt: hostileValue(),
    events: [
      {
        timestamp: hostileValue(),
        model: "gpt-5.6-sol",
        totalTokens: 1_000,
        inputTokens: 900,
        cachedInputTokens: 450,
        outputTokens: 100,
      },
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        model: hostileValue(),
        totalTokens: 1_000,
        inputTokens: 900,
        cachedInputTokens: 450,
        outputTokens: 100,
      },
      {
        timestamp: "2026-08-15T13:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: hostileValue(),
        inputTokens: hostileValue(),
        cachedInputTokens: hostileValue(),
        outputTokens: hostileValue(),
        breakdownAvailable: true,
      },
    ],
  };

  let data;
  let svg;
  assert.doesNotThrow(() => {
    data = buildCacheReportData(snapshot, bounds, 7, 1_100);
    svg = renderCacheReportImage({ snapshot, bounds, days: 7 });
  });
  assert.equal(data.eventCount, 1);
  assert.equal(data.detailedEventCount, 1);
  assert.equal(data.totalTokens, 1_000);
  assert.equal(data.inputTokens, 900);
  assert.deepEqual(
    data.models.map((model) => [model.model, model.inputTokens]),
    [["Unknown", 900]],
  );
  assert.match(svg, />unknown<\/text>/);
  assert.match(svg, /Unknown/);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
});

test("cache report labels non-string generation timestamps as unknown", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const snapshot = {
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 1_000,
        inputTokens: 900,
        cachedInputTokens: 450,
        outputTokens: 100,
      },
    ],
  };

  for (const generatedAt of [null, 0, { toString: null, valueOf: null }]) {
    const svg = renderCacheReportImage({
      snapshot: { ...snapshot, generatedAt },
      bounds,
      days: 7,
    });
    assert.match(svg, /DATA AS OF[\s\S]*>unknown<\/text>/);
  }
});

test("cache report coalesces overflow models and renders zero-measurement state", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const modelNames = [
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.5-daybreak-blue-latest",
    "gpt-5.5-auto-review",
  ];
  const overflowSnapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: modelNames.map((model, index) => {
      const inputTokens = (index + 1) * 100;
      return {
        timestamp: "2026-08-15T12:00:00.000Z",
        model,
        totalTokens: inputTokens + 10,
        inputTokens,
        cachedInputTokens: inputTokens / 2,
        outputTokens: 10,
        breakdownAvailable: true,
      };
    }),
  };
  const overflowSvg = renderCacheReportImage({
    snapshot: overflowSnapshot,
    bounds,
    days: 7,
  });
  assert.match(
    overflowSvg,
    /Other models<\/text>[\s\S]{0,800}>50\.0%<\/text>/,
  );

  const unmeasuredSnapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: [{
      timestamp: "2026-08-15T12:00:00.000Z",
      model: "gpt-5.6-luna",
      totalTokens: 1_000,
      inputTokens: 900,
      cachedInputTokens: 450,
      outputTokens: 100,
      breakdownAvailable: false,
    }],
  };
  const unmeasured = buildCacheReportData(unmeasuredSnapshot, bounds, 7, 1_100);
  assert.equal(unmeasured.rate, null);
  assert.equal(unmeasured.measurementCoveragePercent, 0);
  const unmeasuredSvg = renderCacheReportImage({
    snapshot: unmeasuredSnapshot,
    bounds,
    days: 7,
  });
  assert.match(unmeasuredSvg, /No measured input/);
  assert.match(unmeasuredSvg, /0\.00% of token volume/);
  assert.match(unmeasuredSvg, /0 measured input-bearing calls/);
  assert.doesNotMatch(unmeasuredSvg, /NaN|Infinity|undefined/);
});

test("cache report separates the final multi-day axis label", () => {
  const bounds = multiDayBounds("2026-08-20", "UTC", 90);
  const snapshot = {
    generatedAt: "2026-08-20T12:00:00.000Z",
    events: [],
  };
  const data = buildCacheReportData(snapshot, bounds, 90, 1_104);
  assert.equal(data.binSize, 3);
  assert.equal(data.binCount, 30);
  const svg = renderCacheReportImage({ snapshot, bounds, days: 90 });
  assert.match(svg, /Aug 18–Aug 20/);
  assert.doesNotMatch(svg, /Aug 12–Aug 14/);
});

test("cache report keeps 30 daily bins at default width and coalesces at minimum width", () => {
  const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", 30);
  const snapshot = {
    events: [
      {
        timestamp: "2026-08-15T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 100,
        inputTokens: 90,
        cachedInputTokens: 45,
        outputTokens: 10,
      },
    ],
  };
  const defaultWidth = buildCacheReportData(snapshot, bounds, 30, 1_104);
  assert.equal(defaultWidth.binSize, 1);
  assert.equal(defaultWidth.binCount, 30);

  const minimumWidth = buildCacheReportData(snapshot, bounds, 30, 724);
  assert.equal(minimumWidth.binSize, 2);
  assert.equal(minimumWidth.binCount, 15);
});

test("cache report wraps long timezone footer text at minimum width", () => {
  const timeZone = "America/Argentina/ComodRivadavia";
  const bounds = multiDayBounds("2026-08-15", timeZone, 7);
  const minimumSvg = renderCacheReportImage({
    snapshot: { generatedAt: "2026-08-15T12:00:00.000Z", events: [] },
    bounds,
    days: 7,
    options: { imageWidth: 900 },
  });

  assert.match(minimumSvg, />America\/Argentina\/ComodRivadavia<\/text>/);
  assert.match(minimumSvg, />7-day calendar window<\/text>/);
  assert.doesNotMatch(
    minimumSvg,
    /America\/Argentina\/ComodRivadavia · 7-day calendar window/,
  );

  const shortZoneSvg = renderCacheReportImage({
    snapshot: { generatedAt: "2026-08-15T12:00:00.000Z", events: [] },
    bounds: multiDayBounds("2026-08-15", "UTC", 7),
    days: 7,
    options: { imageWidth: 900 },
  });
  assert.match(shortZoneSvg, />UTC · 7-day calendar window<\/text>/);

  const wideSvg = renderCacheReportImage({
    snapshot: { generatedAt: "2026-08-15T12:00:00.000Z", events: [] },
    bounds,
    days: 7,
    options: { imageWidth: 2_400 },
  });
  assert.match(
    wideSvg,
    />America\/Argentina\/ComodRivadavia · 7-day calendar window<\/text>/,
  );
});

test("cache report wraps large measurement counts within the minimum-width footer column", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const event = {
    timestamp: "2026-08-15T12:00:00.000Z",
    model: "gpt-5.6-luna",
    totalTokens: 1,
    inputTokens: 1,
    cachedInputTokens: 1,
    outputTokens: 0,
    breakdownAvailable: true,
  };
  const snapshot = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    events: Array(100_000).fill(event),
  };
  const minimumSvg = renderCacheReportImage({
    snapshot,
    bounds,
    days: 7,
    options: { imageWidth: 900 },
  });

  const countLine = "100,000 of 100,000 calls";
  const detailLine = "include component detail";
  assert.match(minimumSvg, new RegExp(`>${countLine}<\\/text>`));
  assert.match(minimumSvg, new RegExp(`>${detailLine}<\\/text>`));
  assert.doesNotMatch(
    minimumSvg,
    /100,000 of 100,000 calls include component detail/,
  );

  const dividerX = 32 + ((900 - 64) / 3) * 2;
  assert.match(
    minimumSvg,
    new RegExp(`<line x1="${dividerX.toFixed(2)}"[^>]*x2="${dividerX.toFixed(2)}"`),
  );
  for (const line of [countLine, detailLine]) {
    const escapedLine = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = minimumSvg.match(
      new RegExp(`<text x="([^"]+)"[^>]*font-size="12px"[^>]*>${escapedLine}<\\/text>`),
    );
    assert.ok(match, `expected footer line: ${line}`);
    const rightEdge = Number(match[1]) + textWidth(line, 12);
    assert.ok(rightEdge <= dividerX, `${line} crosses the footer divider`);
  }

  const normalSvg = renderCacheReportImage({
    snapshot: { ...snapshot, events: [event] },
    bounds,
    days: 7,
    options: { imageWidth: 900 },
  });
  assert.match(normalSvg, />1 of 1 calls include component detail<\/text>/);

  const wideSvg = renderCacheReportImage({
    snapshot,
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
  });
  assert.match(
    wideSvg,
    />100,000 of 100,000 calls include component detail<\/text>/,
  );
});

test("cache report moves long timezone header metadata below the title", () => {
  const timeZone = "America/Argentina/ComodRivadavia";
  const bounds = multiDayBounds("2026-08-15", timeZone, 7);
  const minimumSvg = renderCacheReportImage({
    snapshot: { events: [] },
    bounds,
    days: 7,
    options: { imageWidth: 900 },
  });

  assert.match(
    minimumSvg,
    /<text x="32" y="53"[^>]*>TOKEN LEDGER · CACHE REPORT<\/text>/,
  );
  assert.match(
    minimumSvg,
    /<text x="868" y="77"[^>]*>Aug 9 – Aug 15, 2026 · America\/Argentina\/ComodRivadavia<\/text>/,
  );

  const shortZoneSvg = renderCacheReportImage({
    snapshot: { events: [] },
    bounds: multiDayBounds("2026-08-15", "UTC", 7),
    days: 7,
    options: { imageWidth: 900 },
  });
  assert.match(
    shortZoneSvg,
    /<text x="868" y="53"[^>]*>Aug 9 – Aug 15, 2026 · UTC<\/text>/,
  );
  assert.doesNotMatch(
    shortZoneSvg,
    /<text x="868" y="77"[^>]*>Aug 9 – Aug 15, 2026 · UTC<\/text>/,
  );

  const filteredLongZoneSvg = renderCacheReportImage({
    snapshot: {
      events: [],
      provenance: {
        collection: {
          since: "2026-08-01T00:00:00.000Z",
          includeArchived: false,
        },
      },
    },
    bounds: multiDayBounds("2026-08-15", "America/Argentina/Buenos_Aires", 7),
    days: 7,
    options: { imageWidth: 900 },
  });
  const filteredMetadata = filteredLongZoneSvg.match(
    /<text x="868" y="77"[^>]*>([^<]+)<\/text>/,
  )?.[1];
  assert.ok(filteredMetadata);
  assert.ok(textWidth(filteredMetadata, 14) <= 836);
  assert.match(filteredMetadata, /…$/);

  const wideSvg = renderCacheReportImage({
    snapshot: { events: [] },
    bounds,
    days: 7,
    options: { imageWidth: 1_280 },
  });
  assert.match(
    wideSvg,
    /<text x="1248" y="53"[^>]*>Aug 9 – Aug 15, 2026 · America\/Argentina\/ComodRivadavia<\/text>/,
  );
});

test("cache report spaces long multi-day labels at minimum width", () => {
  const bounds = multiDayBounds("2026-08-20", "UTC", 180);
  const svg = renderCacheReportImage({
    snapshot: { events: [] },
    bounds,
    days: 180,
    options: { imageWidth: 900 },
  });
  const labels = [...svg.matchAll(
    /<text x="([^"]+)" y="730"[^>]*>([^<]+)<\/text>/g,
  )].map((match) => ({
    x: Number(match[1]),
    value: match[2],
  }));

  assert.ok(labels.length >= 2, "expected multiple date labels");
  for (let index = 1; index < labels.length; index += 1) {
    const previous = labels[index - 1];
    const current = labels[index];
    const minimumDistance =
      (textWidth(previous.value, 13) + textWidth(current.value, 13)) / 2 + 12;
    assert.ok(
      current.x - previous.x >= minimumDistance,
      `${previous.value} overlaps ${current.value}`,
    );
  }
});

test("PNG image output has a real PNG signature", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-png-");
  try {
    const output = resolve(root, "report.png");
    await writeTrendPng(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="#10a394"/></svg>',
      output,
    );
    const bytes = await readFile(output);
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("report emits progress while generating the PNG", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-report-");
  const snapshotPath = resolve(root, "snapshot.json");
  const outputPath = resolve(root, "report.png");
  const originalWrite = process.stderr.write;
  const stderr = [];
  try {
    await writeFile(
      snapshotPath,
      `${JSON.stringify({
        schemaVersion: 3,
        generatedAt: "2026-08-15T12:00:00.000Z",
        events: [
          {
            timestamp: "2026-08-15T12:00:00.000Z",
            model: "gpt-5.5",
            totalTokens: 1_000,
            inputTokens: 900,
            cachedInputTokens: 0,
            outputTokens: 100,
            reasoningTokens: 0,
            serviceTier: null,
            rateCardCredits: 0.2,
          },
        ],
        threads: [],
        quotaObservations: [],
      })}\n`,
    );
    process.stderr.write = (chunk) => {
      stderr.push(String(chunk));
      return true;
    };
    const result = await run(parseArgs([
      "report",
      "7d",
      "--date",
      "2026-08-15",
      "--tz",
      "UTC",
      "--input",
      snapshotPath,
      "--image-output",
      outputPath,
    ]));
    assert.match(result, /Wrote report:/);
    assert.deepEqual(
      [...(await readFile(outputPath)).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    const progress = stderr.join("");
    assert.match(progress, /generating report PNG/);
    assert.match(progress, /encoding report PNG/);
    assert.match(progress, /finished report PNG/);
  } finally {
    process.stderr.write = originalWrite;
    await rm(root, { recursive: true, force: true });
  }
});

test("standard report preserves split prior-period comparison fragments", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-report-prior-split-");
  const snapshotPath = resolve(root, "snapshot.json");
  const outputPath = resolve(root, "report.png");
  const expectedPath = resolve(root, "expected.png");
  const originalWrite = process.stderr.write;
  const nowMs = Date.parse("2026-08-15T12:00:00.000Z");
  const snapshot = {
    schemaVersion: 3,
    generatedAt: new Date(nowMs).toISOString(),
    events: [
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        startAt: "2026-08-01T12:00:00.000Z",
        endAt: "2026-08-02T12:00:00.000Z",
        project: "prior",
        model: "gpt-5.6-luna",
        totalTokens: 1_000,
        inputTokens: 900,
        outputTokens: 100,
        callCount: 2,
        resolutionSeconds: 86_400,
      },
      {
        timestamp: "2026-08-12T12:00:00.000Z",
        project: "current",
        model: "gpt-5.6-luna",
        totalTokens: 1_000,
        inputTokens: 900,
        outputTokens: 100,
      },
    ],
    threads: [],
    quotaObservations: [],
  };

  try {
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
    process.stderr.write = () => true;
    const options = parseArgs([
      "report",
      "7d",
      "--date",
      "2026-08-15",
      "--tz",
      "UTC",
      "--input",
      snapshotPath,
      "--image-output",
      outputPath,
      "--no-open",
    ]);
    await run(options, { nowMs });

    const bounds = multiDayBounds("2026-08-15", "UTC", 7);
    const analysis = buildRangeAnalysis(snapshot, bounds, {
      priorBounds: priorPeriodBounds(bounds, 7),
    });
    const currentEvents = filterDayEvents(snapshot, bounds, analysis);
    const projectRows = aggregateProjects(
      snapshot,
      currentEvents,
      options,
      analysis,
    );
    const viewModel = buildTrendReportViewModel({
      snapshot,
      bounds,
      days: 7,
      reportTimeMs: nowMs,
      sourceStatus: "explicit-snapshot",
      projectRows,
      events: analysis.currentEvents,
      priorEvents: analysis.priorEvents,
    });
    assert.ok(
      Math.abs(viewModel.summary.priorEquivalentTokens - 500) < 0.001,
    );
    assert.ok(Math.abs(viewModel.summary.totalDeltaPercent - 100) < 0.001);
    assert.equal(viewModel.summary.priorEquivalentEstimated, true);
    assert.equal(viewModel.summary.totalDeltaEstimated, true);

    const expectedSvg = renderTrendImage({
      snapshot,
      bounds,
      trend: buildUsageTrend(snapshot, bounds, { analysis }),
      days: 7,
      options,
      viewModel,
    });
    assert.match(expectedSvg, />≈\+100\.0%<\/text>/);
    await writeTrendPng(expectedSvg, expectedPath);
    assert.deepEqual(await readFile(outputPath), await readFile(expectedPath));
  } finally {
    process.stderr.write = originalWrite;
    await rm(root, { recursive: true, force: true });
  }
});

test("cache-rate report uses its separate renderer and progress label", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-cache-report-");
  const snapshotPath = resolve(root, "snapshot.json");
  const outputPath = resolve(root, "cache-report.png");
  const originalWrite = process.stderr.write;
  const stderr = [];
  try {
    await writeFile(
      snapshotPath,
      `${JSON.stringify({
        schemaVersion: 3,
        generatedAt: "2026-08-15T12:00:00.000Z",
        events: [
          {
            timestamp: "2026-08-15T12:00:00.000Z",
            model: "gpt-5.6-luna",
            totalTokens: 1_000,
            inputTokens: 900,
            cachedInputTokens: 600,
            outputTokens: 100,
          },
        ],
        threads: [],
        quotaObservations: [],
      })}\n`,
    );
    process.stderr.write = (chunk) => {
      stderr.push(String(chunk));
      return true;
    };
    const result = await run(parseArgs([
      "report",
      "7d",
      "--cache-rate",
      "--date",
      "2026-08-15",
      "--tz",
      "UTC",
      "--input",
      snapshotPath,
      "--image-output",
      outputPath,
    ]));
    assert.match(result, /Wrote cache report:/);
    assert.deepEqual(
      [...(await readFile(outputPath)).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    const progress = stderr.join("");
    assert.match(progress, /generating cache report PNG/);
    assert.match(progress, /encoding cache report PNG/);
    assert.match(progress, /finished cache report PNG/);
  } finally {
    process.stderr.write = originalWrite;
    await rm(root, { recursive: true, force: true });
  }
});

test("cache-rate report ignores unused project metadata for an empty range", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-cache-empty-");
  const snapshotPath = resolve(root, "snapshot.json");
  const outputPath = resolve(root, "cache-report.png");
  const originalWrite = process.stderr.write;
  try {
    await writeFile(
      snapshotPath,
      `${JSON.stringify({
        schemaVersion: 3,
        generatedAt: "2026-08-15T12:00:00.000Z",
        events: [
          null,
          { timestamp: { toString: null, valueOf: null } },
          {
            timestamp: "2026-07-01T12:00:00.000Z",
            model: "gpt-5.6-luna",
            totalTokens: 1_000,
            inputTokens: 900,
            cachedInputTokens: 450,
            outputTokens: 100,
          },
        ],
        threads: [null],
      })}\n`,
    );
    process.stderr.write = () => true;
    const result = await run(parseArgs([
      "report",
      "7d",
      "--cache-rate",
      "--date",
      "2026-08-15",
      "--tz",
      "UTC",
      "--input",
      snapshotPath,
      "--image-output",
      outputPath,
      "--no-open",
    ]));
    assert.match(result, /Wrote cache report:/);
    assert.deepEqual(
      [...(await readFile(outputPath)).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
  } finally {
    process.stderr.write = originalWrite;
    await rm(root, { recursive: true, force: true });
  }
});

test("standard image views retain the empty-range diagnostic", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-standard-empty-");
  const snapshotPath = resolve(root, "snapshot.json");
  try {
    await writeFile(
      snapshotPath,
      `${JSON.stringify({
        schemaVersion: 3,
        generatedAt: "2026-08-15T12:00:00.000Z",
        events: [
          null,
          { timestamp: { toString: null, valueOf: null } },
          {
            timestamp: "2026-07-01T12:00:00.000Z",
            model: "gpt-5.6-luna",
            totalTokens: 1_000,
            inputTokens: 900,
            outputTokens: 100,
          },
        ],
      })}\n`,
    );
    const commands = [
      ["report", "7d"],
      ["trend", "7d", "--image"],
    ];
    for (const [index, command] of commands.entries()) {
      const outputPath = resolve(root, `standard-${index}.png`);
      const result = await run(parseArgs([
        ...command,
        "--date",
        "2026-08-15",
        "--tz",
        "UTC",
        "--input",
        snapshotPath,
        "--image-output",
        outputPath,
        "--no-open",
      ]));
      assert.match(result, /No model-call events found/);
      await assert.rejects(readFile(outputPath), { code: "ENOENT" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cache-rate report uses a distinct default filename", async () => {
  const root = await createPrivateFixtureRoot("token-ledger-cache-default-");
  const snapshotPath = resolve(root, "snapshot.json");
  const outputPath = resolve(root, "token-ledger-cache-report-7d.png");
  try {
    await writeFile(
      snapshotPath,
      `${JSON.stringify({
        schemaVersion: 3,
        generatedAt: "2026-08-15T12:00:00.000Z",
        events: [
          {
            timestamp: "2026-08-15T12:00:00.000Z",
            model: "gpt-5.6-sol",
            totalTokens: 1_000,
            inputTokens: 900,
            cachedInputTokens: 450,
            outputTokens: 100,
          },
        ],
      })}\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        CLI_ENTRYPOINT,
        "report",
        "7d",
        "--cache-rate",
        "--date",
        "2026-08-15",
        "--tz",
        "UTC",
        "--input",
        snapshotPath,
        "--no-open",
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Wrote cache report:/);
    assert.match(result.stdout, /token-ledger-cache-report-7d\.png/);
    assert.deepEqual(
      [...(await readFile(outputPath)).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("30-day trend bins use readable multi-day columns", () => {
  const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", 30);
  const snapshot = {
    events: [
      {
        timestamp: "2026-07-20T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 1,
      },
    ],
  };
  const narrow = buildActualTokenBins(snapshot, bounds, 30, 96);
  const wide = buildActualTokenBins(snapshot, bounds, 30, 120);
  assert.equal(narrow.binSize, 3);
  assert.equal(wide.binSize, 2);
  assert.equal(narrow.binCount, 10);
  assert.equal(wide.binCount, 15);

  const forced = buildActualTokenBins(snapshot, bounds, 30, 96, { binSize: 1 });
  assert.equal(forced.binSize, 1);
  assert.equal(forced.binCount, 30);
});

test("long trend windows fit terminal and image column widths", () => {
  const days = 3_650;
  const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", days);
  const snapshot = {
    events: [{
      timestamp: "2026-08-14T12:00:00.000Z",
      model: "gpt-5.6-luna",
      totalTokens: 1,
    }],
  };
  const terminal = buildActualTokenBins(snapshot, bounds, days, 36);
  assert.ok(terminal.binCount <= 36);
  assert.ok(terminal.binSize > 1);
  const terminalOutput = renderTrendPlain({
    snapshot,
    bounds,
    trend: buildUsageTrend(snapshot, bounds),
    days,
    options: { width: 96 },
  });
  assert.ok(terminalOutput.split("\n").every((line) => line.length <= 96));

  const imagePlotWidth = 1_280 - 96 - 96;
  const image = buildActualTokenBins(snapshot, bounds, days, imagePlotWidth, {
    minBinWidth: 26,
    preferDaily: true,
  });
  assert.ok(image.binCount <= Math.floor(imagePlotWidth / 26));
  assert.ok(image.binSize > 1);
  const svg = renderTrendImage({
    snapshot,
    bounds,
    trend: buildUsageTrend(snapshot, bounds),
    days,
    options: { imageWidth: 1_280 },
  });
  assert.match(svg, /<title[^>]*>Token Ledger · 3650-day trend<\/title>/);
  assert.doesNotMatch(svg, /NaN/);
});

test("the 30-day report image draws one bar per calendar day", () => {
  const bounds = multiDayBounds("2026-08-15", "Pacific/Honolulu", 30);
  const snapshot = {
    events: [
      {
        timestamp: "2026-07-20T12:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 5_000_000,
      },
      {
        timestamp: "2026-08-14T12:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: 7_500_000,
      },
    ],
  };
  const svg = renderTrendImage({
    snapshot,
    bounds,
    trend: buildUsageTrend(snapshot, bounds),
    days: 30,
    options: { imageWidth: 1_280 },
  });
  assert.match(svg, /<title[^>]*>Token Ledger · 30-day trend<\/title>/);
  // Weekday captions only render on per-day columns, so their presence shows
  // the 30-day window still fits as daily bars at this image width.
  assert.match(svg, /\bTUE\b/);
  // Per-day columns mean no multi-day range labels like "Jul 17–19" beneath
  // the bars (the en dash in the header subtitle is surrounded by spaces).
  assert.doesNotMatch(svg, /\d–[A-Za-z]*\s*\d/);
});

test("fullscreen renderer applies the Codex Blue terminal theme", () => {
  const snapshot = { events: [] };
  const events = [
    {
      project: "alpha",
      threadId: "alpha-1",
      model: "gpt-5.6-sol",
      inputTokens: 800,
      cachedInputTokens: 400,
      totalTokens: 1_000,
      outputTokens: 200,
      rateCardCredits: 2,
      useType: "sdk",
    },
  ];
  const rows = aggregateProjects(snapshot, events, { rawProjects: true });
  const output = renderFullscreen({
    options: { range: "day", plain: false, ascii: false, forceColor: true },
    bounds: dayBounds("2026-08-01", "Pacific/Honolulu"),
    events,
    rows,
    allRows: rows,
    width: 100,
    height: 30,
  });
  assert.equal(output.split("\n").length, 30);
  assert.doesNotMatch(output, /TOKEN LEDGER — USAGE/);
  assert.doesNotMatch(output, /●/);
  assert.match(output, /\u001b\[38;2;255;255;255m/);
  assert.match(output, /\u001b\[38;2;51;156;255m/);
  assert.match(output, /\u001b\[38;2;120;185;242m/);
  assert.match(output, /\u001b\[38;2;214;168;95m/);
  assert.match(output, /\u001b\[38;2;174;139;219m/);
  assert.match(output, /\u001b\[38;2;116;125;144m/);
  assert.match(output, /\u001b\[38;2;155;155;155m/);
  assert.match(output, /\u001b\[38;2;88;88;88m/);
  assert.match(output, /\u001b\[38;2;59;59;59m/);
  assert.match(output, /\u001b\[48;2;30;30;30m/);
  assert.match(output, /\u001b\[48;2;24;24;24m/);
  assert.doesNotMatch(output, /\u001b\[(?:38|48);5;/);
});

test("epoch-keyed cycles split limit restarts and classify reset kinds", () => {
  const epochOne = Date.parse("2026-08-10T00:00:00.000Z") / 1_000;
  const epochTwo = Date.parse("2026-08-12T00:00:00.000Z") / 1_000;
  const observations = normalizeQuotaTimeline([
    {
      timestampMs: Date.parse("2026-08-04T00:00:00.000Z"),
      resetsAt: epochOne,
      usedPercent: 50,
    },
    {
      timestampMs: Date.parse("2026-08-04T12:00:00.000Z"),
      resetsAt: epochOne,
      usedPercent: 90,
    },
    // A fresh window starts days before the old one expires: a limit restart,
    // not a weekly reset, and never a continuation of the old cycle.
    {
      timestampMs: Date.parse("2026-08-05T00:00:00.000Z"),
      resetsAt: epochTwo,
      usedPercent: 0,
    },
    {
      timestampMs: Date.parse("2026-08-05T12:00:00.000Z"),
      resetsAt: epochTwo,
      usedPercent: 30,
    },
  ]);
  assert.deepEqual(
    observations.map((observation) => observation.cycle),
    [0, 0, 1, 1],
  );
  assert.equal(observations[2].reset, true);
  assert.equal(observations[2].resetKind, "restart");
  assert.deepEqual(
    observations.map((observation) => observation.normalizedUsedPercent),
    [50, 90, 0, 30],
  );
});

test("stale readings from a superseded window are dropped", () => {
  const epochOne = Date.parse("2026-08-10T00:00:00.000Z") / 1_000;
  const epochTwo = Date.parse("2026-08-12T00:00:00.000Z") / 1_000;
  const observations = normalizeQuotaTimeline([
    {
      timestampMs: Date.parse("2026-08-04T00:00:00.000Z"),
      resetsAt: epochOne,
      usedPercent: 50,
    },
    {
      timestampMs: Date.parse("2026-08-05T00:00:00.000Z"),
      resetsAt: epochTwo,
      usedPercent: 5,
    },
    // A long-lived session still echoing the superseded window must not fold
    // its reading into the new cycle.
    {
      timestampMs: Date.parse("2026-08-05T06:00:00.000Z"),
      resetsAt: epochOne,
      usedPercent: 95,
    },
    {
      timestampMs: Date.parse("2026-08-05T12:00:00.000Z"),
      resetsAt: epochTwo,
      usedPercent: 20,
    },
  ]);
  assert.equal(observations.length, 3);
  assert.deepEqual(
    observations.map((observation) => observation.normalizedUsedPercent),
    [50, 5, 20],
  );
});

test("a transient branch window inside a live cycle is ignored", () => {
  const epochOne = Date.parse("2026-08-10T00:00:00.000Z") / 1_000;
  const phantom = Date.parse("2026-08-14T00:00:00.000Z") / 1_000;
  const observations = normalizeQuotaTimeline([
    {
      timestampMs: Date.parse("2026-08-04T00:00:00.000Z"),
      resetsAt: epochOne,
      usedPercent: 20,
    },
    {
      timestampMs: Date.parse("2026-08-05T00:00:00.000Z"),
      resetsAt: phantom,
      usedPercent: 0,
    },
    {
      timestampMs: Date.parse("2026-08-06T00:00:00.000Z"),
      resetsAt: epochOne,
      usedPercent: 40,
    },
    {
      timestampMs: Date.parse("2026-08-07T00:00:00.000Z"),
      resetsAt: epochOne,
      usedPercent: 60,
    },
  ]);
  assert.deepEqual(
    observations.map((observation) => observation.cycle),
    [0, 0, 0],
  );
  assert.deepEqual(
    observations.map((observation) => observation.normalizedUsedPercent),
    [20, 40, 60],
  );
});

test("named limit buckets are not stitched into the account meter", () => {
  const accountEpoch = Date.parse("2026-08-16T00:00:00.000Z") / 1_000;
  const namedEpoch = Date.parse("2026-08-18T00:00:00.000Z") / 1_000;
  const snapshot = {
    metadata: CURRENT_QUOTA_METADATA,
    quotaObservations: [
      {
        timestamp: "2026-08-12T00:00:00.000Z",
        usedPercent: 10,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt: accountEpoch,
      },
      {
        timestamp: "2026-08-12T01:00:00.000Z",
        usedPercent: 50,
        scope: "named",
        windowMinutes: 10_080,
        resetsAt: namedEpoch,
        limitKey: NAMED_QUOTA_LIMIT_KEY,
        limitName: "GPT-5.3-Codex-Spark",
      },
      {
        timestamp: "2026-08-12T02:00:00.000Z",
        usedPercent: 20,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt: accountEpoch,
      },
    ],
  };
  const observations = weeklyQuotaObservations(snapshot);
  assert.deepEqual(
    observations.map((observation) => observation.usedPercent),
    [10, 20],
  );
});

test("account-scoped weekly observations remain the selected account meter", () => {
  const resetAt = Date.parse("2026-08-22T00:00:00.000Z") / 1_000;
  const account = [
    {
      timestamp: "2026-08-18T00:00:00.000Z",
      usedPercent: 10,
      windowMinutes: 10_080,
      resetsAt: resetAt,
      scope: "account",
      limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
    },
    {
      timestamp: "2026-08-19T00:00:00.000Z",
      usedPercent: 20,
      windowMinutes: 10_080,
      resetsAt: resetAt,
      scope: "account",
      limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
    },
  ];
  const named = {
    timestamp: "2026-08-19T01:00:00.000Z",
    usedPercent: 90,
    windowMinutes: 10_080,
    resetsAt: resetAt,
    limitKey: NAMED_QUOTA_LIMIT_KEY,
    limitName: "Luna",
    scope: "named",
  };
  assert.deepEqual(
    weeklyQuotaObservations({
      metadata: CURRENT_QUOTA_METADATA,
      quotaObservations: [...account, named],
    })
      .map((observation) => observation.usedPercent),
    [10, 20],
  );
  assert.deepEqual(
    weeklyQuotaObservations({
      metadata: CURRENT_QUOTA_METADATA,
      quotaObservations: account,
    })
      .map((observation) => observation.usedPercent),
    [10, 20],
  );
});

test("named-only weekly pools do not form an account meter", () => {
  const bounds = multiDayBounds("2026-08-20", "UTC", 7);
  const resetA = Date.parse("2026-08-22T00:00:00.000Z") / 1_000;
  const resetB = Date.parse("2026-08-23T00:00:00.000Z") / 1_000;
  const quotaObservations = [
    {
      timestamp: "2026-08-18T00:00:00.000Z",
      usedPercent: 20,
      windowMinutes: 10_080,
      resetsAt: resetA,
      limitKey: NAMED_QUOTA_LIMIT_KEY,
      limitName: "Luna",
      scope: "named",
    },
    {
      timestamp: "2026-08-19T00:00:00.000Z",
      usedPercent: 40,
      windowMinutes: 10_080,
      resetsAt: resetA,
      limitKey: NAMED_QUOTA_LIMIT_KEY,
      limitName: "Luna",
      scope: "named",
    },
    {
      timestamp: "2026-08-20T00:00:00.000Z",
      usedPercent: 60,
      windowMinutes: 10_080,
      resetsAt: resetA,
      limitKey: NAMED_QUOTA_LIMIT_KEY,
      limitName: "Luna",
      scope: "named",
    },
    {
      timestamp: "2026-08-18T01:00:00.000Z",
      usedPercent: 50,
      windowMinutes: 10_080,
      resetsAt: resetB,
      limitKey: NAMED_QUOTA_LIMIT_KEY,
      limitName: "Sol",
      scope: "named",
    },
  ];
  const snapshot = {
    generatedAt: "2026-08-20T12:00:00.000Z",
    metadata: CURRENT_QUOTA_METADATA,
    events: [{
      timestamp: "2026-08-19T12:00:00.000Z",
      model: "gpt-5.6-luna",
      totalTokens: 100,
      inputTokens: 100,
    }],
    quotaObservations,
  };
  assert.deepEqual(weeklyQuotaObservations(snapshot), []);
  // A current-contract row without explicit scope is malformed and must not
  // revive the old largest-pool fallback.
  assert.deepEqual(
    weeklyQuotaObservations({
      ...snapshot,
      quotaObservations: quotaObservations.map((observation) => {
        const legacyObservation = { ...observation };
        delete legacyObservation.scope;
        return legacyObservation;
      }),
    }),
    [],
  );

  const trend = buildUsageTrend(snapshot, bounds);
  assert.equal(trend.available, false);
  assert.deepEqual(trend.points, []);
  const quota = quotaCycleSummary(snapshot, snapshot.events);
  assert.equal(quota.available, false);
  assert.equal(quota.usedPercent, null);
  assert.equal(quota.remainingPercent, null);

  const terminal = renderTrendPlain({
    snapshot,
    bounds,
    trend,
    days: 7,
    options: { width: 120 },
  });
  assert.match(terminal, /TOKEN LEDGER · ACTUAL TOKENS ·/);
  assert.match(terminal, /NO ACCOUNT-WIDE WEEKLY METER OBSERVED/);
  assert.doesNotMatch(terminal, /ACTUAL TOKENS \+ WEEKLY QUOTA/);
  assert.doesNotMatch(terminal, /RIGHT AXIS|LINE · OBSERVED WEEKLY QUOTA/);

  const image = renderTrendImage({
    snapshot,
    bounds,
    trend,
    days: 7,
    options: { imageWidth: 1_000 },
  });
  assert.doesNotMatch(image, /WEEKLY LIMIT · OPENAI REPORTED/);
  assert.doesNotMatch(image, /data-series="weekly-meter"/);
  assert.doesNotMatch(image, /OpenAI-reported weekly limit/);
});

test("burn day bins place observed drops on days in meter percent units", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const resetsAt = Date.parse("2026-08-16T00:00:00.000Z") / 1_000;
  const snapshot = {
    metadata: CURRENT_QUOTA_METADATA,
    events: [
      {
        // Bogus stored credits must lose to recomputation under the current
        // rate card: 2.5M uncached Luna input = 12.5 credits.
        timestamp: "2026-08-12T09:00:00.000Z",
        model: "gpt-5.6-luna",
        totalTokens: 2_500_000,
        inputTokens: 2_500_000,
        cachedInputTokens: 0,
        outputTokens: 0,
        rateCardCredits: 9_999,
      },
      {
        // 100K uncached Sol input = 10 credits under the promotional card.
        timestamp: "2026-08-12T12:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: 100_000,
        inputTokens: 100_000,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
    ],
    quotaObservations: [
      {
        timestamp: "2026-08-12T06:00:00.000Z",
        usedPercent: 0,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt,
      },
      {
        timestamp: "2026-08-12T18:00:00.000Z",
        usedPercent: 20,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt,
      },
      {
        timestamp: "2026-08-15T00:00:00.000Z",
        usedPercent: 40,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt,
      },
    ],
  };
  const trend = buildUsageTrend(snapshot, bounds);
  const burn = buildBurnDayBins(trend, bounds, { days: 7, binSize: 1 });
  const approximately = (actual, expected) =>
    assert.ok(
      Math.abs(actual - expected) < 0.01,
      `expected ${expected}, got ${actual}`,
    );

  const day12 = burn.bins[3];
  assert.equal(day12.startDateString, "2026-08-12");
  approximately(day12.values.get("Luna"), 20 * (12.5 / 22.5));
  approximately(day12.values.get("Sol"), 20 * (10 / 22.5));
  // The eventless 54-hour drop is spread across its span by duration and
  // flagged approximate: 6h on Aug 12, 24h each on Aug 13 and Aug 14.
  approximately(day12.values.get("Unattributed"), 20 * (6 / 54));
  approximately(burn.bins[4].values.get("Unattributed"), 20 * (24 / 54));
  approximately(burn.bins[5].values.get("Unattributed"), 20 * (24 / 54));
  assert.equal(burn.bins[5].approximate, true);
  approximately(burn.totalPercent, 40);
  approximately(burn.totals.get("Luna"), 20 * (12.5 / 22.5));
  approximately(burn.totals.get("Sol"), 20 * (10 / 22.5));
  approximately(burn.totals.get("Unattributed"), 20);
});

test("rate card prices Luna at the current published credit rates", () => {
  const credits = calculateCodexPurchasedCredits({
    model: "gpt-5.6-luna",
    serviceTier: null,
    usage: {
      totalTokens: 2_000_000,
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
    },
  });
  assert.equal(credits, 35);
});

test("unsupported fast aliases remain unrated after snapshot recomputation", () => {
  const event = {
    model: "daybreak-red",
    rateCardModel: "gpt-daybreak-red-latest",
    serviceTier: "priority",
    totalTokens: 100_000,
    inputTokens: 100_000,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  assert.equal(eventCredits(event), null);
  const rows = aggregateProjects(
    { events: [], threads: [] },
    [event],
    { rawProjects: true },
  );
  assert.equal(rows[0].rateCardCredits, 0);
});

test("purchased-credit calculator applies current rows and fast tiers", () => {
  const usage = {
    totalTokens: 3_000_000,
    inputTokens: 2_000_000,
    cachedInputTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 1_000_000,
  };
  const credits = (model, serviceTier = null, eventUsage = usage) =>
    calculateCodexPurchasedCredits({ model, serviceTier, usage: eventUsage });

  assert.equal(credits("gpt-5.6-sol"), 610);
  assert.equal(credits("gpt-5.5-cyber"), 2_218.75);
  assert.equal(credits("daybreak-red", "priority"), 5_546.875);
  assert.equal(credits("daybreak-blue", "fast"), 1_525);
  assert.equal(credits("gpt-5.6-sol", " Priority "), 1_525);
  assert.equal(credits("gpt-5.5", "FAST"), 2_218.75);
  assert.equal(credits("gpt-5.4", "fast"), 887.5);
  assert.equal(codexCreditMultiplier("gpt-5.6-luna", "priority"), 2.5);
  assert.equal(codexCreditMultiplier("gpt-5.4", "fast"), 2);

  for (const tier of ["priority", " Priority ", "fast", "FAST"]) {
    assert.equal(isFastServiceTier(tier), true);
  }
  for (const tier of [null, "", "standard", "flex", "ultrafast", "unknown"]) {
    assert.equal(isFastServiceTier(tier), false);
    assert.equal(credits("gpt-5.6-sol", tier), 610);
  }

  assert.equal(credits("gpt-5.4-mini", "fast"), null);
  assert.equal(credits("future-model", "priority"), null);
  assert.equal(credits("future-model", null), null);
  assert.equal(
    credits("gpt-5.6-sol", null, {
      totalTokens: 3_000_000,
      inputTokens: 2_000_000,
    }),
    null,
  );
});

test("API USD calculator keeps cache partitions exclusive and separate from credits", () => {
  const usage = {
    model: "gpt-5.6-sol",
    totalTokens: 210_000,
    inputTokens: 200_000,
    cachedInputTokens: 50_000,
    cacheWriteInputTokens: 25_000,
    outputTokens: 10_000,
    reasoningTokens: 5_000,
    callCount: 1,
  };
  const partition = partitionTokenUsage(usage);
  assert.deepEqual(partition, {
    uncachedInputTokens: 125_000,
    cachedInputTokens: 50_000,
    cacheWriteInputTokens: 25_000,
    outputTokens: 10_000,
    reasoningTokens: 5_000,
  });
  assert.equal(
    partition.uncachedInputTokens + partition.cachedInputTokens +
      partition.cacheWriteInputTokens,
    usage.inputTokens,
  );

  const api = apiUsdForUsage(usage);
  const credits = calculateCodexPurchasedCredits({
    model: usage.model,
    usage,
  });
  assert.equal(api.amount, 0.845);
  assert.equal(api.currency, "USD");
  assert.equal(api.ratedTokens, usage.totalTokens);
  assert.equal(api.unratedTokens, 0);
  assert.equal(api.complete, true);
  assert.equal(credits, 20.5);
  assert.notEqual(api.amount, credits);
});

test("API USD calculator has explicit standard text rates for every credit-card model", () => {
  const expected = new Map([
    ["gpt-5.6-sol", [4, 0.4, 20]],
    ["gpt-5.6-terra", [2, 0.2, 12]],
    ["gpt-5.6-luna", [0.2, 0.02, 1.2]],
    ["gpt-5.5", [5, 0.5, 30]],
    ["daybreak-blue", [4, 0.4, 20]],
    ["daybreak-red", [12.5, 1.25, 75]],
    ["gpt-5.4", [2.5, 0.25, 15]],
    ["gpt-5.4-mini", [0.75, 0.075, 4.5]],
    ["gpt-5.3-codex", [1.75, 0.175, 14]],
    ["gpt-5.2", [1.75, 0.175, 14]],
  ]);
  const amount = (model, inputTokens, cachedInputTokens, outputTokens) =>
    apiUsdForUsage({
      model,
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
    }).amount;
  const approximately = (actual, expected, label) =>
    assert.ok(
      Math.abs(actual - expected) < 1e-12,
      `${label}: expected ${expected}, got ${actual}`,
    );

  for (const [model, [input, cached, output]] of expected) {
    approximately(amount(model, 100_000, 0, 0), input / 10, `${model} input`);
    approximately(
      amount(model, 100_000, 100_000, 0),
      cached / 10,
      `${model} cached input`,
    );
    approximately(amount(model, 0, 0, 1_000_000), output, `${model} output`);
  }
});

test("API USD calculator applies Sol fast and exact long-context prices", () => {
  const event = (inputTokens, serviceTier = null, callCount = 1) => ({
    model: "gpt-5.6-sol",
    serviceTier,
    totalTokens: inputTokens + 1_000,
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 1_000,
    callCount,
  });
  const atThreshold = apiUsdForUsage(
    event(API_USD_LONG_CONTEXT_THRESHOLD_TOKENS),
  );
  assert.equal(atThreshold.amount, 1.108);

  const aboveThreshold = apiUsdForUsage(
    event(API_USD_LONG_CONTEXT_THRESHOLD_TOKENS + 1),
  );
  assert.equal(aboveThreshold.amount, 2.206008);

  for (const tier of ["fast", " FAST ", "priority", " Priority "]) {
    assert.equal(
      apiUsdForUsage(event(100_000, tier)).amount,
      0.84,
    );
  }
  assert.equal(
    apiUsdForUsage(event(API_USD_LONG_CONTEXT_THRESHOLD_TOKENS + 1, "fast")).amount,
    4.412016,
  );
});

test("API USD calculator is conservative for compacted and unsupported usage", () => {
  const sol = (inputTokens, callCount) => ({
    model: "gpt-5.6-sol",
    totalTokens: inputTokens,
    inputTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    callCount,
  });
  const safe = apiUsdForUsage(sol(200_000, 2));
  assert.equal(safe.amount, 0.8);
  assert.equal(safe.complete, true);
  assert.equal(safe.estimated, true);

  const ambiguous = apiUsdForUsage(sol(300_000, 2));
  assert.equal(ambiguous.amount, null);
  assert.equal(ambiguous.ratedTokens, 0);
  assert.equal(ambiguous.unratedTokens, 300_000);
  assert.deepEqual(ambiguous.reasons, ["compacted-long-context-ambiguous"]);

  const unknownCompactedCount = apiUsdForUsage({
    ...sol(300_000, undefined),
    callCount: undefined,
    resolutionSeconds: 3_600,
  });
  assert.equal(unknownCompactedCount.amount, null);
  assert.deepEqual(
    unknownCompactedCount.reasons,
    ["compacted-long-context-ambiguous"],
  );

  const exactMissingCount = apiUsdForUsage({
    ...sol(300_000, undefined),
    callCount: undefined,
  });
  assert.equal(exactMissingCount.amount, 2.4);

  const ultrafast = apiUsdForUsage({ ...sol(100_000, 1), serviceTier: "ultrafast" });
  assert.equal(ultrafast.amount, null);
  assert.deepEqual(ultrafast.reasons, ["ultrafast-unrated"]);

  const unsupportedFast = apiUsdForUsage({
    ...sol(100_000, 1),
    model: "gpt-5.5",
    serviceTier: "priority",
  });
  assert.equal(unsupportedFast.amount, null);
  assert.deepEqual(unsupportedFast.reasons, ["unsupported-api-fast-tier"]);

  assert.equal(apiUsdForUsage({
    ...sol(100_000, 1),
    model: "future-model",
  }).amount, null);
  assert.equal(apiUsdForUsage({
    model: "gpt-5.6-sol",
    totalTokens: 100_000,
    inputTokens: 100_000,
  }).amount, null);

  const partialCacheWrite = apiUsdForUsage({
    model: "gpt-5.5",
    totalTokens: 1_100,
    inputTokens: 1_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 200,
    outputTokens: 100,
  });
  assert.equal(partialCacheWrite.ratedTokens, 900);
  assert.equal(partialCacheWrite.unratedTokens, 200);
  assert.equal(partialCacheWrite.complete, false);
  assert.deepEqual(partialCacheWrite.reasons, ["unsupported-cache-write-price"]);
});

test("sliced compacted long-context buckets remain ambiguous", () => {
  const startMs = Date.parse("2026-08-15T00:00:00.000Z");
  const [first, second] = splitUsageBucketsAtBoundaries(
    [{
      timestamp: new Date(startMs + 3_600_000).toISOString(),
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(startMs + 7_200_000).toISOString(),
      model: "gpt-5.6-sol",
      totalTokens: 400_000,
      inputTokens: 400_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      callCount: 2,
    }],
    [startMs + 3_600_000],
  );

  for (const fragment of [first, second]) {
    assert.ok(Math.abs(fragment.inputTokens - 200_000) < 1);
    assert.ok(Math.abs(fragment.callCount - 1) < 1e-6);
    assert.equal(fragment.rangeAllocationEstimated, true);
    const estimate = apiUsdForUsage(fragment);
    assert.equal(estimate.amount, null);
    assert.deepEqual(estimate.reasons, ["compacted-long-context-ambiguous"]);
  }
});

test("cost renderer labels units, coverage, and unrated usage explicitly", () => {
  const bounds = weekBounds("2026-08-23", "UTC");
  const events = [
    {
      model: "gpt-5.6-sol",
      totalTokens: 101_000,
      inputTokens: 100_000,
      cachedInputTokens: 0,
      outputTokens: 1_000,
      callCount: 1,
    },
    {
      model: "future-model",
      totalTokens: 50_000,
      inputTokens: 50_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    },
  ];
  const api = renderCostTerminal({
    events,
    bounds,
    basis: "api-usd",
    snapshotFreshness: { status: "fresh", ageLabel: "12m old" },
    sourceStatus: "stale-fallback",
  });
  assert.match(api, /^Hypothetical API-equivalent cost \(USD\)/);
  assert.match(api, /Snapshot: fresh · 12m old/);
  assert.match(api, /PROVENANCE · STALE FALLBACK/);
  assert.match(api, /Total rated amount: \$0\.42/);
  assert.match(api, /Rated token coverage: 66\.9%/);
  assert.match(api, /Unrated tokens: 50\.0K/);
  assert.match(api, /unknown-model/);
  assert.match(api, /not an actual bill/);

  const credits = renderCostTerminal({ events, bounds, basis: "codex-credits" });
  assert.match(credits, /^Codex purchased-credit estimate/);
  assert.match(credits, /credits/);
  assert.doesNotMatch(credits, /\$/);
  assert.match(credits, /do not infer included-plan/);

  const unrated = renderCostTerminal({
    events: [events[1]],
    bounds,
    basis: "api-usd",
  });
  assert.match(unrated, /Total rated amount: —/);
  assert.doesNotMatch(unrated, /\$0\.00/);
});

test("cost renderer sanitizes fallback model labels", () => {
  const output = renderCostTerminal({
    events: [{
      model: "future\u001b]2;owned\u0007-model",
      totalTokens: 1_000,
      inputTokens: 1_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    }],
    bounds: weekBounds("2026-08-23", "UTC"),
    basis: "api-usd",
  });

  assert.match(output, /future-model/);
  assert.doesNotMatch(output, /owned/);
  assert.doesNotMatch(output, /\u001b/);
});

test("trend fast shading recognizes both tiers and reports mixed model rates", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const event = (model, serviceTier, totalTokens) => ({
    timestamp: "2026-08-12T12:00:00.000Z",
    model,
    serviceTier,
    totalTokens,
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
  });
  const snapshot = {
    generatedAt: "2026-08-15T00:00:00.000Z",
    events: [
      event("gpt-5.4", "priority", 1_000_000),
      event("gpt-5.5", " FAST ", 3_000_000),
      event("gpt-5.4-mini", "fast", 2_000_000),
      event("gpt-5.6-sol", "standard", 1_000_000),
      event("gpt-5.6-sol", "ultrafast", 1_000_000),
    ],
  };
  const bins = buildActualTokenBins(snapshot, bounds, 7, 1_000);
  assert.equal(
    [...bins.fastTotals.values()].reduce((sum, value) => sum + value, 0),
    6_000_000,
  );

  const svg = renderTrendImage({ snapshot, bounds, days: 7 });
  assert.match(svg, /2\.43× avg/);
  assert.match(svg, /Some fast usage is unrated/);
  assert.doesNotMatch(svg, /Fast credit rate ·|Darker shade = fast mode/);

  const unsupportedSvg = renderTrendImage({
    snapshot: {
      generatedAt: snapshot.generatedAt,
      events: [event("gpt-5.4-mini", "fast", 2_000_000)],
    },
    bounds,
    days: 7,
  });
  assert.match(unsupportedSvg, /UNRATED/);
  assert.doesNotMatch(unsupportedSvg, /1\.00×/);
});

test("runtime rejects stale stored credits when current pricing is unavailable", () => {
  assert.equal(eventCredits({
    model: "future-model",
    serviceTier: null,
    totalTokens: 1_000,
    inputTokens: 1_000,
    outputTokens: 0,
    rateCardCredits: 9_999,
  }), null);
  assert.equal(eventCredits({
    model: "gpt-5.6-sol",
    serviceTier: "fast",
    totalTokens: 1_000,
    rateCardCredits: 9_999,
  }), null);
  assert.equal(eventCredits({
    model: "gpt-5.6-sol",
    serviceTier: null,
    totalTokens: 1_000,
    inputTokens: 1_000,
    outputTokens: 0,
    rateCardCredits: 9_999,
  }), 0.1);
});

test("fast-mode turns use model-specific credit weights in burn allocation", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const resetsAt = Date.parse("2026-08-16T00:00:00.000Z") / 1_000;
  const snapshot = {
    metadata: CURRENT_QUOTA_METADATA,
    events: [
      {
        // Sol and GPT-5.5 share identical rate-card prices and identical
        // usage; only the service tier differs.
        timestamp: "2026-08-12T09:00:00.000Z",
        model: "gpt-5.6-sol",
        totalTokens: 1_000_000,
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
        serviceTier: "priority",
      },
      {
        timestamp: "2026-08-12T10:00:00.000Z",
        model: "gpt-5.5",
        totalTokens: 1_000_000,
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
    ],
    quotaObservations: [
      {
        timestamp: "2026-08-12T06:00:00.000Z",
        usedPercent: 0,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt,
      },
      {
        timestamp: "2026-08-12T18:00:00.000Z",
        usedPercent: 25,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt,
      },
    ],
  };
  const trend = buildUsageTrend(snapshot, bounds);
  const burn = buildBurnDayBins(trend, bounds, { days: 7, binSize: 1 });
  const day = burn.bins.find((bin) => bin.startDateString === "2026-08-12");
  // 250 fast Sol credits vs 125 standard GPT-5.5 credits: 25% splits 2:1.
  assert.ok(Math.abs(day.values.get("Sol") - 16.6667) < 0.01);
  assert.ok(Math.abs(day.values.get("GPT-5.5") - 8.3333) < 0.01);
});

test("canonical Daybreak fast tiers retain rate-card burn weights", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const resetsAt = Date.parse("2026-08-16T00:00:00.000Z") / 1_000;
  const event = (model, serviceTier) => ({
    timestamp: "2026-08-12T12:00:00.000Z",
    model,
    serviceTier,
    totalTokens: 1_000_000,
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 0,
  });
  const snapshot = {
    metadata: CURRENT_QUOTA_METADATA,
    events: [
      event("daybreak-red", "priority"),
      event("daybreak-blue", "fast"),
      event("gpt-5.5", null),
    ],
    quotaObservations: [
      {
        timestamp: "2026-08-12T06:00:00.000Z",
        usedPercent: 0,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt,
      },
      {
        timestamp: "2026-08-12T18:00:00.000Z",
        usedPercent: 25,
        scope: "account",
        limitKey: ACCOUNT_QUOTA_LIMIT_KEY,
        windowMinutes: 10_080,
        resetsAt,
      },
    ],
  };

  const trend = buildUsageTrend(snapshot, bounds);
  const burn = buildBurnDayBins(trend, bounds, { days: 7, binSize: 1 });
  const day = burn.bins.find((bin) => bin.startDateString === "2026-08-12");

  assert.equal(trend.allocationMethod, "rate-card weights");
  // Daybreak credits are 25 + 8 + 4 standard credit units here, so the
  // combined Daybreak share is 33/37 of the observed 25-point drain.
  assert.ok(Math.abs(day.values.get("Daybreak") - 22.2973) < 0.01);
  assert.ok(Math.abs(day.values.get("GPT-5.5") - 2.7027) < 0.01);
});

test("purchased-credit reports rate canonical Daybreak fast tiers", () => {
  const output = renderCostTerminal({
    events: [{
      model: "daybreak-red",
      serviceTier: "priority",
      totalTokens: 1_000_000,
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    }],
    bounds: weekBounds("2026-08-23", "UTC"),
    basis: "codex-credits",
  });

  assert.match(output, /Daybreak Red/);
  assert.match(output, /Total rated amount: 781\.250 credits/);
  assert.match(output, /Rated token coverage: 100\.0%/);
  assert.match(output, /Unrated tokens: 0/);
});

test("the report command writes the dashboard image by default", () => {
  const options = parseArgs(["report", "30d"]);
  assert.equal(options.view, "trend");
  assert.equal(options.report, true);
  assert.equal(options.image, true);
  assert.equal(options.trendDays, 30);
  assert.equal(options.date, "today");

  const withOutput = parseArgs([
    "report",
    "7d",
    "--image-output",
    "out/report.png",
  ]);
  assert.equal(withOutput.imageOutput, resolve("out/report.png"));

  const drain = parseArgs(["report", "7d", "--drain"]);
  assert.equal(drain.drain, true);

  const cache = parseArgs(["report", "14d", "--cache-rate"]);
  assert.equal(cache.cacheRate, true);
  assert.equal(cache.image, true);
  assert.equal(cache.trendDays, 14);
  assert.throws(
    () => parseArgs(["trend", "7d", "--cache-rate"]),
    /--cache-rate is only available with the report command/,
  );
  assert.throws(
    () => parseArgs(["report", "7d", "--cache-rate", "--drain"]),
    /--cache-rate cannot be combined with --drain/,
  );
});

test("prior events stay unindexed when no prior range is requested", () => {
  const bounds = multiDayBounds("2026-08-15", "UTC", 7);
  const snapshot = {
    events: [{
      timestamp: "2026-08-05T12:00:00.000Z",
      project: "prior",
      model: "gpt-5.6-luna",
      totalTokens: 1_500,
      inputTokens: 1_000,
      cachedInputTokens: 500,
      callCount: 1,
    }],
    quotaObservations: [],
  };
  const analysis = buildRangeAnalysis(snapshot, bounds, { includeTrend: false });
  assert.equal(analysis.priorEvents, null);

  const viaAnalysis = priorPeriodSummary(
    snapshot,
    bounds,
    7,
    analysis.priorEvents ?? null,
  );
  const viaSnapshot = priorPeriodSummary(snapshot, bounds, 7, null);
  assert.deepEqual(viaAnalysis, viaSnapshot);
  assert.ok(viaSnapshot.eventCount > 0);
  assert.notDeepEqual(viaAnalysis, priorPeriodSummary(snapshot, bounds, 7, []));
});

test("output totals scale with the shared overall total when usage saturates", () => {
  const events = [
    {
      totalTokens: MAX_SAFE_TOKEN_COUNT,
      inputTokens: MAX_SAFE_TOKEN_COUNT,
      outputTokens: 0,
    },
    {
      totalTokens: MAX_SAFE_TOKEN_COUNT,
      inputTokens: 0,
      outputTokens: MAX_SAFE_TOKEN_COUNT,
    },
  ];
  const output = scaledOutputTokens(events, MAX_SAFE_TOKEN_COUNT);
  assert.ok(Math.abs(output / MAX_SAFE_TOKEN_COUNT - 0.5) < 1e-9);

  assert.equal(scaledOutputTokens([{ totalTokens: 100, outputTokens: 40 }], 100), 40);
});

test("cost renderer bounds the model column for oversized labels", () => {
  const output = renderCostTerminal({
    events: [
      {
        model: `custom-${"x".repeat(500_000)}`,
        totalTokens: 1_000,
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
      {
        model: "gpt-5.6-sol",
        totalTokens: 101_000,
        inputTokens: 100_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
        callCount: 1,
      },
    ],
    bounds: weekBounds("2026-08-23", "UTC"),
    basis: "api-usd",
  });
  const longestLine = Math.max(
    ...output.split("\n").map((line) => line.length),
  );
  assert.ok(longestLine < 160);
  assert.match(output, /…/);
});
