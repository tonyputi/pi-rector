/** Rector: configurable virtual model groups, selected manually or by a classifier. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessage, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ModelRoute, type ModelRouteRequest } from "@earendil-works/pi-coding-agent";

const USAGE_FILE = join(fileURLToPath(new URL(".", import.meta.url)), "router-usage.json");
const LEVELS = ["low", "medium", "high", "xhigh"] as const satisfies readonly ModelThinkingLevel[];
const OPENAI = ["openai", "openai-codex"] as const;
const RETRY_AFTER_UNKNOWN = 30 * 60_000;

export interface TimeSpec {
	days?: string[];
	from?: string;
	to?: string;
	tz?: string;
}
export type Criterion =
	| { type: "time"; mode: "include" | "exclude"; time: TimeSpec }
	| { type: "classifier"; model: string; instructions: string };
export type Candidate = string | { model: string; criteria?: string[]; level?: ModelThinkingLevel };
export interface ModelSpec {
	name?: string;
	criteria?: string[];
	candidates: Candidate[];
}
export interface RectorConfig {
	criteria: Record<string, Criterion>;
	models: Record<string, ModelSpec>;
}
export interface RouterState {
	group: string;
	openaiProvider?: string;
	matches?: Record<string, boolean>;
	criteriaVersion?: string;
}
export interface Usage {
	counts: Record<string, number>;
	blocked: Record<string, number>;
}
type Registry = Pick<ExtensionContext["modelRegistry"], "find" | "findOfType" | "classify" | "hasConfiguredAuth">;

const DEFAULTS: RectorConfig = {
	criteria: {
		simpleTask: { type: "classifier", model: "opencode/jev-1.13-free", instructions: "Is the request in `prompt` a short answer, simple lookup, or straightforward small edit?" },
		complexTask: { type: "classifier", model: "opencode/jev-1.13-free", instructions: "Does the request in `prompt` require architecture, difficult debugging, or cross-cutting changes rather than ordinary implementation?" },
		zaiPeak: { type: "time", mode: "exclude", time: { days: ["mon-fri"], from: "14:00", to: "18:00", tz: "UTC+8" } },
	},
	models: {
		simple: {
			name: "Simple",
			criteria: ["simpleTask"],
			candidates: [
				{ model: "zai/glm-5.3-flash", criteria: ["zaiPeak"] },
				{ model: "openai/gpt-6-luna", level: "high" },
				{ model: "openai-codex/gpt-6-luna", level: "high" },
			],
		},
		complex: {
			name: "Complex",
			criteria: ["complexTask"],
			candidates: [{ model: "openai/gpt-6.1-sol", level: "medium" }, { model: "openai-codex/gpt-6.1-sol", level: "medium" }],
		},
		standard: {
			name: "Standard",
			candidates: [{ model: "zai/glm-5.3", criteria: ["zaiPeak"] }, "openai/gpt-6.1-terra", "openai-codex/gpt-6.1-terra"],
		},
	},
};

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}
function text(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}
function knownKeys(value: Record<string, unknown>, keys: string[], label: string): void {
	for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${label} setting "${key}"`);
}
function modelParts(value: unknown, label: string): [string, string] {
	text(value, label);
	const slash = value.indexOf("/");
	if (slash < 1 || slash === value.length - 1 || /\s/.test(value)) throw new Error(`${label}: expected provider/model`);
	return [value.slice(0, slash), value.slice(slash + 1)];
}
function references(value: unknown, criteria: Record<string, unknown>, label: string): void {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !Object.hasOwn(criteria, name))) {
		throw new Error(`${label}: expected an array of defined criterion names`);
	}
}

export function validateConfig(value: unknown): asserts value is RectorConfig {
	const config = record(value, "rector");
	knownKeys(config, ["criteria", "models"], "rector");
	const criteria = record(config.criteria, "rector.criteria");
	for (const [name, value] of Object.entries(criteria)) {
		const label = `rector.criteria.${name}`;
		const criterion = record(value, label);
		if (criterion.type === "classifier") {
			knownKeys(criterion, ["type", "model", "instructions"], label);
			modelParts(criterion.model, `${label}.model`);
			text(criterion.instructions, `${label}.instructions`);
			continue;
		}
		if (criterion.type !== "time") throw new Error(`${label}: type must be time or classifier`);
		knownKeys(criterion, ["type", "mode", "time"], label);
		if (criterion.mode !== "include" && criterion.mode !== "exclude") throw new Error(`${label}: invalid mode`);
		const time = record(criterion.time, `${label}.time`);
		knownKeys(time, ["days", "from", "to", "tz"], `${label}.time`);
		if (time.days !== undefined) {
			if (!Array.isArray(time.days) || time.days.some((day) => typeof day !== "string")) throw new Error(`${label}: invalid days`);
			parseDays(time.days);
		}
		for (const bound of ["from", "to"]) if (time[bound] !== undefined) {
			text(time[bound], `${label}.${bound}`);
			parseHHMM(time[bound]);
		}
		if (time.tz !== undefined) text(time.tz, `${label}.tz`);
		localParts(time.tz as string | undefined, new Date());
	}
	const models = record(config.models, "rector.models");
	if (!Object.keys(models).length) throw new Error("rector.models must not be empty");
	for (const [id, value] of Object.entries(models)) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || /^\d+$/.test(id) || id === "auto") throw new Error(`rector.models: invalid or reserved id "${id}"`);
		const spec = record(value, `rector.models.${id}`);
		knownKeys(spec, ["name", "criteria", "candidates"], `rector.models.${id}`);
		if (spec.name !== undefined) text(spec.name, `rector.models.${id}.name`);
		references(spec.criteria, criteria, `rector.models.${id}.criteria`);
		if (!Array.isArray(spec.candidates) || !spec.candidates.length) throw new Error(`rector.models.${id}: candidates must be a non-empty array`);
		for (const [index, value] of spec.candidates.entries()) {
			const label = `rector.models.${id}.candidates[${index}]`;
			const entry = typeof value === "string" ? { model: value } : record(value, label);
			knownKeys(entry, ["model", "criteria", "level"], label);
			const [provider] = modelParts(entry.model, label);
			if (provider === "rector" || provider === "auto") throw new Error(`${label}: candidates must be physical models, not Rector routes`);
			references(entry.criteria, criteria, `${label}.criteria`);
			if (entry.level !== undefined && !(LEVELS as readonly unknown[]).includes(entry.level)) throw new Error(`${label}: invalid level`);
		}
	}
}

const OLD_CLASSIFIER = {
	model: "opencode/jev-1.13-free",
	instructions: "Choose the model group best suited to the user's request in `prompt`.",
	models: {
		simple: "Short answers, simple lookups, and straightforward small edits.",
		standard: "Ordinary implementation, bug fixes, reviews, and explanations.",
		complex: "Architecture, difficult debugging, and cross-cutting changes.",
	},
	fallback: "standard",
};

/** Compatibility only: convert the former selector to boolean gates, with its fallback last. */
function migrateSelector(raw: Record<string, unknown>): void {
	const selector = { ...OLD_CLASSIFIER, ...record(raw.classifier, "rector.classifier") };
	knownKeys(selector, ["model", "instructions", "models", "fallback"], "rector.classifier");
	modelParts(selector.model, "rector.classifier.model");
	text(selector.instructions, "rector.classifier.instructions");
	const choices = record(selector.models, "rector.classifier.models");
	const models = record(raw.models, "rector.models");
	const criteria = record(raw.criteria, "rector.criteria");
	text(selector.fallback, "rector.classifier.fallback");
	if (!Object.hasOwn(choices, selector.fallback)) throw new Error("rector.classifier.fallback must name a classifier model group");
	for (const [id, rule] of Object.entries(choices)) {
		if (!Object.hasOwn(models, id)) throw new Error(`rector.classifier.models: unknown model group "${id}"`);
		text(rule, `rector.classifier.models.${id}`);
		if (id === selector.fallback) continue;
		const name = `select-${id}`;
		if (Object.hasOwn(criteria, name)) throw new Error(`Migration criterion "${name}" already exists; migrate rector.classifier manually`);
		criteria[name] = { type: "classifier", model: selector.model, instructions: `${selector.instructions}\nAvailable groups: ${JSON.stringify(choices)}\nAnswer true only if "${id}" is the best matching group.` };
		const spec = record(models[id], `rector.models.${id}`);
		references(spec.criteria, criteria, `rector.models.${id}.criteria`);
		models[id] = { ...spec, criteria: [...(spec.criteria as string[] | undefined ?? []), name] };
	}
	const order = [...Object.keys(choices).filter((id) => id !== selector.fallback), selector.fallback];
	raw.models = { ...Object.fromEntries(order.map((id) => [id, models[id]])), ...Object.fromEntries(Object.entries(models).filter(([id]) => !Object.hasOwn(choices, id))) };
	delete raw.classifier;
}

