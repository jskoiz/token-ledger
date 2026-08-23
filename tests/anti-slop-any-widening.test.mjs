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
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), "tledger-anti-slop-any-"));
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

test("no-known-value-widening reports direct and aliased any targets", async () => {
  const result = await lintTypeScript(`
    type AnyAlias = any;
    type NestedAny = AnyAlias;
    type DefaultAny<T = any> = T;
    const direct: any = { id: "ready" };
    const alias: AnyAlias = { id: "ready" };
    const nested: NestedAny = { id: "ready" };
    const generic: DefaultAny = { id: "ready" };
    const wrapped: Readonly<any> = { id: "ready" };
    const asserted = ({ id: "ready" } as any);
    declare const unknownValue: unknown;
    const unknownAssertion = unknownValue as any;
    const checked = { id: "ready" } satisfies any;
    const safe: { id: string } = { id: "ready" };
    void direct;
    void alias;
    void nested;
    void generic;
    void wrapped;
    void asserted;
    void unknownAssertion;
    void checked;
    void safe;
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-known-value-widening\)/g)?.length,
    6,
    result.output,
  );
});
