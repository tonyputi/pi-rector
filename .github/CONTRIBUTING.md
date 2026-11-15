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
