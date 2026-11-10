/** Network-free checks: config validation, routing, retry behavior, and Pi registration. */
import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, AssistantMessage, ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionContext, type ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import extension, { type Criterion, type RectorConfig, type RouterState, type TimeSpec, type Usage, localParts, parseDays, parseReset, readUsage, writeUsage, recordResponse, resolveConfig, routeRequest, timeMatches, validateConfig } from "./auto-router.ts";

function check(label: string, got: unknown, want: unknown): void {
	test(label, () => assert.deepStrictEqual(got, want));
}
check("mon-fri", [...parseDays(["mon-fri"])].sort(), [1, 2, 3, 4, 5]);
check("sat-sun wraps", [...parseDays(["sat-sun"])].sort(), [0, 6]);
check("single day", [...parseDays(["wed"])], [3]);
test("invalid days", () => {
	for (const day of ["monday", "constructor", "toString"]) assert.throws(() => parseDays([day]), /Unknown day/);
});
check("local", localParts(undefined, new Date("2026-10-21T10:30:00Z")) instanceof Object, true);
check("UTC+8 midnight wrap", localParts("UTC+8", new Date("2026-10-19T23:30:00Z")), { day: 2, minutes: 450 });
check("negative fractional offset", localParts("UTC-5:30", new Date("2026-10-19T06:00:00Z")), { day: 1, minutes: 30 });
check("negative zero-hour offset", localParts("UTC-0:30", new Date("2026-10-19T00:00:00Z")), { day: 0, minutes: 1410 });
check("Rome DST midnight", localParts("Europe/Rome", new Date("2026-10-21T22:30:00Z")), { day: 4, minutes: 30 });
const zaiPeak: TimeSpec = { days: ["mon-fri"], from: "14:00", to: "18:00", tz: "UTC+8" };
for (const [label, stamp, expected] of [
	["peak start inclusive", "2026-10-19T06:00:00Z", true],
	["peak last minute", "2026-10-19T09:59:00Z", true],
	["peak end exclusive", "2026-10-19T10:00:00Z", false],
	["before peak", "2026-10-19T05:59:00Z", false],
	["Saturday off peak", "2026-10-17T06:00:00Z", false],
	["Sunday off peak", "2026-10-18T06:00:00Z", false],
] as const) check(label, timeMatches(zaiPeak, new Date(stamp)), expected);
const night: TimeSpec = { from: "23:00", to: "08:00", tz: "Europe/Rome" };
check("overnight inside", timeMatches(night, new Date("2026-10-21T22:30:00Z")), true);
check("overnight outside", timeMatches(night, new Date("2026-10-21T20:30:00Z")), false);
check("overnight exclusive end", timeMatches(night, new Date("2026-10-21T06:00:00Z")), false);
const NOW = Date.parse("2026-10-20T10:00:00Z");
check("explicit reset timestamp", parseReset("Resets at 2026-10-24T09:00:00Z", NOW), NOW + 95 * 3_600_000);
check("past reset clamped", parseReset("resets at 2020-01-01T00:00:00Z", NOW), NOW + 60_000);
check("reset seconds", parseReset("retry after 90 seconds", NOW), NOW + 90_000);
check("fractional compact reset", parseReset("Please try again in 1.253s", NOW), NOW + 1253);
check("fractional word reset", parseReset("Retry after 0.5 seconds", NOW), NOW + 500);
check("compound fractional reset", parseReset("retry in 1.5 minutes and 0.25 seconds", NOW), NOW + 90_250);
check("compound reset duration", parseReset("resets in 2 hours and 30 minutes", NOW), NOW + 2.5 * 3_600_000);
check("duration capped", parseReset("retry in 10 days", NOW), NOW + 5 * 3_600_000);
check("timestamp capped", parseReset("reset 2030-01-01T00:00:00Z", NOW), NOW + 7 * 86_400_000);
check("hyphenated limit ignored", parseReset("You have hit your 5-hour usage limit", NOW), null);
check("no reset message", parseReset(undefined, NOW), null);
check("empty reset message", parseReset("", NOW), null);

