/**
 * Auto router family - virtual models that spend the cheap plans first.
 *
 * Registers under the `auto` provider:
 *
 * - auto/smart: high effort -> the complex workload; low -> trivial; medium ->
 *   the free Jev classifier (opencode/jev-1.13-free) rates each user message.
 * - auto/zai: Z.ai candidates only.
 * - auto/openai: OpenAI candidates only, tier by effort/classifier.
 * - auto/openai-sol-6.1 / openai-terra-6.1 / openai-luna-6: one workload tier
 *   each, defined in settings like every other auto/<id> pool model.
 *
 * Workloads are configured in settings.json and walked in order; a candidate is
 * skipped when its provider is out of quota or its criteria say so. Named
 * criteria combine a mode (include/exclude) with a time window, so e.g. Z.ai
 * models stay out of the peak window when their points cost double. Two
 * consecutive entries with the same model on openai and openai-codex are a
 * balanced pair: the session sticks to one account (prompt cache) and accounts
 * are chosen by least dispatched turns overall. A failed request blocks its
 * provider until its quota returns - from the error message when it says so,
 * else probed after 30 minutes - and retries on the other account. A
 * successful response lifts the block.
 *
 * Settings (all optional; per-tier arrays replace the default, criteria merge).
 * An entry may set `level` to fix the thinking level that model is dispatched
 * at, regardless of the selected level:
 *
 *   "autoRouter": {
 *     "workloads": { "complex": [{ "model": "openai/gpt-6.1-sol", "level": "medium" }, "openai-codex/gpt-6.1-sol"] },
 *     "models": {
 *       "openai-sol-6.1":   { "name": "Auto (Sol 6.1)", "workload": "complex", "providers": ["openai", "openai-codex"] },
 *       "openai-terra-6.1": { "workload": "standard", "providers": ["openai", "openai-codex"] },
 *       "openai-luna-6":    { "workload": "trivial" },
 *       "night-glm":        { "workload": "standard", "providers": ["zai"], "criteria": ["nightOnly"] }
 *     },
 *     "criteria": {
 *       "zaiPeak": { "mode": "exclude", "time": { "days": ["mon-fri"], "from": "14:00", "to": "18:00", "tz": "UTC+8" } }
 *     },
 *     "workloads": {
 *       "complex":  ["openai/gpt-6.1-sol", "openai-codex/gpt-6.1-sol"],
 *       "standard": [{ "model": "zai/glm-5.3", "criteria": ["zaiPeak"] }, "openai/gpt-6-luna", "openai-codex/gpt-6-luna"],
 *       "trivial":  [{ "model": "zai/glm-5.3-flash", "criteria": ["zaiPeak"] }, "openai/gpt-6-luna", "openai-codex/gpt-6-luna"]
 *     }
 *   }
 *
 * Usage: pi --model auto/smart
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

const USAGE_FILE = join(fileURLToPath(new URL(".", import.meta.url)), "router-usage.json");
const OPENAI_PROVIDERS = ["openai", "openai-codex"] as const;
type OpenAIProvider = (typeof OPENAI_PROVIDERS)[number];
const OTHER: Record<OpenAIProvider, OpenAIProvider> = { openai: "openai-codex", "openai-codex": "openai" };
/** Fallback probe when the error does not say when quota returns. */
const RETRY_AFTER_UNKNOWN = 30 * 60_000;
const LEVELS = ["low", "medium", "high", "xhigh"] as const satisfies readonly ModelThinkingLevel[];

interface RouterState {
	/** Plus account this session uses for OpenAI models. */
	openaiProvider?: OpenAIProvider;
}

interface Usage {
	counts: Record<OpenAIProvider, number>;
	/** Provider -> epoch ms until which it is assumed out of quota. */
	blocked: Record<string, number>;
}

export interface TimeSpec {
	/** Days like "mon", ranges like "mon-fri"; default: every day. */
	days?: string[];
	/** "HH:MM"; the window wraps over midnight when from > to. */
	from?: string;
	to?: string;
	/** "local" (default), fixed "UTC+8", or IANA like "Europe/Rome". */
	tz?: string;
}

interface Criterion {
	mode: "include" | "exclude";
	time: TimeSpec;
}

