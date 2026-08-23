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
    type UnknownTarget<T> = unknown extends T ? number : unknown;

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
    export function promisedUnsafe(): Promise<Branch<string>> {
      throw new Error("unreachable");
    }
    export function promiseLikeUnsafe(): PromiseLike<AlwaysUnknown<number>> {
      throw new Error("unreachable");
    }
    export function promisedSafe(): Promise<Branch<number>> {
      throw new Error("unreachable");
    }
    export function literalNever(): never extends string ? unknown : number {
      throw new Error("unreachable");
    }
    export function distributedNever(): Branch<never> {
      throw new Error("unreachable");
    }
    export function anyTrue(): any extends string ? unknown : number {
      throw new Error("unreachable");
    }
    export function anyFalse(): any extends string ? number : unknown {
      throw new Error("unreachable");
    }
    export function unknownFalse(): unknown extends string ? number : unknown {
      throw new Error("unreachable");
    }
    export function anyTopUnknown(): any extends unknown ? unknown : number {
      throw new Error("unreachable");
    }
    export function anyAnyUnknown(): any extends any ? unknown : number {
      throw new Error("unreachable");
    }
    export function unknownUnionUnknown(): unknown extends unknown | string
      ? unknown
      : number {
      throw new Error("unreachable");
    }
    export function unknownUnionFalse(): unknown extends string | number
      ? number
      : unknown {
      throw new Error("unreachable");
    }
    export function unknownTargetConcrete(): UnknownTarget<string> {
      throw new Error("unreachable");
    }
    export function exhaustiveUnionUnknown(): unknown extends
      {} | null | undefined ? unknown : number {
      throw new Error("unreachable");
    }
    export function nonExhaustiveUnionUnknown(): unknown extends {} | null
      ? number
      : unknown {
      throw new Error("unreachable");
    }
    export function anyIntersectionUnknown(): string extends any & number
      ? unknown
      : number {
      throw new Error("unreachable");
    }
    export function anyNeverIntersectionUnknown(): string extends any & never
      ? number
      : unknown {
      throw new Error("unreachable");
    }
    export function anyDominated(): any extends string ? unknown : any {
      throw new Error("unreachable");
    }
    export function unknownConcrete(): unknown extends string ? unknown : number {
      throw new Error("unreachable");
    }
    export function anyTopConcrete(): any extends unknown ? number : unknown {
      throw new Error("unreachable");
    }
    export function anyAnyConcrete(): any extends any ? number : unknown {
      throw new Error("unreachable");
    }
    export function unknownUnionConcrete(): unknown extends unknown | string
      ? number
      : unknown {
      throw new Error("unreachable");
    }
    export function unresolvedUnknownTarget<T>(): unknown extends T
      ? number
      : unknown {
      throw new Error("unreachable");
    }
    export function unknownTargetTop(): UnknownTarget<unknown> {
      throw new Error("unreachable");
    }
    export function exhaustiveUnionConcrete(): unknown extends
      {} | null | undefined ? number : unknown {
      throw new Error("unreachable");
    }
    export function anyIntersectionConcrete(): string extends any & number
      ? number
      : unknown {
      throw new Error("unreachable");
    }
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-unknown-returns\)/g)?.length,
    18,
    result.output,
  );
});
