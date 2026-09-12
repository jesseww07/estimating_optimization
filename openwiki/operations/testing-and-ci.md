---
type: Operations
title: Testing and Continuous Integration
description: The Vitest test suites covering the VE Estimator's parser, engine tuning/parity/category taxonomy, identify (single and batch), export, write-back, and eval logic; the GitHub Actions CI workflow that enforces typecheck/lint/the accuracy eval ratchet on every pull request; and the separate scheduled OpenWiki-update and Wiki-tab-publish workflows.
tags: [testing, ci, vitest, github-actions, wiki-publish]
sources:
  - id: openwiki-source-cbf8826979b66452c4f7cd0d
    resource: repo://__tests__/categories.test.ts
  - id: openwiki-source-c909d9a687c669163f2c96a6
    resource: repo://__tests__/eval.test.ts
  - id: openwiki-source-0d995d307c6ea1eec2175e1a
    resource: repo://__tests__/identify-batch.test.ts
  - id: openwiki-source-15627e15b9d8286da6225e49
    resource: repo://__tests__/parity.test.ts
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-6d4b4e707b8d60b6ccfa3425
    resource: repo://.github/workflows/openwiki-update.yml
  - id: openwiki-source-a7a8965ff53d3530162adf6d
    resource: repo://.github/workflows/wiki-publish.yml
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-ef78767c07114f30622ad312
    resource: repo://scripts/publish-wiki.mjs
  - id: openwiki-source-55831e92f29f8b3e9d43f58b
    resource: repo://vercel.json
  - id: openwiki-source-fbadcd8591b65031efaaedce
    resource: repo://vitest.config.ts
generated: { by: "openwiki/0.5.1", at: "2026-09-10T18:40:06.129Z" }
verified:
  - by: openwiki/0.5.1
    at: 2026-09-10T18:40:06.129Z
---

# Testing & CI

## Test suites (`__tests__/`, Vitest)

`vitest.config.ts` aliases `@` to the repo root and runs everything matching
`__tests__/**/*.test.ts` in the `node` environment. Run locally with
`npx vitest run` (or `npm test`).