type WorkloadEntry = string | { model: string; criteria?: string[]; level?: string };

/** A config-defined pool model, registered as auto/<key>. */
interface ModelSpec {
	/** Display name in /model; default "Auto (<key>)". */
	name?: string;
	/** Workload whose candidates this model dispatches. */
	workload: string;
	/** Restrict candidates to these providers; default: every provider. */
	providers?: string[];
	/** Criteria gating the whole model, on top of per-candidate criteria. */
	criteria?: string[];
}

interface AutoRouterSettings {
	criteria?: Record<string, Criterion>;
	workloads?: Record<string, WorkloadEntry[]>;
	/** Pool models registered as auto/<key>; null removes a default. */
	models?: Record<string, ModelSpec | null>;
}

const DEFAULTS: Required<Omit<AutoRouterSettings, "models">> & { models: Record<string, ModelSpec> } = {
	criteria: {
		zaiPeak: { mode: "exclude", time: { days: ["mon-fri"], from: "14:00", to: "18:00", tz: "UTC+8" } },
	},
	workloads: {
		complex: ["openai/gpt-6.1-sol", "openai-codex/gpt-6.1-sol"],
		standard: [{ model: "zai/glm-5.3", criteria: ["zaiPeak"] }, "openai/gpt-6.1-terra", "openai-codex/gpt-6.1-terra"],
		trivial: [{ model: "zai/glm-5.3-flash", criteria: ["zaiPeak"] }, "openai/gpt-6-luna", "openai-codex/gpt-6-luna"],
	},
	models: {
		"openai-sol-6.1": { name: "Auto (Sol 6.1)", workload: "complex", providers: ["openai", "openai-codex"] },
		"openai-terra-6.1": { name: "Auto (Terra 6.1)", workload: "standard", providers: ["openai", "openai-codex"] },
		"openai-luna-6": { name: "Auto (Luna 6)", workload: "trivial", providers: ["openai", "openai-codex"] },
	},
};

let settingsOf: () => Record<string, unknown> = () => ({});

function readJson(path: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(path, "utf8")) ?? {};
	} catch {
		return {};
	}
}

/** Pool models at registration time. pi.getSettings() is an action method and cannot run during
 * extension loading, so the settings files are read directly, user first then project override. */
function configModelsAtLoad(): Record<string, ModelSpec> {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(fileURLToPath(new URL("..", import.meta.url)));
	const user = readJson(join(agentDir, "settings.json"));
	const project = readJson(join(process.cwd(), ".pi", "settings.json"));
	const custom = { ...(user.autoRouter as AutoRouterSettings | undefined)?.models, ...(project.autoRouter as AutoRouterSettings | undefined)?.models };
	return Object.fromEntries(Object.entries({ ...DEFAULTS.models, ...custom }).filter(([, v]) => v != null) as [string, ModelSpec][]);
}

function routerConfig(): { criteria: Record<string, Criterion>; workloads: Record<string, WorkloadEntry[]>; models: Record<string, ModelSpec> } {
	const custom = (settingsOf() as unknown as { autoRouter?: AutoRouterSettings }).autoRouter;
	return {
		criteria: { ...DEFAULTS.criteria, ...custom?.criteria },
		workloads: { ...DEFAULTS.workloads, ...custom?.workloads },
		models: Object.fromEntries(Object.entries({ ...DEFAULTS.models, ...custom?.models }).filter(([, v]) => v != null) as [string, ModelSpec][]),
	};
}

function readUsage(): Usage {
	try {
		const raw = JSON.parse(readFileSync(USAGE_FILE, "utf8")) ?? {};
		const counts = raw.counts ?? raw; // v1 wrote flat counts
		const blocked = Object.fromEntries(Object.entries(raw.blocked ?? {}).filter(([, v]) => typeof v === "number") as [string, number][]);
		return {
			counts: { openai: Number(counts.openai) || 0, "openai-codex": Number(counts["openai-codex"]) || 0 },
			blocked,
		};
	} catch {
		// First run or unreadable file: start from zero.
		return { counts: { openai: 0, "openai-codex": 0 }, blocked: {} };
	}
}

