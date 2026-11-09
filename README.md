# pi-rector

**Your subscriptions. One model selector.**

A [Pi](https://pi.dev) extension that adds **Rector**, an automatic model selector, and your own virtual model groups alongside Pi's normal models. Configure how requests are classified, which models each group tries, and when each candidate is eligible.

[![CI](https://github.com/tonyputi/pi-rector/actions/workflows/ci.yml/badge.svg)](https://github.com/tonyputi/pi-rector/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/tonyputi/pi-rector/blob/main/LICENSE)

*From Latin rector: a guide or helmsman, from regere, to steer.*

[Quick start](#quick-start) · [Configuration](#configuration) · [Routing](#how-routing-works) · [Migration](#migrating-from-autorouter) · [Troubleshooting](#troubleshooting)

## The problem

The best model for a quick question may not be the one you want for architecture work. Subscription billing windows and account limits complicate the choice further — and manually switching models interrupts the work.

Rector lets you express that policy once:

- **Classification rules you control**, using a compatible Pi classifier.
- **Ordered candidate groups**, with thinking overrides and fallback inside each group.
- **Time criteria**, including billing windows, fixed UTC offsets, and daylight-saving-aware zones.
- **OpenAI account balancing**, with session affinity and persisted dispatch counts.
- **Manual selection when you want it**, without disabling automatic routing for other tasks.

You decide what “cheap first” means through candidate order. Rector does not fetch prices, measure remaining subscription quota, or guarantee the cheapest model.

## One group, two ways to use it

```text
Select Rector  → classifier chooses a group → resolve its physical candidates
Select a group → skip classification       → resolve its physical candidates
Select a normal Pi model                  → use Pi normally
```

A **virtual model group** is simply a named list of physical candidates. There is no separate workload layer or duplicate pool definition.

| Selection in `/model` | Model ID | Behavior |
| --- | --- | --- |
| **Rector** | `rector/auto` | Automatically choose a group using your classifier rules |
| **Simple** | `rector/simple` | Use the `simple` group's candidates directly |
| **Standard** | `rector/standard` | Use the `standard` group's candidates directly |
| **Complex** | `rector/complex` | Use the `complex` group's candidates directly |
| Your custom group | `rector/<key>` | Use the candidates under `rector.models.<key>` |
| A normal Pi model | Its existing ID | Bypass Rector entirely |

`simple`, `standard`, and `complex` are defaults, not special categories. You can use your own names. `auto` is reserved for Rector itself.

## Quick start

### 1. Install

Install from Git:

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

No additional runtime dependencies: the extension uses Node built-ins and Pi's APIs. Use a Pi version with virtual-model routing and classifier support; development checks target Pi 1.4.0.

### 2. Connect your providers

Authenticate the physical models and classifier through Pi as usual. Rector reuses Pi's model registry and credentials; it does not create accounts or manage sign-in.

The bundled groups use the model IDs in the complete configuration below. **Check your Pi catalog and replace IDs you cannot access.** Two-account balancing requires `openai` and `openai-codex` to actually represent the distinct accounts you intend to use.

### 3. Choose Rector

Start or reload Pi, then select **Rector** in `/model`:

```bash
pi --model rector/auto
```

Or select a group directly:

```bash
pi --model rector/complex
```

**Thinking effort no longer selects the group.** Rector uses classification at every offered thinking level. Candidate `level` overrides control physical effort; without one, your selected effort passes through. Pi clamps effort to what the physical model supports.

## Configuration

Three sections describe the whole policy:

| Section | Responsibility |
| --- | --- |
| `classifier` | Which compatible classifier to call, which groups it can choose, and the rules for choosing them |
| `criteria` | Named time conditions reusable by groups and individual candidates |
| `models` | Selectable virtual model groups and their ordered physical candidates |

Put `rector` in `~/.pi/agent/settings.json` or project `.pi/settings.json`. `PI_CODING_AGENT_DIR` overrides the user directory. Merge the section into your existing settings; do not overwrite unrelated settings. **Run `/reload` after edits** — registration and validation use a settings snapshot at extension load. If the policy uses project settings, Rector refuses to route until Pi reports the project as trusted.

### Complete configuration

This is the bundled policy, shown explicitly so you can customize it:

```json
{
  "rector": {
    "classifier": {
      "model": "opencode/jev-1.13-free",
      "instructions": "Choose the model group best suited to the user's request in `prompt`.",
      "models": {
        "simple": "Short answers, simple lookups, and straightforward small edits.",
        "standard": "Ordinary implementation, bug fixes, reviews, and explanations.",
        "complex": "Architecture, difficult debugging, and cross-cutting changes."
      },
      "fallback": "standard"
    },
    "criteria": {
      "zaiPeak": {
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
        "candidates": [
          { "model": "zai/glm-5.3-flash", "criteria": ["zaiPeak"] },
          { "model": "openai/gpt-6-luna", "level": "high" },
          { "model": "openai-codex/gpt-6-luna", "level": "high" }
        ]
      },
      "standard": {
        "name": "Standard",
        "candidates": [
          { "model": "zai/glm-5.3", "criteria": ["zaiPeak"] },
          "openai/gpt-6.1-terra",
          "openai-codex/gpt-6.1-terra"
        ]
      },
      "complex": {
        "name": "Complex",
        "candidates": [
          { "model": "openai/gpt-6.1-sol", "level": "medium" },
          { "model": "openai-codex/gpt-6.1-sol", "level": "medium" }
        ]
      }
    }
  }
}
```

For example, Rector can classify an ordinary bug fix as `standard`. Outside the excluded window it first considers GLM; if unavailable, it considers the Terra account pair. Selecting **Standard** manually runs that exact same candidate resolver, without calling the classifier.

### Classifier: your selection rules

- `model` is a `provider/model` ID resolved specifically as a **classifier**, not a chat model. See [Pi's classifier documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#use-classifier-models) for compatible providers and authentication.
- `instructions` is the overall question passed to the classifier.
- `models` maps group IDs to semantic descriptions. These descriptions are the selection rules; they are not deterministic predicates.
- `fallback` names a listed group to use when the classifier is missing, fails, or returns an invalid answer. Cancellation does not trigger fallback.

Every classifier choice must refer to an existing group. Groups omitted from `classifier.models` remain manually selectable. Group-level criteria remove excluded groups from the classifier's choices; an excluded fallback produces a clear error instead of choosing an arbitrary alternative.

The classifier receives up to 16,000 characters of text from the last user message. It does not receive the entire conversation or images. **That text is sent to your configured classifier provider**, which can add cost and latency before the physical model responds.

### Criteria: group gates versus candidate gates

The bundled `zaiPeak` policy excludes weekdays 14:00–18:00 at UTC+8. It is editable policy, not a guarantee about your plan's current billing terms.

- On a **candidate**, a criterion can skip that candidate and leave later candidates available.
- On a **group**, a criterion makes the entire virtual model unavailable while it disallows use.
- Every attached criterion must allow use: `include` requires a matching window; `exclude` requires a non-matching window.

Time fields:

| Field | Accepted values |
| --- | --- |
| `days` | `mon` through `sun`, or ranges such as `mon-fri`, `sat-sun`; omitted means every day |
| `from` / `to` | `HH:MM`; start inclusive, end exclusive, with overnight windows such as `23:00` → `07:00` |
| `tz` | `local` (default), fixed offsets such as `UTC+8` or `UTC-5:30`, or IANA zones such as `Europe/Rome` |

IANA zones follow daylight-saving rules. Missing time bounds cover the beginning or end of the day. Day filters use the calendar day at evaluation time, including after midnight in an overnight window.

This example adds a **manual-only** night group without changing the classifier's default choices:

```json
{
  "rector": {
    "criteria": {
      "nightOnly": {
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

### Candidates and merging

A candidate is either `"provider/model"` or an object with `model`, optional `criteria`, and optional `level` (`low`, `medium`, `high`, `xhigh`). Candidates must be physical models; groups cannot nest or point back to Rector.

Candidate order controls preference. Adjacent entries for the same model ID on `openai` and `openai-codex` form a balanced pair. Each member still has to pass its own criteria and availability checks.

User settings are applied over defaults, then project settings over user settings:

- `criteria` and `models` merge by key. Each criterion or model definition replaces the entire inherited definition at that key.
- Setting a model group to `null` removes it. Remove it from classifier choices too if it was listed there.
- `classifier` merges by field; its `models` map is replaced as a whole when supplied.
- To use only your own groups, remove the unwanted defaults with `null` and replace `classifier.models` and `fallback` accordingly.

Invalid references, empty candidate lists, recursive Rector candidates, malformed times, unsupported levels, and unknown setting fields are rejected at load. Catalog access and credentials are checked during routing, not proven by config validation.

## How routing works

1. **Choose a group.** New user turns on **Rector** invoke the classifier. Manual groups bypass it. Thinking effort does not affect group selection.
2. **Resolve candidates.** Skip missing catalog entries, virtual candidates, missing credentials, active provider blocks, and candidates excluded by criteria.
3. **Balance account pairs.** Prefer the eligible account already used by the session; otherwise choose the one with fewer recorded dispatches. Counts are dispatch counts, not tokens or remaining quota.
4. **Continue consistently.** Tool follow-ups retain the selected group and physical model when still eligible. Criteria and credentials are rechecked; account affinity is a preference, not an exemption from the policy.
5. **Handle retries through the same resolver.** If Pi requests a retry after a physical failure, block the failed provider and try eligible candidates in the same group. Candidate thinking overrides and criteria still apply.

The chosen group is stored in Pi's branch-local routing state. Continuations and retries do not reclassify the request. A direct request without routing state, such as a compaction summary, uses the classifier's fallback group; direct requests to a manual group still use that group.

**An unavailable group is not a classification failure.** If the chosen group has no eligible candidates, Rector reports an error. It does not silently downgrade from Complex to Simple or use a different group. Standard contains GLM/Terra only, not Luna.

### Failure blocks and local state

Errors from physical models routed through Rector create provider-wide blocks. Reset parsing recognizes date-time stamps and durations such as `2 hours and 30 minutes`. Date-time stamps are clamped to one minute–seven days ahead; summed durations are capped at five hours. Unrecognized reset information uses a 30-minute block. Bare clock times such as `15:30` are not recognized as timestamps.

A newly observed successful response clears that provider's block; historical successful responses do not. Using a physical model directly does not update Rector's state.

`router-usage.json`, beside the extension, persists dispatch counts and block deadlines. Keep the installation writable for persistence. State contains routing metadata rather than prompts or credentials. It is not authoritative quota telemetry, and concurrent Pi processes can overwrite one another's updates.

## Current limitations

- **Same-request failover depends on Pi requesting a retry.** Rector does not start its own retry loop or replay a failed request automatically.
- **Blocks are provider-wide, not model-specific.** A Terra error can also exclude Luna on the same provider.
- **Errors are not yet classified by cause.** Transient network failures can create the same block as exhausted quota.
- **Classifier rules are semantic.** Ambiguous descriptions can produce unexpected group choices; fallback is not a guarantee of classification quality.
- **Persistence is best-effort.** An unwritable installation loses routing history; separate installations have separate state.

## Migrating from autoRouter

Existing `autoRouter` settings are temporarily converted **in memory**, with a deprecation warning. No settings files are rewritten. If `rector` exists in either settings scope, it takes precedence and the legacy section is ignored entirely.

| Old concept | New concept |
| --- | --- |
| `autoRouter.workloads.<key>` | `rector.models.<key>.candidates` |
| `autoRouter.criteria` | `rector.criteria` |
| Pool with `workload` and `providers` | One group with an explicit, filtered candidate list |
| Fixed classifier categories | Configurable `rector.classifier.models` descriptions |
| `auto/smart` | **Rector**, `rector/auto` |
| `auto/openai`, `auto/zai` | Configure provider-specific groups explicitly |
| Bundled Sol/Terra/Luna pools | `rector/complex`, `rector/standard`, `rector/simple` under the new defaults |

Legacy conversion keeps workload keys, including `trivial`, and explicitly configured pools become additional groups. Provider filters are applied to their candidate lists before balancing. Unknown workloads, conflicting group IDs, or filters that produce empty pools fail validation instead of silently changing intent.

**Old `auto/` model IDs are not registered.** Reselect Rector or a group after reload and update any saved defaults or CLI arguments. For Rector as the startup selection, merge this into your settings:

```json
{
  "defaultProvider": "rector",
  "defaultModel": "auto"
}
```

Thinking-to-category shortcuts are removed even in legacy compatibility mode. To force a category, select its virtual model directly.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Rector does not appear | Confirm the package is enabled, reload Pi, and inspect load errors. Your Pi needs virtual-model support. |
| A custom group is missing | Check `rector.models`, its ID, and reload. User settings must be in the agent directory. |
| `no candidate available` | Inspect the listed reasons: catalog, credentials, block deadlines, or criteria. Rector will not switch groups silently. |
| Always uses the fallback group | Check your classifier ID, credentials, availability, and semantic rules. A compatible classifier must be registered in Pi. |
| One OpenAI account gets most dispatches | Session affinity takes priority over counts. Verify both pair members are adjacent, eligible, and authenticated as intended. |
| A manual group is excluded | Check its group-level criteria. Manual selection bypasses classification, not eligibility checks. |
| An old model selection fails after upgrade | Replace `auto/smart` with `rector/auto`, or select one of the newly registered groups. |

To reset routing history, stop Pi instances using the installation and back up `router-usage.json` before removing it. This resets **both** counts and provider blocks, not provider quota.

## Development

```bash
npm ci
npx tsc --noEmit
npm test
```

The extension ships as `auto-router.ts` without a build step. Tests use Node's built-in runner and assertions, mocked classifiers/catalogs, and temporary configuration fixtures — no provider calls or real credentials. CI runs on Node 22 and 24.

Found a bug? [Open an issue](https://github.com/tonyputi/pi-rector/issues) with sanitized configuration, the selected virtual model, and reproduction steps. Never include credentials or private prompts.

## Code of conduct

This project follows the [Contributor Covenant](https://github.com/tonyputi/pi-rector/blob/main/.github/CODE_OF_CONDUCT.md).

## License

[MIT](https://github.com/tonyputi/pi-rector/blob/main/LICENSE)
