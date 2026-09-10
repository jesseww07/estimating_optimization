---
type: Operations
title: Testing and Continuous Integration
description: The Vitest test suites covering the VE Estimator's parser, engine tuning/parity/category taxonomy, identify (single and batch), export, write-back, and eval logic, plus the GitHub Actions CI workflow that enforces typecheck/lint/the accuracy eval ratchet on every pull request.
tags: [testing, ci, vitest, github-actions]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-10T12:24:50.371Z
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
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-55831e92f29f8b3e9d43f58b
    resource: repo://vercel.json
  - id: openwiki-source-fbadcd8591b65031efaaedce
    resource: repo://vitest.config.ts
generated: { by: "openwiki/0.5.1", at: "2026-09-10T12:24:50.371Z" }
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

A separate scheduled workflow (`.github/workflows/openwiki-update.yml`, daily
at 08:00 UTC plus manual dispatch, or push to `main` outside `openwiki/**`)
runs `openwiki code --update --print` to keep this generated wiki (the
`openwiki/` directory, plus `AGENTS.md`/`CLAUDE.md`) in sync with the
codebase, pushing to and opening/updating a PR against branch
`openwiki/update`. It is unrelated to the accuracy/typecheck/lint CI gate
above, and `vercel.json` deliberately disables Vercel deployments for the
`openwiki/update` branch (`git.deploymentEnabled["openwiki/update"] = false`)
— docs-only pushes to that branch are not meant to trigger a deploy, which is
intentional rather than a misconfiguration.
