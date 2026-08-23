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

test("anti-slop resolves dictionary aliases in lexical scopes", async () => {
	const result = await lintTypeScript(`
		type Bag<T = string> = Record<string, T>;
		function load() {
			let forward: LocalBag;
			type LocalBag<T = Value> = Record<string, T>;
			type Value = unknown;
			{
				type Bag<T = unknown> = Record<string, T>;
				let shadowed: Bag;
				void shadowed;
			}
			void forward;
		}
		namespace Box {
			export type Value = unknown;
		}
		namespace Box {
			export type Bag<T = Value> = Record<string, T>;
			export let namespaced: Bag;
		}
		void load;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		3,
		result.output,
	);
});

test("anti-slop resolves qualified references relative to containing namespaces", async () => {
	const result = await lintTypeScript(`
		namespace Box {
			export namespace Inner {
				export type Bag<T = unknown> = Record<string, T>;
				export interface Value {}
				export interface Base<T> { [key: string]: T }
			}
			interface Derived extends Inner.Base<unknown> {}
			let aliasValue: Inner.Bag;
			let interfaceValue: Record<string, Inner.Value>;
			let inheritedValue: Derived;
			void aliasValue;
			void interfaceValue;
			void inheritedValue;
		}
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		3,
		result.output,
	);
});

test("anti-slop does not reuse a terminal name for an unrelated namespace", async () => {
	const result = await lintTypeScript(`
		type Bag<T = unknown> = Record<string, T>;
		namespace Other {
			export type Bag = string;
		}
		let value: Other.Bag;
		void value;
	`);
	assert.equal(result.status, 0, result.output);
});

test("anti-slop respects local declarations that shadow built-ins", async () => {
	const result = await lintTypeScript(`
		namespace Box {
			export type Record<K, V> = { key: K; value: V };
			export type Readonly<T> = { readonly value: T };
			export type Bag = Readonly<Record<string, string>>;
			export let value: Bag;
		}
	`);
	assert.equal(result.status, 0, result.output);
});

test("anti-slop keeps value-only functions from shadowing type built-ins", async () => {
	const result = await lintTypeScript(`
		function Record() {}
		function PropertyKey() {}
		let record: Record<string, unknown>;
		let propertyKey: Record<PropertyKey, unknown>;
		void record;
		void propertyKey;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		2,
		result.output,
	);
});

test("anti-slop resolves namespace aliases exported through specifiers", async () => {
	const result = await lintTypeScript(`
		namespace Box {
			type Bag<T = unknown> = Record<string, T>;
			export { Bag };
			type RenamedBag<T = unknown> = Record<string, T>;
			export { RenamedBag as Renamed };
		}
		let direct: Box.Bag;
		let renamed: Box.Renamed;
		void direct;
		void renamed;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		2,
		result.output,
	);
});

test("anti-slop resolves merged empty interfaces exported through specifiers", async () => {
	const result = await lintTypeScript(`
		namespace Box {
			interface Value {}
			interface Value {}
			export { Value as RenamedValue };
		}
		let value: Record<string, Box.RenamedValue>;
		void value;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		1,
		result.output,
	);
});

test("anti-slop treats finite Pick results as closed objects", async () => {
	const result = await lintTypeScript(`
		type Finite = Pick<Record<string, unknown>, "id">;
		type FiniteByKeyof = Pick<Record<string, unknown>, keyof { id: string }>;
		type FiniteByUnionKey = Pick<Record<string, unknown>, keyof ({ id: string } | { kind: string })>;
		type Broad = Pick<Record<string, unknown>, string>;
		type BroadByKeyof = Pick<Record<string, unknown>, keyof Record<string, unknown>>;
		type BroadByIntersectionKey = Pick<Record<string, unknown>, keyof (Record<string, unknown> & { id: string })>;
		let finite: Finite;
		let finiteByKeyof: FiniteByKeyof;
		let finiteByUnionKey: FiniteByUnionKey;
		let broad: Broad;
		let broadByKeyof: BroadByKeyof;
		let broadByIntersectionKey: BroadByIntersectionKey;
		void finite;
		void finiteByKeyof;
		void finiteByUnionKey;
		void broad;
		void broadByKeyof;
		void broadByIntersectionKey;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		3,
		result.output,
	);
});

