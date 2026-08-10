---
type: Overview
title: VE Estimator Quickstart
description: Entry point for the Premier Lighting VE (value engineering) estimating substitution finder — what it does, how the pieces fit together, and where to go next in the wiki.
tags: [quickstart, ve-estimator, premier-lighting, next.js, airtable]
---

# VE Estimator — Quickstart

This repository (`ve-estimator`, see `package.json`) is Premier Lighting's
internal **VE / estimating substitution finder**: a Next.js app that helps an
estimator turn a bid sheet or fixture-schedule PDF into a corporate export
draft with Premier catalog substitutions already suggested.

## What the app does, end to end

1. An estimator **uploads** a bid sheet (CSV/XLSX) or a fixture-schedule PDF.
2. The app **parses** it into line items (mark, quantity, manufacturer, catalog
   number).
3. The **recommendation engine** scores each line item against Premier's
   Airtable catalogs (own-brand items, third-party items, fans) and against
   **History** — a table of past estimator decisions — and returns up to three
   ranked substitution candidates per line.
4. If a line can't be identified from the sheet alone, the estimator can
   trigger **per-line identification** (Claude reads a pasted spec URL, does a
   web search, or reads an uploaded cut-sheet PDF) and the engine re-runs on
   the identified spec.
5. The estimator reviews/overrides the pre-checked selections and **exports**
   a corporate-template workbook.
6. Export **writes accepted substitutions back to History** — the learning
   loop that makes future analyses better.

This flow, its API surface, and its Next.js structure are documented in
[Architecture Overview](architecture/overview.md).

## Where the "smarts" live

The substitution logic — scoring, category detection, the History learning
tiers, ranking, and the auto-select gate — is the most complex and most
frequently-changed part of the codebase. It is documented in
[Recommendation Engine](engine/recommendation-engine.md).

Because engine changes are risky to get wrong silently, every change is
expected to be measured against a frozen, labeled dataset before it ships.
That measurement discipline — the accuracy eval harness, its metrics, and the
CI ratchet that enforces it — is documented in
[Accuracy Eval Harness](engine/eval-harness.md).

## Where the data comes from

All catalog and history data is Airtable-backed (base `appWj912AEOvtxqJF`).
Field IDs, the read/cache path, and the create-only History write-back that
implements the learning loop are documented in
[Airtable Integration](data/airtable-integration.md).

## How changes are verified

Test suites, the CI workflow, and local dev/check commands are documented in
[Testing & CI](operations/testing-and-ci.md).

## Existing hand-written docs (primary sources, not duplicated here)

The team already maintains detailed prose docs in `docs/`; this wiki
summarizes and links to them rather than repeating them:

- `docs/PHASE3-PRIMER.md` — architecture map, engine pipeline order, learning-loop
  contract, and conventions as of the Phase 3 handoff.
- `docs/PHASE4-PRIMER.md` — the current phase's mission (closing the spec
  *identification* gap), the Largo Station case study that motivated it, and
  the prioritized backlog.
- `docs/EVAL-HARNESS.md` — full detail on how the accuracy eval harness works
  and how to read its output.

These primers double as running engineering journals (they record specific
dates, PR numbers, and named test projects); treat them as historical
narrative and cross-check current behavior against the source code pages
linked above.

## Business context worth knowing up front

- Single production deployment (Vercel), single business (Premier Lighting),
  single Airtable base. This is an internal tool, not a multi-tenant product.
