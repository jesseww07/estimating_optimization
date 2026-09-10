---
type: Overview
title: VE Estimator Quickstart
description: Entry point for the Premier Lighting VE (value engineering) estimating substitution finder — what it does, how the pieces fit together, and where to go next in the wiki.
tags: [quickstart, ve-estimator, premier-lighting, next.js, airtable]
verified:
  - by: openwiki/0.5.1
    at: 2026-09-10T12:24:50.371Z
sources:
  - id: openwiki-source-cbf8826979b66452c4f7cd0d
    resource: repo://__tests__/categories.test.ts
  - id: openwiki-source-0d995d307c6ea1eec2175e1a
    resource: repo://__tests__/identify-batch.test.ts
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-1d4605aa35fb16ba7dd73a86
    resource: repo://app/api/identify-batch/route.ts
  - id: openwiki-source-cc76320853086de7e1dc5681
    resource: repo://lib/identify/batch.ts
  - id: openwiki-source-ca4b0fd930191158922c5af3
    resource: repo://lib/identify/docxPages.ts
  - id: openwiki-source-f156d2964cca4726335ecbcc
    resource: repo://lib/identify/media.ts
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
generated: { by: "openwiki/0.5.1", at: "2026-09-10T12:24:50.371Z" }
---

# VE Estimator — Quickstart

This repository (`ve-estimator`, see `package.json`) is Premier Lighting's
internal **VE / estimating substitution finder**: a Next.js app that helps an
estimator turn a bid sheet or fixture-schedule document into a corporate
export draft with Premier catalog substitutions already suggested.

## What the app does, end to end

1. An estimator **uploads** a bid sheet (CSV/XLSX) or a fixture schedule as a
   PDF, an image (phone photo/screenshot), or a Word document (`.docx`).
2. The app **parses** it into line items (mark, quantity, manufacturer,
   catalog number). Pre-converted sheets go through a known-column parser;
   PDFs, images, and Word schedules are read by Claude, with long documents
   split into several page-range passes joined in document order.
3. The **recommendation engine** scores each line item against Premier's
   Airtable catalogs (own-brand items, third-party items, fans) and against
   **History** — a table of past estimator decisions — and returns up to
   three ranked substitution candidates per line.
4. If a batch of lines can't be categorized from the sheet alone, the
   estimator can trigger a **batched identify pass** — one Claude call per
   ~18 lines, covering only the lines the estimator selects — that assigns a
   category to each and lets the engine re-score them.
5. If a single line still can't be identified, the estimator can trigger
   **per-line identification** (Claude reads a pasted spec URL, does a web
   search, or reads an uploaded cut sheet) and the engine re-runs on the
   identified spec.
6. The estimator reviews/overrides the pre-checked selections and **exports**
   a corporate-template workbook.
7. Export **writes accepted substitutions back to History** — the learning
   loop that makes future analyses better.

This flow, its API surface (including `/api/identify-batch`), and its
Next.js structure are documented in
[Architecture Overview](architecture/overview.md). The mechanics shared by
schedule extraction, per-line identify, and batch identify — Claude prompts,
cost guardrails, page-chunking, and base-item catalog-number extraction —
are documented in
[Spec Identification](workflows/spec-identification.md).

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

## Where line items come from when the sheet alone isn't enough

A line the engine can't score is not always a dead end. A dedicated
subsystem — schedule extraction on upload, per-line identify, and the
sheet-wide batch identify pass — turns an unreadable or under-specified line
into something the engine can act on, all funneling through one shared
`IdentifiedSpec` contract. It is documented in
[Spec Identification](workflows/spec-identification.md).

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
- **This repository is public.** Never commit customer bid workbooks,
  pricing data, or raw Airtable exports — including as new test fixtures.
  Every committed fixture is either synthetic (invented brands/part numbers)
  or a frozen, already-committed snapshot (e.g. `__tests__/eval.context.json.gz`,
  `__tests__/parity.context.json`).
