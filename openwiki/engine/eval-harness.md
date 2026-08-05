---
type: Testing Tool
title: Accuracy Eval Harness
description: How the VE engine's substitution accuracy is measured against labeled historical outcomes (leave-one-project-out replay), the metrics it reports, and the CI regression ratchet that enforces it on every PR.
tags: [eval, accuracy, ci, regression-testing, history]
---

# Accuracy Eval Harness

The [recommendation engine](recommendation-engine.md) is
complex enough that a change can quietly regress accuracy for whole classes
of specs. This harness makes that measurable instead of anecdotal: it treats
every linked Airtable **History** row as a labeled outcome ("this spec →
that item, chosen by a real estimator") and replays each one through
`analyzeLineItem` to check whether the engine would have found the same
answer. It is documented in full detail in `docs/EVAL-HARNESS.md`; this page
summarizes the mechanism and code layout.

## How a case is built

A History row becomes a labeled case (`lib/eval/harness.ts`) when all hold:

1. `matchType !== 'NON-ITEM'` (freight lines etc. aren't spec→item outcomes);
2. it links to a resolvable catalog record (Premier or 3rd Party) — the
   linked item's Item ID is the label;
3. its Original Spec is ≥3 characters and not a pasted URL;
4. its project is not quarantined — currently only `'Collective Medspa'`
   (`QUARANTINED_PROJECTS` in `lib/eval/harness.ts`), a mechanics-test export
   of default selections that are not real estimator endorsements.

Rows sharing `(project, normalized spec)` collapse into one case whose label
set is every item chosen for that spec, so a multi-item fulfillment counts as
a hit if the engine surfaces any of its items.

## Leave-one-project-out (LOPO)

Each case runs against an `EngineContext` whose History **excludes every row
from the case's own project** — otherwise the History tier would trivially
return the label from its own row, testing a lookup instead of a prediction.
Cross-project evidence stays available, which is exactly what the
[History matching tiers](recommendation-engine.md#history-matching-tiers)
are meant to exploit. `referenceDate` is pinned to the snapshot's fetch time
so recency weighting is reproducible.

## Metrics

Passthrough cards ("Left as-spec", "Already a Premier item") are set aside;
against the label:

- **top1** — the first substantive recommendation is the label.
- **top3** — the label appears anywhere among the (≤3) substantive
  recommendations.
- **junk** — recommendations were shown, none is the label.
- **silent** — no substantive recommendation at all.
- **autoWrong** — the top card clears `shouldAutoSelect`
  (see [ranking gate](recommendation-engine.md#ranking-dedupe-and-the-auto-select-gate))
  **and** is not the label — the learning-loop-pollution quadrant, since an
  auto-selected wrong answer is exactly what a careless export would write
  back to History.

`top3 + junk + silent = 100%`. Metrics are reported for a **headline** slice
(pipeline classes `'standard'` + `'bulb'`, where a substitution is expected)
plus separate slices for `'tape'`/`'rfi'` lines (engine-intended suppressions,
not scored as failures) and "as-spec" cases (where the labeled outcome IS the
input spec — the correct engine answer there is a passthrough or silence,
which substitution metrics can't credit).

## The ratchet

`npm run eval` (and the vitest guard in `__tests__/eval.test.ts`) compares a
run against the committed `__tests__/eval.baseline.json`:

- fails if any headline metric moves the wrong way beyond 0.25 percentage
  points (top1/top3 down, junk/silent/autoWrong up), or the case count
  changes;
- fails if the baseline's dataset fingerprint doesn't match the snapshot
  (stale baseline after a snapshot refresh);
- passes on improvement, nudging toward `npm run eval:update`.

This ratchet is what makes `.github/workflows/ci.yml`'s `vitest run` step an
**enforcing** accuracy gate, not an advisory one — no Airtable credentials
are required in CI because the dataset is the committed, frozen snapshot.
See [Testing & CI](../operations/testing-and-ci.md) for the full CI
workflow.

## Files and commands

| File | Role |
|---|---|
| `lib/eval/harness.ts` | Pure core: case construction, LOPO evaluation, metrics, baseline ratchet. No I/O. |
| `lib/eval/dataset.ts` | Snapshot load/save (gzip), sha256 fingerprinting for the ratchet's staleness check. |
| `scripts/eval/run.ts` | CLI entry point for `npm run eval` / `npm run eval:update`. |
| `scripts/eval/fetch-context.ts` | Refreshes `__tests__/eval.context.json.gz` from the live Airtable base (needs `AIRTABLE_PAT`). |
| `__tests__/eval.context.json.gz` + `__tests__/eval.context.meta.json` | The frozen `EngineContext` (full History + all three catalogs) and its plain-JSON provenance mirror (fetch date, row counts, notes). |
| `__tests__/eval.baseline.json` | Committed metrics plus one line per case outcome, so a PR that flips cases shows exactly which ones in its diff. |
| `scripts/build-series-map.ts` | Reads this same snapshot to (re)generate the
[learned series-category map](recommendation-engine.md#learned-series-categories) consumed by the engine. |

Commands (`package.json`):

- `npm run eval` — full run + report + baseline comparison; exits 1 on
  regression.
- `npm run eval -- --failures=25` — also prints the worst misses.
- `npm run eval -- --max-cases=200` — quick deterministic partial run.
- `npm run eval:update` — full run + rewrite the baseline; commit code +
  baseline together, per the change → measure → update → commit workflow.
- `npm run eval:fetch` — refresh the frozen snapshot from live Airtable.

## Current baseline snapshot

The committed `__tests__/eval.baseline.json` (966 headline cases) currently
reports: top1 14.39%, top3 18.12%, junk 40.06%, silent 41.82%, autoWrong
6.11%. This already supersedes the figures `docs/PHASE4-PRIMER.md` recorded
at its Phase 4 kickoff (top1 9.01%, top3 11.28%, junk 45.55%, silent 43.17%,
autoWrong 6.94%) — the gap reflects the family/series-matching tier, learned
series-category map, and null-category junk gate documented above, all of
which had shipped by the time this baseline was generated. Treat both sets of
numbers as point-in-time reference, not a live number — read
`__tests__/eval.baseline.json` and rerun `npm run eval` for the current
figures; the committed baseline is the source of truth, not this page.
