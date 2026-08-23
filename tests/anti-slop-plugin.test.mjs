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
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), "tledger-anti-slop-"));
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

test("anti-slop resolves applied generic aliases before checking returns", async () => {
  const result = await lintTypeScript(`
    type Identity<T> = T;
    type Wrapped<T> = Identity<T>;
    export function load(): Wrapped<unknown> {
      throw new Error("unreachable");
    }
  `);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /anti-slop\(no-unknown-returns\)/);
});

test("anti-slop recognizes aliases whose unions collapse to unknown", async () => {
  const result = await lintTypeScript(`
    export type Payload = string | unknown;
  `);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /anti-slop\(no-unknown-type-aliases\)/);
});

test("anti-slop resolves unions and generic aliases in unknown parameters", async () => {
  const result = await lintTypeScript(`
    type Identity<T> = T;
    type DefaultUnknown<T = unknown> = T;
    export function consumeUnion(value: string | unknown): void {}
    export function consumeAlias(value: Identity<unknown>): void {}
    export function consumeDefault(value: DefaultUnknown): void {}
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-unknown-parameters\)/g)?.length,
    3,
    result.output,
  );
});

test("anti-slop resolves applied generic aliases in object parameters", async () => {
  const result = await lintTypeScript(`
    type Identity<T> = T;
    type Wrapped<T> = Identity<T>;
    type DefaultObject<T = object> = T;
    export function consume(value: Wrapped<object>): void {}
    export function consumeDefault(value: DefaultObject): void {}
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-object-parameters\)/g)?.length,
    2,
    result.output,
  );
});

test("anti-slop keeps concrete generic aliases valid", async () => {
  const result = await lintTypeScript(`
    type Identity<T> = T;
    export function load<T>(value: T): Identity<T> {
      return value;
    }
  `);
  assert.equal(result.status, 0, result.output);
});
