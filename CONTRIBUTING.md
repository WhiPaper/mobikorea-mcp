# Contributing

Thanks for helping improve MobiKorea MCP.

## Development

- Install Node.js 20 or newer.
- Run `npm ci` to install dependencies.
- Run `npm test` for the build and fast unit/in-memory suite.
- Run `npm run test:coverage` for line, branch, and function coverage checks.
- Run `npm run test:e2e` to exercise the built server as a real stdio child process.

Keep changes focused, add or update tests for behavior changes, and do not put
real TAGO or NAVER credentials in source code, tests, issues, or pull requests.
Live API checks in `scripts/` require your own credentials and may use external
service quotas; they are not part of `npm test`.

## Pull requests

Explain the user-visible change, how you verified it, and any required API
configuration. For larger changes, open an issue first to discuss the approach.

Label pull requests with `breaking-change`, `enhancement`, `bug`, or
`documentation` where appropriate. GitHub uses these labels to group generated
release notes; unlabeled changes appear under “Other changes.”

## Releases

Update the version in `package.json` and `package-lock.json`, add the release
date and notes to `CHANGELOG.md`, then publish a GitHub Release for the matching
`vX.Y.Z` tag. The `publish.yml` workflow tests and publishes each published
GitHub Release to npm using Trusted Publishing.

For the first npm publication, publish the package interactively, then configure
the package's npm Trusted Publisher as GitHub Actions with owner `WhiPaper`,
repository `mobikorea-mcp`, and workflow file `publish.yml`. Later releases
publish from GitHub Actions without an npm token.
