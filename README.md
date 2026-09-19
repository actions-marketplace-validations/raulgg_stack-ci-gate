# Stack CI Gate

[Stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs) are a chain of smaller, independently reviewable layers. GitHub Actions still runs as if each pull request targets the **stack base**, so a workflow for `main` runs for every pull request in the stack, not just the bottom one. A large stack multiplies CI usage. Checks run again when you rebase, including after you change a [lower layer](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/managing-stacked-pull-requests#making-changes-to-a-lower-layer) and rebase the branches above it (`gh stack rebase --upstack`).

This action uses [stack metadata](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/optimizing-ci-for-stacked-pull-requests) so those extra runs happen only where they are needed. You choose how many pull requests at the bottom of the remaining stack always run CI, and whether the **top** pull request (the full set of changes) runs as well. Mid-stack pull requests skip the jobs you gate: jobs that do not need to run on every layer after a lower-layer change or a cascading rebase.

Add a `gate` job, read `should-run`, and only run those jobs when `needs.gate.outputs.should-run == 'true'`. The action reads `github.event.pull_request.stack`, and the Pulls REST API when that field is missing (`opened` never includes `stack`).

## Usage

Pin a version tag or SHA, not `@main`.

```yaml
name: CI

on:
  pull_request:
    types: [opened, synchronize, reopened, edited, stacked]
  merge_group:

permissions:
  contents: read
  pull-requests: read

jobs:
  gate:
    runs-on: ubuntu-latest
    outputs:
      should-run: ${{ steps.gate.outputs.should-run }}
    steps:
      - name: Gate stacked CI
        id: gate
        uses: raulgg/stack-ci-gate@v1
        with:
          bottom-n: 1
          run-top: true

  test:
    needs: gate
    if: needs.gate.outputs.should-run == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
```

Add `needs: gate` and the `if:` to each job that should not run on every pull request in the stack. Jobs that should still run on every layer (lint, labeler) omit both.

`stacked` is the webhook GitHub fires when a PR joins a stack. Actions documentation does not list it yet; if a runner ignores the unknown type, the action still fetches stack membership on `opened`. Keep it in `types` so `should-run` is re-evaluated if the event is delivered.

## Inputs

| Name | Default | Purpose |
|---|---|---|
| `bottom-n` | `1` | How many PRs at the bottom of the **remaining** stack run CI. |
| `run-top` | `true` | Also run CI on the top PR of the stack. |
| `github-token` | `${{ github.token }}` | Reads pull request and stack metadata. Needs `pull-requests: read`. |
| `pr-number` | event PR | Override PR number on `pull_request` / `pull_request_target`. Loads stack from the API; ignores the triggering event’s `stack`. Ignored on other events. |

## Outputs

All strings. Compare with `== 'true'` / `== 'false'`.

| Name | Meaning |
|---|---|
| `should-run` | `'true'` means the jobs you gated should run. |
| `reason` | Why, also printed in the gate job log. |
| `is-stacked` | A stack object was resolved. |
| `is-bottom` | This PR currently targets the stack base (`stack.base.ref == pull_request.base.ref`). |
| `is-top` | `stack.position == stack.size`. |
| `position` | Stack position, or empty. |
| `size` | Stack size, or empty. |

## How `should-run` is decided

`should-run = true` means the jobs you gated should run.

| Condition | `should-run` |
|---|---|
| Not a `pull_request` / `pull_request_target` event (`workflow_dispatch`, `merge_group`, `push`) | `true` |
| Error / API failure / unreadable stack | `true` (fail open) |
| Invalid `bottom-n` or `run-top` | `true` (fail open; logs an error) |
| No stack after the event payload and API fallback | `true` (standalone PR) |
| Lowest unmerged, and remaining depth ≤ `bottom-n` | `true` |
| Remaining depth ≤ `bottom-n` | `true` |
| `run-top` and this PR is top | `true` |
| Else (mid-stack, above `bottom-n`) | `false` |

Lowest unmerged is **not** `position == 1`. GitHub documents `position == 1` as the original bottom of the stack object, which can disagree with the remaining bottom after a partial merge. This action uses `stack.base.ref == pull_request.base.ref`. For `bottom-n > 1` it lists the stack via `GET /repos/{owner}/{repo}/stacks/{number}` and counts **open** PRs from the bottom.

A 1-PR stack is both lowest and top; `should-run` is true.

## `opened` vs `stacked`

GitHub creates a pull request, then adds it to a stack. `pull_request.opened` never includes `stack`. Default `on: pull_request` only runs for `opened`, `synchronize`, and `reopened`.

If the action treated a missing stack as a standalone PR, `gh stack submit` would run the gated jobs on every layer.

When the event has no `stack`, the action calls `GET /repos/{owner}/{repo}/pulls/{number}`. On `opened` and `reopened` it retries for a few seconds so a just-created stack is visible. If the PR is still not in a stack, it runs CI (standalone).

## You might not need this action

GitHub already documents a job-level `if:` for “lowest unmerged or top”:

```yaml
if: >
  github.event.pull_request.stack == null ||
  github.event.pull_request.stack.base.ref == github.event.pull_request.base.ref ||
  github.event.pull_request.stack.position == github.event.pull_request.stack.size
```

Use that when you have one workflow, only care about the ends of the stack, and can live with those jobs running on `opened` (no `stack` on the event). Use this action when you want a shared `should-run` output, `bottom-n`, or a correct decision on `gh stack submit`.

## Required checks

A job skipped by `if:` reports **Success**. GitHub will merge a PR whose required check was skipped this way.

That is why a `gate` job that always runs, plus `if:` on the jobs you gate, works: the workflow still starts, the job names are reported, and mid-stack pull requests stay mergeable.

Those jobs did not run on the mid-stack pull requests. You are trusting CI on the **lowest unmerged** pull request (it targets the stack base) and the **top** (the full set of changes). If every layer must be tested independently, do not skip those jobs.

A **workflow** that never starts (path filters, `[skip ci]`, workflow-level `if:`) leaves required checks **Pending** and blocks merge. Do not skip the whole workflow.

## Fail open

Network errors, unreadable payloads, invalid knobs, and unknown events run CI. The action never cancels the workflow run. It never skips `merge_group` (merge queue).

## Development

```bash
npm test
```

Zero runtime dependencies. The action is plain Node 24 ESM (`src/gate.mjs`).

---

Inspired by [Graphite CI](https://github.com/withgraphite/graphite-ci-action).
