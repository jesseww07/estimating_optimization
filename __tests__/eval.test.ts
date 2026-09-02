/**
 * Accuracy eval — harness unit tests + the baseline regression guard.
 *
 * Two layers:
 *   1. Pure unit tests on synthetic contexts (always run): case construction,
 *      leave-one-project-out isolation, and the regression ratchet itself.
 *   2. The guard: replays the full frozen dataset (__tests__/eval.context.json.gz)
 *      and fails when any headline metric regresses vs the committed baseline
 *      (__tests__/eval.baseline.json). Skipped with a notice when the snapshot
 *      isn't present (it ships in-repo; `npm run eval:fetch` regenerates it).
 *
 * Workflow after an intentional engine change:
 *   npm run eval            # see metrics + case flips
 *   npm run eval:update     # accept the new numbers as the baseline
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import type { EngineContext, HistoryRow, PremierItemRow } from '@/lib/types';
import {
    buildEvalCases,
    checkRegression,
    runEval,
    toBaseline,
    QUARANTINED_PROJECTS,
    type Baseline,
} from '@/lib/eval/harness';
import {
    defaultBaselinePath,
    defaultSnapshotPath,
    fingerprintFile,
    loadSnapshot,
} from '@/lib/eval/dataset';

// ── Synthetic context helpers ─────────────────────────────────────────────────

const historyRow = (o: Partial<HistoryRow>): HistoryRow => ({
    id: 'recH000000000000',
    mark: 'X9',
    bidItem: '',
    originalSpec: '',
    project: '',
    bidDate: '',
    specManufacturer: '',
    bidManufacturer: '',
    specMfrBackup: '',
    bidMfrBackup: '',
    matchType: 'EXACT',
    productCategory: '',
    specDescription: '',
    specEnrichConfidence: '',
    premierLinkIds: [],
    thirdPartyLinkIds: [],
    ...o,
});

const premierItem = (o: Partial<PremierItemRow>): PremierItemRow => ({
    id: 'recP000000000000',
    itemId: '',
    fixtureCategory: '',
    itemDescription: '',
    finish: '',
    colorTemp: '',
    maxWattage: '',
    lightOutput: '',
    timesUsed: 0,
    ...o,
});

const ctxWith = (history: HistoryRow[], premierItems: PremierItemRow[]): EngineContext => ({
    history,
    premierItems,
    thirdPartyItems: [],
    fans: [],
    referenceDate: '2026-07-29T00:00:00.000Z',
});

const QUARANTINED_NAME = Object.keys(QUARANTINED_PROJECTS)[0]!;

// ── 1. Case construction ──────────────────────────────────────────────────────

describe('eval harness — case construction', () => {
    const premier = premierItem({ id: 'recP1AAAAAAAAAAA', itemId: 'GC-TEST-1' });

    it('turns a linked EXACT row into a labeled case; unlinked and NON-ITEM rows are skipped', () => {
        const ctx = ctxWith([
            historyRow({ id: 'recA', project: 'Alpha', originalSpec: 'ABC-123-XYZ', bidItem: 'GC-TEST-1', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
            historyRow({ id: 'recB', project: 'Alpha', originalSpec: 'NOLINK-1', bidItem: 'SOMETHING' }),
            historyRow({ id: 'recC', project: 'Alpha', originalSpec: 'ABC-123-XYZ', bidItem: 'freight', matchType: 'NON-ITEM', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
        ], [premier]);

        const { cases, skipped } = buildEvalCases(ctx);
        expect(cases).toHaveLength(1);
        expect(cases[0]!.expectedItems).toEqual(['GC-TEST-1']);
        expect(cases[0]!.aliases).toContain('gctest1');
        expect(skipped.noLink).toBe(1);
        expect(skipped.nonItem).toBe(1);
    });

    it('a multi-item fulfillment (one spec, several linked items) is ONE case with a label set', () => {
        const premier2 = premierItem({ id: 'recP2BBBBBBBBBBB', itemId: 'GC-CHANNEL-9' });
        const ctx = ctxWith([
            historyRow({ id: 'rec1', project: 'Alpha', originalSpec: 'TAPE-SYS-100', bidItem: 'GC-TEST-1', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
            historyRow({ id: 'rec2', project: 'Alpha', originalSpec: 'TAPE-SYS-100', bidItem: 'GC-CHANNEL-9', premierLinkIds: ['recP2BBBBBBBBBBB'] }),
        ], [premier, premier2]);

        const { cases } = buildEvalCases(ctx);
        expect(cases).toHaveLength(1);
        expect(cases[0]!.expectedItems.sort()).toEqual(['GC-CHANNEL-9', 'GC-TEST-1']);
        expect(cases[0]!.rowCount).toBe(2);
    });

    it('collapses repeat rows of the same (project, spec, label) and counts them', () => {
        const ctx = ctxWith([
            historyRow({ id: 'rec1', project: 'Alpha', originalSpec: 'ABC-123-XYZ', bidItem: 'GC-TEST-1', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
            historyRow({ id: 'rec2', project: 'Alpha', originalSpec: 'abc 123 xyz', bidItem: 'GC-TEST-1', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
            historyRow({ id: 'rec3', project: 'Beta', originalSpec: 'ABC-123-XYZ', bidItem: 'GC-TEST-1', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
        ], [premier]);

        const { cases, skipped } = buildEvalCases(ctx);
        expect(cases).toHaveLength(2); // Alpha (collapsed) + Beta
        const alpha = cases.find(c => c.project === 'Alpha')!;
        expect(alpha.rowCount).toBe(2);
        expect(skipped.duplicate).toBe(1);
    });

    it('skips dangling links, URL specs, and quarantined projects — with reasons counted', () => {
        const ctx = ctxWith([
            historyRow({ id: 'rec1', project: 'Alpha', originalSpec: 'DEF-456', bidItem: 'X', premierLinkIds: ['recMISSING000000'] }),
            historyRow({ id: 'rec2', project: 'Alpha', originalSpec: 'https://example.com/spec.pdf', bidItem: 'GC-TEST-1', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
            historyRow({ id: 'rec3', project: QUARANTINED_NAME, originalSpec: 'ABC-123-XYZ', bidItem: 'GC-TEST-1', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
        ], [premier]);

        const { cases, skipped } = buildEvalCases(ctx);
        expect(cases).toHaveLength(0);
        expect(skipped.danglingLink).toBe(1);
        expect(skipped.urlSpec).toBe(1);
        expect(skipped.quarantined).toBe(1);
    });

    it('tags pipeline classes with the engine predicates (tape example)', () => {
        const ctx = ctxWith([
            historyRow({ id: 'rec1', project: 'Alpha', mark: 'TAPE1', originalSpec: 'DI-24V-BLBSC1-30-100', specMfrBackup: 'Diode LED', bidItem: 'GC-TEST-1', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
            historyRow({ id: 'rec2', project: 'Alpha', originalSpec: 'ABC-123-XYZ', bidItem: 'GC-TEST-1', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
        ], [premier]);

        const { cases } = buildEvalCases(ctx);
        expect(cases.find(c => c.mark === 'TAPE1')?.pipelineClass).toBe('tape');
        expect(cases.find(c => c.mark === 'X9')?.pipelineClass).toBe('standard');
    });
});

// ── 2. Leave-one-project-out ──────────────────────────────────────────────────

describe('eval harness — leave-one-project-out evaluation', () => {
    const premier = premierItem({ id: 'recP1AAAAAAAAAAA', itemId: 'GC-TEST-1' });

    it('cross-project history evidence produces a hit; own-project rows are excluded', () => {
        // Alpha and Beta both swapped this spec to GC-TEST-1. Evaluating Alpha's
        // case, Beta's row remains as evidence → the History tier should hit.
        const ctx = ctxWith([
            historyRow({ id: 'rec1', project: 'Alpha', originalSpec: 'ABC-123-XYZ', bidItem: 'GC-TEST-1', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
            historyRow({ id: 'rec2', project: 'Beta', originalSpec: 'ABC-123-XYZ', bidItem: 'GC-TEST-1', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
        ], [premier]);

        const built = buildEvalCases(ctx);
        const report = runEval(ctx, built);
        expect(report.caseOutcomes['Alpha::abc123xyz']).toBe('top1');
        expect(report.caseOutcomes['Beta::abc123xyz']).toBe('top1');
    });

    it('a spec whose ONLY history evidence is its own project cannot hit via lookup', () => {
        const ctx = ctxWith([
            historyRow({ id: 'rec1', project: 'Gamma', originalSpec: 'ZZZ-999-QQQ', bidItem: 'GC-TEST-1', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
        ], [premier]);

        const built = buildEvalCases(ctx);
        const report = runEval(ctx, built);
        const result = report.results[0]!;
        expect(result.outcome).not.toBe('top1');
        expect(result.outcome).not.toBe('top3');
        expect(result.topSource ?? '').not.toBe('History');
    });
});

// ── 3. Regression ratchet ─────────────────────────────────────────────────────

describe('eval harness — regression ratchet', () => {
    const premier = premierItem({ id: 'recP1AAAAAAAAAAA', itemId: 'GC-TEST-1' });
    const ctx = ctxWith([
        historyRow({ id: 'rec1', project: 'Alpha', originalSpec: 'ABC-123-XYZ', bidItem: 'GC-TEST-1', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
        historyRow({ id: 'rec2', project: 'Beta', originalSpec: 'ABC-123-XYZ', bidItem: 'GC-TEST-1', premierLinkIds: ['recP1AAAAAAAAAAA'] }),
    ], [premier]);

    it('identical run vs its own baseline passes with no flips', () => {
        const report = runEval(ctx, buildEvalCases(ctx));
        const baseline = toBaseline(report, 'fp', '2026-07-29');
        const check = checkRegression(report, baseline);
        expect(check.ok).toBe(true);
        expect(check.flips).toHaveLength(0);
        expect(check.improved).toBe(false);
    });

    it('a dropped hit rate / risen junk rate fails; case flips are reported', () => {
        const report = runEval(ctx, buildEvalCases(ctx));
        const baseline: Baseline = {
            ...toBaseline(report, 'fp', '2026-07-29'),
            headline: { ...toBaseline(report, 'fp', '2026-07-29').headline, top1Rate: 100, junkRate: 0 },
        };
        // Corrupt the baseline's memory of one case so a flip is visible.
        const firstId = Object.keys(report.caseOutcomes)[0]!;
        baseline.caseOutcomes = { ...baseline.caseOutcomes, [firstId]: 'junk' };

        const degraded = { ...report, headline: { ...report.headline, top1Rate: report.headline.top1Rate - 1, junkRate: report.headline.junkRate + 1 } };
        const check = checkRegression(degraded, baseline);
        expect(check.ok).toBe(report.headline.top1Rate - 1 >= 100 - 0.25 && report.headline.junkRate + 1 <= 0.25);
        expect(check.ok).toBe(false);
        expect(check.flips.some(f => f.id === firstId)).toBe(true);
    });

    it('a changed case count fails loudly (dataset drift must be deliberate)', () => {
        const report = runEval(ctx, buildEvalCases(ctx));
        const baseline = toBaseline(report, 'fp', '2026-07-29');
        baseline.headline = { ...baseline.headline, cases: baseline.headline.cases + 5 };
        const check = checkRegression(report, baseline);
        expect(check.ok).toBe(false);
        expect(check.failures.join(' ')).toContain('case count');
    });
});

// ── 4. The full-dataset baseline guard ────────────────────────────────────────

const snapshotPath = defaultSnapshotPath();
const baselinePath = defaultBaselinePath();
const haveDataset = existsSync(snapshotPath) && existsSync(baselinePath);

describe('accuracy eval — frozen dataset vs committed baseline', () => {
    it.skipIf(!haveDataset)(
        'headline metrics do not regress (top1/top3 down, junk/silent/autoWrong up)',
        { timeout: 300_000 },
        () => {
            const snapshot = loadSnapshot(snapshotPath);
            const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as Baseline;

            expect(
                fingerprintFile(snapshotPath),
                'baseline was generated from a different snapshot — rerun `npm run eval:update` after reviewing',
            ).toBe(baseline.datasetFingerprint);

            const report = runEval(snapshot.context, buildEvalCases(snapshot.context));
            const check = checkRegression(report, baseline);

            if (check.flips.length > 0) {
                const shown = check.flips.slice(0, 20).map(f => `  ${f.from} → ${f.to}  ${f.id}`).join('\n');
                console.log(`[eval] ${check.flips.length} case flip(s) vs baseline:\n${shown}`);
            }
            if (check.improved) {
                console.log('[eval] run BEATS the committed baseline — lock it in with `npm run eval:update`.');
            }

            expect(check.failures, check.failures.join('; ')).toEqual([]);
        },
    );

    it.skipIf(haveDataset)('dataset present', () => {
        console.warn(
            `[eval] snapshot or baseline missing (${snapshotPath}) — guard skipped. ` +
            'Generate with `npm run eval:fetch` then `npm run eval:update`.',
        );
        expect(true).toBe(true);
    });
});

describe('eval harness — as-spec case classification', () => {
    const premierX = premierItem({ id: 'recPXAAAAAAAAAAA', itemId: 'ABC-123-XYZ' });
    const premierY = premierItem({ id: 'recPYAAAAAAAAAAA', itemId: 'GC-SWAP-1' });

    it('a case whose only labels are the spec itself is asSpec and leaves the headline', () => {
        const ctx = ctxWith([
            historyRow({ id: 'r1', project: 'Alpha', originalSpec: 'ABC-123-XYZ', bidItem: 'ABC-123-XYZ', premierLinkIds: ['recPXAAAAAAAAAAA'] }),
        ], [premierX]);
        const built = buildEvalCases(ctx);
        expect(built.cases[0]!.asSpec).toBe(true);
        const report = runEval(ctx, built);
        expect(report.headline.cases).toBe(0);
        expect(report.asSpec.cases).toBe(1);
    });

    it('a real swap alongside an as-spec row keeps the case in the headline', () => {
        const ctx = ctxWith([
            historyRow({ id: 'r1', project: 'Alpha', originalSpec: 'ABC-123-XYZ', bidItem: 'ABC-123-XYZ', premierLinkIds: ['recPXAAAAAAAAAAA'] }),
            historyRow({ id: 'r2', project: 'Alpha', originalSpec: 'ABC-123-XYZ', bidItem: 'GC-SWAP-1', premierLinkIds: ['recPYAAAAAAAAAAA'] }),
        ], [premierX, premierY]);
        const built = buildEvalCases(ctx);
        expect(built.cases[0]!.asSpec).toBe(false);
        expect(runEval(ctx, built).headline.cases).toBe(1);
    });
});
