# Phase 4 Kickoff Primer — Spec Identification

> For a fresh Claude session. Written 2026-07-30, immediately after PR #6 merged
> (`main` @ `ef3e3ab`: eval harness + CI + first identification fixes, deployed
> to production). Read `docs/PHASE3-PRIMER.md` for the app map and conventions
> and `docs/EVAL-HARNESS.md` for the measurement contract — both still hold.
> This primer carries ONLY what Phase 4 needs: the mission, the evidence, and
> the prioritized plan.

## The mission (Jesse's direction, ownership meeting + Largo Station test)

The substitution database can only be as useful as identification of the item
it is substituting FOR. Live tests keep producing "near misses that should be
easy dunks" and "total misses / weird recommendations" whose root cause is the
same: the engine never figured out WHAT the spec item is. Phase 4 is entirely
about closing that gap. The eval harness exists so every change here is
measured; current baseline (966 substitution cases): top1 9.01%, top3 11.28%,
junk 45.55%, silent 43.17%, autoWrong 6.94%.

## The Largo Station evidence (test of 2026-07-30, engine @ PR #6)

Jesse ran the post-#6 production app against the Largo Station bid ("BLANK BID
FORM" sheet) and compared with what estimators actually bid (the workbook's
"07-31-26 AP" sheet). Files are NOT committed (the bid workbook carries
internal pricing and the repo is public); the ground-truth pairs below are
extracted from it. Google identified each spec from exactly the manufacturer +
catalog # the tool had already parsed — identification failed downstream of
parsing.

Ground truth (mark · spec → what Premier actually bid):