- The exported workbook is a **takeoff draft, not a quote** — pricing columns
  are intentionally left blank; see
  [Architecture Overview](architecture/overview.md#export).
- The engine is deliberately conservative about auto-selecting recommendations
  because an accepted default gets written back to History and can pollute
  future scoring — see the auto-select gate in
  [Recommendation Engine](engine/recommendation-engine.md).

## Task routing

Start here for common change categories. "Focused tests" is the narrowest
regression net; "Validation" is the quietest command that still surfaces
failures. All commands run from the repo root.

| Change area / intent | Wiki page | Source entry points | Key symbols/types | Focused tests | Minimal validation |
|---|---|---|---|---|---|
| Upload parsing (CSV/XLSX/PDF schedule) | [Architecture Overview](architecture/overview.md#upload--post-apiupload) | `app/api/upload/route.ts`, `lib/parse/workbook.ts`, `lib/identify/schedule.ts` | `parseWorkbook`, `extractScheduleFromPdf`, `scheduleRowsToLineItems`, `ParsedLineItem` | `__tests__/parse.test.ts`; `__tests__/identify.test.ts` ("schedule PDF row mapping") | `npx vitest run __tests__/parse.test.ts` |
| Recommendation scoring/matching/ranking | [Recommendation Engine](engine/recommendation-engine.md) | `lib/engine/matcher.ts`, `lib/engine/recommend.ts`, `lib/engine/ranking.ts` | `analyzeLineItem`, `calculateCatalogMatchScore`, `isFamilySpecMatch`, `isIdentifiableSpecKey`, `shouldAutoSelect` | `__tests__/tuning.test.ts`, `__tests__/parity.test.ts` | `npx vitest run __tests__/tuning.test.ts __tests__/parity.test.ts`, then (conditional — any scoring/threshold change) `npm run eval` |
| Learned series → category map | [Recommendation Engine](engine/recommendation-engine.md#learned-series-categories) | `scripts/build-series-map.ts`, `lib/engine/series-categories.ts` (generated) | `SERIES_CATEGORY_MAP`, `MIN_SUPPORT`, `MIN_AGREEMENT` | `__tests__/tuning.test.ts` ("Largo Station: learned series → category") | `npx tsx scripts/build-series-map.ts` (regenerate, review the diff), then `npm run eval` |
| Per-line identify (URL / web / PDF) | [Architecture Overview](architecture/overview.md#per-line-identify--post-apiidentify) | `app/api/identify/route.ts`, `lib/identify/claude.ts`, `lib/identify/fetchUrl.ts`, `lib/identify/apply.ts` | `applyIdentifiedSpec`, `isFetchableSpecUrl`, `isIdentifyAvailable` | `__tests__/identify.test.ts` | `npx vitest run __tests__/identify.test.ts` |
| Export / corporate workbook | [Architecture Overview](architecture/overview.md#export) | `app/api/export/route.ts`, `lib/export/corporate.ts` | `buildCorporateWorkbook`, `inferSubManufacturer` | `__tests__/export.test.ts` | `npx vitest run __tests__/export.test.ts` |
| Airtable schema / fetch / cache | [Airtable Integration](data/airtable-integration.md) | `lib/airtable/schema.ts`, `lib/airtable/fetch.ts`, `lib/airtable/cached.ts` | `fetchEngineContext`, `getEngineContext`, `invalidateEngineContext`, `isLiveDataAvailable` | No dedicated unit file — exercised indirectly via `parity.test.ts`/`tuning.test.ts` fixtures that shape `EngineContext` | `npx tsc --noEmit` (typecheck; live-base changes need a manual `GET /api/recommendations` healthcheck against real `AIRTABLE_PAT`) |
| History write-back / learning loop | [Airtable Integration](data/airtable-integration.md#history-write-back--the-learning-loop) | `lib/airtable/writeback.ts`, `app/api/export/route.ts` | `writeSelectionsToHistory`, `backfillBidManufacturers`, `getWritebackMode`, `writebackKey` | `__tests__/writeback.test.ts` | `npx vitest run __tests__/writeback.test.ts` |
| Accuracy eval harness / ratchet | [Accuracy Eval Harness](engine/eval-harness.md) | `lib/eval/harness.ts`, `lib/eval/dataset.ts`, `scripts/eval/run.ts` | `buildEvalCases`, `runEval`, `checkRegression`, `toBaseline` | `__tests__/eval.test.ts` | `npx vitest run __tests__/eval.test.ts` (conditional — full-corpus check) `npm run eval` |
| CI / test infrastructure | [Testing & CI](operations/testing-and-ci.md) | `.github/workflows/ci.yml`, `vitest.config.ts` | n/a | Whichever suite the workflow step covers | `npx vitest run` (conditional — release-shaped change) full CI dry run via a draft PR |

## Repo layout at a glance

| Path | Role |
|---|---|
| `app/page.tsx` | Client UI: upload, review recommendations, identify, export |
| `app/api/{upload,recommendations,identify,export}/route.ts` | Thin Next.js API routes; logic lives in `lib/**` |
| `lib/parse/` | CSV/XLSX parsing (`workbook.ts`) and request-body coercion (`coerce.ts`) |
| `lib/identify/` | Claude-powered per-line identification and PDF schedule extraction |
| `lib/engine/` | Matching, ranking, and recommendation orchestration (`matcher.ts`, `ranking.ts`, `recommend.ts`, generated `series-categories.ts`) |
| `lib/airtable/` | Schema (field IDs), fetch, in-memory cache, create-only write-back |
| `lib/export/` | Corporate-template workbook builder |
| `lib/eval/` + `scripts/eval/` + `scripts/build-series-map.ts` | Accuracy evaluation harness and the generated series→category map |
| `__tests__/` | Vitest suites (parse, tuning, parity, writeback, identify, export, eval) plus the frozen eval snapshot/baseline |
| `.github/workflows/ci.yml` | Typecheck + lint + vitest (incl. eval ratchet) on every PR/push |
| `.github/workflows/openwiki-update.yml` | Scheduled job that regenerates this wiki |
| `docs/*.md` | Hand-written phase primers and the eval-harness reference |

## Backlog

- **UI component structure of `app/page.tsx`** (state management, card
  rendering, identify affordances) — not documented in depth here; see the
  file directly (`app/page.tsx`) and the UI refinement candidates list in
  `docs/PHASE3-PRIMER.md`. Deferred because the client component is large and
  its logic mirrors the already-documented engine/API contracts rather than
  introducing new domain concepts.
- **`scripts/build-series-map.ts` internals beyond its documented thresholds**
  (`MIN_SUPPORT = 3`, `MIN_AGREEMENT = 0.8`) — the full token-matching/labeling
  logic is summarized in
  [Recommendation Engine](engine/recommendation-engine.md#learned-series-categories)
  but not walked line by line; read the script directly for edge cases.
