# Stack CI Optimizer — Implementation Plan

Ship a GitHub Action that decides *when* expensive CI should run on GitHub native stacked PRs. Consumer shape: a first `optimize-ci` job, a `should-run` output, and downstream jobs gated on `needs.optimize-ci.outputs.should-run == 'true'`.

This document supersedes the draft at `~/Downloads/stack-ci-action-implementation-plan.md`. Changes from that draft are listed in [§16](#16-changes-from-the-draft).

References:

- Native stack CI: https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/optimizing-ci-for-stacked-pull-requests
- Stack REST/webhooks: https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-rest-and-graphql-apis
- Marketplace publish: https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace
- Required checks vs skipped jobs: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/troubleshooting-required-status-checks

---

## 1. Goal

- Decide whether expensive jobs should run from GitHub native stack metadata. No third-party account.
- Two knobs: **bottom N** remaining layers always run; optional **top of stack** also runs.
- Workflow contract: job `optimize-ci` → output `should-run` → other jobs `needs` + `if: should-run == 'true'`.
- Fail open (always run on errors / unknown state).
- Handle the `opened` race: a PR is created *before* it joins a stack, so `github.event.pull_request.stack` is missing on `opened`. v1 fetches stack from the REST API instead of fail-opening into a full CI burst on `gh stack submit`.
- Publish to Marketplace.

## 2. Non-goals (v1)

- Do not require a third-party token.
- Do not cancel the workflow run. Cancelling makes required checks look failed. Use `should-run` + job `if:` only.
- Do not skip the calling `optimize-ci` job itself.
- Do not invent stack membership. After API fallback, still-missing `stack` → do not skip (standalone PR).
- Do not auto-label PRs or mutate the stack.
- Do not implement **wait for downstack CI** in v1. A skip-because-parent-is-pending with no retrigger leaves the PR skipped until the next push. Defer to v2 with an explicit retrigger story (`workflow_run` / `check_suite` / `repository_dispatch`).
- Do not ship a `mode` shorthand. One API: `bottom-n` + `run-top`.
- This action is for GitHub native stacks (`gh stack` / GitHub UI).

## 3. Why an action exists

GitHub already documents a zero-dependency job-level `if:` for “lowest unmerged or top”:

```yaml
if: >
  github.event.pull_request.stack == null ||
  github.event.pull_request.stack.base.ref == github.event.pull_request.base.ref ||
  github.event.pull_request.stack.position == github.event.pull_request.stack.size
```

That expression is the right answer for a single workflow that only needs ends-of-stack **and** can tolerate a full CI run on `opened` (no stack on the event).

The action is worth publishing because:

1. **Shared gate job.** Many workflows can share `optimize-ci` / `should-run` / `if: should-run == 'true'`.
2. **`opened` race.** `gh stack submit` creates PRs first, then stacks them. `opened` never includes `stack`. Without an API fallback, fail-open runs full CI on every layer at the most expensive moment.
3. **Shared knobs.** `bottom-n` and `run-top` live in one place across many workflows.
4. **Diagnostics.** `reason`, `position`, `size` in the optimize job log.

README must show the expression as the “you might not need this action” path.

## 4. Product rules

### 4.1 Position model

GitHub documents two different notions of “bottom”:

| Notion | How to detect | Meaning |
|---|---|---|
| **Lowest unmerged** | `stack.base.ref == pull_request.base.ref` | The remaining stack’s current bottom, the PR that will land on trunk next. After a partial merge, GitHub retargets the next PR at the stack base. **Always use this, never `position == 1` alone.** |
| **Original bottom** | `stack.position == 1` | GitHub’s own docs treat this as distinct from lowest unmerged. Do not assume `position` is rewritten to remaining-stack index after merges. |
| **Top** | `stack.position == stack.size` | Last PR in the stack object, full changeset. |

`bottom-n` means “the N lowest **unmerged** PRs in the remaining stack.”

- `bottom-n = 1` (default): run iff lowest unmerged (base-ref test) **or** (`run-top` and this PR is top).
- `bottom-n > 1`: remaining depth is the 1-based index of this PR among **unmerged** PRs in the stack, counting from the current lowest. Compute that from `GET /repos/{owner}/{repo}/stacks/{stack_number}` (`pull_requests[]` with `state`), not from raw `position`. If that call fails → fail open.

A 1-PR stack is both lowest and top. `should-run` is true.

### 4.2 `should-run` decision

`should-run = true` means expensive jobs should run.

| Condition | `should-run` |
|---|---|
| Not a `pull_request` / `pull_request_target` event (`workflow_dispatch`, `merge_group`, `push`) | `true` |
| Error / invalid *runtime* state / API failure | `true` (fail open) |
| Invalid *config* (`bottom-n` not a non-negative integer, `run-top` not a boolean) | step fails (exit 1) |
| After event + API fallback, `stack` is still null | `true` (standalone) |
| Lowest unmerged | `true` |
| Remaining depth `<= bottom-n` | `true` |
| `run-top` and this PR is top | `true` |
| Else (middle / upstack beyond N) | `false` |

Never skip when GitHub is merging via merge queue (`merge_group`).

### 4.3 The `opened` / `stacked` race (v1, not a footnote)

GitHub creates a PR, then adds it to a stack. Consequences:

- `pull_request.opened` **never** includes `stack`.
- A dedicated `pull_request` action `stacked` fires when the PR joins a stack (webhook is live; Actions trigger docs do not yet list `stacked` — treat support as something to verify, not assume).
- Default `on: pull_request` only runs for `opened`, `synchronize`, `reopened`. It does **not** include `stacked`.

v1 behavior when the event has no `stack`:

1. `GET /repos/{owner}/{repo}/pulls/{number}` (the PR resource includes `stack`).
2. If still null and the event is `opened` or `reopened`, retry a few times with short backoff (budget ~5–8s). `gh stack submit` stacks immediately after create; a short wait catches the race without stalling standalone PRs for long.
3. If still null → standalone → `should-run=true`.

Also document:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, stacked]
  merge_group:
```

If Actions ignores unknown `stacked`, the API fallback still covers submit. If it works, `stacked` re-evaluates skip once membership is known (too late to cancel an `opened` run that already started — which is why the API fallback on `opened` matters).

### 4.4 Required checks (the draft had this backwards)

A **job skipped by `if:` reports Success**. GitHub will merge a PR whose required check was skipped this way.

- Workflow-level skip (path filter, `[skip ci]`, workflow `if:` false) → checks stay **Pending** and **block** merge.
- Job-level `if: should-run == 'true'` → skipped jobs are **Success** and **do not block** merge.

That is why an always-running `optimize-ci` job plus job-level `if` on expensive jobs is correct: the workflow runs, required job names are reported, middle layers are mergeable.

The real warning is the opposite of “middle PRs cannot merge”:

> Skipping expensive jobs on middle PRs means those tests never ran on those layers, and GitHub still treats the skipped required check as passing. That is the point: you trust **lowest unmerged** (about to land on trunk) and **top** (full changeset). If every layer must be tested independently, do not skip.

A “missing required CI” caveat applies when the workflow never starts. Native stacks trigger `pull_request` workflows as if each PR targets the stack base, so the workflow *does* start.

Do not ship an always-green companion job in v1. It is unnecessary for job-level skip, and it would hide real failures if wired wrong.

## 5. Public API

### Inputs

| Name | Required | Default | Purpose |
|---|---|---|---|
| `bottom-n` | no | `1` | How many PRs at the bottom of the **remaining** stack run CI. |
| `run-top` | no | `true` | Also run CI on the top PR. |
| `github-token` | no | `${{ github.token }}` | Used for the `opened` API fallback and for `bottom-n > 1` stack listing. `pull-requests: read` is enough. |
| `pr-number` | no | event PR | Override PR number. When set, **always** load stack from the API; do not trust the triggering event’s `stack`. |

No `mode`. No `wait_for_downstack` in v1. No `downstack_check_names`.

### Outputs

All strings. Compare with `== 'true'` / `== 'false'`.

| Name | Meaning |
|---|---|
| `should-run` | Downstream: `if: needs.optimize-ci.outputs.should-run == 'true'` |
| `reason` | Human reason, logged and output. |
| `is-stacked` | `'true'` if a stack object was resolved |
| `is-bottom` | remaining bottom (base-ref test) |
| `is-top` | `position == size` |
| `position` | stack position or `''` |
| `size` | stack size or `''` |

Dropped from the draft: `skip` (replaced by affirmative `should-run`), `run-full`, `is-middle` (derivable), `stack-base`, `pr-base`.

### Example consumer

```yaml
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
        uses: OWNER/stack-ci-action@v1
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