function config(): RectorConfig { return resolveConfig(); }
function peak(c: RectorConfig): Extract<Criterion, { type: "time" }> {
	return c.criteria.zaiPeak as Extract<Criterion, { type: "time" }>;
}
test("default groups are ordered with the unconditional fallback last", () => {
	const c = config();
	assert.deepEqual(Object.keys(c.models), ["simple", "complex", "standard"]);
	assert.deepEqual(c.models.simple.criteria, ["simpleTask"]);
	assert.deepEqual(c.models.complex.criteria, ["complexTask"]);
	assert.equal(c.models.standard.criteria, undefined);
	assert.equal((c.models.simple.candidates[1] as { level: string }).level, "high");
	assert.equal((c.models.complex.candidates[0] as { level: string }).level, "medium");
	assert.equal("classifier" in c, false);
	validateConfig(c);
});
for (const [label, mutate, error] of [
	["unknown criterion", (c) => { c.models.simple.criteria = ["missing"]; }, /defined criterion/],
	["bad physical id", (c) => { c.models.simple.candidates = ["no-slash"]; }, /expected provider/],
	["empty model id", (c) => { c.models.simple.candidates = ["openai/"]; }, /expected provider/],
	["recursive Rector candidate", (c) => { c.models.simple.candidates = ["rector/auto"]; }, /physical models/],
	["reserved group", (c) => { c.models.auto = c.models.simple; }, /reserved/],
	["numeric group would break declared ordering", (c) => { c.models["12"] = c.models.simple; }, /invalid/],
	["invalid group id", (c) => { c.models["has/slash"] = c.models.simple; }, /invalid/],
	["unknown criterion type", (c) => { c.criteria.bad = { type: "script" } as never; }, /type must be/],
	["classifier model missing", (c) => { c.criteria.bad = { type: "classifier", instructions: "Question" } as never; }, /non-empty string/],
	["classifier question blank", (c) => { c.criteria.bad = { type: "classifier", model: "p/m", instructions: " " }; }, /non-empty string/],
	["invalid criterion mode", (c) => { (peak(c) as unknown as { mode: string }).mode = "maybe"; }, /invalid mode/],
	["invalid days", (c) => { peak(c).time.days = ["lun"]; }, /Unknown day/],
	["invalid time independent of weekday", (c) => { peak(c).time.days = []; peak(c).time.from = "12:99"; }, /Bad time/],
	["invalid end of day", (c) => { peak(c).time.to = "24:01"; }, /Bad time/],
	["invalid offset", (c) => { peak(c).time.tz = "UTC+25"; }, /Bad timezone/],
	["invalid IANA zone", (c) => { peak(c).time.tz = "Not/AZone"; }, /time zone/i],
	["empty candidates", (c) => { c.models.simple.candidates = []; }, /non-empty array/],
	["no model groups", (c) => { c.models = {}; }, /must not be empty/],
	["unknown group property", (c) => { Object.assign(c.models.simple, { workload: "standard" }); }, /Unknown/],
	["invalid level", (c) => { c.models.simple.candidates = [{ model: "openai/x", level: "super" } as never]; }, /invalid level/],
	["null candidate", (c) => { c.models.simple.candidates = [null as never]; }, /must be an object/],
] satisfies [string, (c: RectorConfig) => void, RegExp][]) test(`validation: ${label}`, () => {
	const c = config(); mutate(c); assert.throws(() => validateConfig(c), error);
});
test("scope overrides take priority in declared order; definitions replace and null removes", () => {
	const c = resolveConfig(
		{ rector: { models: { custom: { candidates: ["p/a"] }, simple: null } } },
		{ rector: { models: { other: { candidates: ["p/c"] }, custom: { name: "Project", candidates: ["p/b"] } } } },
	);
	assert.deepEqual(Object.keys(c.models), ["other", "custom", "complex", "standard"]);
	assert.deepEqual(c.models.custom.candidates, ["p/b"]);
	assert.equal(c.models.simple, undefined);
	assert(c.models.standard);
});
test("bad settings types fail rather than silently default", () => {
	for (const rector of [null, [], "bad", { classifier: null }, { models: [] }, { workloads: {} }]) assert.throws(() => resolveConfig({ rector }));
});
test("obsolete settings are rejected, never converted or silently ignored", () => {
	for (const settings of [
		{ autoRouter: {} },
		{ autoRouter: {}, rector: {} },
		{ rector: { classifier: {} } },
		{ rector: { criteria: { old: { mode: "include", time: {} } } } },
	]) {
		const before = structuredClone(settings);
		assert.throws(() => resolveConfig(settings));
		assert.throws(() => resolveConfig({}, settings));
		assert.deepEqual(settings, before);
	}
});
test("usage round-trips, sanitizes numbers, and leaves no temporary files", () => {
	const dir = mkdtempSync(join(tmpdir(), "rector-usage-")), path = join(dir, "usage.json");
	try {
		assert.deepEqual(readUsage(path), { counts: {}, blocked: {} });
		writeUsage({ counts: { openai: 3 }, blocked: { zai: NOW + 1000 } }, path);
		assert.deepEqual(readUsage(path), { counts: { openai: 3 }, blocked: { zai: NOW + 1000 } });
		writeUsage({ counts: { openai: 4 }, blocked: {} }, path);
		assert.deepEqual(readUsage(path), { counts: { openai: 4 }, blocked: {} });
		writeFileSync(path, JSON.stringify({ counts: { good: 2, bad: -1, text: "3" }, blocked: {} }));
		assert.deepEqual(readUsage(path), { counts: { good: 2 }, blocked: {} });
		assert.deepEqual(readdirSync(dir), ["usage.json"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
test("invalid and obsolete usage files are rejected without being overwritten", () => {
	const dir = mkdtempSync(join(tmpdir(), "rector-usage-")), path = join(dir, "usage.json");
	try {
		for (const content of ["{broken", "null", '{"openai":3}', '{"counts":{}}']) {
			writeFileSync(path, content);
			assert.throws(() => readUsage(path), /Cannot read Rector usage/);
			assert.equal(readFileSync(path, "utf8"), content);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
test("a failed atomic replacement leaves the original complete and removes the temporary file", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "rector-usage-")), path = join(dir, "usage.json");
	writeUsage({ counts: { openai: 2 }, blocked: {} }, path);
	const before = readFileSync(path, "utf8");
	let snapshot: { original: string; replacement: string } | undefined;
	const rename = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
		snapshot = { original: readFileSync(to, "utf8"), replacement: readFileSync(from, "utf8") };
		throw new Error("Simulated replacement failure");
	});
	syncBuiltinESMExports();
	try {
		writeUsage({ counts: { openai: 3 }, blocked: {} }, path);
		assert.deepEqual(snapshot, { original: before, replacement: JSON.stringify({ counts: { openai: 3 }, blocked: {} }) });
		assert.equal(readFileSync(path, "utf8"), before);
		assert.deepEqual(readdirSync(dir), ["usage.json"]);
	} finally {
		rename.mock.restore(); syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true });
	}
});
test("failed persistence preserves the destination and cleans temporary files", () => {
	const dir = mkdtempSync(join(tmpdir(), "rector-usage-")), path = join(dir, "usage.json");
	try {
		writeUsage({ counts: { openai: 2 }, blocked: {} }, path);
		const before = readFileSync(path, "utf8");
		writeUsage({ counts: { invalid: 1n as never }, blocked: {} }, path);
		assert.equal(readFileSync(path, "utf8"), before);
		const directory = join(dir, "destination");
		mkdirSync(directory); writeFileSync(join(directory, "keep"), "unchanged");
		writeUsage({ counts: {}, blocked: {} }, directory);
		assert.equal(readFileSync(join(directory, "keep"), "utf8"), "unchanged");
		assert.deepEqual(readdirSync(dir).sort(), ["destination", "usage.json"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

function fixture() {
	const c = config();
	const usage: Usage = { counts: {}, blocked: {} };
	const catalog = new Map<string, Model<Api>>();
	for (const spec of Object.values(c.models)) for (const entry of spec.candidates) {
		const ref = typeof entry === "string" ? entry : entry.model;
		const slash = ref.indexOf("/");
		catalog.set(ref, { provider: ref.slice(0, slash), id: ref.slice(slash + 1), api: "openai-responses" } as Model<Api>);
	}
	const noAuth = new Set<string>();
	const classifier = { provider: "opencode", id: "jev-1.13-free" } as ClassifierModel<ClassifierApi>;
	let answer = "standard", failure = false, missing = false;
	const probabilities: Record<string, number> = {};
	let calls = 0;
	const contexts: ClassifierContext[] = [];
	let lookup: unknown[] = [];
	const registry: Parameters<typeof routeRequest>[3] = {
		find: (provider, id) => catalog.get(`${provider}/${id}`),
		hasConfiguredAuth: (model) => !noAuth.has(model.provider),
		findOfType: ((_type: string, provider: string, id: string) => { lookup = [_type, provider, id]; return missing ? undefined : { ...classifier, provider, id }; }) as Parameters<typeof routeRequest>[3]["findOfType"],
		classify: async (_model, context) => {
			calls++; contexts.push(context);
			if (failure) throw new Error("classifier offline");
			return {
				api: "typesafe-system-one", provider: _model.provider, model: _model.id, timestamp: NOW, stopReason: "stop",
				answers: Object.fromEntries(Object.entries(context.questions).map(([id, question]) => {
					const name = Object.keys(c.criteria).find((name) => {
						const criterion = c.criteria[name];
						return criterion.type === "classifier" && criterion.instructions === question.instructions;
					})!;
					const probability = probabilities[name] ?? Number(name === "simpleTask" && answer === "simple" || name === "complexTask" && answer === "complex");
					return [id, { type: "bool" as const, probability }];
				})),
			};
		},
	};
	const request = (overrides: Partial<ModelRouteRequest<RouterState>> = {}): ModelRouteRequest<RouterState> => ({ reason: "user", thinkingLevel: "medium", messages: [{ role: "user", content: "Fix this bug", timestamp: NOW }], ...overrides }) as ModelRouteRequest<RouterState>;
	const route = (group: string | undefined = undefined, overrides: Partial<ModelRouteRequest<RouterState>> = {}) => routeRequest(c, group, request(overrides), registry, usage, new Date(NOW));
	return {
		c, usage, catalog, noAuth, registry, request, route,
		setAnswer: (value: string) => { answer = value; },
		setMatch: (name: string, value: boolean | number) => { probabilities[name] = typeof value === "boolean" ? Number(value) : value; },
		setFailure: () => { failure = true; }, setMissing: () => { missing = true; },
		get calls() { return calls; }, get context() { return contexts.at(-1); }, contexts, get lookup() { return lookup; },
	};
}
function response(message: Pick<AssistantMessage, "provider" | "stopReason"> & Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant", api: "openai-responses", model: "fixture", content: [], timestamp: NOW,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		...message,
	};
}
function failed(model: Model<Api>, errorMessage = "retry after 60 seconds"): NonNullable<ModelRouteRequest<RouterState>["failed"]> {
	return { model, thinkingLevel: "medium", message: response({ provider: model.provider, model: model.id, errorMessage, stopReason: "error" }) };
}
function never(f: ReturnType<typeof fixture>): void {
	f.c.criteria.never = { type: "time", mode: "include", time: { days: [] } };
}
test("automatic routing uses compatible classifier models and batches boolean rules", async () => {
	const f = fixture();
	f.c.criteria.simpleTask = { type: "classifier", model: "openrouter/typesafe/jev-1.14", instructions: "Is this simple?" };
	f.c.criteria.complexTask = { type: "classifier", model: "openrouter/typesafe/jev-1.14", instructions: "Is this complex?" };
	f.setMatch("complexTask", true);
	const result = await f.route();
	assert.equal(result.model.id, "gpt-6.1-sol");
	assert.deepEqual(f.lookup, ["classifier", "openrouter", "typesafe/jev-1.14"]);
	assert.equal(f.calls, 1);
	assert.deepEqual(Object.values(f.context!.questions).map((q) => [q.type, q.instructions]), [["bool", "Is this simple?"], ["bool", "Is this complex?"]]);
	assert.deepEqual(f.context?.state, { prompt: "Fix this bug" });
});
test("manual group selection bypasses root classifiers", async () => {
	const f = fixture(); f.setFailure();
	const result = await f.route("complex");
	assert.equal(result.model.id, "gpt-6.1-sol"); assert.equal(result.thinkingLevel, "medium"); assert.equal(f.calls, 0);
});
test("manual selection keeps group-level time constraints", async () => {
	const f = fixture(); never(f);
	f.c.models.complex.criteria = ["complexTask", "never"];
	await assert.rejects(f.route("complex"), /excluded by group time criteria/);
	assert.equal(f.calls, 0);
});
test("manual selection does not bypass classifiers attached to candidates", async () => {
	const f = fixture();
	f.c.models.complex.candidates = [{ model: "openai/gpt-6.1-sol", criteria: ["complexTask"] }];
	await assert.rejects(f.route("complex"), /candidate criteria not satisfied/);
	assert.equal(f.calls, 1);
});
test("group and candidate criteria combine with AND", async () => {
	const f = fixture(); never(f); f.setAnswer("simple");
	f.c.models.simple.candidates = [{ model: "zai/glm-5.3-flash", criteria: ["never"] }, "openai/gpt-6-luna"];
	const result = await f.route();
	assert.equal(result.state?.group, "simple"); assert.equal(result.model.provider, "openai");
});
test("thinking never chooses the group", async () => {
	const f = fixture();
	for (const thinkingLevel of ["low", "medium", "high", "xhigh"] as const) {
		const result = await f.route(undefined, { thinkingLevel });
		assert.equal(result.state?.group, "standard"); assert.equal(result.thinkingLevel, thinkingLevel);
	}
	assert.equal(f.calls, 4);
});
test("arbitrary group names work in automatic and manual modes", async () => {
	const f = fixture();
	f.c.models = { lookup: f.c.models.simple, fallback: f.c.models.standard };
	f.setAnswer("simple");
	assert.equal((await f.route()).state?.group, "lookup");
	assert.equal((await f.route("lookup")).state?.group, "lookup");
});
test("first matching usable group wins when several classifiers return true", async () => {
	const f = fixture(); f.setMatch("simpleTask", true); f.setMatch("complexTask", true);
	assert.equal((await f.route()).state?.group, "simple");
	f.c.models = { complex: f.c.models.complex, simple: f.c.models.simple, standard: f.c.models.standard };
	assert.equal((await f.route()).state?.group, "complex");
});
test("automatic selection can advance to another group if a matching group has no candidates", async () => {
	const f = fixture(); f.setAnswer("complex"); f.usage.blocked = { openai: NOW + 60_000, "openai-codex": NOW + 60_000 };
	assert.equal((await f.route()).state?.group, "standard");
	await assert.rejects(f.route("complex"), /complex: no candidate available/);
});
for (const mode of ["missing", "throws", "false"] as const) test(`classifier gates fail closed: ${mode}`, async () => {
	const f = fixture();
	if (mode === "missing") f.setMissing(); else if (mode === "throws") f.setFailure();
	assert.equal((await f.route()).state?.group, "standard");
	assert.equal(f.calls, mode === "missing" ? 0 : 1);
});
for (const stopReason of ["error", "stop"] as const) test(`missing classifier answers close gates: ${stopReason}`, async () => {
	const f = fixture(); f.registry.classify = async () => ({ stopReason, answers: {} }) as ClassifierResult;
	assert.equal((await f.route()).state?.group, "standard");
});
for (const probability of [NaN, Infinity, -0.1, 1.1, 0.49]) test(`invalid or negative classifier verdict does not match: ${probability}`, async () => {
	const f = fixture(); f.setMatch("simpleTask", probability);
	assert.equal((await f.route()).state?.group, "standard");
});
test("boolean probability threshold is inclusive at 0.5", async () => {
	const f = fixture(); f.setMatch("simpleTask", 0.5);
	assert.equal((await f.route()).state?.group, "simple");
});
test("no matching group fails explicitly without inventing a fallback", async () => {
	const f = fixture(); delete f.c.models.standard;
	await assert.rejects(f.route(), /no eligible model group/);
});
test("time criteria are checked before classifiers even when listed last", async () => {
	const f = fixture(); never(f);
	for (const spec of Object.values(f.c.models)) spec.criteria = ["simpleTask", "never"];
	await assert.rejects(f.route(), /no eligible model group/); assert.equal(f.calls, 0);
});
test("all unavailable physical candidates avoid classifier requests", async () => {
	const f = fixture(); for (const provider of ["openai", "openai-codex", "zai"]) f.noAuth.add(provider);
	await assert.rejects(f.route(), /no credentials/); assert.equal(f.calls, 0);
});
test("time-only routing works without a classifier", async () => {
	const f = fixture(); f.c.models = { first: { candidates: ["zai/glm-5.3"] } };
	assert.equal((await f.route()).state?.group, "first"); assert.equal(f.calls, 0);
});
test("unused classifier definitions are not sent to a provider", async () => {
	const f = fixture(); f.c.criteria.unused = { type: "classifier", model: "opencode/jev-1.13-free", instructions: "Unused instruction" };
	await f.route();
	assert(Object.values(f.context!.questions).every((q) => q.instructions !== "Unused instruction"));
});
test("classifiers with different model IDs are not batched together", async () => {
	const f = fixture(); f.c.criteria.complexTask = { type: "classifier", model: "other/judge", instructions: "Complex?" };
	await f.route(); assert.equal(f.calls, 2);
});
test("multiple root and candidate gates share one classifier call", async () => {
	const f = fixture(); f.setAnswer("simple");
	f.c.models.simple.criteria = ["simpleTask", "complexTask"]; f.setMatch("complexTask", true);
	f.c.models.simple.candidates = [{ model: "openai/gpt-6-luna", criteria: ["simpleTask"] }];
	assert.equal((await f.route()).state?.group, "simple"); assert.equal(f.calls, 1);
});
test("new user turns discard cached classifier answers", async () => {
	const f = fixture(); f.setAnswer("simple"); const first = await f.route();
	f.setAnswer("complex"); const next = await f.route(undefined, { state: first.state });
	assert.equal(next.state?.group, "complex"); assert.equal(f.calls, 2);
});
test("criteria edits invalidate persisted classifier answers", async () => {
	const f = fixture(); f.setAnswer("complex"); const first = await f.route();
	f.c.criteria.complexTask = { type: "classifier", model: "opencode/jev-1.13-free", instructions: "New rule" };
	f.setAnswer("standard");
	await assert.rejects(f.route(undefined, { reason: "continuation", state: first.state, previous: { model: first.model, thinkingLevel: first.thinkingLevel } }), /group criteria/);
	assert.equal(f.calls, 2);
});

test("peak window skips GLM; Terra does not downgrade to Luna", async () => {
	const f = fixture();
	const result = await routeRequest(f.c, "standard", f.request(), f.registry, f.usage, new Date("2026-10-19T07:00:00Z"));
	assert.equal(result.model.id, "gpt-6.1-terra");
});
test("missing catalog entries and unauthenticated providers are skipped", async () => {
	const f = fixture(); f.catalog.delete("zai/glm-5.3"); f.noAuth.add("openai");
	assert.equal((await f.route("standard")).model.provider, "openai-codex");
});
test("nested model IDs keep their full path", async () => {
	const f = fixture(); f.c.models.standard.candidates = ["openrouter/vendor/model"];
	f.catalog.set("openrouter/vendor/model", { provider: "openrouter", id: "vendor/model", api: "openai-completions" } as Model<Api>);
	assert.equal((await f.route("standard")).model.id, "vendor/model");
});
test("virtual candidates from other extensions are skipped", async () => {
	const f = fixture(); f.c.models.standard.candidates = ["other/auto"];
	f.catalog.set("other/auto", { provider: "other", id: "auto", api: "pi-virtual" } as Model<Api>);
	await assert.rejects(f.route("standard"), /not a physical model/);
});
test("OpenAI pairs choose fewer dispatches and retain session affinity", async () => {
	const f = fixture(); f.usage.counts = { openai: 20, "openai-codex": 1 };
	assert.equal((await f.route("complex")).model.provider, "openai-codex");
	const selected = await f.route("complex", { state: { group: "complex", openaiProvider: "openai" } });
	assert.equal(selected.model.provider, "openai"); assert.equal(f.usage.counts.openai, 21);
});
test("both pair members obey criteria and entry thinking", async () => {
	const f = fixture(); never(f);
	f.c.models.complex.candidates = [{ model: "openai/gpt-6.1-sol", level: "low" }, { model: "openai-codex/gpt-6.1-sol", criteria: ["never"], level: "high" }];
	f.usage.counts = { openai: 10, "openai-codex": 0 };
	const result = await f.route("complex");
	assert.equal(result.model.provider, "openai"); assert.equal(result.thinkingLevel, "low");
});
test("manual and automatic selection resolve the same group identically", async () => {
	const a = fixture(), b = fixture(); a.setAnswer("complex");
	const automatic = await a.route(), manual = await b.route("complex");
	assert.deepEqual(automatic.model, manual.model);
	assert.equal(automatic.thinkingLevel, manual.thinkingLevel);
	assert.equal(automatic.state?.group, manual.state?.group);
});
for (const group of [undefined, "complex"] as const) test(`retry shares resolver: ${group ?? "automatic"}`, async () => {
	const f = fixture(); f.setAnswer("complex");
	const first = await f.route(group);
	const result = await f.route(group, { reason: "retry", state: first.state, failed: failed(first.model), previous: { model: first.model, thinkingLevel: "high" } });
	assert.equal(result.model.provider, "openai-codex"); assert.equal(result.thinkingLevel, "medium");
	assert.equal(result.state?.group, "complex"); assert.equal(f.usage.blocked.openai, NOW + 60_000);
	assert.equal(f.calls, group ? 0 : 1);
});
test("retry cannot bypass the other account's criterion", async () => {
	const f = fixture(); never(f);
	f.c.models.complex.candidates[1] = { model: "openai-codex/gpt-6.1-sol", criteria: ["never"] };
	const first = await f.route("complex");
	await assert.rejects(f.route("complex", { reason: "retry", state: first.state, failed: failed(first.model) }), /no candidate available/);
});
test("automatic retry stays in its selected group even if another group is usable", async () => {
	const f = fixture(); f.setAnswer("complex");
	const first = await f.route(); f.usage.blocked["openai-codex"] = NOW + 60_000;
	await assert.rejects(f.route(undefined, { reason: "retry", state: first.state, failed: failed(first.model) }), /complex: no candidate available/);
	assert.equal(f.calls, 1);
});
test("retry follows candidate order even across providers", async () => {
	const f = fixture(); const first = await f.route("standard");
	const next = await f.route("standard", { reason: "retry", state: first.state, failed: failed(first.model) });
	assert.equal(first.model.provider, "zai"); assert.equal(next.model.id, "gpt-6.1-terra");
});
test("unknown reset uses 30 minutes; existing longer blocks are preserved", async () => {
	const f = fixture(); const model = f.catalog.get("zai/glm-5.3")!;
	await f.route("standard", { reason: "retry", state: { group: "standard" }, failed: failed(model, "network error") });
	assert.equal(f.usage.blocked.zai, NOW + 30 * 60_000);
	f.usage.blocked.zai = NOW + 3_600_000;
	await f.route("standard", { reason: "retry", state: { group: "standard" }, failed: failed(model) });
	assert.equal(f.usage.blocked.zai, NOW + 3_600_000);
});
test("continuations retain model, effort, and category without classification or double counting", async () => {
	const f = fixture(); f.setAnswer("complex"); const first = await f.route();
	const result = await f.route(undefined, { reason: "continuation", state: first.state, previous: { model: first.model, thinkingLevel: first.thinkingLevel } });
	assert.equal(result.model, first.model); assert.equal(result.thinkingLevel, "medium"); assert.equal(f.calls, 1); assert.equal(f.usage.counts.openai, 1);
});
test("continuation rechecks criteria, availability, and credential changes", async () => {
	const f = fixture(); const first = await f.route("standard"); f.noAuth.add("zai");
	const result = await f.route("standard", { reason: "continuation", state: first.state, previous: { model: first.model, thinkingLevel: first.thinkingLevel } });
	assert.equal(result.model.id, "gpt-6.1-terra");
});
test("continuations recheck time gates without repeating classifier calls", async () => {
	const f = fixture(); f.setAnswer("simple"); const first = await f.route();
	const result = await routeRequest(f.c, undefined, f.request({ reason: "continuation", state: first.state, previous: { model: first.model, thinkingLevel: first.thinkingLevel } }), f.registry, f.usage, new Date("2026-10-21T07:00:00Z"));
	assert.equal(first.model.provider, "zai"); assert.equal(result.model.id, "gpt-6-luna"); assert.equal(f.calls, 1);
});
test("an expired group time gate stops a continuation rather than switching groups", async () => {
	const f = fixture(); f.setAnswer("simple");
	f.c.criteria.morning = { type: "time", mode: "include", time: { from: "10:00", to: "11:00", tz: "UTC" } };
	f.c.models.simple.criteria = ["simpleTask", "morning"];
	const first = await f.route();
	await assert.rejects(routeRequest(f.c, undefined, f.request({ reason: "continuation", state: first.state, previous: { model: first.model, thinkingLevel: first.thinkingLevel } }), f.registry, f.usage, new Date("2026-10-20T12:00:00Z")), /excluded by group time criteria/);
	assert.equal(f.calls, 1);
});
test("historical successful response cannot clear a current provider block", async () => {
	const f = fixture(); f.usage.blocked.openai = NOW + 60_000;
	const result = await f.route("complex", { previous: { model: f.catalog.get("openai/gpt-6.1-sol")!, thinkingLevel: "medium" } });
	assert.equal(result.model.provider, "openai-codex"); assert.equal(f.usage.blocked.openai, NOW + 60_000);
});
test("direct automatic requests follow the same ordered criteria", async () => {
	const f = fixture(); f.setAnswer("simple");
	assert.equal((await f.route(undefined, { reason: "direct" })).state?.group, "simple"); assert.equal(f.calls, 1);
});
test("aborted requests do not dispatch or fallback", async () => {
	const f = fixture(); const controller = new AbortController(); controller.abort();
	await assert.rejects(f.route(undefined, { signal: controller.signal }), /abort/i); assert.equal(f.calls, 0);
});
test("abort during classification propagates", async () => {
	const f = fixture(); const controller = new AbortController();
	f.registry.classify = async () => { controller.abort(); throw new Error("cancelled"); };
	await assert.rejects(f.route(undefined, { signal: controller.signal }), /abort/i); assert.deepEqual(f.usage.counts, {});
});
test("classifier aborted result does not use fallback", async () => {
	const f = fixture(); f.registry.classify = async () => ({ stopReason: "aborted", answers: {} }) as ClassifierResult;
	await assert.rejects(f.route(), /aborted/);
});
test("classifier input uses only last user text, with a 16000-character limit", async () => {
	const f = fixture();
	await f.route(undefined, { messages: [{ role: "user", content: "old", timestamp: NOW }, { role: "user", content: [{ type: "text", text: "x".repeat(16_500) }, { type: "image", data: "not-sent", mimeType: "image/png" }], timestamp: NOW }] });
	assert.deepEqual(f.context?.state, { prompt: "x".repeat(16_000) });
});
test("context overflow neither creates nor clears provider blocks", () => {
	const f = fixture();
	const message = response({ provider: "zai", stopReason: "error", errorMessage: "maximum context length exceeded" });
	recordResponse(f.usage, message, NOW);
	assert.deepEqual(f.usage.blocked, {});
	f.usage.blocked.zai = NOW + 60_000;
	recordResponse(f.usage, message, NOW);
	assert.equal(f.usage.blocked.zai, NOW + 60_000);
});
test("context overflow retry can reuse the provider after Pi compacts", async () => {
	const f = fixture(); const first = await f.route("standard");
	const next = await f.route("standard", { reason: "retry", state: first.state, failed: failed(first.model, "maximum context length exceeded") });
	assert.equal(next.model.provider, "zai"); assert.deepEqual(f.usage.blocked, {});
});
test("rate limits still block even when their text mentions tokens", () => {
	const f = fixture();
	recordResponse(f.usage, response({ provider: "zai", stopReason: "error", errorMessage: "rate limit: too many tokens; retry in 2 seconds" }), NOW);
	assert.equal(f.usage.blocked.zai, NOW + 2000);
});
test("an observed error blocks the next turn even without a Pi retry", async () => {
	const f = fixture();
	recordResponse(f.usage, response({ provider: "zai", stopReason: "error", errorMessage: "retry after 90 seconds" }), NOW);
	assert.equal((await f.route("standard")).model.provider, "openai");
	assert.equal(f.usage.blocked.zai, NOW + 90_000);
});
test("only new successful responses clear blocks; cancellation does not", () => {
	const f = fixture(); f.usage.blocked = { zai: NOW + 60_000 };
	recordResponse(f.usage, response({ provider: "zai", stopReason: "aborted" }), NOW);
	assert.equal(f.usage.blocked.zai, NOW + 60_000);
	recordResponse(f.usage, response({ provider: "zai", stopReason: "stop" }), NOW);
	assert.equal(f.usage.blocked.zai, undefined);
});
test("README examples validate and the complete policy equals the defaults", () => {
	const doc = readFileSync(new URL("./README.md", import.meta.url), "utf8");
	const examples = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
	assert.equal(examples.length, 3);
	for (const example of examples) resolveConfig(example);
	assert.deepEqual(examples[0].rector, config());
	const headings = [...doc.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/[^\w\s-]/g, "").replace(/ /g, "-"));
	for (const [, anchor] of doc.matchAll(/\]\(#([^)]*)\)/g)) assert(headings.includes(anchor), `Broken anchor ${anchor}`);
});
test("Pi's real model runtime accepts both Rector routes and keeps physical models selectable", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-rector-runtime-"));
	const offline = process.env.PI_OFFLINE;
	try {
		process.env.PI_OFFLINE = "1";
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
		runtime.registerProvider("rector-fixture", {
			api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-only-placeholder",
			models: [{ id: "physical", name: "Physical", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }],
		});
		await runtime.refresh({ allowNetwork: false });
		const registry = new ModelRegistry(runtime);
		const c = resolveConfig({ rector: { models: { standard: { candidates: ["rector-fixture/physical"] } } } });
		for (const id of ["auto", "standard"]) runtime.registerVirtualModel({
			provider: "rector", id, name: id === "auto" ? "Rector" : "Standard", thinkingLevels: ["medium", "high"],
			route: (request) => routeRequest(c, id === "auto" ? undefined : id, request as ModelRouteRequest<RouterState>, registry, { counts: {}, blocked: {} }),
		});
		for (const id of ["auto", "standard"]) {
			const virtual = runtime.getModel("rector", id)!;
			assert.equal(virtual.api, "pi-virtual");
			const result = await runtime.resolveModel(virtual, [{ role: "user", content: "Hello", timestamp: NOW }], { reason: "user", thinkingLevel: "high" });
			assert.equal(result.model.provider, "rector-fixture"); assert.equal(result.model.id, "physical");
			assert.equal((result.state as RouterState).group, "standard");
		}
		assert.equal(runtime.getPhysicalModel("rector-fixture", "physical")?.api, "openai-completions");
		assert.equal(runtime.getPhysicalModel("rector", "auto"), undefined);
	} finally {
		if (offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = offline;
		rmSync(dir, { recursive: true, force: true });
	}
});
test("registration exposes Rector groups and rejects untrusted project routing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-rector-test-"));
	const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = dir; process.chdir(dir);
		mkdirSync(join(dir, ".pi"));
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ rector: { models: { custom: { name: "Custom", candidates: ["p/a"] } } } }));
		writeFileSync(join(dir, ".pi/settings.json"), JSON.stringify({ rector: { models: { custom: { name: "Project Custom", candidates: ["p/b"] } } } }));
		type Definition = { provider: string; id: string; name: string; route: (request: ModelRouteRequest<RouterState>, ctx: ExtensionContext) => Promise<unknown> };
		const registrations: Definition[] = [];
		const hooks: string[] = [];
		extension({ registerVirtualModel: (definition: Definition) => { registrations.push(definition); }, on: (event: string) => { hooks.push(event); } } as unknown as ExtensionAPI);
		assert.deepEqual(registrations.map(({ provider, id, name }) => [provider, id, name]), [["rector", "auto", "Rector"], ["rector", "custom", "Project Custom"], ["rector", "simple", "Simple"], ["rector", "complex", "Complex"], ["rector", "standard", "Standard"]]);
		assert.deepEqual(hooks, ["message_end"]);
		await assert.rejects(registrations[0].route(fixture().request(), { isProjectTrusted: () => false } as ExtensionContext), /requires project trust/);
		assert.throws(() => { writeFileSync(join(dir, "settings.json"), "{broken"); extension({} as ExtensionAPI); }, /Cannot read Rector settings/);
	} finally {
		process.chdir(cwd); if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = agentDir;
		rmSync(dir, { recursive: true, force: true });
	}
});
