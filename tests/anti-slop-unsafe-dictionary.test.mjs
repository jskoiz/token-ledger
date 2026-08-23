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
	const fixtureDirectory = await mkdtemp(resolve(tmpdir(), "tledger-unsafe-dictionary-"));
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

test("anti-slop reports an unapplied generic dictionary alias with an unsafe default", async () => {
	const result = await lintTypeScript(`
		type Bag<T = unknown> = Record<string, T>;
		let value: Bag;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		1,
		result.output,
	);
});

test("anti-slop keeps duplicate suppression for a reportable alias declaration", async () => {
	const result = await lintTypeScript(`
		type Bag = Record<string, unknown>;
		let value: Bag;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		1,
		result.output,
	);
});
