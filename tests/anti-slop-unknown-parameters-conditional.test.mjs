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
  const fixtureDirectory = await mkdtemp(
    resolve(tmpdir(), "tledger-anti-slop-parameters-"),
  );
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

test("no-unknown-parameters resolves conditional aliases", async () => {
  const result = await lintTypeScript(`
    type Select<T> = T extends string ? unknown : number;
    type AlwaysUnknown<T> = T extends string ? unknown : unknown;
    type UnknownTarget<T> = unknown extends T ? number : unknown;

    export function selected(value: Select<string>): void {}
    export function distributed(value: Select<string | number>): void {}
    export function alwaysUnknown<T>(value: AlwaysUnknown<T>): void {}
    export function literalNever(
      value: never extends string ? unknown : number,
    ): void {}
    export function anyTrue(
      value: any extends string ? unknown : number,
    ): void {}
    export function anyFalse(
      value: any extends string ? number : unknown,
    ): void {}
    export function unknownFalse(
      value: unknown extends string ? number : unknown,
    ): void {}
    export function anyTopUnknown(
      value: any extends unknown ? unknown : number,
    ): void {}
    export function anyAnyUnknown(
      value: any extends any ? unknown : number,
    ): void {}
    export function unknownUnionUnknown(
      value: unknown extends unknown | string ? unknown : number,
    ): void {}
    export function unknownUnionFalse(
      value: unknown extends string | number ? number : unknown,
    ): void {}
    export function unknownTargetConcrete(value: UnknownTarget<string>): void {}

    export function concrete(value: Select<number>): void {}
    export function unresolved<T>(value: Select<T>): void {}
    export function distributedNever(value: Select<never>): void {}
    export function allowedCause(cause: Select<string>): void {}
    export function anyDominated(
      value: any extends string ? unknown : any,
    ): void {}
    export function unknownConcrete(
      value: unknown extends string ? unknown : number,
    ): void {}
    export function anyTopConcrete(
      value: any extends unknown ? number : unknown,
    ): void {}
    export function anyAnyConcrete(
      value: any extends any ? number : unknown,
    ): void {}
    export function unknownUnionConcrete(
      value: unknown extends unknown | string ? number : unknown,
    ): void {}
    export function unresolvedUnknownTarget<T>(
      value: unknown extends T ? number : unknown,
    ): void {}
    export function unknownTargetTop(value: UnknownTarget<unknown>): void {}
  `);
  assert.equal(result.status, 1, result.output);
  assert.equal(
    result.output.match(/anti-slop\(no-unknown-parameters\)/g)?.length,
    12,
    result.output,
  );
});