- The exported workbook is a **takeoff draft, not a quote** — pricing columns
  are intentionally left blank; see
  [Architecture Overview](architecture/overview.md#export--post-apiexport).
- The engine is deliberately conservative about auto-selecting recommendations
  because an accepted default gets written back to History and can pollute
  future scoring — see the auto-select gate in
  [Recommendation Engine](engine/recommendation-engine.md).
- Identification calls to Claude are cost-guarded and always
  user-triggered — per-line identify is one line per click, and the batch
  pass is one bounded, estimator-initiated sweep of the lines they pick, not
  an automatic sheet-wide sweep. See
  [Spec Identification](workflows/spec-identification.md).

## Task routing

Start here for common change categories. "Focused tests" is the narrowest
regression net; "Validation" is the quietest command that still surfaces
failures. All commands run from the repo root.

| Change area / intent | Wiki page | Source entry points | Key symbols/types | Focused tests | Minimal validation |
|---|---|---|---|---|---|
| Upload parsing (CSV/XLSX known-column path) | [Architecture Overview](architecture/overview.md#upload--post-apiupload) | `app/api/upload/route.ts`, `lib/parse/workbook.ts` | `parseWorkbook`, `ParsedLineItem` | `__tests__/parse.test.ts` | `npx vitest run __tests__/parse.test.ts` |
| Schedule extraction (Claude-read PDF/image/Word, page-chunking) | [Spec Identification](workflows/spec-identification.md#flow-1--upload-time-schedule-extraction) | `app/api/upload/route.ts`, `lib/identify/schedule.ts`, `lib/identify/docxPages.ts`, `lib/identify/media.ts`, `lib/identify/pdfPages.ts` | `extractScheduleFromDocument`, `extractScheduleFromPages`, `planPageRanges`, `planDocxPages`, `detectSupportedMedia`, `scheduleRowsToLineItems` | `__tests__/identify.test.ts` (schedule/media/PDF-page-count cases) | `npx vitest run __tests__/identify.test.ts` |
| Recommendation scoring/matching/ranking | [Recommendation Engine](engine/recommendation-engine.md) | `lib/engine/matcher.ts`, `lib/engine/recommend.ts`, `lib/engine/ranking.ts`, `lib/engine/categories.ts` | `analyzeLineItem`, `calculateCatalogMatchScore`, `isFamilySpecMatch`, `isIdentifiableSpecKey`, `categoriesCompatible`, `shouldAutoSelect` | `__tests__/tuning.test.ts`, `__tests__/parity.test.ts`, `__tests__/categories.test.ts` | `npx vitest run __tests__/tuning.test.ts __tests__/parity.test.ts __tests__/categories.test.ts`, then (conditional — any scoring/threshold change) `npm run eval` |
| Learned series → category map | [Recommendation Engine](engine/recommendation-engine.md#learned-series-categories) | `scripts/build-series-map.ts`, `lib/engine/series-categories.ts` (generated) | `SERIES_CATEGORY_MAP`, `MIN_SUPPORT`, `MIN_AGREEMENT` | `__tests__/tuning.test.ts` ("Largo Station: learned series → category") | `npx tsx scripts/build-series-map.ts` (regenerate, review the diff), then `npm run eval` |
<!-- openwiki: broken internal link [workflows/spec-identification.md#flow-2--per-line-identify] heading anchor "flow-2--per-line-identify" does not exist in "workflows/spec-identification.md". Fix the href or restore the target, then delete this comment. -->
| Per-line identify (URL / web / cut sheet) | [Spec Identification](workflows/spec-identification.md#flow-2--per-line-identify) · [Architecture Overview](architecture/overview.md#per-line-identify--post-apiidentify) | `app/api/identify/route.ts`, `lib/identify/claude.ts`, `lib/identify/fetchUrl.ts`, `lib/identify/apply.ts`, `lib/identify/catalogNumber.ts` | `applyIdentifiedSpec`, `isFetchableSpecUrl`, `isIdentifyAvailable`, `planCatalogSearch` | `__tests__/identify.test.ts` | `npx vitest run __tests__/identify.test.ts` |
<!-- openwiki: broken internal link [workflows/spec-identification.md#flow-3--batch-category-identification] heading anchor "flow-3--batch-category-identification" does not exist in "workflows/spec-identification.md". Fix the href or restore the target, then delete this comment. -->
| Batched sheet-wide category identify | [Spec Identification](workflows/spec-identification.md#flow-3--batch-category-identification) · [Architecture Overview](architecture/overview.md#batch-identify--post-apiidentify-batch) | `app/api/identify-batch/route.ts`, `lib/identify/batch.ts` | `identifyCategoriesInBatch`, `isBatchIdentifyAvailable`, `selectBatchCandidates`, `chunkCandidates`, `mergeBatchRows`, `MAX_BATCH_CALLS`, `BATCH_CHUNK_SIZE` | `__tests__/identify-batch.test.ts` | `npx vitest run __tests__/identify-batch.test.ts` |
| Export / corporate workbook | [Architecture Overview](architecture/overview.md#export--post-apiexport) | `app/api/export/route.ts`, `lib/export/corporate.ts` | `buildCorporateWorkbook`, `inferSubManufacturer` | `__tests__/export.test.ts` | `npx vitest run __tests__/export.test.ts` |
| Airtable schema / fetch / cache | [Airtable Integration](data/airtable-integration.md) | `lib/airtable/schema.ts`, `lib/airtable/fetch.ts`, `lib/airtable/cached.ts` | `fetchEngineContext`, `getEngineContext`, `invalidateEngineContext`, `isLiveDataAvailable` | No dedicated unit file — exercised indirectly via `parity.test.ts`/`tuning.test.ts` fixtures that shape `EngineContext` | `npx tsc --noEmit` (typecheck; live-base changes need a manual `GET /api/recommendations` healthcheck against real `AIRTABLE_PAT`) |
| History write-back / learning loop | [Airtable Integration](data/airtable-integration.md#history-write-back--the-learning-loop) | `lib/airtable/writeback.ts`, `app/api/export/route.ts` | `writeSelectionsToHistory`, `backfillBidManufacturers`, `getWritebackMode`, `writebackKey` | `__tests__/writeback.test.ts` | `npx vitest run __tests__/writeback.test.ts` |
| Accuracy eval harness / ratchet | [Accuracy Eval Harness](engine/eval-harness.md) | `lib/eval/harness.ts`, `lib/eval/dataset.ts`, `scripts/eval/run.ts` | `buildEvalCases`, `runEval`, `checkRegression`, `toBaseline` | `__tests__/eval.test.ts` | `npx vitest run __tests__/eval.test.ts` (conditional — full-corpus check) `npm run eval` |
| CI / test infrastructure | [Testing & CI](operations/testing-and-ci.md) | `.github/workflows/ci.yml`, `vitest.config.ts` | n/a | Whichever suite the workflow step covers | `npx vitest run` (conditional — release-shaped change) full CI dry run via a draft PR |

## Repo layout at a glance

| Path | Role |
|---|---|
| `app/page.tsx` | Client UI: upload, review recommendations, identify (single + batch), export |
| `app/prepareUpload.ts` | Browser-only Word-schedule pre-processing (page-image extraction/recompression) to stay under Vercel's request-body limit |
| `app/api/{upload,recommendations,identify,identify-batch,export}/route.ts` | Thin Next.js API routes; logic lives in `lib/**` |
| `lib/parse/` | CSV/XLSX parsing (`workbook.ts`), `.docx` reading (`docx.ts`), and request-body coercion (`coerce.ts`) |
| `lib/identify/` | Claude-powered schedule extraction (PDF/image/Word), per-line identification, batch category identification, and base-item catalog-number extraction |
| `lib/engine/` | Matching, ranking, and recommendation orchestration (`matcher.ts`, `ranking.ts`, `recommend.ts`, `categories.ts`, generated `series-categories.ts`) |
| `lib/airtable/` | Schema (field IDs), fetch, in-memory cache, create-only write-back |
| `lib/export/` | Corporate-template workbook builder |
| `lib/eval/` + `scripts/eval/` + `scripts/build-series-map.ts` | Accuracy evaluation harness and the generated series→category map |
| `__tests__/` | Vitest suites (parse, tuning, parity, categories, writeback, identify, identify-batch, export, eval) plus the frozen eval snapshot/baseline |
| `.github/workflows/ci.yml` | Typecheck + lint + vitest (incl. eval ratchet) on every PR/push |
| `.github/workflows/openwiki-update.yml` | Scheduled job that regenerates this wiki |
| `docs/*.md` | Hand-written phase primers and the eval-harness reference |

## Backlog

- **UI component structure of `app/page.tsx`** (state management, card
  rendering, identify/batch-identify affordances) — not documented in depth
  here; see the file directly (`app/page.tsx`) and the UI refinement
  candidates list in `docs/PHASE3-PRIMER.md`. Deferred because the client
  component is large and its logic mirrors the already-documented
  engine/API contracts rather than introducing new domain concepts.
- **`scripts/build-series-map.ts` internals beyond its documented thresholds**
  (`MIN_SUPPORT = 3`, `MIN_AGREEMENT = 0.8`) — the full token-matching/labeling
  logic is summarized in
  [Recommendation Engine](engine/recommendation-engine.md#learned-series-categories)
  but not walked line by line; read the script directly for edge cases.
