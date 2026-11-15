# Contributing

Thanks for taking a look! Keep changes focused and routing policies easy to understand.

## Development setup

```bash
npm ci
npx tsc --noEmit
npm test
```

No build step: the extension ships as `auto-router.ts` and Pi loads its TypeScript directly. Tests use Node's built-in test runner and assertions, mocked providers, and temporary settings fixtures. They must not call real providers or read real credentials.

## Pull requests

- Use an issue for non-trivial work and keep one concern per PR.
- Add tests in `test.ts` for classification, config validation, candidate resolution, or retry changes.
- Automatic and manual group selection must share candidate eligibility and thinking rules.
- Run type checking and tests; update README examples and migration guidance when configuration changes.
- Do not add runtime dependencies for behavior already provided by Node or Pi.
- Use [Conventional Commits](https://www.conventionalcommits.org/) in PR titles: `fix:` patches, `feat:` bumps minor, and breaking-change markers bump major. `docs:`, `chore:`, and `test:` do not trigger releases by themselves. Semantic-release uses the commits that land on the release branch.
- Never commit credentials, private prompts, session histories, or local `router-usage.json` state.

## Dependabot auto-merge

After the caller is merged to `main`, successful `CI` pull-request runs let the
shared workflow opt current, non-draft Dependabot PRs to `main` into native squash
auto-merge. All update types are eligible; titles are not rewritten. Required
checks and human CODEOWNER approval still gate merging; no approval or bypass is
provided by the workflow.

Before merging the caller, verify that native auto-merge and squash are enabled,
required checks and human CODEOWNER review are enforced with stale approvals
dismissed, and the App has no bypass. The caller needs the Actions variable
`GH_APP_ID` and secret `GH_APP_PRIVATE_KEY`, with the App installed on this repository
and granted Contents and Pull requests write permissions. Repository settings are
managed separately through Terraform.

The caller does not run from an unmerged PR. Live acceptance needs a future actual
Dependabot PR and human review. To opt out, remove the caller and cancel its active
runs; disable auto-merge separately on already queued PRs.

## Releases

The Release workflow runs semantic-release after a merge to `main`. It publishes
npm packages, versioned Git tags and GitHub Releases without pushing release commits
to the protected branch. The npm plugin sets the published package version in the CI
workspace; the source `package.json` keeps its development-version placeholder.
Use [GitHub Releases](https://github.com/tonyputi/pi-rector/releases) for current
release notes. The existing `CHANGELOG.md` is retained as historical release notes.

## Security issues

**Do not open a public issue for security problems.** Use [private vulnerability reporting](https://github.com/tonyputi/pi-rector/security/advisories/new).

## License

By contributing you agree that your contributions are licensed under the MIT License.
