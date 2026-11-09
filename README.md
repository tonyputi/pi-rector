# pi-rector

**Your models. Your conditions. One selector.**

A [Pi](https://pi.dev) extension that adds **Rector**, an automatic model selector, plus virtual model groups you can select directly. Define when a group fits a request, when its candidates are eligible, and which fallback to try next — in configuration, not TypeScript.

[![CI](https://github.com/tonyputi/pi-rector/actions/workflows/ci.yml/badge.svg)](https://github.com/tonyputi/pi-rector/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/tonyputi/pi-rector/blob/main/LICENSE)

*From Latin rector: a guide or helmsman, from regere, to steer.*

[Quick start](#quick-start) · [Configuration](#configuration) · [Manual selection](#automatic-versus-manual-selection) · [Routing](#how-routing-works) · [Migration](#migration) · [Troubleshooting](#troubleshooting)

## Why Rector?

A short lookup and a difficult debugging task do not need the same model. Subscription billing windows and unavailable accounts complicate the choice further.

Rector composes two kinds of condition:

- **Classifier criteria:** ask a compatible Pi classifier a yes/no question about the request.
- **Time criteria:** include or exclude a calendar window, with fixed offsets or daylight-saving-aware timezones.

Attach conditions to a **group**, to its **physical candidates**, or both. Every attached condition combines with **AND**. Groups and candidates are tried in order; adjacent matching OpenAI accounts can be balanced.

This is a configurable routing policy, not a subscription-metering service. Rector does not fetch prices, read remaining subscription quota, or guarantee the cheapest model.

## Quick start

### 1. Install

From Git:

```bash
pi install git:github.com/tonyputi/pi-rector
```

Or a local checkout:

```bash
pi install /absolute/path/to/pi-rector
```

The npm package is not yet published. Once available, installation will also be:

```bash
pi install npm:pi-rector
```

No additional runtime dependencies: Rector uses Node built-ins and Pi's APIs. Development checks target Pi 1.4.0, including its virtual-model and classifier APIs.

### 2. Connect your providers

Authenticate physical models and classifiers through Pi as usual. Rector reuses Pi's registry and credentials; it does not manage accounts or sign-in.

**Check that your catalog includes the model IDs below**, or replace them with models you can access. OpenAI balancing only represents two separate accounts if `openai` and `openai-codex` are authenticated as the distinct identities you intend to use.

### 3. Choose automatic or direct selection

Start or reload Pi and select **Rector** in `/model`:

```bash
pi --model rector/auto
```

To choose a group yourself:

```bash
pi --model rector/complex
```

Normal Pi models remain selectable and bypass Rector entirely.

## Configuration

Only two sections describe the policy:

| Section | Responsibility |
| --- | --- |
| `criteria` | Named time conditions and compatible classifier questions |
| `models` | Ordered virtual groups, their conditions, and physical candidates |

Put `rector` in `~/.pi/agent/settings.json` or project `.pi/settings.json`. `PI_CODING_AGENT_DIR` overrides the user directory. Merge it into existing settings rather than overwriting unrelated settings. **Run `/reload` after edits**: validation and registration use a load-time snapshot. Policies using project settings require Pi's project trust before routing.

### Complete configuration

This is the bundled policy. Notice the order: Simple, Complex, then an unconditional Standard fallback.

```json
{
  "rector": {
    "criteria": {
      "simpleTask": {
        "type": "classifier",
        "model": "opencode/jev-1.13-free",
        "instructions": "Is the request in `prompt` a short answer, simple lookup, or straightforward small edit?"
      },
      "complexTask": {
        "type": "classifier",
        "model": "opencode/jev-1.13-free",
        "instructions": "Does the request in `prompt` require architecture, difficult debugging, or cross-cutting changes rather than ordinary implementation?"
      },
      "zaiPeak": {
        "type": "time",
        "mode": "exclude",
        "time": {
          "days": ["mon-fri"],
          "from": "14:00",
          "to": "18:00",
          "tz": "UTC+8"
        }
      }
    },
    "models": {
      "simple": {
        "name": "Simple",
        "criteria": ["simpleTask"],
        "candidates": [
          { "model": "zai/glm-5.3-flash", "criteria": ["zaiPeak"] },
          { "model": "openai/gpt-6-luna", "level": "high" },
          { "model": "openai-codex/gpt-6-luna", "level": "high" }
        ]
      },
      "complex": {
        "name": "Complex",
        "criteria": ["complexTask"],
        "candidates": [
          { "model": "openai/gpt-6.1-sol", "level": "medium" },
          { "model": "openai-codex/gpt-6.1-sol", "level": "medium" }
        ]
      },
      "standard": {
        "name": "Standard",
        "candidates": [
          { "model": "zai/glm-5.3", "criteria": ["zaiPeak"] },
          "openai/gpt-6.1-terra",
          "openai-codex/gpt-6.1-terra"
        ]
      }
    }
  }
}
```

For a simple request, Rector first checks `simpleTask`. If it passes, Rector looks inside Simple: GLM-Flash outside the excluded window, otherwise an eligible Luna account. If Simple cannot serve the request, Rector considers Complex and then Standard.

**Fallback is explicit policy.** Standard has no group conditions, so it is a fallback even when a matching Complex group has no available candidate. Remove that fallback or add restrictive conditions if you do not want automatic cross-group downgrades. Selecting Complex directly never falls through to Standard.

### Classifier conditions

A classifier criterion names a compatible `provider/model` and an `instructions` question. It uses Pi's typed **boolean** classifier API, not generated chat text. A valid probability of at least `0.5` satisfies the condition; false, missing, malformed, or unsuccessful answers do not. Cancellation stops routing rather than falling through.

Multiple questions may all be true. **Configuration order breaks ties**, not classifier confidence or a hidden ranking algorithm. Descriptions are semantic rules, not deterministic guarantees.

Rector sends up to 16,000 characters of text from the last user message to the configured classifier provider. It does not send conversation history or images. Questions using the same classifier model are batched when needed; unused criterion definitions are not sent. Different classifier models can require separate calls, adding latency and usage charges.

Answers are reused within the user turn, including continuations and retries. A new user turn or changed criterion definitions invalidates them. Branch-local routing state stores boolean results and a configuration hash, not the prompt. Define a final unconditioned group if classifier failure should have a fallback; there is no separate global classifier or hidden fallback setting.

### Time conditions

`include` requires a matching window; `exclude` requires a non-matching window. Time checks run before classifier calls and are evaluated again on subsequent routing requests.

| Field | Accepted values |
| --- | --- |
| `days` | `mon` through `sun`, or ranges such as `mon-fri`, `sat-sun`; omitted means every day |
| `from` / `to` | `HH:MM`; start inclusive, end exclusive; overnight windows such as `23:00` → `07:00` work |
| `tz` | `local` (default), fixed offsets such as `UTC+8` or `UTC-5:30`, or IANA zones such as `Europe/Rome` |

IANA zones follow daylight-saving rules. Missing bounds cover the beginning or end of the day. Day filters use the calendar day at evaluation time, including after midnight in an overnight window. The bundled `zaiPeak` window is editable policy, not a guarantee about your plan's billing terms.

### Two levels, not recursive groups

- **Group criteria** decide whether automatic routing can enter that group.
- **Candidate criteria** decide whether an individual physical model can be used inside it.
- All time gates, credentials, and provider blocks remain mandatory.
- Candidates are physical models, never another Rector group. No recursive rule graph is supported.

This adds a time-gated group before the inherited defaults. While eligible, it prefers GLM; if the entire group is unavailable, automatic routing can continue to the inherited groups.

```json
{
  "rector": {
    "criteria": {
      "nightOnly": {
        "type": "time",
        "mode": "include",
        "time": { "from": "23:00", "to": "07:00", "tz": "Europe/Rome" }
      }
    },
    "models": {
      "night": {
        "name": "Night GLM",
        "criteria": ["nightOnly"],
        "candidates": [
          { "model": "zai/glm-5.3", "criteria": ["zaiPeak"] }
        ]
      }
    }
  }
}
```

Classifier criteria can also be attached to candidates. These remain mandatory even if you manually select the containing group.

### Order, merging, and thinking effort

User settings apply over defaults, then project settings over user settings:

- `criteria` merge by name; each definition replaces the inherited definition at that name.
- Group definitions replace inherited definitions as a whole. Groups explicitly listed in a scope come **first, in their listed order**; unmentioned inherited groups follow in their previous order.
- Set a group to `null` to remove it. To replace the bundled policy entirely, remove unneeded defaults explicitly.
- Group IDs contain letters, numbers, `.`, `_`, or `-`, starting with a letter or number. Purely numeric IDs are rejected because JavaScript would reorder them. `auto` is reserved.
- An unconditional early group can shadow every later group. Put broad fallback groups last.

A candidate is `"provider/model"` or an object with `model`, optional `criteria`, and optional `level` (`low`, `medium`, `high`, `xhigh`). Candidate order determines preference, except within adjacent balanced OpenAI pairs.

**Thinking does not select a group.** `level` overrides the physical candidate's effort; otherwise selected effort passes through. Pi clamps effort to the model's supported levels.

## Automatic versus manual selection

| Selection | Group classifier gates | Group time gates | Candidate gates, credentials, and blocks |
| --- | --- | --- | --- |
| **Rector** (`rector/auto`) | Evaluated | Enforced | Enforced |
| A group (`rector/complex`) | **Bypassed** | Enforced | Enforced |
| A physical Pi model | Rector is bypassed entirely | — | Pi's normal behavior |

Selecting Complex means “use this group”, not “let a classifier veto my choice”. It does **not** authorize ignoring time restrictions, candidate-level classifier questions, or unavailable accounts.

## How routing works

1. **Walk groups in order.** Automatic selection takes the first group whose conditions pass and that has a usable physical candidate. Direct group selection considers only that group.
2. **Walk candidates.** Skip missing catalog entries, virtual models, missing credentials, active provider blocks, and unsatisfied candidate conditions. Obvious time/availability exclusions avoid unnecessary classifier calls.
3. **Balance matching OpenAI pairs.** Adjacent entries for the same model ID on `openai` and `openai-codex` form a pair. Each must pass its own conditions. Prefer the eligible session account; otherwise choose the account with fewer recorded dispatches.
4. **Keep the turn together.** Continuations and retries retain the chosen group. Tool follow-ups retain their physical model while eligible. Time and availability are rechecked; classifier answers are reused.
5. **Handle a Pi-requested retry.** Block the failed provider and resolve another eligible candidate in the same group. No criteria or effort override is bypassed. A locked group with no candidate fails rather than switching groups mid-turn.

Automatic requests without turn state, including direct requests such as compaction, use the same ordered policy and can call classifiers. Pi records physical models on assistant responses while the selected virtual model remains visible in its selector.

### Blocks and local state

Physical assistant errors observed while using Rector create provider-wide blocks. Reset parsing recognizes date-time stamps and durations such as `2 hours and 30 minutes`. Date-time stamps are clamped to one minute–seven days ahead; durations are capped at five hours. Unrecognized reset information uses 30 minutes. A bare clock time such as `15:30` is not a recognized timestamp.

Only newly observed successful responses clear blocks; historical successful responses do not. Selecting a normal physical model does not update Rector state.

`router-usage.json`, beside the extension, persists dispatch counts and block deadlines. It contains routing metadata rather than prompts or credentials. Counts are not token usage or remaining quota. Keep the installation writable for persistence; separate installations have separate state, and concurrent processes can overwrite one another's updates.

## Current limitations

- Same-request failover depends on Pi requesting a retry; Rector does not replay failed requests itself.
- Failure blocks are provider-wide, not model-specific. They do not distinguish quota exhaustion from transient network errors.
- A boolean classifier can satisfy multiple group conditions; order is part of the policy and must be reviewed.
- Initial automatic selection may use a later, less capable group if an earlier group cannot serve the request. Continuations and retries do not switch groups.
- Persistence is best-effort and not safe for concurrent writers.

## Migration

Older `autoRouter`, the former `rector.classifier` selector, and untyped time criteria are temporarily converted **in memory** with a warning. No settings files or saved selections are rewritten. If `rector` exists in either scope, `autoRouter` is ignored entirely.

- Former classifier choices become boolean group gates containing the original instructions and category descriptions. The old fallback is placed after the other listed categories.
- Legacy workloads become model groups; explicitly configured pools become additional groups with filtered candidate lists. Invalid references or empty lists fail validation.
- Untyped time conditions acquire `type: "time"`.
- **Compatibility is structural, not identical classification behavior:** exclusive categories become independent yes/no questions, and automatic routing now selects the first usable matching group. Review the generated intent and migrate explicitly rather than relying on identical decisions.
- Replace the former top-level `classifier` section with named classifier criteria, and attach those criteria to the relevant groups. Keep a fallback group last if desired.

The selection IDs remain `rector/auto` and `rector/<group>`. Old `auto/` IDs are not registered. For Rector as the startup selection, merge:

```json
{
  "defaultProvider": "rector",
  "defaultModel": "auto"
}
```

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Rector or a custom group is missing | Confirm the extension is enabled, inspect load errors, check the agent directory, and reload. |
| Unexpected group selected | Check resolved group order, overlapping classifier questions, and unconditional groups that shadow later entries. |
| Always uses the last fallback | Check classifier availability, credentials, questions, and returned probabilities. Failed classifier gates do not pass. |
| `no eligible model group` | No group could serve the request. Review the listed criteria, credentials, catalog entries, and block deadlines. |
| Manual selection fails | Group time gates and all candidate gates still apply. Selecting a group does not bypass them. |
| A turn stops instead of switching groups | Continuations and retries stay in the selected group; cross-group fallback is only for a fresh automatic selection. |
| One OpenAI account gets most dispatches | Session affinity wins over counts. Confirm both matching entries are adjacent, eligible, and authenticated as intended. |

To reset history, stop Pi instances using the installation and back up `router-usage.json` before removing it. This resets both counts and blocks, not provider quota.

## Development

```bash
npm ci
npx tsc --noEmit
npm test
```

The extension ships as `auto-router.ts`, without a build step. Tests use Node's built-in runner, mocked classifiers/catalogs, temporary settings, and an offline Pi runtime. CI runs on Node 22 and 24. No real provider calls or credentials are needed.

[Report a bug](https://github.com/tonyputi/pi-rector/issues) with sanitized configuration, selected model, and reproduction steps. Never include credentials or private prompts.

## Code of conduct

This project follows the [Contributor Covenant](https://github.com/tonyputi/pi-rector/blob/main/.github/CODE_OF_CONDUCT.md).

## License

[MIT](https://github.com/tonyputi/pi-rector/blob/main/LICENSE)
