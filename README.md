# VE Estimator

Premier Lighting's internal **value-engineering (VE) substitution finder** for
estimating. An estimator uploads a bid sheet or fixture schedule; the app
suggests Premier catalog substitutions for each line, learns from accepted
swaps recorded at export, and produces a corporate-template takeoff draft.

**Live app:** deployed on Vercel from `main`. The exported workbook is a
takeoff draft, not a quote; pricing columns are intentionally blank.

## How it works

1. **Upload** a bid sheet (CSV/XLSX) or a fixture-schedule PDF.
2. The app **parses** it into line items (mark, quantity, manufacturer,
   catalog number). PDFs are read by Claude.
3. The **recommendation engine** scores each line against Premier's Airtable
   catalogs (Premier Items, 3rd Party Domestic, Fans) and **History** — past
   estimator decisions — and returns up to three ranked substitutions per
   line, pre-checking one only when the auto-select gate is confident.
4. Lines the sheet alone can't identify can go through **per-line
   identification**: Claude reads a pasted spec URL, searches the web, or
   reads an uploaded cut-sheet PDF, then the engine re-runs.
5. The estimator reviews/overrides selections and **exports** the workbook.
6. When the export opts into recording (`recordToHistory`) and
   `HISTORY_WRITEBACK` allows it, accepted substitutions are **written back
   to History** — the learning loop that makes the next bid's suggestions
   better.

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000
```

### Environment variables

| Variable | Purpose |
|---|---|
| `AIRTABLE_PAT` | Personal access token for the Premier estimating Airtable base (required for live data) |
| `AIRTABLE_BASE_ID` | Overrides the default base ID (optional; defaults to the production base) |
| `ANTHROPIC_API_KEY` | Claude API key for PDF reading and per-line identification |
| `IDENTIFY_MODEL` | Overrides the Claude model used for identification (optional) |
| `HISTORY_WRITEBACK` | `live` / `dry_run` / `off` kill switch. When unset: production defaults to `live`; previews and local dev default to `dry_run`, so non-production exports never write to History |

### Commands

```bash
npm run dev              # dev server
npm run build            # production build
npm run lint             # eslint
npm test                 # vitest suites (parse, tuning, parity, writeback, identify, export, eval guard)
npm run eval             # accuracy eval: replays 1,000+ labeled History outcomes through the engine
npm run eval:update      # accept new eval results as the baseline (do this deliberately)
npm run eval:fetch       # refresh the frozen Airtable snapshot the eval runs against
npm run build:series-map # regenerate lib/engine/series-categories.ts from History
```

## Engine changes are measured, not eyeballed

CI (`.github/workflows/ci.yml`) runs typecheck, lint, and the full vitest
suite — including the **eval ratchet**, which fails the build if an engine
change regresses top-1 accuracy, junk rate, or auto-select-wrong rate against
the committed baseline. If you change anything in `lib/engine/`, run
`npm run eval` and look at the per-case flip diff before you push. See
`docs/EVAL-HARNESS.md`.

## Repo layout

| Path | Role |
|---|---|
| `app/page.tsx` | Client UI: upload, review, identify, export |
| `app/api/{upload,recommendations,identify,export}/route.ts` | Thin API routes; logic lives in `lib/**` |
| `lib/parse/` | CSV/XLSX parsing and request coercion |
| `lib/identify/` | Claude-powered identification and PDF schedule extraction |
| `lib/engine/` | Matching, ranking, recommendation orchestration (pure TS — no Next.js/React imports) |
| `lib/airtable/` | Schema/field IDs, fetch, in-memory cache, create-only History write-back |
| `lib/export/` | Corporate-template workbook builder |
| `lib/eval/`, `scripts/eval/` | Accuracy eval harness |
| `__tests__/` | Vitest suites + frozen eval snapshot/baseline |
| `docs/` | Hand-written phase primers and eval-harness reference |
| `openwiki/` | Generated wiki (refreshed by a scheduled workflow — don't hand-edit) |

## Further reading

- `openwiki/quickstart.md` — generated wiki entry point (architecture, engine, data, ops)
- `docs/PHASE4-PRIMER.md` — current phase: closing the spec-identification gap
- `docs/PHASE3-PRIMER.md` — architecture map and conventions from the Phase 3 handoff
- `docs/EVAL-HARNESS.md` — eval metrics, workflow, and how to read output

> ⚠️ This is a **public** repository. Never commit customer bid workbooks,
> pricing data, or Airtable exports. Test fixtures must use frozen,
> already-committed snapshots or synthetic data.
