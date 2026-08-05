---
type: Operations
title: Testing and Continuous Integration
description: The Vitest test suites covering the VE Estimator's parser, engine, identify, export, and write-back logic, and the GitHub Actions CI workflow that enforces typecheck, lint, and the accuracy eval ratchet on every pull request.
tags: [testing, ci, vitest, github-actions]
---

# Testing & CI

## Test suites (`__tests__/`, Vitest)

`vitest.config.ts` aliases `@` to the repo root and runs everything matching
`__tests__/**/*.test.ts` in the `node` environment. Run locally with
`npx vitest run` (or `npm test`).

| File | Covers |
|---|---|
| `parse.test.ts` | `lib/parse/workbook.ts` — CSV/XLSX column detection, healthiest-sheet selection; mirrors a real MedSpa workbook regression. |
| `tuning.test.ts` | Engine scoring/gating behavior across many hand-picked scenarios — the largest suite; this is where category detection, dimension gates, and confidence-tier changes get exercised. |
| `parity.test.ts` + `parity.fixtures.ts` + `parity.context.json` | Frozen, hand-picked "must never regress" cases against `recommendForLineItem`/`analyzeLineItem`, run against a fixed context snapshot (frozen 2026-07-19) so parity stays stable as the live Airtable base moves. `parity.findings.json` records reviewed exceptions. |
| `eval.test.ts` | Unit tests for the [eval harness](../engine/eval-harness.md) plus the **accuracy regression guard** — replays `__tests__/eval.context.json.gz` and fails if headline metrics regress against `__tests__/eval.baseline.json`. Skips with a notice if the snapshot file is missing. |
| `identify.test.ts` | `lib/identify/*` — spec identification merging, URL fetch safety (`isFetchableSpecUrl`), schedule row mapping. |
| `export.test.ts` | `lib/export/corporate.ts` — corporate workbook layout/column contract. |
| `writeback.test.ts` | `lib/airtable/writeback.ts` — pure safety logic only (dedupe key, write-back eligibility, mode default); no live Airtable calls. |

When changing an area, run at least its own test file plus `tuning.test.ts`
and `parity.test.ts` if the change touches `lib/engine/*` — those two are the
regression net for scoring/gating behavior broader than one named scenario.

## CI workflow (`.github/workflows/ci.yml`)

Runs on every pull request and every push to `main` (concurrency-canceled per
branch — a newer push supersedes an in-flight run):

1. `npm ci` (lockfile-authoritative install).
2. `npx tsc --noEmit` — typecheck.
3. `npm run lint` — ESLint (`eslint.config.mjs`).
4. `npx vitest run` — the full suite above, **including the eval regression
   guard**. No Airtable credentials are needed in CI because the eval dataset
   is the committed, frozen snapshot (`__tests__/eval.context.json.gz`), and
   the parity/tuning suites run against frozen fixtures too.

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
3. `npm run eval:update` if the change is an intentional improvement — this
   rewrites `__tests__/eval.baseline.json`.
4. Commit code and baseline together; the baseline diff in the PR *is* the
   accuracy review.

Auto-select conservatism is a standing rule, not just a code comment: never
widen `shouldAutoSelect`
(see [the ranking gate](../engine/recommendation-engine.md#ranking-dedupe-and-the-auto-select-gate))
just to move a metric — confidence should be earned through evidence (family
history, attribute agreement), not threshold inflation.

## `openwiki-update.yml`

A separate scheduled workflow (`.github/workflows/openwiki-update.yml`, daily
at 08:00 UTC plus manual dispatch) runs `openwiki code --update --print` to
keep this generated wiki (the `openwiki/` directory) in sync with the
codebase, opening/updating a PR against branch `openwiki/update`. It is
unrelated to the accuracy/typecheck/lint CI gate above.