/** Convert legacy settings in memory only; no user files or stored selections are rewritten. */
function legacyConfig(user: Record<string, unknown>, project: Record<string, unknown>): Record<string, unknown> {
	const a = user.autoRouter === undefined ? {} : record(user.autoRouter, "autoRouter");
	const b = project.autoRouter === undefined ? {} : record(project.autoRouter, "autoRouter");
	const section = (source: Record<string, unknown>, key: string) => source[key] === undefined ? {} : record(source[key], `autoRouter.${key}`);
	const tiers = { trivial: DEFAULTS.models.simple.candidates, complex: DEFAULTS.models.complex.candidates, standard: DEFAULTS.models.standard.candidates, ...section(a, "workloads"), ...section(b, "workloads") };
	const groups: Record<string, ModelSpec> = {};
	for (const [id, candidates] of Object.entries(tiers)) groups[id] = { candidates: candidates as Candidate[] };
	for (const [id, value] of Object.entries({ ...section(a, "models"), ...section(b, "models") })) {
		if (value === null) continue;
		if (["smart", "zai", "openai"].includes(id) || Object.hasOwn(tiers, id)) throw new Error(`autoRouter.models.${id} conflicts with a router or workload; migrate to rector.models`);
		const pool = record(value, `autoRouter.models.${id}`);
		text(pool.workload, `autoRouter.models.${id}.workload`);
		if (!Object.hasOwn(tiers, pool.workload)) throw new Error(`autoRouter.models.${id}: unknown workload "${pool.workload}"`);
		let candidates = tiers[pool.workload as keyof typeof tiers];
		if (!Array.isArray(candidates)) throw new Error(`autoRouter workload "${pool.workload}" must be an array`);
		if (pool.providers !== undefined) {
			if (!Array.isArray(pool.providers) || pool.providers.some((provider) => typeof provider !== "string")) throw new Error(`autoRouter.models.${id}: invalid providers`);
			candidates = candidates.filter((entry) => (pool.providers as string[]).includes(modelParts(typeof entry === "string" ? entry : record(entry, id).model, id)[0]));
		}
		groups[id] = { name: pool.name as string | undefined, criteria: pool.criteria as string[] | undefined, candidates: candidates as Candidate[] };
	}
	return {
		classifier: { ...OLD_CLASSIFIER, models: { trivial: OLD_CLASSIFIER.models.simple, complex: OLD_CLASSIFIER.models.complex, standard: OLD_CLASSIFIER.models.standard } },
		criteria: { zaiPeak: DEFAULTS.criteria.zaiPeak, ...section(a, "criteria"), ...section(b, "criteria") },
		models: groups,
	};
}