| Mark | Spec | Actually bid | Engine @ #6 showed |
|---|---|---|---|
| BA (qty 205) | PHILIPS `S7R835K10AL` (7" SlimSurface LED downlight, 3500K, 1000 lm) | `R-SLIM-DISK-12W-5CCT-WH` (+ `R-SLIM-TRIM-SN`) | **The right item, #1 card — but partial@45, not pre-checked** |
| BD (qty 14) | HE WILLIAMS `75L-4-L50/835-AF12125-EM/10WLP-DIM-UNV` (4-ft narrow flat-lens strip) | `LIN-UD-2INCH-4FT-20/30/40/50W-FINISH*` (+ `LIN-UD-EM`) | EFS/EFV wraps @ 18% (closest IN-CATALOG family; see coverage note) |
| BF (qty 20) | PHILIPS `FSW-4-30L-835-UNV-DIM` (4-ft wrap) | `EFS-001-LED40-PATU-MV-WH-O-DIM-4FT` | EFS-003-LED20 @ 31% top |
| BH (qty 6) | BEGHELLI `BS100LED-4-HT-VLO-WT35-120-277` (4-ft vapor-tight) | `EFV-002-LED40-PATU-MV-WH-O-DIM-4FT` | **Pole/pier heads @ 30–45% — total category miss** |
| BS (qty 62) | FC Lighting `FCW3052/FCW3062` | `GC-BLK-14-E-24/32/40W-3CCT-BK` | (not re-tested; freeze it too) |
| PA/CA (qty 6/54) | HE WILLIAMS `6DR` 6" downlight | `TJRECFRAME-R` + `REC-TJ-20/25/36W-…` + `TRIM-TJ--6R-…` (multi-item) | — |
| EM / X1 | Paco PEH T20 / PX (Beghelli) | `GCEM-G2` / `GCEXITEM-G2` | — |

`detectFixtureCategory` returns **null for BA, BD, and BH**. That single fact
drives most of what follows.

## Why each one missed (verified mechanically against the frozen snapshot)

1. **BH — the answer was in History four times and the engine threw it away.**
   Snapshot History holds `BS100LED-4-SA-HO-WT40-120-277-SM-EMG` →
   `EFV-002-LED40-PATU-MV-WH-O-DIM-4FT` (linked) 3× on Flourney Research Park,
   plus `BS100LED-PG-4HT-HO-WT30-…` → `EFV-002-LED75-…` on Saturday. Largo's
   spec is the same series, different options. The history tier DOES build the
   candidate (`calculateCatalogMatchScore` ≈ 43 on shared tokens) — then
   `trueMatchingSwaps` requires **exact normalized-key equality**, finds zero,
   and `continue`s. Family evidence contributes nothing today, by construction
   (`recommend.ts`, the `trueMatchingSwaps` filter).
2. **BA — same mechanism.** History holds `S7R-8-27K-10-ZI0U`,
   `S7R-8-35K-10-Z10U`, `S7R-8-30K-10` → `R-SLIM-DISK-12W-5CCT-WH` (and
   `-MULTIDIM-` variants) across Diamond View, COTTONWOOD, YWCA, Cupertino.
   Normalized, Largo's `s7r835k10al` shares a 9-char prefix with Cupertino's
   `s7r835k10z10u` — but equality fails, so 4+ prior decisions were invisible
   and the right item arrived only via the 45-capped most-used fallback.
   Note: PR #6's single-token junk gate also zeroed the *accidental* substring
   score this pair used to get — family matching must be purpose-built
   (series/prefix-aware), not substring-accidental.
3. **BD — catalog coverage, not matching.** `LIN-UD-2INCH-4FT-…` (the item
   actually bid) does **not exist in the Premier Items snapshot** (likely a
   custom/templated SKU — note the `FINISH*` placeholder). No engine change
   can surface an item that isn't in the catalog. The EFS wraps at 18% were
   the closest in-catalog family. Two consequences: (a) flag off-catalog bids
   as an Airtable hygiene issue (they also weaken eval labels — unlinked
   rows), (b) an attribute-scoring tier would still have lifted the honest
   in-catalog candidates well above 18% (4FT ✓, 3500K-in-tunable-range ✓,
   strip/wrap family ✓).
4. **BH's junk had a second enabler:** with `inferredCategory === null` there
   is no category gate on Premier-direct, so 43%-grade token matches
   (`…-100-…` tokens) surfaced **pole/pier heads** for a vapor-tight linear —
   three different fixture types with near-identical confidences. Cross-
   category junk under a null category is its own fixable failure mode.

## Phase 4 backlog (prioritized; each measured with `npm run eval`)

1. **Freeze the Largo exemplars first.** Add the table above as tuning/parity
   cases (synthetic contexts pinning: BA → R-SLIM family surfaced with real
   confidence; BH → EFV family, never pole heads; BD → EFS/EFV as best
   in-catalog answer). They are the acceptance tests for everything below.
2. **Family/series history matching — the single biggest win.** Sub-
   authoritative tier: history rows whose ORIGINAL SPEC matches the input at
   family level (shared normalized prefix ≥ N chars, or high
   `calculateCatalogMatchScore` with ≥2 significant tokens) and whose bid
   target agrees across rows/projects → a real recommendation at graduated
   confidence (e.g. 55–75, below the 95 authoritative floor; matchType
   'fuzzy' so auto-select applies only when it clears 50 honestly). This alone
   pre-selects BA and BH correctly from existing data. Guard against
   overreach: family key must not be so short it merges different products
   (measure junk/autoWrong; the harness's flip diff is the reviewer).
3. **Attribute extraction + scoring layer.** Decode the option grammar both
   ways (spec AND catalog item ids/descriptions): lengths (`-4-`/`4FT`),
   CCT (`835`/`35K`/`30K`/`5CCT`/`PATU` tunable), lumens (`K10`≈1000 lm,
   `L50`≈5000 lm, `30L`), wattage tokens, CRI, voltage (`UNV`/`MV`/`120-277`),
   environment (`VLO`, `HT`, vapor-tight, wet). Use agreement to (a) raise
   direct-tier and fallback confidence past the 45/60 caps when size+CCT+lumens
   align (BA-type: 45 → 70+, pre-checkable), (b) hard-gate contradictions
   (a 2700K-only item for a 5000K spec). Extend `extractLampAttributes`'s
   pattern to fixtures rather than inventing a parallel system.
4. **Series → category knowledge, learned from History.** Build (offline,
   from the snapshot) a series-prefix → linked-item-category map: `BS100LED`
   → Surface Mount (vapor family), `S7R` → Disk Light, `LNC` → wall pack, etc.
   Curated additions welcome, but the History-derived map scales with the
   learning loop and would have categorized all three exemplars. Feed it into
   `detectFixtureCategory` ahead of the regex chains.
5. **Null-category junk gate.** When `inferredCategory` is null, weak
   Item-ID-only matches (< ~55 idScore) should not surface cross-category
   cards at 40+ confidence (BH's pole heads). Measure — expect junk ↓ with
   silence ↑ on unknowns, which the identify flow should then absorb.
6. **Catalog/label hygiene (Airtable side).** Off-catalog bid items
   (`LIN-UD-2INCH-4FT`) get no links → invisible to eval and to future
   history matching. Surface a list of unlinked high-frequency bid items from
   the snapshot for Jesse to add/link in Airtable; refresh the eval snapshot
   after (`npm run eval:fetch`, needs `AIRTABLE_PAT`; else the MCP pull recipe
   from the 2026-07-29 session).
7. **Carried over from Phase 3, still open:** schedule↔bid-sheet join (the
   3rd & Flower Type-column loss — biggest ceiling for decorative lines);
   surfacing "Look up spec" when top confidence < auto-select bar; verify the
   suspected `fetch.ts` productCategories ids-vs-names bug (EVAL-HARNESS.md
   data notes); Spec Match Confidence consumption (P3 backlog #5); threshold
   normalization (P3 #8).

## Measurement contract (unchanged, now enforced)

Every engine change ships as: change → `npm run eval` → review the case-flip
diff → `npm run eval:update` → commit code + baseline together. CI
(`.github/workflows/ci.yml`) runs typecheck + lint + vitest (incl. the eval
ratchet) on every PR and push to `main`; Vercel builds/deploys separately.
Auto-select stays conservative: never widen `shouldAutoSelect` to make a
number move — earn confidence through evidence (family history, attribute
agreement), not threshold inflation. Expect item 2 to raise headline top1
several points on its own (the S7R/BS100LED patterns are common); expect item
5 to trade junk for silence.

## State / conventions carry-over

- `main` @ `ef3e3ab` (PR #6 squash: harness + CI + 3rd & Flower fixes), live
  on production. 109 tests green. Eval baseline as in the header above.
- Branch convention unchanged (session's designated branch; squash-merge;
  committer email `noreply@anthropic.com`; after a merge, restart the branch
  from `origin/main`). The stop-hook may false-positive on GitHub's own merge
  commit (committer `noreply@github.com`) right after a merge — re-pushing the
  restarted branch resolves it; never amend merged history.
- Test files: parse / tuning / parity / writeback / identify / export / eval.
  `npx vitest run` ≈ 60s (eval guard dominates). `npm run eval -- --failures=N`
  prints worst misses. Node in Bash is v22 — `tsx` is the script runner.
- Eval snapshot is frozen 2026-07-29; it already contains the Flourney/
  Saturday/Diamond View history rows cited above (verify with a quick
  normalizeSpecKey grep before building on them). Largo's own export will add
  labeled rows once bid through the tool — re-fetch before re-baselining if so.
- The Airtable MCP connector can rebuild the snapshot without a PAT (per-slice
  paging + transcript extraction; see the 2026-07-29 session summary in PR #6)
  — but prefer `npm run eval:fetch` when a PAT is available.
