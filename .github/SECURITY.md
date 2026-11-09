# Security Policy

## Supported versions

This project is in early development: security fixes land on `main` and are released as patch versions. Only the latest published release is supported.

## Reporting a vulnerability

**Do not open a public issue.** Use [private vulnerability reporting](https://github.com/tonyputi/pi-rector/security/advisories/new) — reports reach only the maintainer, and GitHub supports discussing, fixing, and publishing a coordinated advisory.

Include reproduction steps, affected behavior, and the extension and Pi versions. Sanitize `rector` configuration and `router-usage.json` before sharing: they do not require credentials, but custom instructions, model names, and usage metadata may be private. Never include Pi's `auth.json`, API keys, private prompts, or session histories.

Expect an acknowledgment within a few days. Disclosure is coordinated through a GitHub Security Advisory once a fix is released, with credit in the advisory unless you prefer to remain anonymous.

## Scope

This extension routes requests through Pi's model registry and reuses Pi's provider authentication. It does not manage GitHub credentials or provide a sandbox. In scope:

- sending prompt text to a provider outside the configured classification and routing policy
- exposing provider credentials, private prompts, or sensitive configuration in logs or persisted routing state
- configuration or retry behavior that bypasses declared candidate eligibility

Configured classifier criteria receive text from the last user message. Only select classifier providers you trust with that content. Manual group selection intentionally bypasses group-level classifier gates, but not time gates or candidate conditions. These policies are not a sandbox. Review third-party extension code before installing it.

Out of scope, consistent with [Pi's own security model](https://github.com/earendil-works/pi/blob/main/SECURITY.md):

- attacks that already require running code as your user on your machine
- agent misbehavior driven by prompt injection from repository content
