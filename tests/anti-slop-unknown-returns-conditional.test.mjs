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
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), "tledger-anti-slop-returns-"));
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

test("no-unknown-returns selects decidable conditional alias branches", async () => {
  const result = await lintTypeScript(`
    type Branch<T = number> = T extends string ? unknown : string;
    type AlwaysUnknown<T> = T extends string ? unknown : unknown;

    export function safeNumber(): Branch<number> {
      throw new Error("unreachable");
    }
    export function safeDefault(): Branch {
      throw new Error("unreachable");
    }
    export function unsafeString(): Branch<string> {
      throw new Error("unreachable");
    }
    export function unresolved<T>(): Branch<T> {
      throw new Error("unreachable");
    }
    export function distributed(): Branch<string | number> {
      throw new Error("unreachable");
    }
    export function alwaysUnknown<T>(): AlwaysUnknown<T> {
      throw new Error("unreachable");
    }
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-unknown-returns\)/g)?.length,
    3,
    result.output,
  );
});
