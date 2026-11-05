/**
 * Self-checks for the pure routing logic. Run with `npm test` (Node >= 22.18
 * strips types natively). No network, no credentials, no filesystem writes.
 */

import assert from "node:assert/strict";
import { type TimeSpec, localParts, parseDays, parseReset, timeMatches } from "./auto-router.ts";

let passed = 0;
function check(label: string, got: unknown, want: unknown): void {
	assert.deepStrictEqual(got, want, label);
	passed++;
}

// parseDays: single days, ranges, wrap-around ranges, bad input
check("mon-fri", [...parseDays(["mon-fri"])].sort(), [1, 2, 3, 4, 5]);
check("sat-sun wraps", [...parseDays(["sat-sun"])].sort(), [0, 6]);
check("single day", [...parseDays(["wed"])], [3]);
assert.throws(() => parseDays(["monday"]), /Unknown day/);
passed++;

// localParts: local, fixed offset (UTC+8), midnight wrap
check("local", localParts(undefined, new Date("2026-10-21T10:30:00Z")) instanceof Object, true);
const shifted = localParts("UTC+8", new Date("2026-10-19T23:30:00Z"));
check("UTC+8 midnight wrap", [shifted.day, shifted.minutes], [2, 450]); // Mon 23:30Z = Tue 07:30 +8
const rome = localParts("Europe/Rome", new Date("2026-10-21T22:30:00Z"));
check("Europe/Rome DST (+2, crosses midnight)", [rome.day, rome.minutes], [4, 30]); // Thu 00:30

// timeMatches: the Z.ai peak window (exclude Mon-Fri 14:00-18:00 UTC+8)
const zaiPeak: TimeSpec = { days: ["mon-fri"], from: "14:00", to: "18:00", tz: "UTC+8" };
check("peak start inclusive", timeMatches(zaiPeak, new Date("2026-10-19T06:00:00Z")), true);
check("peak last minute", timeMatches(zaiPeak, new Date("2026-10-19T09:59:00Z")), true);
check("peak end exclusive", timeMatches(zaiPeak, new Date("2026-10-19T10:00:00Z")), false);
check("before peak", timeMatches(zaiPeak, new Date("2026-10-19T05:59:00Z")), false);
check("saturday always off-peak", timeMatches(zaiPeak, new Date("2026-10-17T06:00:00Z")), false);
check("sunday always off-peak", timeMatches(zaiPeak, new Date("2026-10-18T06:00:00Z")), false);

// timeMatches: overnight window with wrap-around in an IANA zone
const night: TimeSpec = { from: "23:00", to: "08:00", tz: "Europe/Rome" };
check("00:30 inside night", timeMatches(night, new Date("2026-10-21T22:30:00Z")), true);
check("22:30 outside night", timeMatches(night, new Date("2026-10-21T20:30:00Z")), false);
check("08:00 outside night (exclusive end)", timeMatches(night, new Date("2026-10-21T06:00:00Z")), false);

// parseReset: timestamps win, durations sum, hyphenated forms ignored
const NOW = Date.parse("2026-10-20T10:00:00Z");
check("explicit timestamp", parseReset("Resets at 2026-10-24T09:00:00Z", NOW), NOW + (4 * 24 - 1) * 3_600_000);
check("past timestamp clamped", parseReset("resets at 2020-01-01T00:00:00Z", NOW), NOW + 60_000);
check("seconds", parseReset("retry after 90 seconds", NOW), NOW + 90_000);
check("compound duration", parseReset("resets in 2 hours and 30 minutes", NOW), NOW + 2.5 * 3_600_000);
check("hyphenated 5-hour ignored", parseReset("You have hit your 5-hour usage limit", NOW), null);
check("no message", parseReset(undefined, NOW), null);
check("empty message", parseReset("", NOW), null);

console.log(`ok - ${passed} checks passed`);