function writeUsage(usage: Usage): void {
	try {
		writeFileSync(USAGE_FILE, JSON.stringify(usage));
	} catch {
		// shortcut: if the usage file is unwritable, balancing degrades to tie-breaking and resets on restart
	}
}

function blockedUntil(provider: string, usage = readUsage()): number {
	return usage.blocked[provider] ?? 0;
}

function block(provider: string, untilMs: number): void {
	const usage = readUsage();
	usage.blocked[provider] = Math.max(untilMs, usage.blocked[provider] ?? 0);
	writeUsage(usage);
}

function unblock(provider: string): void {
	const usage = readUsage();
	if (usage.blocked[provider] === undefined) return;
	delete usage.blocked[provider];
	writeUsage(usage);
}

const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function parseDays(days: readonly string[]): Set<number> {
	const out = new Set<number>();
	for (const day of days) {
		const range = /^([a-z]{3})-([a-z]{3})$/.exec(day);
		if (range) {
			const from = DAY_INDEX[range[1]];
			const to = DAY_INDEX[range[2]];
			if (from === undefined || to === undefined) throw new Error(`Unknown day range "${day}"`);
			for (let i = from; ; i = (i + 1) % 7) {
				out.add(i);
				if (i === to) break;
			}
		} else {
			const index = DAY_INDEX[day];
			if (index === undefined) throw new Error(`Unknown day "${day}"`);
			out.add(index);
		}
	}
	return out;
}

function parseHHMM(value: string): number {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value);
	if (!match) throw new Error(`Bad time "${value}", expected HH:MM`);
	const minutes = Number(match[1]) * 60 + Number(match[2]);
	if (minutes > 24 * 60) throw new Error(`Bad time "${value}"`);
	return minutes;
}

