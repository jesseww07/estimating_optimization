# Accuracy Eval Harness

> Phase 3 backlog item 1 (built 2026-07-29). Batch accuracy evaluation of the VE
> engine against **labeled historical outcomes**: every History row whose Bid
> Item links to a catalog record is a real estimator decision "this spec → that
> item". The harness replays each spec through `analyzeLineItem` and measures
> whether the engine finds the item the estimator actually chose. Build on this
> before touching engine scoring — every backlog change should move these
> numbers, visibly.

## Commands

| Command | What it does |
|---|---|
| `npm run eval` | Full run + report + comparison against the committed baseline. Exit 1 on regression. |
| `npm run eval -- --failures=25` | Also prints the first 25 headline misses with what the engine surfaced instead. |
| `npm run eval -- --max-cases=200` | Quick deterministic partial run (no baseline compare). |
| `npm run eval:update` | Full run + rewrite `__tests__/eval.baseline.json`. Commit alongside the change that moved the numbers. |
| `npm run eval:fetch` | Refresh `__tests__/eval.context.json.gz` from the live base (needs `AIRTABLE_PAT`). |
| `npx vitest run __tests__/eval.test.ts` | Harness unit tests + the CI regression guard (same ratchet as `npm run eval`). |

## Files

- `lib/eval/harness.ts` — pure core: case construction, leave-one-project-out
  evaluation, metrics, baseline ratchet. No I/O.
- `lib/eval/dataset.ts` — snapshot load/save (gzip), fingerprinting.
- `scripts/eval/run.ts` / `scripts/eval/fetch-context.ts` — CLI entry points.
- `__tests__/eval.context.json.gz` — frozen `EngineContext` (full History +
  all three catalogs), gzipped. `__tests__/eval.context.meta.json` mirrors its
  provenance (fetch date, row counts, notes) in reviewable plain JSON.
- `__tests__/eval.baseline.json` — committed metrics **plus one line per case
  outcome**, so a PR that flips cases shows exactly which ones in its diff.
- `__tests__/eval.test.ts` — unit tests (always run) + the dataset guard
  (skips with a notice if the snapshot is missing).
- `.github/workflows/ci.yml` — runs `tsc --noEmit`, `npm run lint`, and
  `vitest run` on every pull request and every push to `main`. This is what
  makes the ratchet below *enforcing* rather than advisory. It needs no
  Airtable credentials, because the dataset is the committed snapshot.
  (`next build` is not repeated there — Vercel already builds every PR.)

## How a case is built

A History row becomes a labeled case when **all** hold:

1. `matchType !== 'NON-ITEM'` (freight lines etc. aren't spec→item outcomes);
2. it links to a catalog record that resolves in the snapshot
   (`PREMIER_LINK` preferred, else `THIRD_PARTY_LINK`) — the linked item's
   Item ID is the label, and the row's Bid Item text is accepted as an alias;
3. its Original Spec is ≥ 3 chars and not a pasted URL;
4. its project is not quarantined (see below).

All rows sharing `(project, normalized spec)` collapse into **one case whose
label set is every item chosen for that spec** (`rowCount` records how many
rows). One bid line, one verdict — a multi-item fulfillment (a tape run bid as
tape + channel + driver + feeds) counts as a hit when the engine surfaces ANY
of its items, since a line offers at most 3 recommendation slots. The case id
is content-derived (`project::normSpec`) so it survives dataset refreshes.

**Quarantine** (`QUARANTINED_PROJECTS` in `lib/eval/harness.ts`): projects
excluded both as cases and as evidence. Currently only `Collective Medspa` —
the 2026-07-28 mechanics-test export (default selections, no Spec Match
Confidence; confirmed still in the base on 2026-07-29, e.g. L7 "CANNELE
PICTURE LIGHT" → "FLAIRE 5 LIGHT SEMI-FLUSH MOUNT" is a wrong default).

## Leave-one-project-out (LOPO)

Evaluating a case with its own row in context would be a lookup, not a
prediction. Each case runs against history **excluding every row of its own
project** — the "this bid just arrived" scenario. Cross-project evidence stays:
if two other projects swapped the same spec to the same item, the History tier
can (and should) find it. `referenceDate` is pinned to the snapshot's fetch
time so recency weighting can't drift with the calendar.

## Metrics

Passthrough cards ("Left as-spec", "Already a Premier item") are not
substitutions and are set aside; against the label:

- **top1** — first substantive recommendation is the label.
- **top3** — label appears anywhere in the (≤3) substantive recommendations.
- **junk** — recommendations shown, none is the label.
- **silent** — no substantive recommendation (kinds: passthrough-only /
  info-message suppression / true empty).
- **autoWrong** — the top card clears the UI auto-select gate
  (`shouldAutoSelect`) **and** is not the label. This is the learning-loop
  pollution quadrant: a wrong default selection that an export would write
  back to History. Keep this near zero even while junk exists — junk one
  click away is annoying; junk pre-checked is self-reinforcing.

`top3 + junk + silent = 100%`. **Headline** covers pipeline classes where a
substitution is expected (`standard` + `bulb`); `tape` and `rfi` lines are
engine-intended suppressions and are reported separately so working guards
aren't scored as failures. **As-spec cases** — where every labeled outcome IS
the input spec (the line was bid as itself; Premier resells/carries it) — are
also excluded from the headline and reported as their own slice: the engine
deliberately never recommends the input back, so the correct outcome there is
a passthrough card or silence, which substitution metrics cannot credit.
Slices: pipeline class, prose-vs-catalog spec style (backlog items 3/9
territory), label source (premier / third-party), and per-project.

## The ratchet

`npm run eval` (and the vitest guard) compare the run to
`__tests__/eval.baseline.json`:

- fail if any headline metric moves the wrong way beyond 0.25 pp
  (top1/top3 down; junk/silent/autoWrong up), or the case count changes;
- pass on improvement, with a nudge to `npm run eval:update`;
- fail if the baseline's dataset fingerprint doesn't match the snapshot
  (stale baseline after a refresh — regenerate deliberately).

Intentional engine changes therefore ship as: change → `npm run eval` →
review the case flips it prints → `npm run eval:update` → commit code +
baseline together. The baseline diff in the PR *is* the accuracy review.

Skipping that flow is not an option in practice: CI runs the same guard on
every pull request, so an accuracy regression turns the PR red instead of
merging quietly behind Vercel's green deployment check.

## Initial baseline (2026-07-29, engine @ PR #5 state)

1,086 cases from 66 projects (5,222 linked rows → label-set cases; ~44 s run):

| Slice | n | top1 | top3 | junk | silent | autoWrong |
|---|---|---|---|---|---|---|
| **Headline** (standard+bulb) | 1,070 | **5.79%** | **7.76%** | **64.21%** | **28.04%** | **8.50%** |
| prose specs | 183 | 2.19% | 7.10% | 72.68% | 20.22% | 4.37% |
| premier-labeled | 439 | 11.16% | 13.90% | 53.76% | 32.35% | 10.02% |
| third-party-labeled | 647 | 2.16% | 3.55% | 69.86% | 26.58% | 7.26% |

Reading this honestly: under LOPO the History tier only fires when another
project bid the *same normalized spec*, which is rare — most lines fall to
category fallback (by-design `partial` cards that rarely name the exact item →
junk) or to silence when no category is detected. The numbers put weight
behind the backlog: 84 of 91 autoWrong cases are `Premier Items/fuzzy` matches
at 60–63 confidence riding weak token overlaps (e.g. matching on "BRASS"
alone — backlog #2/#8), and the silent bucket is full of family-level
substitutions the detector misses (e.g. Lithonia `CLXL…` strips → Premier
`EFS-001` builds; backlog #3/#4). Every backlog change should move a specific
cell of this table.

## First measured change (2026-07-30, 3rd & Flower review)

The identification fixes driven by the 3rd & Flower bid sheet + IS schedule
(parser URL/short-header bugs, detector additions, short-mark and single-token
junk gates, the 3rd-party direct tier, accessory/fan-span gates on history,
as-spec handling) moved the headline to **top1 9.01% / top3 11.28% / junk
45.55% / silent 43.17% / autoWrong 6.94%** on 966 cases. Two caveats for
honest comparison against the initial table above: (1) the headline
*definition* changed — 104 as-spec cases left the denominator (see above), and
(2) much of the junk drop converted to silence by design (a wrong card removed
is a quieter line, not a hit). Like-for-like on the original definition, top1
went 5.79% → 8.79% and junk 64.21% → 47.57% with zero previously-hit cases
lost (verified per-case via the baseline flip diff).

## Data notes

- Initial snapshot pulled 2026-07-29 via the Airtable MCP connector
  (per-project History slices, each verified against the server's
  `totalRecordCount`; 9,479 history / 2,402 premier / 1,115 third-party /
  113 fans). `npm run eval:fetch` is the canonical refresh path when an
  `AIRTABLE_PAT` is available.
- `specManufacturer` / `bidManufacturer` are empty in the snapshot exactly as
  the production adapter emits them (REST returns link ids; the engine reads
  the `…MfrBackup` text fields).
- **Suspected production bug (backlog #6 adjacent):** the snapshot stores
  `thirdPartyItems.productCategories` as linked category *names*
  ("Lamp", "Vanity", …) per the `ThirdPartyItemRow` contract. The production
  adapter (`lib/airtable/fetch.ts`) stringifies the REST link cell, which
  carries record *ids* — so in production `thirdPartyCategoriesCompatible`
  and the lamp-catalog gate likely never match on names. Verify against a
  live fetch before relying on eval numbers for third-party fallback
  behavior; fixing it is an engine change and should be measured here.
- History's Match Type select carries 13 junk options (e.g. "400 Divisadero
  for database") created by past `typecast: true` imports — case selection
  keys on links, not on those names.
