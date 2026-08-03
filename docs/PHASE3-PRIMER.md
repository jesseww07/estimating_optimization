# Phase 3 Kickoff Primer — Accuracy Improvements & UI Refinements

> For a fresh Claude session picking up this project. Written 2026-07-29, after the
> Collective MedSpa live test and its fix batch (PRs #1–#4, `main` @ `8563206`).
> Read this before touching code; skim the referenced files as you need them.

## What this app is

Premier Lighting's internal **VE / estimating substitution finder**. An estimator
uploads a bid sheet (CSV/XLSX) or a fixture-schedule PDF; the engine parses line
items, recommends substitutions from Premier's catalog (Airtable base
`appWj912AEOvtxqJF`), the estimator reviews/overrides selections, and exports a
corporate-template workbook. Exports write selections back to the Airtable
**History** table (the learning loop) so future analyses benefit.

- Production: `estimating-optimization.vercel.app` (Vercel project
  `prj_2yvE1212kIqpvTo6xOoFbfLmhbNX`, team `jesseww07s-projects`). Deploys
  automatically from `main`.
- Owner: Jesse (jessew@shoppremier.com). Single developer, edits happen through
  Claude sessions; PRs are squash-merged to `main`, branches auto-delete on merge.

## Architecture map

| Area | Files | Notes |
|---|---|---|
| Workbook parsing | `lib/parse/workbook.ts` | Multi-sheet (healthiest sheet wins), alias-priority catalog column + data-density fallback, junk-row filters. Regression suite: `__tests__/parse.test.ts` (mirrors the real MedSpa workbook). |
| PDF / identify | `lib/identify/*` | Claude-powered: `schedule.ts` (fixture-schedule PDF → line items), `claude.ts` + `fetchUrl.ts` + `apply.ts` (per-line identify via URL / web search / cut-sheet PDF). Server-only; user-triggered, one line per request. |
| Engine | `lib/engine/matcher.ts`, `recommend.ts`, `ranking.ts` | matcher = normalization, category detection, scoring primitives, guards (RFI/tape/bulb/accessory). recommend = `analyzeLineItem` pipeline. ranking = own-brand bonus, comparator, dedupe, **`shouldAutoSelect`**. |
| Airtable | `lib/airtable/schema.ts`, `fetch.ts`, `cached.ts`, `writeback.ts` | schema.ts holds field IDs — always use these constants. Write-back is CREATE-ONLY, deduped, live on production (`HISTORY_WRITEBACK` env var overrides: live/dry_run/off). |
| UI | `app/page.tsx` (client), `app/api/{upload,recommendations,identify,export}/route.ts` | page.tsx duplicates lib types locally but now imports `shouldAutoSelect` from `lib/engine/ranking`. |
| Export | `lib/export/corporate.ts` | Corporate workbook template; pricing columns intentionally blank (takeoff draft, not a quote). |

### Engine pipeline order (`analyzeLineItem` — order matters for any change)

1. URL-as-catalog scrub → 2. **RFI placeholder** (returns RFI notice + in-category
suggestions when a category is detectable) → 3. **LED tape** suppression → 4.
**Bulb/lamp** dedicated path → 5. fixture-type hint + `detectFixtureCategory` →
6. **History** matching (authoritative tier at 3+ swaps → 95%+, recency weighting) →
7. **Premier direct** text match (category gate, dimension gate, accessory gate) →
8. Fans → 9. already-a-Premier-item passthrough → 10. **category fallback**
(`categoryFallbackRecommendations` — token overlap + Times Used, capped 60/45) →
11. decorative **passthrough badge** → 12. own-brand bonus (+15) → sort → dedupe →
**post-dedupe fallback retry** (a known category never ends silent) → slice(0,3).

### Learning-loop contract (do not weaken)

- Auto-select gate: UI pre-checks a recommendation only if `confidence ≥ 50` AND
  `matchType !== 'partial'` and not passthrough (`shouldAutoSelect`). Category
  guesses stay one click away — this is what keeps default-selection exports from
  polluting History.
- Write-back: only selected substitutions (never as-spec/passthrough/RFI/tape rows);
  records `Spec Match Confidence` (e.g. "45%"); backfills empty Bid Manufacturer by
  History majority vote; Match Type is always `EXACT` (describes spec→item linkage,
  vocabulary: EXACT / NON-ITEM / UNMAPPED — never invent new select options; the
  Airtable create uses `typecast: true`, which silently creates them).
- Bid Date = export date; that's what activates recency weighting.

## State as of this primer

- All Phase 2 work + MedSpa fixes merged. 77 tests green (`npx vitest run`),
  `tsc --noEmit` clean, `next build` clean.
- History contains ~11 rows for "Collective Medspa" from a mechanics test export
  (2026-07-28, default selections, no confidence values). Jesse considers them
  non-endorsements; they may or may not have been deleted — **check before using
  MedSpa history as evidence**.
- Known real test artifacts: Collective MedSpa (decorative worst case, no catalog
  numbers), Candlewood (bulb/lamp lines), Camino Del Rio (poles, tape, vanities),
  1868 Ogden (frozen parity context).

## Accuracy backlog (prioritized; sourced from the 2026-07-28 engine audit)

1. **Accuracy eval harness.** Jesse's explicit direction: real accuracy evaluation
   needs a larger spec listing. Extend the parity pattern (`__tests__/parity.*`)
   into a batch harness: N historical bids with known-good outcomes → measure
   top-1/top-3 hit rate, silence rate, junk rate. Build this FIRST so every change
   below is measurable. Candidate data source: History rows with links (they ARE
   labeled outcomes).