Add `needs: optimize-ci` and the `if:` to **every** expensive job.

Cheap jobs (lint) omit `needs`/`if` so they still run on middle layers.

## 6. Implementation

**JavaScript action, no build step.** `runs.using: node24` with `main: src/gate.mjs` committed as plain ESM. No `dist/`, no TypeScript compile, no Dependabot for a bundler.

Why not the draft’s composite + bash:

- The v1 differentiator is REST (opened race, `pr-number`, `bottom-n > 1`). Passing `toJson(stack)` through env into bash is brittle; Octokit/`fetch` is not.
- Node is on GitHub-hosted Windows/macOS/Linux. Composite `shell: bash` is not a given on self-hosted Windows.
- Unit tests are ordinary node tests, not an env-var harness around a shell script.

`@actions/core` is the only required library. Use `fetch` against the REST API (available on node24) so we do not need Octokit if we want a tiny dependency surface. Pin `@actions/core` in `package.json` and vendor or rely on `node_modules` committed — **decision: depend on `@actions/core` via `package.json` and commit `node_modules` only if we must; preferred is to use the Actions toolkit as a package and document `npm ci` in the release workflow, committing `package-lock.json`. JS actions run with `node_modules` present; GitHub does not run `npm install` for the action. So either commit `node_modules` or vendor a single file, or zero-dep by writing `$GITHUB_OUTPUT` ourselves.**

**Zero-dependency `gate.mjs`:** write outputs to `process.env.GITHUB_OUTPUT`, read inputs from `process.env.INPUT_*` (Actions sets these automatically). No `@actions/core`, no install at runtime, no committed `node_modules`. Tests import the decision function from the same file.

Structure:

```
src/gate.mjs          # CLI entry: read env, write outputs
src/decide.mjs        # pure decision table, unit-tested
src/github.mjs        # REST: get PR, get stack, retry
tests/decide.test.mjs
tests/fixtures/*.json
```

Fail-open rules:

- Any exception → `should-run=true`, log warning, do not fail the step.
- Invalid `bottom-n` / `run-top` → fail the step (config error).
- `workflow_dispatch` / `merge_group` / `push` → `should-run=true`.
- Missing stack after fallback → `should-run=true`.
- Never `gh run cancel` / Actions cancel API.

Permissions in README: `pull-requests: read` (and `contents: read` if the workflow already checks out). Default `GITHUB_TOKEN` is enough.

## 7. `action.yml` (contract)

```yaml
name: Stack CI Optimizer
description: Run expensive CI only on the lowest unmerged and top PRs of a GitHub native stack.
author: YOUR_NAME
branding:
  icon: layers
  color: purple

inputs:
  bottom-n:
    description: How many PRs at the bottom of the remaining stack should run CI
    required: false
    default: '1'
  run-top:
    description: Also run CI on the top PR of the stack
    required: false
    default: 'true'
  github-token:
    description: Token used to read pull request stack metadata
    required: false
    default: ${{ github.token }}
  pr-number:
    description: Override pull request number
    required: false
    default: ''

outputs:
  should-run:
    description: True means expensive jobs should run
  reason:
    description: Why should-run is true or false
  is-stacked:
    description: Whether this PR is in a stack
  is-bottom:
    description: Whether this is the remaining bottom PR of the stack
  is-top:
    description: Whether this is the top PR
  position:
    description: Stack position, or empty
  size:
    description: Stack size, or empty

runs:
  using: node24
  main: src/gate.mjs
```

