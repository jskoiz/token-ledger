import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const demoUrl = new URL("../docs/token-ledger-demo.svg", import.meta.url);
const fixtureUrl = new URL("./fixtures/demo-snapshot.json", import.meta.url);
const generatorUrl = new URL("../scripts/generate-demo-screenshot.mjs", import.meta.url);

test("synthetic demo matches the current renderer", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(generatorUrl), "--check"],
    { encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("synthetic demo uses the Token Ledger title and model palette", async () => {
  const svg = await readFile(demoUrl, "utf8");

  assert.match(svg, />TOKEN LEDGER<\/text>/);
  assert.doesNotMatch(svg, /SYNTHETIC DEMO/);

  for (const color of ["#5fd7d7", "#5f87af", "#d7af5f", "#d787d7", "#5f87ff", "#afd7ff", "#5f5f87"]) {
    assert.match(svg, new RegExp(`fill="${color}"`));
  }
});

test("synthetic demo contains no local or account metadata", async () => {
  const svg = await readFile(demoUrl, "utf8");

  assert.doesNotMatch(svg, /\/(?:Users|home)\//i);
  assert.doesNotMatch(svg, /[A-Z]:\\/i);
  assert.doesNotMatch(svg, /@[a-z0-9.-]+/i);
  assert.doesNotMatch(svg, /github\.com/i);
  assert.doesNotMatch(svg, /token-ledger-snapshot/i);
  assert.doesNotMatch(svg, /\u001b/);
});

test("synthetic demo fixture fills the dashboard with varied usage", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const projects = new Set(fixture.events.map((event) => event.project));
  const threads = new Set(fixture.events.map((event) => event.threadId));
  const models = new Set(fixture.events.map((event) => event.model));
  const useTypes = new Set(fixture.events.map((event) => event.useType));

  assert.equal(projects.size, 10);
  assert.ok(threads.size >= 30);
  assert.ok(models.size >= 5);
  assert.ok(models.has("codex-auto-review"));
  assert.ok(models.has("gpt-daybreak-blue-latest"));
  assert.ok(models.has("other-model"));
  assert.ok(useTypes.size >= 5);
});
