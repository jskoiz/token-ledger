import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { ESLint } from "eslint";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");

test("ESLint checks repository JavaScript tooling and ignores generated output", async () => {
  const eslint = new ESLint({ cwd: REPOSITORY_ROOT });
  const toolingConfig = await eslint.calculateConfigForFile("tools/oxlint/anti-slop/index.js");
  const eslintConfig = await eslint.calculateConfigForFile("eslint.config.mjs");

  assert.equal(toolingConfig.rules["no-undef"][0], 2);
  assert.equal(toolingConfig.rules["no-unused-vars"][0], 2);
  assert.equal(eslintConfig.rules["no-undef"][0], 2);
  assert.deepEqual(toolingConfig.rules["no-control-regex"], [0]);
  assert.equal(await eslint.isPathIgnored(resolve(REPOSITORY_ROOT, "outputs/generated.mjs")), true);
  assert.equal(
    await eslint.isPathIgnored(resolve(REPOSITORY_ROOT, "tools/oxlint/anti-slop/index.js")),
    false,
  );
});
