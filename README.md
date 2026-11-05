# pi-rector

A [Pi](https://pi.dev) extension that registers a family of **subscription-aware
virtual models**: every request is routed to the cheapest model your plans can
serve, in the moment you ask.

> Latin *rector* — the helmsman, the one who holds the direction (from *regere*,
> to steer). The Latin translation of *router*.

Keywords: pi extension, virtual model router, subscription quota, off-peak
routing, model failover, OpenAI Plus balancing, GLM coding plan.

## The problem

Most model routers optimize for quality or API dollars. But coding-agent
subscriptions have their own economy:

- **GLM Coding Plan** costs half the points outside peak hours (Mon-Fri
  14:00-18:00 UTC+8) and on weekends — a window in the *plan's* timezone,
  not yours.
- **Two OpenAI Plus accounts** on the same models drain unevenly: without
  balancing, one dies at noon while the other sits untouched.
- **Quota errors** say when they reset ("resets at 15:30"), yet routers either
  retry blindly or back off on fixed schedules.

No existing Pi router routes on any of this. pi-rector routes on all of it.

## What it registers

| Virtual model | Behavior |
|---|---|
| `auto/smart` | Full router: effort level or a free classifier picks the tier; time criteria, balancing and failover apply |
| `auto/zai` | Z.ai candidates only, with fallback between tiers |
| `auto/openai` | OpenAI candidates only, tier by effort/classifier |
| `auto/<key>` | **Config-defined pools** — any entry in `autoRouter.models` becomes a selectable model |

The built-in pools `auto/openai-sol-6.1`, `auto/openai-terra-6.1` and
`auto/openai-luna-6` walk the `complex` / `standard` / `trivial` workloads on
whichever Plus account has quota. All of them — including your own — can be
removed or replaced from settings.

## How a request is routed

1. **Sticky** — tool follow-ups and retries stay on the model of the turn, so
   the prompt cache is never paid twice.
2. **Quota blocks** — a failed response blocks its provider until the reset
   found in the error message (a 30-minute probe when it says nothing); blocks
   are persisted across restarts and lifted by the first success.
3. **Tier** — level `high`/`xhigh` → complex, `low` → trivial, `medium` → the
   free Jev classifier (`opencode/jev-1.13-free`) rates the message as
   trivial / standard / complex.
4. **Workload walk** — candidates are tried in order; entries are skipped when
   their provider is blocked or their time criteria exclude them. Two
   consecutive entries with the same model on `openai` and `openai-codex` form
   a **balanced pair**: least dispatched turns wins, the session stays sticky
   on one account.
5. **Dispatch** — an entry may pin the thinking `level` the model runs at,
   regardless of the selected one.

## Install

Copy `auto-router.ts` into `~/.pi/agent/extensions/`, or point the `extensions`
setting at this repository. Then select `auto/smart` in `/model` and set the
thinking level to `medium`.

## Configuration

Everything lives under `"autoRouter"` in `settings.json` (user or project —
project overrides user). All sections are optional.

```jsonc
{
  "autoRouter": {
    // Named, reusable predicates. mode: include = usable only when matching,
    // exclude = unusable while matching. Multiple criteria on an entry are ANDed.
    "criteria": {
      "zaiPeak":     { "mode": "exclude", "time": { "days": ["mon-fri"], "from": "14:00", "to": "18:00", "tz": "UTC+8" } },
      "notteItalia": { "mode": "include", "time": { "from": "23:00", "to": "07:00", "tz": "Europe/Rome" } },
      "soloWeekend": { "mode": "include", "time": { "days": ["sat-sun"] } }
    },

    // Ordered candidate lists. A string is "provider/model"; an object may
    // carry criteria (time gates) and level (pinned dispatch thinking level).
    "workloads": {
      "complex":  [{ "model": "openai/gpt-6.1-sol", "level": "medium" }, { "model": "openai-codex/gpt-6.1-sol", "level": "medium" }],
      "standard": [{ "model": "zai/glm-5.3", "criteria": ["zaiPeak"] }, "openai/gpt-6.1-terra", "openai-codex/gpt-6.1-terra"],
      "trivial":  [{ "model": "zai/glm-5.3-flash", "criteria": ["zaiPeak"] }, { "model": "openai/gpt-6-luna", "level": "high" }, { "model": "openai-codex/gpt-6-luna", "level": "high" }]
    },

    // Pool models registered as auto/<key>. null removes a default;
    // smart, zai and openai are reserved for the built-in routers.
    "models": {
      "openai-luna-6": null,
      "weekend-glm":  { "name": "GLM Weekend", "workload": "standard", "providers": ["zai"], "criteria": ["soloWeekend"] },
      "solo-codex":    { "workload": "standard", "providers": ["openai-codex"] }
    }
  }
}
```

**Time windows** accept `days` (`"mon"`, ranges like `"mon-fri"`), `from`/`to`
as `HH:MM` with wrap-over-midnight support (`23:00 → 07:00`), and `tz` as
`"local"`, a fixed offset (`"UTC+8"`), or an IANA zone (`"Europe/Rome"`, DST
handled).

**Merging**: `criteria` entries merge over the defaults; a `workloads` tier or
a `models` key replaces its default. Changes are live, except `models`
(registration happens at load — run `/reload`).

## State

`router-usage.json`, next to the extension, keeps per-account dispatched-turn
counts and provider quota blocks. Delete it to reset balancing.

## Why not pi-router / pi-shift-router / pi-weighted-model-router?

They are excellent at what they do — channel failover, judge-based tiering,
weighted pools. pi-rector is the only one that routes on **plan billing
windows**, keeps **quota blocks across sessions** by parsing provider reset
times, and balances **two accounts of the same provider** fairly. Use it when
your constraint is subscriptions, not API dollars.