test("anti-slop classifies merged empty interfaces as empty objects", async () => {
	const result = await lintTypeScript(`
		interface Value {}
		interface Value {}
		type Bag = Record<string, Value>;
		interface Concrete {}
		interface Concrete { id: string }
		type SafeBag = Record<string, Concrete>;
		let value: Bag;
		let safe: SafeBag;
		void value;
		void safe;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		1,
		result.output,
	);
});

test("anti-slop gates Record and mapped dictionaries on broad key domains", async () => {
	const result = await lintTypeScript(`
		type LiteralKey = "id";
		type BroadKey = string;
		type FiniteKeyofRecord = keyof Record<"id", unknown>;
		let finiteRecord: Record<"id", unknown>;
		let finiteRecordByAlias: Record<LiteralKey, unknown>;
		let finitePickByKeyofRecord: Pick<Record<string, unknown>, FiniteKeyofRecord>;
		let finiteMapped: { [P in "id" | "name"]: unknown };
		let broadRecord: Record<"id" | string, unknown>;
		let broadRecordByAlias: Record<BroadKey, unknown>;
		let broadMapped: { [P in "id" | string]: unknown };
		let broadMappedByAlias: { [P in BroadKey]: unknown };
		void finiteRecord;
		void finiteRecordByAlias;
		void finitePickByKeyofRecord;
		void finiteMapped;
		void broadRecord;
		void broadRecordByAlias;
		void broadMapped;
		void broadMappedByAlias;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		4,
		result.output,
	);
});

test("anti-slop recognizes keyof never and unbounded template key domains", async () => {
	const result = await lintTypeScript(`
		type BroadTemplate = \`foo-\${string}\`;
		type BroadNumberTemplate = \`\${number}\`;
		type FiniteTemplate = \`foo-\${"id"}\`;
		let broadRecord: Record<BroadTemplate, unknown>;
		let broadNumberRecord: Record<BroadNumberTemplate, unknown>;
		let broadPick: Pick<Record<string, unknown>, BroadTemplate>;
		let broadMapped: { [P in BroadTemplate]: unknown };
		let finiteRecord: Record<FiniteTemplate, unknown>;
		let finiteMapped: { [P in FiniteTemplate]: unknown };
		let neverRecord: Record<keyof never, unknown>;
		let neverPick: Pick<Record<string, unknown>, keyof never>;
		let neverMapped: { [P in keyof never]: unknown };
		void broadRecord;
		void broadNumberRecord;
		void broadPick;
		void broadMapped;
		void finiteRecord;
		void finiteMapped;
		void neverRecord;
		void neverPick;
		void neverMapped;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		7,
		result.output,
	);
});

test("anti-slop resolves merged empty interfaces through qualified namespaces", async () => {
	const result = await lintTypeScript(`
		namespace Box {
			export interface Value {}
		}
		namespace Box {
			export interface Value {}
		}
		let value: Record<string, Box.Value>;
		void value;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		1,
		result.output,
	);
});

test("anti-slop keeps Omit open for uncovered dictionary key domains", async () => {
	const result = await lintTypeScript(`
		let finiteOmission: Omit<Record<string, unknown>, "id">;
		let stringOmission: Omit<Record<string, unknown>, string>;
		let propertyKeyOmission: Omit<Record<PropertyKey, unknown>, PropertyKey>;
		let partialPropertyKeyOmission: Omit<Record<PropertyKey, unknown>, string>;
		void finiteOmission;
		void stringOmission;
		void propertyKeyOmission;
		void partialPropertyKeyOmission;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		2,
		result.output,
	);
});

test("anti-slop preserves nested dictionaries inside closed containers", async () => {
	const result = await lintTypeScript(`
		let finiteRecordValue: Record<"id", Record<string, unknown>>;
		let finiteMappedValue: { [P in "id"]: Record<string, unknown> };
		let finitePickValue: Pick<{ d: Record<string, unknown> }, "d">;
		let neverOmitValue: Omit<{ d: Record<string, unknown> }, never>;
		let omittedProperty: Omit<{ d: Record<string, unknown> }, "d">;
		let unpickedProperty: Pick<{ d: Record<string, unknown>; x: string }, "x">;
		let omittedRecordKey: Omit<Record<"d", Record<string, unknown>>, "d">;
		let pickedNestedProperty: Pick<
			{ d: { x: Record<string, unknown> }; x: string },
			"d"
		>;
		let unpickedNestedProperty: Pick<
			{ d: { x: Record<string, unknown> }; x: string },
			"x"
		>;
		let retainedNestedProperty: Omit<
			{ d: { x: Record<string, unknown> }; x: string },
			"x"
		>;
		let omittedNestedProperty: Omit<
			{ d: { x: Record<string, unknown> }; x: string },
			"d"
		>;
		void finiteRecordValue;
		void finiteMappedValue;
		void finitePickValue;
		void neverOmitValue;
		void omittedProperty;
		void unpickedProperty;
		void omittedRecordKey;
		void pickedNestedProperty;
		void unpickedNestedProperty;
		void retainedNestedProperty;
		void omittedNestedProperty;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		6,
		result.output,
	);
});

