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
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), "tledger-anti-slop-chained-"));
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

test("anti-slop rejects assertions chained across a non-null expression", async () => {
  const result = await lintTypeScript(`
    declare const value: unknown;
    const narrowed = (value as unknown)! as string;
    void narrowed;
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-chained-type-assertions\)/g)?.length,
    1,
    result.output,
  );
});

test("anti-slop does not report a single assertion or an all-const chain across non-null", async () => {
  const result = await lintTypeScript(`
    declare const value: unknown;
    const single = (value as string)!;
    const constOnly = (value as const)! as const;
    void single;
    void constOnly;
  `);
  assert.doesNotMatch(result.output, /anti-slop\(no-chained-type-assertions\)/);
});

test("anti-slop traverses satisfies wrappers and reports the outer assertion once", async () => {
  const result = await lintTypeScript(`
    declare const value: unknown;
    const chained = ((value as unknown) satisfies unknown) as string;
    const nested = (((value as unknown) satisfies unknown)!) as string;
    const outerSatisfies = ((value as unknown) as string) satisfies string;
    const single = (value as string) satisfies string;
    const constOnly = ((value as const) satisfies unknown) as const;
    void chained;
    void nested;
    void outerSatisfies;
    void single;
    void constOnly;
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-chained-type-assertions\)/g)?.length,
    3,
    result.output,
  );
});
