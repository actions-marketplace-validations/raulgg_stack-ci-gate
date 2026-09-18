# Stack CI Optimizer

A GitHub Action that decides **when** expensive CI should run on [GitHub native stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs). Add a first `optimize-ci` job, read its `should-run` output, and gate downstream jobs with `needs.optimize-ci.outputs.should-run == 'true'`.

The action reads `github.event.pull_request.stack` and, when that is missing (it always is on `opened`), the Pulls REST API.

Defaults run full CI on the **lowest unmerged** PR (the one that currently targets the stack base, usually `main`) and the **top** of the stack (the full changeset). Middle layers skip the expensive jobs.

## Usage

Pin a version tag or SHA, not `@main`.

```yaml
name: CI

on:
  pull_request:
    types: [opened, synchronize, reopened, stacked]
  merge_group:

permissions:
  contents: read
  pull-requests: read

jobs:
  optimize-ci:
    runs-on: ubuntu-latest
    outputs:
      should-run: ${{ steps.gate.outputs.should-run }}
    steps:
      - name: Optimize CI
        id: gate
        uses: raulgg/stack-ci-action@v1
        with:
          bottom-n: 1
          run-top: true

  test:
    needs: optimize-ci
    if: needs.optimize-ci.outputs.should-run == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
```

Add `needs: optimize-ci` and the `if:` to **every expensive job**. Cheap jobs (lint, labeler) omit both so they still run on middle layers.

`stacked` is the webhook GitHub fires when a PR joins a stack. Actions documentation does not list it yet; if a runner ignores the unknown type, the action still fetches stack membership on `opened`. Keep it in `types` so `should-run` is re-evaluated if the event is delivered.

## Inputs

| Name | Default | Purpose |
|---|---|---|
| `bottom-n` | `1` | How many PRs at the bottom of the **remaining** stack run CI. |
| `run-top` | `true` | Also run CI on the top PR of the stack. |
| `github-token` | `${{ github.token }}` | Reads pull request and stack metadata. Needs `pull-requests: read`. |
| `pr-number` | event PR | Override PR number. Always loads stack from the API; ignores the triggering event’s `stack`. |

## Outputs

All strings. Compare with `== 'true'` / `== 'false'`.

| Name | Meaning |
|---|---|
| `should-run` | `'true'` means expensive jobs should run. |
| `reason` | Why, also printed in the optimize job log. |
| `is-stacked` | A stack object was resolved. |
| `is-lowest` | This PR currently targets the stack base (`stack.base.ref == pull_request.base.ref`). |
| `is-top` | `stack.position == stack.size`. |
| `position` | Stack position, or empty. |
| `size` | Stack size, or empty. |

## How `should-run` is decided

`should-run = true` means expensive jobs should run.

| Condition | `should-run` |
|---|---|
| Not a `pull_request` / `pull_request_target` event (`workflow_dispatch`, `merge_group`, `push`) | `true` |
| Error / API failure / unreadable stack | `true` (fail open) |
| Invalid `bottom-n` or `run-top` | the optimize step **fails** (config error) |
| No stack after the event payload and API fallback | `true` (standalone PR) |
| Lowest unmerged, and remaining depth ≤ `bottom-n` | `true` |
| Remaining depth ≤ `bottom-n` | `true` |
| `run-top` and this PR is top | `true` |
| Else (middle / upstack beyond N) | `false` |

Lowest unmerged is **not** `position == 1`. GitHub documents `position == 1` as the original bottom of the stack object, which can disagree with the remaining bottom after a partial merge. This action uses `stack.base.ref == pull_request.base.ref`. For `bottom-n > 1` it lists the stack via `GET /repos/{owner}/{repo}/stacks/{number}` and counts **open** PRs from the bottom.

A 1-PR stack is both lowest and top; `should-run` is true.

## `opened` vs `stacked`

GitHub creates a pull request, then adds it to a stack. `pull_request.opened` never includes `stack`. Default `on: pull_request` only runs for `opened`, `synchronize`, and `reopened`.

If the action treated a missing stack as “standalone, run everything,” `gh stack submit` would start full CI on every layer.

When the event has no `stack`, the action calls `GET /repos/{owner}/{repo}/pulls/{number}`. On `opened` and `reopened` it retries for a few seconds so a just-created stack is visible. If the PR is still not in a stack, it runs CI (standalone).

## You might not need this action

GitHub already documents a job-level `if:` for “lowest unmerged or top”:

```yaml
if: >
  github.event.pull_request.stack == null ||
  github.event.pull_request.stack.base.ref == github.event.pull_request.base.ref ||
  github.event.pull_request.stack.position == github.event.pull_request.stack.size
```

Use that when you have one workflow, only care about the ends of the stack, and can live with a full CI run on `opened` (no `stack` on the event). Use this action when you want a shared `should-run` output, `bottom-n`, or a correct decision on `gh stack submit`.

## Required checks

A job skipped by `if:` reports **Success**. GitHub will merge a PR whose required check was skipped this way.

That is why an `optimize-ci` job that always runs, plus `if:` on expensive jobs, works: the workflow still starts, the job names are reported, and middle layers stay mergeable.

The cost is that those tests never ran on the middle layers. You are trusting **lowest unmerged** (about to land on trunk) and **top** (full changeset). If every layer must be tested independently, do not skip.

A **workflow** that never starts (path filters, `[skip ci]`, workflow-level `if:`) leaves required checks **Pending** and blocks merge. Do not skip the whole workflow.

## Fail open

Network errors, unreadable payloads, and unknown events run CI. The action never cancels the workflow run. It never skips `merge_group` (merge queue).

## Development

```bash
npm test
```

Zero runtime dependencies. The action is plain Node 24 ESM (`src/gate.mjs`).

---

Inspired by [Graphite CI](https://github.com/withgraphite/graphite-ci-action).