2. **Short-mark junk generator.** `calculateMatchScore` returns 85 when the target
   merely contains the search string (`matcher.ts`), so 1–2 char marks match most of
   the catalog when `inferredCategory` is null. Gate mark-based matching on mark
   length / require category agreement.
3. **Description channel is lost.** Sheets/PDFs that separate "Catalog #" from
   "Description" lose the description: `lib/identify/schedule.ts` promotes
   description→catalogNumber only when catalog is empty; `rawRow`'s only consumer is
   the whole-cell single-token `FIXTURE_HINT_RE` in recommend.ts. Build a
   `descriptiveText` from unused row cells, feed it to `detectFixtureCategory` and
   the fallback token scorer.
4. **Category detector gaps.** No picture/art-light branch (L7 fell to null); no
   head-noun logic ("ELIF ... RECESSED METAL PLASTER **WALL LAMP**" → Recessed
   because RECESSED appears); detector labels vs `CATEGORY_GROUPS` drift (audit the
   two lists together).
5. **Spec Match Confidence is recorded but never consumed.** Consider discounting
   low-confidence History rows in swap counting / authoritative tier
   (`AUTHORITATIVE_SWAP_COUNT` in recommend.ts) so accepted-default rows can't
   graduate to 95% on volume alone.
6. **Third-party category compat is substring** (`thirdPartyCategoriesCompatible`)
   while Premier's is exact — third-party items enter pools on looser terms.
7. **Own-brand bonus applied after caps** — fallback cards can exceed their
   documented 45/60 ceilings (45+15, 60+15) and jump a UI color tier. Decide:
   cap-then-bonus (current) vs bonus-within-cap.
8. **Match-type thresholds inconsistent** across blocks (Premier/Fans 70/40,
   bulbs 70/45, fallback always 'partial'). Normalize or document.
9. **History keys on prose.** `originalSpec` is stored verbatim, so description-style
   specs become normalized history keys and can turn authoritative. Consider keying
   quality by `looksLikeProse`.

## UI refinement candidates

1. **Editable quantities** — fixture-schedule lines parse with Qty "—"; estimators
   need to type counts before export.
2. **Header autofill** — bid-sheet preambles carry `JOB NAME - X`, `CUSTOMER - X`,
   `SALES - X`, `ESTIMATOR - X`, `BID DATE` (see the MedSpa workbook rows 1–4);
   parse them and prefill the export header fields.
3. **Selection summary strip** — n substitutions / n as-spec / n RFI, and which rows
   will write to History (make the learning loop visible pre-export).
4. **Confidence display vs gate** — colors are ≥90 green / ≥70 amber / grey; the
   auto-select bar is 50 and "Look up spec" prompts at <70. Align tiers so the UI
   explains why something wasn't pre-checked.
5. **Identify affordances** — surface "Look up spec" more aggressively when the top
   candidate is below the auto-select bar (decorative schedules are the designed
   use case for identify); consider batch identify with cost guardrails (currently
   deliberately one line per request).
6. **RFI banner + suggestions** — infoMessage and candidate list now coexist; style
   the pairing so suggestions read as "category-level only".
7. **Type consolidation** — `app/page.tsx` hand-copies lib types; drift risk. Import
   shared plain-data types (the `lib/identify/types.ts` pattern exists for this).

## Conventions & gotchas

- **Branch**: develop on `claude/document-execution-setup-3gzf9u` (or the session's
  designated branch), squash-merge PRs; after a merge, restart the branch from
  `origin/main` (`git checkout -B <branch> origin/main`). Committer email must be
  `noreply@anthropic.com` or GitHub shows commits Unverified.
- **Next.js**: per `AGENTS.md`, this Next version has breaking changes — read
  `node_modules/next/dist/docs/` before writing Next-specific code.
- **Parity fixtures are frozen live cases** — evolve an expectation only with a
  documented reason in the fixture (see `satco-bulb-exclude` and
  `dimension-hard-gate` for the pattern).
- **Catalog domain facts**: GC/GCL/LUC/PL/MIR/MDL/PKL/FRIS/HW + R-/REC-/COM-/TJ =
  Premier own brands (+15 rank bonus). SATCO/Westgate = third-party tier. In the
  GC-REC downlight system, `-POWER` and `EMGDRIVER` SKUs are **drivers**
  (accessories, excluded); `-TUNABLE` and `-EM` are fixture variants (matchable).
  SATCO S-numbers are lamps — never fixture substitutions; bulb lines have their
  own path.
- **Write-back env**: `HISTORY_WRITEBACK` (live default on `VERCEL_ENV=production`,
  dry_run elsewhere; explicit env var always wins — it's the kill switch).
- **Tests**: `npx vitest run` (fast); `npx tsc --noEmit`; `npx next build` before
  shipping. Test files: parse / tuning / parity / writeback / identify / export /
  eval. Since 2026-07-29 CI enforces the first three of those locally-run checks
  automatically (`.github/workflows/ci.yml`: typecheck + lint + vitest on every
  PR and push to `main`; Vercel still owns the build check) — so an accuracy
  regression caught by the eval ratchet now turns the PR red. See
  `docs/EVAL-HARNESS.md` for the accuracy eval harness and its baseline workflow.
- The git proxy in remote sessions cannot delete remote branches (403) — GitHub's
  auto-delete-on-merge handles cleanup now.
