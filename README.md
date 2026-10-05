# VE Estimator

Premier Lighting's internal **value-engineering (VE) substitution finder**.

Specs on multifamily bids often name products Premier doesn't sell. Before the
submittal goes out, an estimator has to find the Premier private-label item
that can stand in for each one (a "VE swap"). This app reads a bid sheet or
fixture schedule and suggests those swaps line by line. It draws on what
Premier's estimators chose on past bids and on what's in the Premier catalog.
Every export it records makes the next bid's suggestions better.

**Live app:** deployed on Vercel from `main`. The exported workbook is a
takeoff draft, not a quote, so pricing columns are intentionally blank.

> ⚠️ This is a **public** repository. Never commit customer bid workbooks,
> pricing data, credentials, or Airtable exports. Test fixtures use the
> frozen, already-committed snapshots or synthetic data.

---

## For estimators: what the app does

1. **Upload** a bid sheet (CSV/XLSX) or a fixture schedule: a Word document,
   a PDF, or a photo/screenshot.
2. **Review.** Each line gets up to three ranked suggestions, each with a
   confidence score and a reason. A suggestion is pre-checked only when the
   app is genuinely confident. Anything else stays one click away.
3. **Identify, if needed.** For lines the app can't place, use **Identify**
   (a batch pass over the lines you pick) or **Look up spec** on a single
   line. Look up spec can read a spec URL you paste, search the web, or read a
   cut sheet you upload. These calls cost money, so they only run when you ask.
4. **Export** the corporate-template workbook. Lines left **as specified** are
   banded yellow, meaning "price this one as the specified product."
5. **Your export teaches the app.** On the live app, the substitutions you
   selected are recorded to History and inform future suggestions. Only
   selected swaps are recorded. Unchecked guesses, RFIs and tape lines are not.

What the badges and rules mean:

| You see | It means |
|---|---|
| **✓ Bid X times** | Premier made this exact swap on 3+ past bids. Treated as authoritative (95%+). |
| Premier items ranked first | Own-brand lines (GC, GCL, LUC, PL, MIR, MDL, PKL, FRIS, HW, R-/REC-/COM-/TJ) and house lines such as Globalux rank ahead of resold items that score the same. |
| **Left as-spec** | The spec should stay as written. Shown below real substitutions, never hidden. |
| No swap for LED tape / RFI | Intentional. These lines get an informational message instead. |
| An item you'd expect is missing | Size is a hard gate: a dimensionally incompatible swap is never shown. The item may also be missing from the Airtable catalog. |

---

## How the whole system fits together

This repo is the app. It sits on shared data that other tools maintain.

```text
NetSuite ──(sync scripts)─────────────┐
Box bid intake ──(BidWatcher)─────────┤
                                      ▼
                          AIRTABLE base (the hub)
                     catalogs · History · categories
                                      ▲
                     reads catalogs + History, writes
                     accepted swaps back to History
                                      │
GitHub (this repo) ──auto-deploy──►  Vercel app  ──► Claude API
                                                     (reading schedules,
                                                      identifying specs)
```

| Piece | Role | Where it lives |
|---|---|---|
| **Airtable** | The shared database: catalogs, History of past bid decisions, and the category and manufacturer vocabularies. | One base, `appWj912AEOvtxqJF` |
| **NetSuite** | Source of truth for items and vendors. Premier Items are NetSuite items whose preferred vendor is Premier's own (PREMCOL). | Synced into Airtable by scripts outside this repo |
| **BidWatcher** | A Python watcher on a Premier workstation. It converts finished bid workbooks dropped in the Box intake folder into Airtable-ready CSVs, which are imported into History. | Outside this repo, in the Box intake folder |
| **This app** | Upload → recommend → identify → export, plus History write-back. | This repo, deployed on Vercel |
| **Claude** | Reads Word, PDF and image schedules. Identifies specs on request. | Called server-side from `lib/identify/` |

### The Airtable tables

| Table | Role |
|---|---|
| **History** | Every past bid line and what Premier bid instead. It's the main source of intelligence and the labeled data the accuracy eval replays. |
| **Premier Items** | Premier's private-label catalog. |
| **3rd Party Domestic Items** | Products Premier resells. This table is **context, not a substitution catalog**: it lets the app recognize a named resold product. A resold item is recommended only when it *is* the answer, and it never displaces a Premier item that scores as well. House lines (see `PREFERRED_THIRD_PARTY_MANUFACTURERS` in `lib/engine/ranking.ts`) are the exception. |
| **Fans** | Ceiling-fan catalog. |
| **Product Categories** | The single category vocabulary every table links to. It was consolidated on 2026-09-02 from four parallel systems. |
| **Manufacturers** | The single brand registry, with spelling variants kept in `Aliases`. |

The app binds every Airtable field by **field ID**, not by name
(`lib/airtable/schema.ts`), so renaming a column is safe. **Deleting or
retyping a column is not.** After any schema edit in Airtable, run
`npx tsx --env-file=.env scripts/schema-audit.ts`.

### How we got here

- **Airtable Interface app (early 2026).** The first version was a single
  pasted React file running inside Airtable. It had no server, no build step
  and no version control, so it couldn't hold secrets, read PDFs, or call
  Claude, and nobody could be sure which copy was current.
- **Next.js on Vercel, code on GitHub (July 2026).** The validated engine was
  ported here. Vercel gives it a server, so keys stay out of the browser.
  GitHub gives it history and review, and Vercel deploys from it.
- **Measured accuracy (late July 2026).** An eval harness replays about 1,000
  past estimator decisions on every change. CI blocks changes that make
  suggestions worse.