export function resolveConfig(user: Record<string, unknown> = {}, project: Record<string, unknown> = {}): { config: RectorConfig; legacy: boolean } {
	const hasRector = user.rector !== undefined || project.rector !== undefined;
	let legacy = user.autoRouter !== undefined || project.autoRouter !== undefined;
	let raw: Record<string, unknown>;
	if (legacy && !hasRector) raw = legacyConfig(user, project);
	else {
		const scopes = [user, project].filter((settings) => settings.rector !== undefined).map((settings) => record(settings.rector, "rector"));
		const oldSelector = scopes.some((scope) => scope.classifier !== undefined);
		raw = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;
		if (oldSelector) {
			raw.classifier = structuredClone(OLD_CLASSIFIER);
			raw.models = Object.fromEntries(Object.entries(DEFAULTS.models).map(([id, spec]) => [id, { ...spec, criteria: undefined }]));
			legacy = true;
		}
		for (const custom of scopes) {
			knownKeys(custom, ["classifier", "criteria", "models"], "rector");
			for (const key of ["classifier", "criteria", "models"]) if (custom[key] !== undefined) {
				const entries = record(custom[key], `rector.${key}`);
				const inherited = record(raw[key], key);
				raw[key] = key === "models"
					? { ...entries, ...Object.fromEntries(Object.entries(inherited).filter(([id]) => !Object.hasOwn(entries, id))) }
					: { ...inherited, ...entries };
			}
		}
	}
	raw.models = Object.fromEntries(Object.entries(record(raw.models, "rector.models")).filter(([, value]) => value !== null));
	if (raw.classifier !== undefined) migrateSelector(raw);
	raw.criteria = Object.fromEntries(Object.entries(record(raw.criteria, "rector.criteria")).map(([name, value]) => {
		const criterion = record(value, `rector.criteria.${name}`);
		if (criterion.type === undefined && criterion.time !== undefined) { legacy = true; return [name, { type: "time", ...criterion }]; }
		return [name, criterion];
	}));
	validateConfig(raw);
	return { config: raw, legacy };
}