| File | Covers |
|---|---|
| `parse.test.ts` | `lib/parse/workbook.ts` — CSV/XLSX column detection, healthiest-sheet selection; mirrors a real MedSpa workbook regression (empty catalog column, junk-row survival, summary rows becoming line items). |
| `tuning.test.ts` | Engine scoring/gating behavior across many hand-picked scenarios — the largest suite (1200+ lines); built from a live-use review and this is where category detection, dimension gates, and confidence-tier changes get exercised. |
| `parity.test.ts` + `parity.fixtures.ts` + `parity.context.json` | Frozen, hand-picked "must never regress" cases against `recommendForLineItem`/`analyzeLineItem`, run against a fixed context snapshot (frozen 2026-07-19) so parity stays stable as the live Airtable base moves. Cases marked `ready: false` are skipped rather than false-passing, and a placeholder-value guard fails a `ready` case that still holds an illustrative value instead of a real one. `parity.findings.json` records reviewed exceptions. |
| `categories.test.ts` | `lib/engine/categories.ts` (`CATEGORY_TAXONOMY`, `groupOfCatalogCategory`) and the category-compatibility gates in `lib/engine/matcher.ts` (`categoriesCompatible`, `thirdPartyCategoriesCompatible`) — pins that every taxonomy group is reachable from both the Premier and 3rd-party catalog vocabularies, that 3rd-party categories are matched against 3rd-party labels (not Premier's), and that a catalog category resolves to the spec's own display group. Built from a live-use review that found dead taxonomy entries and vocabulary mismatches. |
| `eval.test.ts` | Unit tests for the [eval harness](../engine/eval-harness.md) plus the **accuracy regression guard** — replays `__tests__/eval.context.json.gz` and fails if headline metrics regress against `__tests__/eval.baseline.json`. Skips with a notice if the snapshot file is missing. |
| `identify.test.ts` | `lib/identify/*` — spec identification merging (`applyIdentifiedSpec`), the engine's category-gate override, URL fetch safety (`isFetchableSpecUrl`, `htmlToText`), supported-media detection, PDF page counting, and schedule row/request coercion. No live API calls. |
| `identify-batch.test.ts` | `lib/identify/batch.ts` — the batched category-identification pure functions: `batchSkipReason` (only lines the engine can't already handle get sent), `selectBatchCandidates` (dense id assignment, ineligible-line tracking), `chunkCandidates`/`planBatchIdentify` (bounded chunk sizes and the `MAX_BATCH_CALLS` cap, with overflow reported rather than dropped), `batchSchema`/`BATCH_SYSTEM_PROMPT` (category enum kept in sync with `CATEGORY_GROUPS`), `renderBatchLines` (pathological-value clamping), `mergeBatchRows` (matches model output back to lines **by `lineId`, not array position** — the case that can silently corrupt a whole sheet), and `summarizeOutcomes`. `identifyCategoriesInBatch` itself is tested only for its zero-candidate short-circuit (zero calls) and its refusal to run without `ANTHROPIC_API_KEY`; fixtures use invented brands and part numbers only. |
| `export.test.ts` | `lib/export/corporate.ts` — corporate workbook layout/column contract. |
| `writeback.test.ts` | `lib/airtable/writeback.ts` — pure safety logic only (dedupe key, write-back eligibility, mode default, history partitioning); no live Airtable calls. |

When changing an area, run at least its own test file plus `tuning.test.ts`,
`parity.test.ts`, and `categories.test.ts` if the change touches `lib/engine/*`
— those are the regression net for scoring/gating/taxonomy behavior broader
than one named scenario.

**Fixture data policy**: this repository is public. Every test fixture above
is either a synthetic, invented record (brands, part numbers, projects) or a
frozen, already-committed snapshot (`parity.context.json`,
`eval.context.json.gz`, `eval.baseline.json`). New tests must follow the same
rule — never add a fixture built from a real customer bid workbook or a live
Airtable export; freeze a redacted/synthetic snapshot and commit that instead.

## CI workflow (`.github/workflows/ci.yml`)

Runs on every pull request and every push to `main` (concurrency-canceled per
branch — a newer push supersedes an in-flight run):

1. `npm ci` (lockfile-authoritative install).
2. `npx tsc --noEmit` — typecheck.
3. `npm run lint` — ESLint (`eslint.config.mjs`).
4. `npx vitest run` — the full suite above, **including the eval regression
   guard**. No Airtable credentials are needed in CI because the eval dataset
   is the committed, frozen snapshot (`__tests__/eval.context.json.gz`), and
   the parity/tuning/categories suites run against frozen fixtures too.

`next build` is deliberately **not** repeated here — Vercel's own integration
already builds and reports a check on every PR, so this workflow only adds
what Vercel doesn't cover. This makes the
[accuracy eval ratchet](../engine/eval-harness.md#the-ratchet) an
*enforcing* gate rather than an advisory one: an accuracy regression turns
the PR red instead of merging quietly behind a green Vercel deploy check.

## Engine change workflow

Any change to `lib/engine/**` (or to `SERIES_CATEGORY_MAP` via
`scripts/build-series-map.ts`) is expected to ship as:

1. Make the change.
2. `npm run eval` — review the printed case-flip diff.
3. `npm run eval:update` if the change is an intentional, reviewed
   trade-off — this rewrites `__tests__/eval.baseline.json`.
4. Commit code and baseline together; the baseline diff in the PR *is* the
   accuracy review.

Auto-select conservatism is a standing rule, not just a code comment: never
widen `shouldAutoSelect`
(see [the ranking gate](../engine/recommendation-engine.md#ranking-dedupe-and-the-auto-select-gate))
just to move a metric — confidence should be earned through evidence (family
history, attribute agreement), not threshold inflation.

## `openwiki-update.yml`

A separate workflow (`.github/workflows/openwiki-update.yml`) keeps this
generated wiki (the `openwiki/` directory, plus `AGENTS.md`/`CLAUDE.md`) in
sync with the codebase. It triggers on:

- **push to `main`** outside `openwiki/**` (`paths-ignore: openwiki/**`) —
  the normal trigger, firing on code changes but not on merges of the wiki's
  own update PR;
- **manual `workflow_dispatch`** — used for the very first run, when no
  `openwiki/` directory exists yet;
- **a weekly cron backstop**, `0 8 * * 1` (Monday 08:00 UTC), *not* a daily
  schedule. The workflow's own comment explains why: a run costs ~20 minutes
  of agent time, and until the resulting `openwiki/update` PR is merged,
  `.last-update.json` on `main` still points at the old head, so every run
  before that merge regenerates the same pages from scratch. A daily cron
  would scale cost with how long the PR sits unreviewed rather than with how
  much code actually changed, so the schedule is weekly instead.

Each triggered run executes `openwiki code --update --print`, which reads the
commits since the last update and rewrites only the affected pages (or
generates the whole wiki from scratch on the first run), then pushes to and
opens/updates a PR against branch `openwiki/update` rather than committing
straight to `main`. This is unrelated to the accuracy/typecheck/lint CI gate
above, and `vercel.json` deliberately disables Vercel deployments for the
`openwiki/update` branch (`git.deploymentEnabled["openwiki/update"] = false`)
— docs-only pushes to that branch are not meant to trigger a deploy, which is
intentional rather than a misconfiguration.

## `wiki-publish.yml` — publishing to the GitHub Wiki tab

A third, independent workflow (`.github/workflows/wiki-publish.yml`, "Publish
Wiki") renders the committed `openwiki/` markdown into this repository's
separate GitHub Wiki tab (`<repo>.wiki.git`), so the docs are readable at
`/wiki` instead of only by browsing the repo tree. It triggers on:

- **push to `main`** that touches `openwiki/**`, `scripts/publish-wiki.mjs`,
  or the workflow file itself;
- **manual `workflow_dispatch`**.

It is deliberately a **separate workflow** from `openwiki-update.yml` rather
than a step appended to it, for two reasons documented in the workflow's own
comments:

1. `openwiki-update.yml`'s push trigger carries `paths-ignore: openwiki/**`,
   so merging a docs-only PR never fires that workflow at all — a publish
   step living inside it would never run on exactly the merges it needs to
   react to (an `openwiki/**` push is precisely what that workflow ignores).
2. Splitting keeps publishing cheap (seconds, no model calls, no
   dependencies) and independent of whether the ~20-minute OpenWiki agent run
   in the other workflow succeeded.

The steps: check out the repo, clone the wiki repo (`<repo>.wiki.git`) into a
temp directory over HTTPS using `secrets.GITHUB_TOKEN`, run
`node scripts/publish-wiki.mjs "$RUNNER_TEMP/wiki"` to render pages into that
checkout, then `git add -A` / commit / push from inside the wiki checkout. A
run that produces no diff (e.g. a merge that only touched OpenWiki's own
state files, not rendered page content) exits cleanly without committing —
that is the normal no-op case, not a failure.

`scripts/publish-wiki.mjs` is intentionally **dependency-free** (only Node
built-ins) so the workflow can skip `npm ci` entirely and stay a few seconds
rather than a full install. It walks `openwiki/` (skipping dotfiles/dirs and
`index.md`, which are OpenWiki's own state and auto-generated directory
listings), flattens each nested path into the wiki's flat page namespace by
title-casing and hyphenating path segments — e.g. `engine/eval-harness.md` →
`Engine-Eval-Harness` — and rewrites internal `](*.md)` links to the
corresponding wiki page names, warning on any it can't resolve. Page names
are derived from the **file path**, not the front-matter title, on purpose:
OpenWiki regularly rewrites titles as the code changes, and a title-derived
page name would silently move the page (breaking bookmarks and inbound
links) every time a title changed. Existing top-level `*.md` files in the
wiki checkout are removed before rendering so a source page that gets
deleted doesn't linger as an orphan.

One-time setup note: the wiki repo has to already exist before this workflow
can push to it — GitHub only creates `<repo>.wiki.git` after at least one
page has been created through the Wiki tab's UI, which this workflow does
not do itself; that initialization happened once, out of band, before this
workflow could run successfully.

As `AGENTS.md` notes, **the Wiki tab is generated and never hand-edited**:
anything typed directly into it is overwritten on the next publish run, and
changes should go through the code or the `openwiki/` source instead, letting
OpenWiki (and then this publish workflow) regenerate the Wiki tab.
