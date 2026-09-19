# Changelog

## Unreleased

### Added

- Initial GitHub Action: skip redundant CI on mid-stack pull requests after lower-layer changes and rebases.
- Inputs: `bottom-n`, `run-top`, `github-token`, `pr-number`.
- Outputs: `should-run`, `reason`, `is-stacked`, `is-bottom`, `is-top`, `position`, `size`.
- REST fallback on `opened` / `reopened` when `github.event.pull_request.stack` is missing.
- Remaining-depth lookup via the Stacks API when `bottom-n > 1`.

### Fixed

- Fail-open on invalid `bottom-n` / `run-top` so gated jobs still run.
- Fail-open when `stack.base.ref` or the PR base ref is missing.
- Start the action with `import.meta.main` instead of a path-string CLI check.
- Pin `X-GitHub-Api-Version: 2026-03-10` and abort hung REST calls after 15s.
