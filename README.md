# pi-rector

**Your subscriptions. One model selector.**

A [Pi](https://pi.dev) extension that routes requests through configurable model tiers, billing windows, and account availability — so you can spend less time switching models and more time getting work done.

[![CI](https://github.com/tonyputi/pi-rector/actions/workflows/ci.yml/badge.svg)](https://github.com/tonyputi/pi-rector/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/tonyputi/pi-rector/blob/main/LICENSE)

*From Latin rector: a guide or helmsman, from regere, to steer.*

[Quick start](#quick-start) · [Configuration](#configuration) · [Routing](#how-routing-works) · [Limitations](#current-limitations) · [Troubleshooting](#troubleshooting)

## The problem

A model that is a good choice for one request may be a poor choice for the next:

- A short question does not need the same model as a difficult debugging task.
- A subscription's peak window can change which plan you prefer to use.
- One account may be unavailable while another can still serve requests.
- Manually switching models interrupts the work you wanted the agent to do.

API token prices alone do not capture this. Subscription routing also needs your plan's calendar, candidate order, and account availability.

## The solution

pi-rector adds virtual models under `auto/`. You select a routing policy; Pi dispatches the request to a physical model from your configured candidates.

- **Three workload tiers:** `trivial`, `standard`, and `complex`.
- **Time-aware eligibility:** reusable include/exclude criteria with fixed offsets or IANA timezones.
- **Two-account balancing:** adjacent matching `openai` / `openai-codex` entries can share dispatches while preferring the session's existing account.
- **Persistent failure blocks:** supported provider errors can temporarily remove candidates, using reset information when available.
- **Your own virtual models:** define named pools in settings, without editing TypeScript.

**You decide what “cheap first” means.** Candidates are tried in configuration order; pi-rector does not fetch prices, inspect your subscription balance, or guarantee the cheapest available model.

## Quick start

### 1. Install

Install from Git today:

```bash
pi install git:github.com/tonyputi/pi-rector
```

Or use a local checkout:

```bash
pi install /absolute/path/to/pi-rector
```

The npm package is not yet published. Once available, installation will also be:

```bash
pi install npm:pi-rector
```

No additional runtime dependencies: the extension uses Node built-ins and Pi's APIs. Use a Pi version with virtual-model routing and classifier support; development checks currently target Pi 1.4.0.

### 2. Configure your providers

Authenticate your underlying providers in Pi as usual. pi-rector reuses Pi's model registry and credentials; it does not sign you in or create accounts.

The bundled workloads reference the model IDs listed below. **Check that those IDs exist in your Pi catalog**, or replace the workload lists with models you can actually access. Balancing across `openai` and `openai-codex` only represents two separate accounts if you have configured those provider identities that way.

### 3. Select a route

Start or reload Pi, choose `auto/smart` in `/model`, and set thinking to `medium` for automatic difficulty classification. You can also start with:

```bash
pi --model auto/smart
```

| Selected thinking level | Workload selection in `auto/smart` and `auto/openai` |
| --- | --- |
| `low` | `trivial` |
| `medium` | Classifier chooses `trivial`, `standard`, or `complex` |
| `high` / `xhigh` | `complex` |

On new user turns, the classifier reads up to 16,000 characters of text from the last user message. It uses `opencode/jev-1.13-free`; if unavailable or unsuccessful, selection falls back to `standard`. It does not assess the entire conversation or image contents. Configure classifier access through Pi if you want automatic classification.

## Virtual models

| Model | Policy |
| --- | --- |
| `auto/smart` | Select a workload by thinking level or classifier; consider all its candidates |
| `auto/openai` | Select a workload, considering `openai` and `openai-codex` candidates |
| `auto/zai` | Try Z.ai candidates in the selected workload, then other workloads |
| `auto/openai-sol-6.1` | Bundled OpenAI pool for `complex` |
| `auto/openai-terra-6.1` | Bundled OpenAI pool for `standard` |
| `auto/openai-luna-6` | Bundled OpenAI pool for `trivial` |
| `auto/<your-key>` | A pool you define under `autoRouter.models` |

A pool selects a fixed workload: raising its thinking level does not select a different workload. The three built-in router IDs (`smart`, `openai`, `zai`) are reserved.

## Configuration

Keep three concerns separate:

| Section | Defines |
| --- | --- |
| `criteria` | **When** a candidate or pool is eligible |
| `workloads` | **Which physical models** a tier tries, in order |
| `models` | **Which virtual pools** appear in `/model` |

Put `autoRouter` in project `.pi/settings.json`, or in your user settings. Merge it into existing settings rather than replacing the whole file. Reload Pi after editing settings on disk.

> **User-settings caveat:** pool registration and startup validation currently locate user settings through `PI_CODING_AGENT_DIR`, falling back to the extension's parent directory. For reliable user-level custom pools in a package installation, set `PI_CODING_AGENT_DIR` to your actual agent directory before starting Pi. Project `.pi/settings.json` is read directly at registration time.

### Workloads: candidate order and thinking effort

This example uses the bundled candidate order, adding explicit thinking overrides for Sol and Luna:

```json
{
  "autoRouter": {
    "workloads": {
      "complex": [
        { "model": "openai/gpt-6.1-sol", "level": "medium" },
        { "model": "openai-codex/gpt-6.1-sol", "level": "medium" }
      ],
      "standard": [
        { "model": "zai/glm-5.3", "criteria": ["zaiPeak"] },
        "openai/gpt-6.1-terra",
        "openai-codex/gpt-6.1-terra"
      ],
      "trivial": [
        { "model": "zai/glm-5.3-flash", "criteria": ["zaiPeak"] },
        { "model": "openai/gpt-6-luna", "level": "high" },
        { "model": "openai-codex/gpt-6-luna", "level": "high" }
      ]
    }
  }
}
```

A string means `provider/model`. An object can also name criteria and set `level` to `low`, `medium`, `high`, or `xhigh`. The physical model must support the effort you request.

**Selection effort and dispatch effort are different.** For example, selecting `high` on `auto/smart` chooses `complex`; a Sol entry with `"level": "medium"` then requests medium thinking from the physical model. Without an override, effort generally passes through; `auto/smart` and `auto/zai` default trivial dispatches to `low`.

The bundled defaults do **not** set entry-level thinking overrides. The standard tier contains GLM and Terra only — it does not silently downgrade to Luna.

### Criteria: billing windows and timezones

The bundled `zaiPeak` criterion excludes weekdays from 14:00 until 18:00 at UTC+8. Treat it as an editable policy, not a guarantee about your plan's current billing terms.

```json
{
  "autoRouter": {
    "criteria": {
      "zaiPeak": {
        "mode": "exclude",
        "time": { "days": ["mon-fri"], "from": "14:00", "to": "18:00", "tz": "UTC+8" }
      },
      "nightOnly": {
        "mode": "include",
        "time": { "from": "23:00", "to": "07:00", "tz": "Europe/Rome" }
      }
    }
  }
}
```

- `include`: eligible only while the window matches. `exclude`: ineligible while it matches.
- Every criterion attached to an entry must allow it.
- Days use `mon` through `sun`, or ranges such as `mon-fri` and `sat-sun`.
- Windows include `from` and exclude `to`; they can wrap over midnight.
- Omitted days mean every day. Omitted time bounds cover the beginning or end of the day.
- `tz` accepts `local` (default), fixed offsets such as `UTC+8`, or IANA zones such as `Europe/Rome` with daylight-saving rules.
- Day filters apply to the calendar day at evaluation time, including the after-midnight portion of an overnight window.

### Models: your own selectable pools

This adds `auto/night-glm` and removes the bundled Luna pool from `/model`:

```json
{
  "autoRouter": {
    "criteria": {
      "nightOnly": {
        "mode": "include",
        "time": { "from": "23:00", "to": "07:00", "tz": "Europe/Rome" }
      }
    },
    "models": {
      "night-glm": {
        "name": "Night GLM",
        "workload": "standard",
        "providers": ["zai"],
        "criteria": ["nightOnly"]
      },
      "openai-luna-6": null
    }
  }
}
```

`name` is optional. `workload` names a configured tier. `providers` narrows candidate selection; omit it to consider all providers. Pool criteria apply in addition to candidate criteria — in this example, both `nightOnly` and the standard GLM entry's `zaiPeak` policy must allow the request.

Criteria merge by name over defaults. Each workload array and model definition replaces the corresponding default entry; `null` removes a default pool. Removing a pool does not remove its physical models from workloads. Registration and validation happen at extension load, so use `/reload` after changes.

## How routing works

1. **Choose a workload.** The smart routers use thinking level and, where needed, the classifier. Named pools use their configured workload.
2. **Walk the candidates.** Normal selection skips missing catalog entries, blocked providers, and candidates excluded by criteria.
3. **Choose an account.** Adjacent entries for the same model ID on `openai` and `openai-codex` form a balanced pair. An eligible session account is preferred; otherwise the account with fewer recorded dispatches wins.
4. **Dispatch.** The selected physical model handles the request. Tool follow-ups normally retain the previous model and thinking level, avoiding unnecessary switches.
5. **Observe errors.** Assistant errors from `openai`, `openai-codex`, and `zai` create provider blocks. Explicit retry handling can choose another account or eligible candidate, depending on the virtual model and Pi's retry behavior.

Reset parsing recognizes date-time stamps and duration text such as `2 hours and 30 minutes`. Date-time stamps are clamped to one minute–seven days ahead; summed durations are capped at five hours. Without recognized reset information, the fallback block is 30 minutes. A bare clock time such as `15:30` is not recognized as a reset timestamp.

### Local state

`router-usage.json`, next to the extension, stores dispatch counts and provider block deadlines. It contains routing metadata, not credentials or prompts. Counts are not token usage or a measurement of remaining quota.

Keep the installation directory writable for persistence. Writes are best-effort; an unwritable directory prevents reliable balancing and block persistence. Separate checkouts have separate state, and concurrent Pi processes can overwrite one another's updates.

## Current limitations

- **Failover is not guaranteed within the same request.** Pi may surface the error before another route is attempted. Custom pools do not have the built-in routers' explicit account-switching retry logic.
- **Blocks are provider-wide, not model-specific.** An error on Terra can also exclude Luna on the same provider. Non-quota errors also trigger blocks; the router does not yet distinguish transient network failures from exhausted quota.
- **Block tracking is heuristic.** Previous-route handling and OpenAI dispatch can clear blocks; stored deadlines are not authoritative subscription telemetry.
- **Filters and thinking overrides are not hard isolation boundaries.** The second member of a balanced OpenAI pair is not independently provider-filtered, and direct retry account switches can bypass candidate criteria and entry-level thinking overrides. Do not use these settings as security controls.
- **Startup validation is partial.** It checks several references and values, but does not prove model access or validate every malformed configuration. Some time checks depend on the current day.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No `auto/` models appear | Confirm the package is enabled, reload Pi, and inspect extension-load errors. Your Pi needs virtual-model routing support. |
| `no candidate available` | Check the named workload, model catalog, provider blocks, and time criteria. Some errors list why candidates were skipped; not all include reset deadlines. |
| Requests keep using `standard` | At `medium`, a missing or failing classifier falls back to `standard`. Check classifier availability and authentication in Pi. |
| Custom pools do not appear | Reload Pi. For user-level settings, check `PI_CODING_AGENT_DIR` and the registration caveat above. |
| One OpenAI account gets most requests | Session affinity takes priority over balancing. Check that both matching entries are adjacent, available, and authenticated as intended. |
| A configuration error appears | Check the criterion name, `provider/model` format, workload reference, and supported `level` values named in the error. |

To reset routing history, stop Pi instances using this installation and back up `router-usage.json` before removing it. This resets **both** counts and provider blocks; it does not restore provider quota.

## Development

```bash
npm ci
npx tsc --noEmit
npm test
```

The extension ships as TypeScript without a build step. CI runs type checking and assert-based checks on Node 22 and 24.

Found a bug? [Open an issue](https://github.com/tonyputi/pi-rector/issues). Include the virtual model, relevant configuration, and a sanitized error — never credentials or private prompts.

## Code of conduct

This project follows the [Contributor Covenant](https://github.com/tonyputi/pi-rector/blob/main/.github/CODE_OF_CONDUCT.md).

## License

[MIT](https://github.com/tonyputi/pi-rector/blob/main/LICENSE)
