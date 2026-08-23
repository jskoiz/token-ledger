import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OXLINT = resolve(
  REPOSITORY_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "oxlint.cmd" : "oxlint",
);
const OXLINT_CONFIG = resolve(REPOSITORY_ROOT, ".oxlintrc.json");

async function lintTypeScript(source) {
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), "tledger-anti-slop-widen-"));
  const fixturePath = resolve(fixtureDirectory, "fixture.ts");
  try {
    await writeFile(fixturePath, source);
    const result = spawnSync(
      OXLINT,
      ["--config", OXLINT_CONFIG, "--no-ignore", fixturePath],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    );
    assert.ifError(result.error);
    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
    };
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

test("no-widen-then-assert unwraps non-null and satisfies initializer and use wrappers", async () => {
  const result = await lintTypeScript(`
    type Item = { id: string };
    const known = { id: "ready" };

    const widenedNonNull = (known as unknown)!;
    const narrowedNonNull = (widenedNonNull as Item)!;

    const widenedSatisfies = (known as unknown) satisfies unknown;
    const narrowedSatisfies = (widenedSatisfies satisfies unknown) as Item;

    const widenedDirect = known as unknown;
    const narrowedOuterSatisfies = (widenedDirect as Item) satisfies Item;

    void narrowedNonNull;
    void narrowedSatisfies;
    void narrowedOuterSatisfies;
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-widen-then-assert\)/g)?.length,
    3,
    result.output,
  );
});

test("no-widen-then-assert preserves broad targets, safe satisfies, and mutable controls", async () => {
  const result = await lintTypeScript(`
    type Item = { id: string };
    const known = { id: "ready" };

    const checked = known satisfies unknown;
    const checkedUse = (checked as Item)!;

    const widened = (known as unknown)!;
    const stillBroad = (widened as object);

    let mutable = known as unknown;
    const mutableUse = (mutable as Item);

    const alreadyNarrow = known as Item;
    const repeatedNarrow = (alreadyNarrow satisfies Item) as Item;

    void checkedUse;
    void stillBroad;
    void mutableUse;
    void repeatedNarrow;
  `);
  assert.doesNotMatch(result.output, /anti-slop\(no-widen-then-assert\)/);
});
