#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// These suites exercise subprocesses, SQLite coordination, or complete CLI runs.
const integration = new Set([
  "benchmark-importer.test.mjs",
  "cli.smoke.test.mjs",
  "cli-timing.contract.test.mjs",
  "collector-cli.contract.test.mjs",
  "token-ledger-durable-ledger.test.mjs",
]);
const tier = process.argv[2] ?? "all";
if (!["fast", "integration", "all"].includes(tier)) {
  throw new Error(`Unknown test tier: ${tier}`);
}
const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.mjs"))
  .filter((name) => tier === "all" || integration.has(name) === (tier === "integration"))
  .sort()
  .map((name) => `tests/${name}`);
if (tier === "all") {
  files.push(...readdirSync(new URL("../tests/stress/", import.meta.url))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => `tests/stress/${name}`));
}
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