/** Weekday (0 = Sunday) and minute of day at `tz`: "local", a fixed "UTC+8", or an IANA zone. */
export function localParts(tz: string | undefined, now: Date): { day: number; minutes: number } {
	if (!tz || tz === "local") return { day: now.getDay(), minutes: now.getHours() * 60 + now.getMinutes() };
	const offset = /^(?:UTC|GMT)([+-]\d{1,2})(?::?(\d{2}))?$/.exec(tz);
	if (offset) {
		const shifted = new Date(now.getTime() + (Number(offset[1]) * 60 + Number(offset[2] ?? 0)) * 60_000);
		return { day: shifted.getUTCDay(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
	}
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
	const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	return { day: DAY_INDEX[get("weekday").toLowerCase()] ?? -1, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function timeMatches(spec: TimeSpec, now: Date): boolean {
	const parts = localParts(spec.tz, now);
	if (spec.days && !parseDays(spec.days).has(parts.day)) return false;
	if (spec.from || spec.to) {
		const from = spec.from ? parseHHMM(spec.from) : 0;
		const to = spec.to ? parseHHMM(spec.to) : 24 * 60;
		const inWindow = from <= to ? parts.minutes >= from && parts.minutes < to : parts.minutes >= from || parts.minutes < to;
		if (!inWindow) return false;
	}
	return true;
}

/** An entry passes when every include criterion matches and no exclude criterion does. */
function entryAllowed(entry: { model: string; criteria?: string[] }, criteria: Record<string, Criterion>, now: Date): boolean {
	for (const name of entry.criteria ?? []) {
		const def = criteria[name];
		if (!def?.time) throw new Error(`Unknown or incomplete criterion "${name}" in autoRouter settings`);
		const hit = timeMatches(def.time, now);
		if (def.mode === "exclude" ? hit : !hit) return false;
	}
	return true;
}

const UNITS: Record<string, number> = {
	s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
	m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
	h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
	d: 86_400_000, day: 86_400_000, days: 86_400_000,
};

/**
 * When the provider says when quota returns, believe it: an explicit timestamp wins (clamped to
 * [now+1min, now+7d]), else the sum of durations like "2 hours and 30 minutes" (capped at 5h).
 * Hyphenated forms ("5-hour limit") are deliberately ignored. Null when the message says nothing.
 */
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
	for (const match of message.matchAll(/(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|s|m|h|d)\b/g)) {
		delay += Number(match[1]) * (UNITS[match[2]] ?? 0);
	}
	return delay > 0 ? now + Math.min(delay, 5 * 3_600_000) : null;
}

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

type Difficulty = "trivial" | "standard" | "complex";

/** Jev rates the last user message; a missing or failed rating counts as standard. */
async function rateDifficulty(request: ModelRouteRequest<RouterState>, ctx: ExtensionContext): Promise<Difficulty> {
	const jev = ctx.modelRegistry.findOfType("classifier", "opencode", "jev-1.13-free");
	if (!jev) return "standard";
	try {
		const result = await ctx.modelRegistry.classify(
			jev,
			{
				state: { prompt: lastUserText(request.messages).slice(0, 16_000) },
				questions: {
					difficulty: {
						type: "choice",
						instructions: "How demanding is the work requested in `prompt`?",
						criteria: {
							trivial: "One-liner replies, quick questions, small lookups - no real engineering",
							standard: "Ordinary features, fixes, reviews, or explanations",
							complex: "Subtle design, cross-cutting changes, or hard debugging",
						},
					},
				},
			},
			{ signal: request.signal },
		);
		const answer = result.stopReason === "stop" ? result.answers.difficulty : undefined;
		return answer?.type === "choice" && answer.choice !== undefined ? (answer.choice as Difficulty) : "standard";
	} catch {
		// shortcut: a broken or expired classifier routes as standard instead of failing the turn
		return "standard";
	}
}

/** Tool follow-ups stay on the model that handled the turn. */
function stickyRoute(request: ModelRouteRequest<RouterState>): ModelRoute<RouterState> | undefined {
	if (request.reason === "user" || !request.previous) return undefined;
	return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? "medium", state: request.state };
}

/**
 * Walk a workload in order and return a model whose provider has quota and whose criteria pass.
 * A consecutive same-model pair on openai/openai-codex is balanced by least dispatched turns,
 * sticky to the account the session already uses. `filter` scopes candidates to a provider set.
 */
function pickFromWorkload(
	ctx: ExtensionContext,
	state: RouterState | undefined,
	tier: string,
	filter: (provider: string) => boolean,
): { model: Model<Api>; level?: string } {
	const { criteria, workloads } = routerConfig();
	const entries = (workloads[tier] ?? []).map((entry) => {
		const model = typeof entry === "string" ? entry : entry.model;
		const [provider, id] = model.split("/");
		if (!provider || !id) throw new Error(`Bad model "${model}" in autoRouter workload "${tier}", expected "provider/id"`);
		return { provider, id, criteria: typeof entry === "string" ? undefined : entry.criteria, level: typeof entry === "string" ? undefined : entry.level };
	});
	const usage = readUsage();
	const now = new Date();
	const skip: string[] = [];

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!filter(entry.provider)) continue;
		const model = ctx.modelRegistry.find(entry.provider, entry.id);
		const usable = (provider: string, id: string, entryCriteria?: string[]) =>
			ctx.modelRegistry.find(provider, id) && blockedUntil(provider, usage) <= now.getTime() && entryAllowed({ model: id, criteria: entryCriteria }, criteria, now);
		const isPlus = entry.provider === "openai" || entry.provider === "openai-codex";
		const next = entries[i + 1];

		// A balanced pair across the two Plus accounts resolves in one step.
		if (isPlus && next && (next.provider === "openai" || next.provider === "openai-codex") && next.provider !== entry.provider && next.id === entry.id) {
			i++;
			const pool: OpenAIProvider[] = [];
			if (usable(entry.provider, entry.id, entry.criteria) && model) pool.push(entry.provider as OpenAIProvider);
			if (usable(next.provider, next.id, next.criteria)) pool.push(next.provider as OpenAIProvider);
			if (!pool.length) {
				skip.push(`${entry.id}: both Plus accounts unavailable`);
				continue;
			}
			const chosen = state?.openaiProvider && pool.includes(state.openaiProvider)
				? state.openaiProvider
				: pool.reduce((best, p) => (usage.counts[p] < usage.counts[best] ? p : best));
			return { model: ctx.modelRegistry.find(chosen, entry.id)!, level: chosen === entry.provider ? entry.level : next.level };
		}

		if (model && usable(entry.provider, entry.id, entry.criteria)) return { model, level: entry.level };
		skip.push(`${entry.provider}/${entry.id}: ${!model ? "not in catalog" : blockedUntil(entry.provider, usage) > now.getTime() ? "quota blocked" : "criteria"}`);
	}
	throw new Error(`autoRouter workload "${tier}": no candidate available${skip.length ? ` (${skip.join("; ")})` : ""}`);
}

