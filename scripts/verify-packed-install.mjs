import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tarball = process.argv[2] && resolve(process.argv[2]);
if (!tarball) {
  throw new Error("Usage: node scripts/verify-packed-install.mjs <package.tgz>");
}

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = resolve(repository, "tests/fixtures/demo-snapshot.json");
const expectedPackage = JSON.parse(await readFile(
  resolve(repository, "package.json"),
  "utf8",
));
const root = await mkdtemp(resolve(tmpdir(), "token-ledger-packed-"));
const prefix = resolve(root, "prefix");
const home = resolve(root, "home");
const source = resolve(root, "synthetic-codex-home");
const npmCache = resolve(root, "npm-cache");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function execute(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    input: options.input,
    timeout: 20_000,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: source,
      npm_config_cache: npmCache,
      ...options.env,
    },
  });
}

function runCli(bin, args, options = {}) {
  const result = execute(bin, args, options);
  assert.equal(
    result.status,
    options.expectedStatus ?? 0,
    `tledger ${args.join(" ")}\n${result.stderr}`,
  );
  return result;
}

async function writeSyntheticSource() {
  const threadId = "44444444-4444-4444-8444-444444444444";
  const turnId = "synthetic-packed-turn";
  const timestamp = "2026-08-05T12:00:00.000Z";
  const directory = resolve(source, "sessions", "2026", "08", "05");
  await mkdir(directory, { recursive: true });
  const rows = [
    {
      timestamp,
      type: "session_meta",
      payload: {
        id: threadId,
        cwd: "/workspace/synthetic-packed",
        source: "exec",
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turnId,
        started_at: Date.parse(timestamp) / 1000,
      },
    },
    {
      timestamp,
      type: "turn_context",
      payload: {
        turn_id: turnId,
        model: "gpt-5.6-sol",
        effort: "medium",
        cwd: "/workspace/synthetic-packed",
      },
    },
    {
      timestamp: "2026-08-05T12:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 90,
            cached_input_tokens: 40,
            output_tokens: 10,
            reasoning_output_tokens: 2,
            total_tokens: 100,
          },
          last_token_usage: {
            input_tokens: 90,
            cached_input_tokens: 40,
            output_tokens: 10,
            reasoning_output_tokens: 2,
            total_tokens: 100,
          },
          model_context_window: 128000,
        },
      },
      model: "gpt-5.6-sol",
      turnId,
    },
  ];
  await writeFile(
    resolve(directory, `rollout-2026-08-05-${threadId}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  const databasePath = resolve(source, "state_5.sqlite");
  const createDatabase = execute(process.execPath, [
    "--no-warnings",
    "--input-type=module",
    "--eval",
    [
      "import { DatabaseSync } from 'node:sqlite';",
      "const database = new DatabaseSync(process.argv[1]);",
      "database.exec(`CREATE TABLE threads (id TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, cwd TEXT, tokens_used INTEGER, git_origin_url TEXT, model TEXT, reasoning_effort TEXT, thread_source TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);`);",
      "database.close();",
    ].join(" "),
    databasePath,
  ]);
  assert.equal(createDatabase.status, 0, createDatabase.stderr);
}

try {
  await mkdir(home, { recursive: true });
  await writeSyntheticSource();
  const install = execute(npmCommand, [
    "install",
    "--prefix",
    prefix,
    "--ignore-scripts",
    tarball,
  ]);
  assert.equal(install.status, 0, install.stderr);

  const bin = resolve(
    prefix,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tledger.cmd" : "tledger",
  );
  const legacyBin = resolve(
    prefix,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "token-ledger.cmd" : "token-ledger",
  );
  await assert.rejects(
    access(legacyBin),
    (error) => error.code === "ENOENT",
    "packed install must expose only the tledger executable",
  );
  const installedRoot = resolve(
    prefix,
    "node_modules",
    "tledger",
  );
  const installedPackage = JSON.parse(await readFile(
    resolve(installedRoot, "package.json"),
    "utf8",
  ));
  assert.equal(installedPackage.name, "tledger");
  assert.equal(installedPackage.version, expectedPackage.version);
  assert.deepEqual(installedPackage.dependencies ?? {}, {});

  const installedModule = await import(pathToFileURL(
    resolve(installedRoot, "bin", "token-ledger.mjs"),
  ));
  const defaults = installedModule.parseArgs([]);
  assert.equal(defaults.range, "week");
  assert.equal(defaults.date, "today");
  assert.equal(defaults.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);

  const help = runCli(bin, ["--help"]);
  const shortHelp = runCli(bin, ["-h"]);
  assert.equal(shortHelp.stdout, help.stdout);
  for (const option of [
    "--date",
    "--input",
    "--refresh",
    "--no-refresh",
    "--codex-home",
    "--tz",
    "--top",
    "--width",
    "--raw-projects",
    "--no-archived",
    "--plain",
    "--ascii",
    "--static",
    "--help",
  ]) {
    assert.ok(help.stdout.includes(option), option);
  }

  const bare = runCli(bin, [
    "--input",
    fixture,
    "--static",
    "--plain",
    "--raw-projects",
    "--tz",
    "UTC",
  ]);
  assert.match(bare.stdout, /TOKEN LEDGER|No model-call events found/);

  const week = runCli(bin, [
    "week",
    "2026-08-05",
    "--input",
    fixture,
    "--static",
    "--plain",
    "--raw-projects",
    "--top",
    "2",
    "--width",
    "80",
    "--tz",
    "UTC",
    "--no-refresh",
  ]);
  assert.match(week.stdout, /sample-atlas/);
  assert.match(week.stdout, /sample-beacon/);
  assert.doesNotMatch(week.stdout, /sample-cascade/);
  assert.ok(week.stdout.trimEnd().split("\n").every((line) => line.length <= 80));

  const day = runCli(bin, [
    "day",
    "--date",
    "2026-08-05",
    "--input",
    fixture,
    "--static",
    "--plain",
    "--ascii",
    "--raw-projects",
    "--width",
    "200",
    "--tz",
    "UTC",
  ]);
  assert.match(day.stdout, /DAY/);
  assert.match(day.stdout, /#+/);
  assert.doesNotMatch(day.stdout, /\u001b|█/);

  const noColor = runCli(bin, [
    "week",
    "2026-08-05",
    "--input",
    fixture,
    "--static",
  ], { env: { NO_COLOR: "1" } });
  assert.doesNotMatch(noColor.stdout, /\u001b/);

  const refresh = runCli(bin, [
    "week",
    "2026-08-05",
    "--refresh",
    "--codex-home",
    source,
    "--no-archived",
    "--static",
    "--plain",
    "--raw-projects",
    "--tz",
    "UTC",
  ]);
  assert.match(refresh.stderr, /refreshing local snapshot/);
  assert.doesNotMatch(refresh.stderr, /ExperimentalWarning/);
  assert.match(refresh.stdout, /synthetic-packed/);

  const automaticRefresh = runCli(bin, [
    "week",
    "2026-08-05",
    "--codex-home",
    source,
    "--static",
    "--plain",
    "--raw-projects",
    "--tz",
    "UTC",
  ]);
  assert.match(automaticRefresh.stderr, /refreshing local snapshot/);
  assert.match(automaticRefresh.stdout, /synthetic-packed/);

  const automaticCached = runCli(bin, [
    "week",
    "2026-08-05",
    "--codex-home",
    source,
    "--static",
    "--plain",
    "--raw-projects",
    "--tz",
    "UTC",
  ]);
  assert.doesNotMatch(automaticCached.stderr, /refreshing local snapshot/);
  assert.equal(automaticCached.stderr, "");
  assert.match(automaticCached.stdout, /synthetic-packed/);

  const cached = runCli(bin, [
    "week",
    "2026-08-05",
    "--no-refresh",
    "--static",
    "--plain",
    "--raw-projects",
    "--tz",
    "UTC",
  ]);
  assert.doesNotMatch(cached.stderr, /refreshing local snapshot/);
  assert.match(cached.stdout, /synthetic-packed/);

  for (const [args, message] of [
    [["unknown"], /Unknown command/],
    [["--top", "0"], /1 to 100/],
    [["--width", "39"], /40 to 200/],
    [["day", "2026-02-30", "--input", fixture, "--static"], /Invalid calendar day/],
    [["week", "--input", fixture, "--tz", "Mars\/Base", "--static"], /Unknown IANA timezone/],
    [["--refresh", "--no-refresh"], /cannot be combined/],
    [["--refresh", "--input", fixture], /cannot be combined/],
  ]) {
    const failure = runCli(bin, args, { expectedStatus: 1 });
    assert.match(failure.stderr, message);
  }

  const dependencyTree = execute(npmCommand, [
    "ls",
    "--prefix",
    installedRoot,
    "--omit=dev",
    "--json",
  ]);
  assert.equal(dependencyTree.status, 0, dependencyTree.stderr);
  const tree = JSON.parse(dependencyTree.stdout);
  assert.deepEqual(
    tree.dependencies?.["tledger"]?.dependencies ?? {},
    {},
  );

  process.stdout.write("Packed install verification passed.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