Marketplace `name` must be unique. Search immediately before first publish. Fallbacks: `Native Stack CI Optimizer`, `Stacked PR CI Optimizer`. Do not use `GitHub` in the name (reserved). Repo name can stay `stack-ci-action`; Marketplace listing slug follows `name`, not the repo.

## 8. Tests

Pure tests of `decide.mjs` plus mocked-fetch tests of the API fallback. Do not duplicate the decision table in the runner.

Fixtures:

1. standalone — no stack → `should-run=true`
2. lowest of 3, `bottom-n=1` — `should-run=true`, `is-bottom=true`
3. middle of 3, defaults — `should-run=false`
4. top of 3, `run-top=true` — `should-run=true`, `is-top=true`
5. top of 3, `run-top=false` — `should-run=false`
6. `bottom-n=2` on remaining depth 2 of 4 — `should-run=true`
7. after partial merge — former middle now lowest via base-ref → `should-run=true` even if `position != 1`
8. single-layer stack — lowest and top, `should-run=true`
9. `event_name=merge_group` — `should-run=true`
10. `event_name=workflow_dispatch` — `should-run=true`
11. invalid `bottom-n` — exit 1
12. `opened` with no event stack, API returns stack middle → `should-run=false`
13. `opened` with no event stack, API empty then stack appears on retry → use stacked result
14. `opened` with no event stack, API still empty after retries → `should-run=true`
15. API failure → `should-run=true` (fail open)
16. `pr-number` override ignores triggering event stack and fetches the override PR