test("no-known-value-widening recognizes broad Pick and domain-aware Omit targets", async () => {
	const result = await lintTypeScript(`
		const broadPick: Pick<Record<string, string>, string> = { id: "ready" };
		const finitePick: Pick<Record<string, string>, "id"> = { id: "ready" };
		const finiteOmit: Omit<Record<string, string>, "id"> = { other: "ready" };
		const closedOmit: Omit<Record<string, string>, string> = { other: "ready" };
		const partialPropertyKeyOmit: Omit<Record<PropertyKey, string>, string> = { other: "ready" };
		void broadPick;
		void finitePick;
		void finiteOmit;
		void closedOmit;
		void partialPropertyKeyOmit;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-known-value-widening\)/g)?.length,
		3,
		result.output,
	);
});

test("no-known-value-widening resolves local broad dictionary aliases", async () => {
	const result = await lintTypeScript(`
		function load() {
			type LocalKey = string;
			const localRecord: Record<LocalKey, string> = { id: "ready" };
			const localPick: Pick<Record<string, string>, LocalKey> = { id: "ready" };
			void localRecord;
			void localPick;
		}
		void load;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-known-value-widening\)/g)?.length,
		2,
		result.output,
	);
});

test("no-known-value-widening recognizes keyof never and template dictionaries", async () => {
	const result = await lintTypeScript(`
		const broadTemplate: Record<\`foo-\${string}\`, string> = { "foo-id": "ready" };
		const finiteTemplate: Record<\`foo-\${"id"}\`, string> = { "foo-id": "ready" };
		const neverRecord: Record<keyof never, string> = { id: "ready" };
		const neverMapped: { [P in keyof never]: string } = { id: "ready" };
		void broadTemplate;
		void finiteTemplate;
		void neverRecord;
		void neverMapped;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-known-value-widening\)/g)?.length,
		3,
		result.output,
	);
});

test("anti-slop traverses inherited interface dictionaries with substitutions", async () => {
	const result = await lintTypeScript(`
		interface Base<T> { [key: string]: T }
		interface Derived extends Base<unknown> {}
		let direct: Derived;
		let record: Record<string, Derived>;
		let picked: Pick<Derived, string>;
		let mapped: { [P in keyof Derived]: unknown };
		void direct;
		void record;
		void picked;
		void mapped;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		4,
		result.output,
	);
});

test("no-known-value-widening traverses inherited interface dictionaries", async () => {
	const result = await lintTypeScript(`
		interface Base<T> { [key: string]: T }
		interface Derived extends Base<unknown> {}
		const direct: Derived = { id: "ready" };
		const picked: Pick<Derived, string> = { id: "ready" };
		const mapped: { [P in keyof Derived]: unknown } = { id: "ready" };
		void direct;
		void picked;
		void mapped;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-known-value-widening\)/g)?.length,
		3,
		result.output,
	);
});

test("anti-slop respects finite mapped key remapping", async () => {
	const result = await lintTypeScript(`
		const finite: { [K in string as "id"]: unknown } = { id: "ready" };
		const broad: { [K in string as K]: unknown } = { id: "ready" };
		void finite;
		void broad;
	`);
	assert.equal(result.status, 1, result.output);
	assert.equal(
		result.output.match(/anti-slop\(no-unsafe-dictionary-type\)/g)?.length,
		1,
		result.output,
	);
	assert.equal(
		result.output.match(/anti-slop\(no-known-value-widening\)/g)?.length,
		1,
		result.output,
	);
});
