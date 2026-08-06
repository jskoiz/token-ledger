import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const demoUrl = new URL("../docs/token-ledger-demo.svg", import.meta.url);

test("synthetic demo uses the Token Ledger title and model palette", async () => {
  const svg = await readFile(demoUrl, "utf8");

  assert.match(svg, />TOKEN LEDGER<\/text>/);
  assert.doesNotMatch(svg, /SYNTHETIC DEMO/);

  for (const color of ["#5fd7d7", "#5f87af", "#d7af5f", "#d787d7", "#5f5f87"]) {
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
