import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const BENCHMARK_ENTRYPOINT = fileURLToPath(
  new URL("../tools/benchmark-importer.mjs", import.meta.url),
);
const NORMAL_LEDGER_PATH = resolve(
  userInfo().homedir,
  ".token-ledger",
  "token-ledger-ledger.sqlite",
);
const NORMAL_LEDGER_PATHS = [
  NORMAL_LEDGER_PATH,
  `${NORMAL_LEDGER_PATH}.writer-lock.sqlite`,
  `${NORMAL_LEDGER_PATH}-journal`,
  `${NORMAL_LEDGER_PATH}-wal`,
  `${NORMAL_LEDGER_PATH}-shm`,
];

async function fileMetadata(filePath) {
  try {
    const metadata = await lstat(filePath);
    return {
      exists: true,
      mode: metadata.mode & 0o777,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
      dev: metadata.dev,
      ino: metadata.ino,
      nlink: metadata.nlink,
    };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) {
      return { exists: false };
    }
    throw error;
  }
}

async function normalLedgerMetadata() {
  return Promise.all(NORMAL_LEDGER_PATHS.map(fileMetadata));
}

async function benchmarkTemporaryDirectories() {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("token-ledger-benchmark-"))
    .sort();
}

test("refresh benchmark isolates and cleans up its durable ledger", async () => {
  const before = await normalLedgerMetadata();
  const temporaryDirectoriesBefore = await benchmarkTemporaryDirectories();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.TOKEN_LEDGER_TEST_STATE_NAMESPACE;
  delete env.TOKEN_LEDGER_TEST_STATE_ROOT;

  const result = spawnSync(
    process.execPath,
    [
      BENCHMARK_ENTRYPOINT,
      "--files",
      "2",
      "--lines",
      "1",
      "--warm-runs",
      "2",
    ],
    {
      encoding: "utf8",
      env,
      maxBuffer: 1_000_000,
      timeout: 30_000,
    },
  );

  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.durableRevision, 2);
  assert.deepEqual(report.runCoverage, [
    {
      filesScanned: 2,
      filesReused: 0,
      bytesScanned: report.bytes,
      bytesReused: 0,
    },
    {
      filesScanned: 0,
      filesReused: 2,
      bytesScanned: 0,
      bytesReused: report.bytes,
    },
  ]);

  assert.deepEqual(await normalLedgerMetadata(), before);
  assert.deepEqual(
    await benchmarkTemporaryDirectories(),
    temporaryDirectoriesBefore,
  );
});