CI workflow:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, stacked]
  push:
    branches: [main]
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node --test tests/*.test.mjs
  self:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./
        id: gate
      - run: |
          echo "should-run=${{ steps.gate.outputs.should-run }} reason=${{ steps.gate.outputs.reason }}"
          test -n "${{ steps.gate.outputs.should-run }}"
```

Manual test on a 3-PR native stack before Marketplace: middle skips, top+bottom run; merge bottom, former middle becomes lowest and runs.

## 9. Docs (README must include)

1. Usage: `optimize-ci` + `should-run` + `needs`/`if` on each expensive job.
2. Knobs: `bottom-n`, `run-top`.
3. When **not** to use it (single workflow, ends-of-stack only → job-level `if:` expression).
4. Required-checks behavior: skipped jobs report Success; this is intentional; do not skip if you need every layer tested.
5. Fail-open and never-skip-merge-queue.
6. `opened` vs `stacked` / `synchronize`; include `stacked` in `types`; action still API-fetches on `opened`.
7. Permissions: `pull-requests: read`.
8. Pin `@v1` or a SHA, never `@main`.
9. Marketplace badge after publish.

## 10. Versioning and release

- Tags: `v1.0.0`, moving major tag `v1`.
- Release workflow: on `v*` tag, create GitHub Release with CHANGELOG notes.
- No build artifacts.
- Semver: output/input changes = minor or major. Logic bugfix = patch.
- Adding `wait_for_downstack` later is a minor if default remains off.

## 11. Publish setup

Unchanged in substance from the draft (public repo, one root `action.yml`, unique `name`, branding, 2FA, Marketplace Developer Agreement). Replace `OWNER/stack-ci-gate` with `OWNER/stack-ci-action` unless the publisher prefers a different repo name.

Consumers:

```yaml
- uses: OWNER/stack-ci-action@v1
  id: gate
```

Primary Marketplace category: **Continuous integration**.

Short description: “Run full CI only on the lowest unmerged and top PRs in a GitHub native stack.”

## 12. Rollout in a consuming repo

1. Add `stacked` to `pull_request` types and `merge_group` if the repo uses a merge queue.
2. Add `optimize-ci` + `if:` on expensive jobs in one workflow. Confirm middle PRs skip and top/bottom still run, including on a fresh `gh stack submit` (the `opened` path).
3. Confirm a 2-layer stack: merge bottom, watch the former middle become lowest and run full CI on the next `synchronize`.
4. Audit rulesets: required checks will pass on skipped middle jobs. That is expected.

## 13. Risks

| Risk | Mitigation |
|---|---|
| `opened` has no `stack` → full CI on every submit | v1 REST fallback + short retry |
| Actions may not trigger on `stacked` (docs omit it) | Do not rely on it; API fallback is the real fix |
| `position` is not remaining-stack depth after merges | Lowest via base-ref; `bottom-n > 1` via Stacks API |
| Preview API changes (`stack` fields) | Pin field names; fixtures |
| Skipped required jobs count as passing | Document as the intended model |
| Users expect cancelled workflows | Do not cancel; use `should-run` |
| Marketplace name collision | Search immediately before first publish |
| Self-hosted without Node 24 | Document node24; GitHub-hosted is the supported runner |

## 14. v2 (explicitly out of v1)

- `wait_for_downstack` plus a retrigger when parent checks complete.
- Bypass label (`ci-run-full`) to force a full run.
- Fetch-on-demand of stack membership for `workflow_dispatch` with `pr-number`.
- Extra diagnostic outputs (`stack-base`, `pr-base`, remaining depth).

## 15. Definition of done

- Consumer shape: `optimize-ci.outputs.should-run` + job `if`.
- Defaults (`bottom-n=1`, `run-top=true`) run remaining base + top only.
- `opened` without event `stack` does not fail-open into full CI when the PR is already stacked by the time the API is queried.
- Fail open; never skip `merge_group` / `workflow_dispatch`.
- Fixtures pass; self-test job passes.
- README covers required-check Success-on-skip, `opened` race, expression alternative.
- Public repo, agreement accepted, Marketplace listing live.
- `uses: OWNER/stack-ci-action@v1` works from a second repo.

## 16. Changes from the draft

1. **`opened` race is v1, not a later optional.** The draft fail-opened on missing stack, which runs full CI on every `gh stack submit`.
2. **Required-checks warning reversed.** Job-level skip reports Success and does *not* block merge. The draft’s “middle PRs cannot merge” is wrong for this pattern.
3. **Do not treat `position` as remaining-stack index.** GitHub documents `position == 1` as original bottom, distinct from lowest unmerged (base-ref). `bottom-n > 1` uses the Stacks API.
4. **Drop `wait_for_downstack` from v1.** No retrigger = skip forever until the next push.
5. **Drop `mode`.** Do not ship a deprecated-on-arrival API.
6. **Drop extra outputs** (`run-full`, `is-middle`, `stack-base`, `pr-base`). Gate with `should-run`, not `skip`.
7. **JS (`gate.mjs`) instead of composite bash.** v1 needs REST; JSON-in-env bash is the wrong tool.
8. **Repo / Marketplace name:** `stack-ci-action` / `Stack CI Optimizer` (was `stack-ci-gate`). Confirm uniqueness at publish time.
9. **Honest “you might not need this” path:** GitHub’s documented job-level `if:` for the 80% case.
10. **Document `types: [..., stacked]`** and that Actions docs do not yet list it.

## 17. Suggested first tickets

1. Repo skeleton: `action.yml`, `src/{gate,decide,github}.mjs`, MIT LICENSE, README.
2. Fixture harness for the decision table + mocked `opened` retry.
3. README with `optimize-ci` / `should-run` example, expression alternative, required-check Success-on-skip, `opened` race.
4. Manual test on a 3-PR native stack, including fresh submit (not only `synchronize`).
5. Account 2FA + Marketplace Developer Agreement.
6. Public repo, tag `v1.0.0` + `v1`, publish Marketplace listing.

Inspired by [Graphite CI](https://github.com/withgraphite/graphite-ci-action).