- **Reading real schedules (Aug–Sept 2026).** Added PDF, image and Word
  schedules, batch and per-line identification, family and series matching
  from History, and matching on the base item number.
- **One vocabulary (Sept 2026).** The Airtable base was consolidated onto
  one category table and one manufacturer registry.

The phase primers in `docs/` tell this story in engineering detail.

---

## For developers

### Getting started

```bash
npm install
cp .env.example .env   # then fill in the keys below
npm run dev            # http://localhost:3000
```

Without `AIRTABLE_PAT` the app still builds and runs, but with an empty
catalog. API responses report `liveData: false`.

### Environment variables

| Variable | Purpose |
|---|---|
| `AIRTABLE_PAT` | Personal access token for the Airtable base. Required for live data. |
| `AIRTABLE_BASE_ID` | Overrides the default base ID. Optional. |
| `ANTHROPIC_API_KEY` | Claude API key for schedule reading and identification. |
| `ANTHROPIC_WORKSPACE_ID` | Required **only** for an identity-linked API key (`400 anthropic-workspace-id is required…`). Leave it unset for a workspace-scoped key. |
| `IDENTIFY_MODEL` | Overrides the Claude model used for identification. Optional. |
| `HISTORY_WRITEBACK` | `live` / `dry_run` / `off` kill switch. When unset, production defaults to `live` and everything else to `dry_run`, so previews and local dev never write to History. |

Production secrets live only in the Vercel project's environment variables.
Never put them in code, scripts, or shared folders.

### Commands

```bash
npm run dev              # dev server
npm run build            # production build
npm run lint             # eslint
npm test                 # all vitest suites, including the eval guard
npm run eval             # accuracy eval against the committed baseline
npm run eval -- --failures=25   # ...and print the worst misses
npm run eval:update      # accept new results as the baseline (deliberately!)
npm run eval:fetch       # refresh the frozen Airtable snapshot (needs AIRTABLE_PAT)
npm run build:series-map # regenerate lib/engine/series-categories.ts from History
```

### Engine changes are measured, not eyeballed

CI (`.github/workflows/ci.yml`) runs typecheck, lint and the full test suite on
every PR. That includes the **eval ratchet**, which fails the build if a change
lowers top-1/top-3 accuracy or raises the junk, silent or wrong-pre-check
rates. If you touch `lib/engine/`:

1. Run `npm run eval` and review the per-case flips it prints.
2. If the trade-off is deliberate, run `npm run eval:update`.
3. Commit the code and the baseline together.

Never run `eval:update` just to make a red build pass. See
`docs/EVAL-HARNESS.md`.

### Repo layout

| Path | Role |
|---|---|
| `app/page.tsx` | The estimator UI: upload, review, identify, export |
| `app/prepareUpload.ts` | Browser-side Word-schedule prep: extracts and shrinks page images to fit Vercel's 4.5 MB request limit |
| `app/api/{upload,recommendations,identify,identify-batch,export}/` | Thin API routes. The logic lives in `lib/` |
| `lib/engine/` | Matching, category detection, History tiers, ranking, auto-select gate. Pure TypeScript with no Next/React/Airtable imports |
| `lib/identify/` | Claude-powered schedule reading and spec identification |
| `lib/parse/` | CSV/XLSX and Word parsing, request coercion |
| `lib/airtable/` | Field-ID schema, fetch, in-memory cache, create-only History write-back. The only place the Airtable SDK is used |
| `lib/export/` | Corporate-template workbook builder |
| `lib/eval/`, `scripts/eval/` | Accuracy eval harness |
| `__tests__/` | Vitest suites plus the frozen eval snapshot and baseline |
| `scripts/schema-audit.ts` | Read-only: checks pinned field IDs against the live base |
| `scripts/hygiene-report.ts` | Read-only: data-quality report on the base |
| `scripts/base-cleanup/` | Bulk Airtable maintenance. Dry run by default, writes only with `--apply`. Run `backup.ts` first |
| `scripts/build-series-map.ts` | Builds the learned series → category map from History |
| `docs/` | Hand-written phase primers and the eval reference |
| `openwiki/` | Generated wiki, published to the GitHub Wiki tab. Don't hand-edit |

### Rules that protect the data

- **History write-back is create-only**, deduped, and gated by
  `HISTORY_WRITEBACK`. Non-production code paths must never write to it.
- **Pre-checking stays conservative.** A wrong default that gets exported
  becomes History and can snowball. Earn confidence with evidence, not by
  lowering thresholds.
- **Back up before any bulk Airtable write** (`scripts/base-cleanup/backup.ts`).
  The Airtable API has no undo.

Full project rules are in `AGENTS.md`.

### Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "Catalog offline", or empty suggestions everywhere | `AIRTABLE_PAT` is missing or expired in Vercel, or the base is unreachable. Check the Vercel runtime logs. |
| Log line `field fld… no longer exists — continuing without it` | A pinned field was deleted in Airtable. The app keeps running without it. Run `schema-audit.ts` and update `lib/airtable/schema.ts`. |
| Suggestions don't reflect a bid just exported | The catalog cache refreshes within about 5 minutes. A live write-back clears it immediately. |
| Identify / Look up spec unavailable | `ANTHROPIC_API_KEY` (or `ANTHROPIC_WORKSPACE_ID` for identity-linked keys) is not set. |

## Further reading

- `openwiki/quickstart.md` is the entry point to the generated wiki
  (architecture, engine, data, operations). It's also on the repo's Wiki tab.
- `docs/PHASE4-PRIMER.md` covers the spec-identification work and its backlog.
- `docs/PHASE3-PRIMER.md` covers the architecture map, engine pipeline order and conventions.
- `docs/EVAL-HARNESS.md` covers the eval metrics, the workflow, and how to read output.