function readSettings(path: string): Record<string, unknown> {
	try {
		return record(JSON.parse(readFileSync(path, "utf8")), path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Cannot read Rector settings from ${path}`, { cause: error });
	}
}
function readUsage(): Usage {
	try {
		const raw = JSON.parse(readFileSync(USAGE_FILE, "utf8"));
		const numbers = (value: unknown) => Object.fromEntries(Object.entries(record(value, "usage")).filter(([, n]) => typeof n === "number" && Number.isFinite(n) && n >= 0)) as Record<string, number>;
		return { counts: numbers(raw.counts ?? raw), blocked: numbers(raw.blocked ?? {}) };
	} catch {
		return { counts: {}, blocked: {} };
	}
}
function writeUsage(usage: Usage): void {
	try {
		writeFileSync(USAGE_FILE, JSON.stringify(usage));
	} catch {
		// shortcut: an unwritable installation loses routing history; use a writable checkout for persistence.
	}
}

const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
export function parseDays(days: readonly string[]): Set<number> {
	const out = new Set<number>();
	for (const day of days) {
		const range = /^([a-z]{3})-([a-z]{3})$/.exec(day);
		if (range) {
			const from = DAY_INDEX[range[1]], to = DAY_INDEX[range[2]];
			if (from === undefined || to === undefined) throw new Error(`Unknown day range "${day}"`);
			for (let i = from; ; i = (i + 1) % 7) { out.add(i); if (i === to) break; }
		} else {
			if (!Object.hasOwn(DAY_INDEX, day)) throw new Error(`Unknown day "${day}"`);
			out.add(DAY_INDEX[day]);
		}
	}
	return out;
}
function parseHHMM(value: string): number {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value);
	if (!match || Number(match[2]) > 59 || Number(match[1]) > 24 || (Number(match[1]) === 24 && Number(match[2]) !== 0)) throw new Error(`Bad time "${value}", expected HH:MM`);
	return Number(match[1]) * 60 + Number(match[2]);
}
export function localParts(tz: string | undefined, now: Date): { day: number; minutes: number } {
	if (!tz || tz === "local") return { day: now.getDay(), minutes: now.getHours() * 60 + now.getMinutes() };
	const offset = /^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(tz);
	if (offset) {
		if (Number(offset[2]) > 23 || Number(offset[3] ?? 0) > 59) throw new Error(`Bad timezone "${tz}"`);
		const minutes = (Number(offset[2]) * 60 + Number(offset[3] ?? 0)) * (offset[1] === "-" ? -1 : 1);
		const shifted = new Date(now.getTime() + minutes * 60_000);
		return { day: shifted.getUTCDay(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
	}
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
	const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	return { day: DAY_INDEX[get("weekday").toLowerCase()] ?? -1, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}
export function timeMatches(spec: TimeSpec, now: Date): boolean {
	const parts = localParts(spec.tz, now);
	if (spec.days && !parseDays(spec.days).has(parts.day)) return false;
	const from = spec.from ? parseHHMM(spec.from) : 0, to = spec.to ? parseHHMM(spec.to) : 24 * 60;
	return from <= to ? parts.minutes >= from && parts.minutes < to : parts.minutes >= from || parts.minutes < to;
}
function timeAllowed(names: string[] | undefined, criteria: Record<string, Criterion>, now: Date): boolean {
	return (names ?? []).every((name) => {
		const def = criteria[name];
		if (def.type !== "time") return true;
		return def.mode === "include" ? timeMatches(def.time, now) : !timeMatches(def.time, now);
	});
}

const UNITS: Record<string, number> = {
	s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
	m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
	h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
	d: 86_400_000, day: 86_400_000, days: 86_400_000,
};
export function parseReset(message: string | undefined, now = Date.now()): number | null {
	if (!message) return null;
	const stamp = message.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
	if (stamp) {
		let iso = stamp[0].replace(" ", "T");
		if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso += "Z";
		const t = Date.parse(iso);
		if (!Number.isNaN(t)) return Math.min(Math.max(t, now + 60_000), now + 7 * 86_400_000);
	}
	let delay = 0;
	for (const match of message.matchAll(/(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|s|m|h|d)\b/g)) delay += Number(match[1]) * (UNITS[match[2]] ?? 0);
	return delay > 0 ? now + Math.min(delay, 5 * 3_600_000) : null;
}
function block(usage: Usage, provider: string, message: string | undefined, now: number): void {
	usage.blocked[provider] = Math.max(usage.blocked[provider] ?? 0, parseReset(message, now) ?? now + RETRY_AFTER_UNKNOWN);
}
export function recordResponse(usage: Usage, message: Pick<AssistantMessage, "provider" | "stopReason" | "errorMessage">, now = Date.now()): void {
	if (message.stopReason === "error") block(usage, message.provider, message.errorMessage, now);
	else if (message.stopReason !== "aborted") delete usage.blocked[message.provider];
}
function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	return typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}
/** Evaluate each referenced classifier once per prompt; group and candidate gates share answers. */
function criteriaEvaluator(config: RectorConfig, request: ModelRouteRequest<RouterState>, registry: Registry, now: Date, needed: Set<string>) {
	const version = createHash("sha256").update(JSON.stringify(config.criteria)).digest("hex");
	const reuse = request.reason !== "user" && request.state?.criteriaVersion === version;
	const answers = new Map<string, boolean>(reuse ? Object.entries(request.state?.matches ?? {}).filter(([name, value]) => needed.has(name) && typeof value === "boolean") : []);
	let changed = !reuse;
	const evaluate = async (name: string): Promise<boolean> => {
		if (answers.has(name)) return answers.get(name)!;
		const def = config.criteria[name];
		if (def.type !== "classifier") throw new Error("Expected a classifier criterion");
		const batch = [...needed].filter((key) => {
			const other = config.criteria[key];
			return other.type === "classifier" && other.model === def.model && !answers.has(key);
		});
		// Default every answer to false; a missing model, refusal, or error must not open a gate.
		for (const key of batch) answers.set(key, false);
		changed = true;
		try {
			const [provider, id] = modelParts(def.model, "classifier criterion");
			const model = registry.findOfType("classifier", provider, id);
			if (!model) return false;
			const result = await registry.classify(model, {
				state: { prompt: lastUserText(request.messages).slice(0, 16_000) },
				questions: Object.fromEntries(batch.map((key, index) => {
					const criterion = config.criteria[key] as Extract<Criterion, { type: "classifier" }>;
					return [`q${index}`, { type: "bool" as const, instructions: criterion.instructions, criteria: { true: "The condition is satisfied.", false: "The condition is not satisfied." } }];
				})),
			}, { signal: request.signal });
			request.signal?.throwIfAborted();
			if (result.stopReason === "aborted") throw new DOMException("Rector classification aborted", "AbortError");
			if (result.stopReason === "stop") batch.forEach((key, index) => {
				const answer = result.answers[`q${index}`];
				answers.set(key, answer?.type === "bool" && Number.isFinite(answer.probability) && answer.probability >= 0.5 && answer.probability <= 1);
			});
		} catch (error) {
			request.signal?.throwIfAborted();
			if (error instanceof Error && error.name === "AbortError") throw error;
			// shortcut: classifier errors close their gates; use an unconditional last group for fallback.
		}
		return answers.get(name)!;
	};
	return {
		version,
		get changed() { return changed; },
		results: () => Object.fromEntries(answers),
		async allows(names: string[] | undefined, skipClassifiers = false): Promise<boolean> {
			if (!timeAllowed(names, config.criteria, now)) return false;
			for (const name of names ?? []) {
				if (!skipClassifiers && config.criteria[name].type === "classifier" && !(await evaluate(name))) return false;
			}
			return true;
		},
	};
}

/** Resolve two levels only: ordered groups, then physical candidates. */
export async function routeRequest(config: RectorConfig, groupId: string | undefined, request: ModelRouteRequest<RouterState>, registry: Registry, usage: Usage, now = new Date()): Promise<ModelRoute<RouterState>> {
	request.signal?.throwIfAborted();
	if (request.reason === "retry" && request.failed) block(usage, request.failed.model.provider, request.failed.message.errorMessage, now.getTime());
	const locked = groupId ?? (request.reason !== "user" && request.reason !== "direct" ? request.state?.group : undefined);
	const groups = locked === undefined ? Object.keys(config.models) : [locked];
	const needed = new Set<string>();
	for (const group of groups) {
		if (!Object.hasOwn(config.models, group)) throw new Error(`Rector: unknown model group "${group}"; reload Pi after changing configuration`);
		const spec = config.models[group];
		for (const name of spec.criteria ?? []) if (groupId === undefined || config.criteria[name].type !== "classifier") needed.add(name);
		for (const entry of spec.candidates) if (typeof entry !== "string") for (const name of entry.criteria ?? []) needed.add(name);
	}
	const evaluator = criteriaEvaluator(config, request, registry, now, needed);
	const skipped: string[] = [];
	for (const group of groups) {
		const spec = config.models[group];
		if (!timeAllowed(spec.criteria, config.criteria, now)) {
			skipped.push(`rector/${group}: excluded by group time criteria`);
			continue;
		}
		const candidates = spec.candidates.map((entry) => typeof entry === "string" ? { model: entry } : entry);
		const physical = candidates.map((entry) => {
			const [provider, id] = modelParts(entry.model, "candidate");
			const model = registry.find(provider, id);
			let reason: string | undefined;
			if (!model) reason = "not in catalog";
			else if (model.api === "pi-virtual") reason = "not a physical model";
			else if (!registry.hasConfiguredAuth(model)) reason = "no credentials";
			else if ((usage.blocked[provider] ?? 0) > now.getTime()) reason = `blocked until ${new Date(usage.blocked[provider]).toISOString()}`;
			else if (!timeAllowed(entry.criteria, config.criteria, now)) reason = "candidate time criteria";
			if (reason) { skipped.push(`rector/${group} ${entry.model}: ${reason}`); return undefined; }
			return model;
		});
		if (!physical.some(Boolean)) continue;
		if (!(await evaluator.allows(spec.criteria, groupId !== undefined))) {
			skipped.push(`rector/${group}: group criteria [${(spec.criteria ?? []).join(", ")}] not satisfied`);
			continue;
		}
		const usable = async (index: number): Promise<Model<Api> | undefined> => {
			const model = physical[index];
			if (!model) return undefined;
			if (await evaluator.allows(candidates[index].criteria)) return model;
			skipped.push(`rector/${group} ${candidates[index].model}: candidate criteria not satisfied`);
			return undefined;
		};
		const dispatch = (index: number, model: Model<Api>, sticky = false): ModelRoute<RouterState> => {
			const entry = candidates[index];
			const state: RouterState = { group, openaiProvider: request.state?.openaiProvider, matches: evaluator.results(), criteriaVersion: evaluator.version };
			if ((OPENAI as readonly string[]).includes(model.provider)) {
				state.openaiProvider = model.provider;
				if (!sticky) usage.counts[model.provider] = (usage.counts[model.provider] ?? 0) + 1;
			}
			return {
				model,
				thinkingLevel: entry.level ?? (sticky ? request.previous?.thinkingLevel ?? request.thinkingLevel : request.thinkingLevel),
				state: sticky && !evaluator.changed ? request.state : state,
			};
		};
		if (request.reason === "continuation" && request.previous && request.state?.group === group) {
			for (let i = 0; i < candidates.length; i++) {
				if (candidates[i].model !== `${request.previous.model.provider}/${request.previous.model.id}`) continue;
				const model = await usable(i);
				if (model) return dispatch(i, model, true);
			}
		}
		for (let i = 0; i < candidates.length; i++) {
			const entry = candidates[i], next = candidates[i + 1];
			const [provider, id] = modelParts(entry.model, "candidate");
			const nextParts = next ? modelParts(next.model, "candidate") : undefined;
			if ((OPENAI as readonly string[]).includes(provider) && nextParts && (OPENAI as readonly string[]).includes(nextParts[0]) && nextParts[0] !== provider && nextParts[1] === id) {
				const pool: { index: number; model: Model<Api> }[] = [];
				for (const index of [i, i + 1]) { const model = await usable(index); if (model) pool.push({ index, model }); }
				i++;
				if (!pool.length) continue;
				const chosen = pool.find(({ model }) => model.provider === request.state?.openaiProvider) ?? pool.reduce((best, item) => (usage.counts[item.model.provider] ?? 0) < (usage.counts[best.model.provider] ?? 0) ? item : best);
				return dispatch(chosen.index, chosen.model);
			}
			const model = await usable(i);
			if (model) return dispatch(i, model);
		}
	}
	const label = locked === undefined ? "Rector: no eligible model group with an available candidate" : `rector/${locked}: no candidate available`;
	throw new Error(`${label} (${skipped.join("; ")})`);
}

export default function (pi: ExtensionAPI) {
	const user = readSettings(join(getAgentDir(), "settings.json"));
	const project = readSettings(join(process.cwd(), ".pi", "settings.json"));
	const { config, legacy } = resolveConfig(user, project);
	const usesProject = project.rector !== undefined || (user.rector === undefined && project.autoRouter !== undefined);
	if (legacy) pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify("Legacy Rector settings detected. Migrate to typed rector.criteria and ordered rector.models. Classifier choices are converted to boolean gates; Auto now uses the first usable matching group. No files were rewritten.", "warning");
	});
	for (const [id, name] of [["auto", "Rector"], ...Object.entries(config.models).map(([id, spec]) => [id, spec.name ?? id])]) {
		pi.registerVirtualModel<RouterState>({
			provider: "rector", id, name, thinkingLevels: LEVELS,
			async route(request, ctx) {
				if (usesProject && !ctx.isProjectTrusted()) throw new Error("Rector project configuration requires project trust. Trust the project and reload Pi, or remove its Rector settings.");
				const usage = readUsage();
				try { return await routeRequest(config, id === "auto" ? undefined : id, request, ctx.modelRegistry, usage); }
				finally { writeUsage(usage); }
			},
		});
	}
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (ctx.model?.provider !== "rector" || message.role !== "assistant" || message.provider === "rector") return;
		const usage = readUsage();
		recordResponse(usage, message);
		writeUsage(usage);
	});
}