/** Record the dispatch (counts, block lift) and keep the Plus account in router state. */
function dispatch(ctx: ExtensionContext, state: RouterState | undefined, model: Model<Api>, level: string): ModelRoute<RouterState> {
	const dispatchLevel = level as ModelThinkingLevel;
	if (isPlus(model.provider)) {
		const usage = readUsage();
		usage.counts[model.provider]++; // per dispatched turn, so heavy sessions weigh more than quick ones
		delete usage.blocked[model.provider]; // trying an account again clears its block
		writeUsage(usage);
		return { model, thinkingLevel: dispatchLevel, state: { openaiProvider: model.provider } };
	}
	return { model, thinkingLevel: dispatchLevel, state: state };
}

function isPlus(provider: string): provider is OpenAIProvider {
	return provider === "openai" || provider === "openai-codex";
}

/** Tier for this request: manual levels win, medium asks the classifier. */
async function tierFor(request: ModelRouteRequest<RouterState>, ctx: ExtensionContext): Promise<string> {
	if (request.thinkingLevel === "high" || request.thinkingLevel === "xhigh") return "complex";
	if (request.thinkingLevel === "low") return "trivial";
	if (request.reason === "user") return await rateDifficulty(request, ctx);
	return "standard";
}

export default function (pi: ExtensionAPI) {
	settingsOf = () => pi.getSettings() as unknown as Record<string, unknown>;

	// Observe every failed response: a quota error that Pi does not retry would otherwise never
	// block the provider, and the next turn would hit the dead account again. Only physical
	// providers are blocked - a failing route() reports the virtual "auto" provider, which is us.
	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; provider?: string; stopReason?: string; errorMessage?: string };
		if (message.role === "assistant" && message.stopReason === "error" && (message.provider === "openai" || message.provider === "openai-codex" || message.provider === "zai")) {
			block(message.provider, parseReset(message.errorMessage) ?? Date.now() + RETRY_AFTER_UNKNOWN);
		}
	});

	pi.registerVirtualModel<RouterState>({
		provider: "auto",
		id: "smart",
		name: "Auto",
		thinkingLevels: LEVELS,
		async route(request, ctx) {
			// A response that got through proves the quota is back.
			if (request.previous) unblock(request.previous.model.provider);

			// A failed request blocks its provider until its quota returns and retries elsewhere.
			if (request.reason === "retry" && request.failed) {
				const failed = request.failed.model;
				if (failed.provider === "zai") {
					block("zai", parseReset(request.failed.message.errorMessage) ?? Date.now() + RETRY_AFTER_UNKNOWN);
					const pick = pickFromWorkload(ctx, request.state, await tierFor(request, ctx), (p) => p !== "zai");
					return dispatch(ctx, request.state, pick.model, pick.level ?? request.thinkingLevel);
				}
				if (isPlus(failed.provider)) {
					block(failed.provider, parseReset(request.failed.message.errorMessage) ?? Date.now() + RETRY_AFTER_UNKNOWN);
					const other = OTHER[failed.provider];
					if (blockedUntil(other) <= Date.now()) {
						const model = ctx.modelRegistry.find(other, failed.id);
						if (model) return dispatch(ctx, request.state, model, request.thinkingLevel);
					}
					// Both Plus accounts out: any remaining candidate (criteria still apply) buys the turn.
					const pick = pickFromWorkload(ctx, request.state, await tierFor(request, ctx), (p) => !isPlus(p));
					return dispatch(ctx, request.state, pick.model, pick.level ?? request.thinkingLevel);
				}
			}

			const sticky = stickyRoute(request);
			if (sticky) return sticky;

			const tier = await tierFor(request, ctx);
			const pick = pickFromWorkload(ctx, request.state, tier, () => true);
			return dispatch(ctx, request.state, pick.model, pick.level ?? (tier === "trivial" ? "low" : request.thinkingLevel));
		},
	});

	pi.registerVirtualModel<RouterState>({
		provider: "auto",
		id: "zai",
		name: "Auto (Z.ai)",
		thinkingLevels: LEVELS,
		async route(request, ctx) {
			// A response that got through proves the quota is back.
			if (request.previous?.model.provider === "zai") unblock("zai");

			if (request.reason === "retry" && request.failed?.model.provider === "zai") {
				block("zai", parseReset(request.failed.message.errorMessage) ?? Date.now() + RETRY_AFTER_UNKNOWN);
				throw new Error(`Z.ai is out of quota; it returns at ${new Date(blockedUntil("zai")).toLocaleTimeString()}. Select an OpenAI model instead.`);
			}
			if (blockedUntil("zai") > Date.now()) {
				throw new Error(`Z.ai is out of quota; it returns at ${new Date(blockedUntil("zai")).toLocaleTimeString()}. Select an OpenAI model instead.`);
			}

			const sticky = stickyRoute(request);
			if (sticky) return sticky;

			// Every workload may carry Z.ai candidates; the richer tier wins.
			const tier = await tierFor(request, ctx);
			const order = [tier, "standard", "trivial", "complex"].filter((t, i, a) => a.indexOf(t) === i);
			for (const candidate of order) {
				try {
					const pick = pickFromWorkload(ctx, request.state, candidate, (p) => p === "zai");
					return dispatch(ctx, request.state, pick.model, pick.level ?? (tier === "trivial" ? "low" : request.thinkingLevel));
				} catch {
					// This workload has no usable Z.ai candidate; try the next.
				}
			}
			throw new Error("No Z.ai candidate is available under the autoRouter criteria; use auto/smart or an OpenAI model.");
		},
	});

	pi.registerVirtualModel<RouterState>({
		provider: "auto",
		id: "openai",
		name: "Auto (OpenAI)",
		thinkingLevels: LEVELS,
		async route(request, ctx) {
			// A response that got through proves the quota is back.
			if (request.previous) unblock(request.previous.model.provider);

			if (request.reason === "retry" && request.failed && isPlus(request.failed.model.provider)) {
				const failed = request.failed.model;
				block(failed.provider, parseReset(request.failed.message.errorMessage) ?? Date.now() + RETRY_AFTER_UNKNOWN);
				const other = OTHER[failed.provider as OpenAIProvider];
				if (blockedUntil(other) <= Date.now()) {
					const model = ctx.modelRegistry.find(other, failed.id);
					if (model) return dispatch(ctx, request.state, model, request.thinkingLevel);
				}
				const back = new Date(Math.min(blockedUntil("openai"), blockedUntil("openai-codex"))).toLocaleTimeString();
				throw new Error(`Both OpenAI accounts are out of quota; the earlier one returns at ${back}.`);
			}

			const sticky = stickyRoute(request);
			if (sticky) return sticky;

			const tier = await tierFor(request, ctx);
			const pick = pickFromWorkload(ctx, request.state, tier, isPlus);
			return dispatch(ctx, request.state, pick.model, pick.level ?? request.thinkingLevel);
		},
	});

	// Pool models from configuration: auto/<key> for each entry. Reserved ids keep
	// the smart routers registered above; a null entry removes a default pool.
	const reserved = new Set(["smart", "zai", "openai"]);
	for (const [id, spec] of Object.entries(configModelsAtLoad())) {
		if (reserved.has(id)) continue;
		pi.registerVirtualModel<RouterState>({
			provider: "auto",
			id,
			name: spec.name ?? `Auto (${id})`,
			thinkingLevels: LEVELS,
			route(request, ctx) {
				if (request.previous) unblock(request.previous.model.provider);
				if (spec.criteria?.length && !entryAllowed({ model: id, criteria: spec.criteria }, routerConfig().criteria, new Date())) {
					throw new Error(`auto/${id} is not available under its criteria; select another model.`);
				}
				const sticky = stickyRoute(request);
				if (sticky) return sticky;
				const providers = spec.providers;
				const filter = providers ? (p: string) => providers.includes(p) : () => true;
				const pick = pickFromWorkload(ctx, request.state, spec.workload, filter);
				return dispatch(ctx, request.state, pick.model, pick.level ?? request.thinkingLevel);
			},
		});
	}
}
