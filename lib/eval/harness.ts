/**
 * Accuracy eval harness — batch evaluation of the VE engine against labeled
 * historical outcomes (Phase 3 backlog item 1).
 *
 * The parity suite (__tests__/parity.*) freezes ~10 hand-picked rules; this
 * harness extends that idea to the whole labeled corpus: every History row
 * whose Bid Item is LINKED to a catalog record is a real estimator decision
 * "this spec → that item", i.e. a labeled outcome. We replay each spec through
 * the engine and ask: did it find the item the estimator actually chose?
 *
 * ── Leave-one-project-out (LOPO) ─────────────────────────────────────────────
 * Evaluating a case with its own History row present would be a lookup, not a
 * prediction (the History tier would trivially return the label). Each case
 * therefore runs against a context whose history EXCLUDES every row from the
 * case's own project — simulating "this bid just arrived and has never been
 * exported", while all OTHER projects' history remains available. That is
 * exactly the deployment scenario the learning loop is meant to serve.
 *
 * ── Metric definitions ───────────────────────────────────────────────────────
 * For each case the engine returns up to 3 recommendations; passthrough cards
 * ("Left as-spec", "Already a Premier item") are NOT substitutions and are set
 * aside. Against the label (the linked item id, with the row's Bid Item text
 * accepted as an alias — both via normalizeProductId):
 *
 *   top1    — the FIRST substantive recommendation is the labeled item
 *   top3    — the labeled item appears among the substantive recommendations
 *             (top1 ⊆ top3)
 *   junk    — substantive recommendations were shown but NONE is the label
 *   silent  — no substantive recommendation at all (sub-kinds: passthrough-only,
 *             info-message suppression, true empty)
 *
 * top3 + junk + silent = 100% of cases. Additionally:
 *
 *   autoSelected — the TOP card would be pre-checked by the UI (shouldAutoSelect)
 *   autoWrong    — pre-checked AND not the label: the dangerous quadrant that
 *                  pollutes History via default-selection exports
 *
 * ── Pipeline classes ─────────────────────────────────────────────────────────
 * Lines the engine SUPPRESSES by design (LED tape, RFI placeholders) can carry
 * labels in old imported history, but "silent" is the engine's intended answer
 * there — scoring them as failures would punish working guards. They are
 * tagged 'tape' / 'rfi' and reported separately; the HEADLINE metrics cover
 * classes where a recommendation is expected: 'standard' and 'bulb'.
 *
 * Pure module: no I/O, no env. Dataset loading lives in lib/eval/dataset.ts.
 */

import type { EngineContext, ParsedLineItem, Recommendation } from '../types';
import { analyzeLineItem } from '../engine/recommend';
import {
    isBulbLampLine,
    isLedTape,
    isRfiPlaceholder,
    isUrlLike,
    looksLikeProse,
    normalizeProductId,
    normalizeSpecKey,
} from '../engine/matcher';
import { shouldAutoSelect } from '../engine/ranking';

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Projects excluded from the eval entirely — as labeled cases AND as history
 * evidence for other cases. Add a project here only with a documented reason.
 */
export const QUARANTINED_PROJECTS: Record<string, string> = {
    'Collective Medspa':
        'Mechanics-test export of 2026-07-28: default selections, no Spec Match Confidence. ' +
        'Jesse considers these rows non-endorsements (PHASE3-PRIMER "State as of this primer"); ' +
        'e.g. L7 CANNELE PICTURE LIGHT → FLAIRE 5 LIGHT SEMI-FLUSH MOUNT is a wrong default.',
};

/** Minimum raw Original Spec length for a row to become a case. */
const MIN_SPEC_LENGTH = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

export type PipelineClass = 'standard' | 'bulb' | 'tape' | 'rfi';
export type SpecStyle = 'catalog' | 'prose';
export type Outcome = 'top1' | 'top3' | 'junk' | 'silent';
export type SilentKind = 'passthrough' | 'suppressed' | 'empty';
export type LabelSource = 'premier' | 'third_party';

export interface EvalCase {
    /** Stable content-derived id: project::normSpec (survives re-snapshots). */
    id: string;
    project: string;
    mark: string;
    originalSpec: string;
    manufacturer: string;
    /**
     * The labeled outcome SET: every catalog item the estimators chose for this
     * spec within this project. Usually one; component systems (tape runs:
     * tape + channel + driver + feeds) legitimately carry several — surfacing
     * ANY of them counts as a hit, since the engine has 3 slots per line.
     */
    expectedItems: string[];
    /** Normalized accepted answers: linked item ids + the rows' Bid Item texts. */
    aliases: string[];
    labelSource: LabelSource;
    pipelineClass: PipelineClass;
    specStyle: SpecStyle;
    /** How many History rows collapsed into this case (same project + spec). */
    rowCount: number;
    /** Record id of the first History row backing this case (for tracing). */
    historyRecordId: string;
}

export interface CaseResult {
    evalCase: EvalCase;
    outcome: Outcome;
    silentKind?: SilentKind;
    autoSelected: boolean;
    autoWrong: boolean;
    /** What the engine surfaced (item ids best-first) — for failure reports. */
    surfaced: string[];
    topConfidence?: number;
    topMatchType?: string;
    topSource?: string;
    infoMessage?: string;
}

export interface MetricBlock {
    cases: number;
    top1: number;
    top3: number;
    junk: number;
    silent: number;
    autoSelected: number;
    autoWrong: number;
    /** Rates in percent, 2dp — derived from the counts above. */
    top1Rate: number;
    top3Rate: number;
    junkRate: number;
    silentRate: number;
    autoWrongRate: number;
}

export interface SkippedRows {
    nonItem: number;
    noLink: number;
    danglingLink: number;
    shortSpec: number;
    urlSpec: number;
    quarantined: number;
    duplicate: number;
}

export interface EvalReport {
    /** Headline metrics: pipeline classes where a recommendation is expected (standard + bulb). */
    headline: MetricBlock;
    /** Every case regardless of class. */
    all: MetricBlock;
    byClass: Record<PipelineClass, MetricBlock>;
    bySpecStyle: Record<SpecStyle, MetricBlock>;
    byLabelSource: Record<LabelSource, MetricBlock>;
    byProject: Array<{ project: string } & MetricBlock>;
    skipped: SkippedRows;
    /** Case-level outcomes keyed by case id — the baseline ratchet's unit of diff. */
    caseOutcomes: Record<string, Outcome>;
    results: CaseResult[];
}

// ── Case construction ─────────────────────────────────────────────────────────

const isQuarantined = (project: string): boolean =>
    Object.prototype.hasOwnProperty.call(QUARANTINED_PROJECTS, project.trim());

export interface BuiltCases {
    cases: EvalCase[];
    skipped: SkippedRows;
}

/**
 * Turn linked History rows into labeled eval cases.
 *
 * A row qualifies when it is a real spec→item outcome: not NON-ITEM, carries a
 * link that resolves in the snapshot's catalogs, and its Original Spec is a
 * plausible input (non-empty, not a pasted URL). All rows sharing the same
 * (project, normalized spec) collapse into ONE case whose label set is every
 * linked item chosen for that spec — one bid line, possibly a multi-item
 * fulfillment, one verdict.
 */
export function buildEvalCases(ctx: EngineContext): BuiltCases {
    const skipped: SkippedRows = {
        nonItem: 0, noLink: 0, danglingLink: 0, shortSpec: 0, urlSpec: 0, quarantined: 0, duplicate: 0,
    };
    const premierById = new Map(ctx.premierItems.map(p => [p.id, p]));
    const thirdPartyById = new Map(ctx.thirdPartyItems.map(t => [t.id, t]));

    const byKey = new Map<string, EvalCase>();

    for (const row of ctx.history) {
        if (row.matchType === 'NON-ITEM') { skipped.nonItem++; continue; }

        const premierLink = row.premierLinkIds[0];
        const thirdPartyLink = row.thirdPartyLinkIds[0];
        if (!premierLink && !thirdPartyLink) { skipped.noLink++; continue; }

        // Resolve the label. Premier wins when both exist (mirrors the engine's
        // own History-link resolution order).
        let expectedItemId = '';
        let labelSource: LabelSource = 'premier';
        if (premierLink) {
            expectedItemId = premierById.get(premierLink)?.itemId ?? '';
        }
        if (!expectedItemId && thirdPartyLink) {
            expectedItemId = thirdPartyById.get(thirdPartyLink)?.itemId ?? '';
            labelSource = 'third_party';
        }
        if (!expectedItemId) { skipped.danglingLink++; continue; }

        const spec = row.originalSpec.trim();
        if (spec.length < MIN_SPEC_LENGTH) { skipped.shortSpec++; continue; }
        if (isUrlLike(spec)) { skipped.urlSpec++; continue; }
        if (isQuarantined(row.project)) { skipped.quarantined++; continue; }

        const normSpec = normalizeSpecKey(spec);
        const normLabel = normalizeProductId(expectedItemId);
        const key = `${row.project.trim()}::${normSpec}`;
        const bidAlias = normalizeProductId(row.bidItem);

        const existing = byKey.get(key);
        if (existing) {
            existing.rowCount++;
            skipped.duplicate++;
            // Grow the label set + alias coverage across collapsed rows.
            if (!existing.aliases.includes(normLabel)) {
                existing.aliases.push(normLabel);
                existing.expectedItems.push(expectedItemId);
            }
            if (bidAlias && !existing.aliases.includes(bidAlias)) existing.aliases.push(bidAlias);
            if (labelSource === 'premier') existing.labelSource = 'premier';
            continue;
        }

        const manufacturer = row.specManufacturer || row.specMfrBackup || '';
        const aliases = [normLabel];
        if (bidAlias && !aliases.includes(bidAlias)) aliases.push(bidAlias);

        // Pipeline class, using the SAME predicates (and precedence) the engine
        // applies to the constructed input.
        const pipelineClass: PipelineClass =
            isRfiPlaceholder(row.mark, spec, manufacturer) ? 'rfi'
                : isLedTape(row.mark, spec, manufacturer) ? 'tape'
                    : isBulbLampLine(row.mark, spec, manufacturer) ? 'bulb'
                        : 'standard';

        byKey.set(key, {
            id: key,
            project: row.project.trim(),
            mark: row.mark,
            originalSpec: spec,
            manufacturer,
            expectedItems: [expectedItemId],
            aliases,
            labelSource,
            pipelineClass,
            specStyle: looksLikeProse(spec) ? 'prose' : 'catalog',
            rowCount: 1,
            historyRecordId: row.id,
        });
    }

    return { cases: [...byKey.values()], skipped };
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/** The raw item values a recommendation surfaces, whichever fields carry them. */
function surfacedItems(rec: Recommendation): string[] {
    return [rec.premierItem, rec.bidItem, rec.fanItem].filter((v): v is string => !!v);
}

function recHits(rec: Recommendation, aliasSet: Set<string>): boolean {
    return surfacedItems(rec).some(id => aliasSet.has(normalizeProductId(id)));
}

export interface RunOptions {
    /** Cap on cases (deterministic: cases are sorted by id before capping). 0 = all. */
    maxCases?: number;
    /** Progress callback every `progressEvery` cases (for CLI display). */
    onProgress?: (done: number, total: number) => void;
    progressEvery?: number;
}

/**
 * Run every case through the engine under leave-one-project-out history and
 * score it. Deterministic for a fixed snapshot: cases are processed in sorted
 * id order and the context's referenceDate pins recency weighting.
 */
export function runEval(ctx: EngineContext, built: BuiltCases, opts: RunOptions = {}): EvalReport {
    // Quarantined projects never serve as evidence either.
    const cleanHistory = ctx.history.filter(h => !isQuarantined(h.project));

    let cases = [...built.cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (opts.maxCases && opts.maxCases > 0 && cases.length > opts.maxCases) {
        cases = cases.slice(0, opts.maxCases);
    }

    // Group by project so the LOPO-filtered history is built once per project.
    const byProject = new Map<string, EvalCase[]>();
    for (const c of cases) {
        const list = byProject.get(c.project) ?? [];
        list.push(c);
        byProject.set(c.project, list);
    }

    const results: CaseResult[] = [];
    let done = 0;
    const total = cases.length;
    const progressEvery = opts.progressEvery ?? 100;

    for (const [project, projectCases] of byProject) {
        const lopoCtx: EngineContext = {
            ...ctx,
            history: cleanHistory.filter(h => h.project.trim() !== project),
        };

        for (const c of projectCases) {
            const input: ParsedLineItem = {
                rowIndex: 0,
                section: '',
                mark: c.mark,
                quantity: '',
                manufacturer: c.manufacturer,
                catalogNumber: c.originalSpec,
                rawRow: {},
            };

            const analysis = analyzeLineItem(input, lopoCtx);
            const recs = analysis.recommendations;
            const substantive = recs.filter(r => !r.isPassthrough);
            const aliasSet = new Set(c.aliases);

            let outcome: Outcome;
            let silentKind: SilentKind | undefined;
            if (substantive.length === 0) {
                outcome = 'silent';
                silentKind = recs.length > 0 ? 'passthrough' : analysis.infoMessage ? 'suppressed' : 'empty';
            } else if (recHits(substantive[0]!, aliasSet)) {
                outcome = 'top1';
            } else if (substantive.some(r => recHits(r, aliasSet))) {
                outcome = 'top3';
            } else {
                outcome = 'junk';
            }

            const top = recs[0];
            const autoSelected = shouldAutoSelect(top);
            const autoWrong = autoSelected && !!top && !recHits(top, aliasSet);

            results.push({
                evalCase: c,
                outcome,
                ...(silentKind ? { silentKind } : {}),
                autoSelected,
                autoWrong,
                surfaced: recs.map(r => surfacedItems(r)[0] ?? '').filter(Boolean),
                ...(top ? {
                    topConfidence: top.confidence,
                    topMatchType: top.matchType,
                    topSource: top.source,
                } : {}),
                ...(analysis.infoMessage ? { infoMessage: analysis.infoMessage } : {}),
            });

            done++;
            if (opts.onProgress && (done % progressEvery === 0 || done === total)) {
                opts.onProgress(done, total);
            }
        }
    }

    return buildReport(results, built.skipped);
}

// ── Aggregation ───────────────────────────────────────────────────────────────

const pct = (num: number, den: number): number => (den === 0 ? 0 : Math.round((num / den) * 10000) / 100);

function metricsFor(results: CaseResult[]): MetricBlock {
    const cases = results.length;
    const top1 = results.filter(r => r.outcome === 'top1').length;
    const top3within = results.filter(r => r.outcome === 'top3').length;
    const junk = results.filter(r => r.outcome === 'junk').length;
    const silent = results.filter(r => r.outcome === 'silent').length;
    const autoSelected = results.filter(r => r.autoSelected).length;
    const autoWrong = results.filter(r => r.autoWrong).length;
    const top3 = top1 + top3within;
    return {
        cases, top1, top3, junk, silent, autoSelected, autoWrong,
        top1Rate: pct(top1, cases),
        top3Rate: pct(top3, cases),
        junkRate: pct(junk, cases),
        silentRate: pct(silent, cases),
        autoWrongRate: pct(autoWrong, cases),
    };
}

function buildReport(results: CaseResult[], skipped: SkippedRows): EvalReport {
    const byClassResults: Record<PipelineClass, CaseResult[]> = { standard: [], bulb: [], tape: [], rfi: [] };
    const byStyleResults: Record<SpecStyle, CaseResult[]> = { catalog: [], prose: [] };
    const bySourceResults: Record<LabelSource, CaseResult[]> = { premier: [], third_party: [] };
    const byProjectResults = new Map<string, CaseResult[]>();

    for (const r of results) {
        byClassResults[r.evalCase.pipelineClass].push(r);
        byStyleResults[r.evalCase.specStyle].push(r);
        bySourceResults[r.evalCase.labelSource].push(r);
        const list = byProjectResults.get(r.evalCase.project) ?? [];
        list.push(r);
        byProjectResults.set(r.evalCase.project, list);
    }

    const headlineResults = [...byClassResults.standard, ...byClassResults.bulb];

    const caseOutcomes: Record<string, Outcome> = {};
    for (const r of [...results].sort((a, b) => (a.evalCase.id < b.evalCase.id ? -1 : 1))) {
        caseOutcomes[r.evalCase.id] = r.outcome;
    }

    return {
        headline: metricsFor(headlineResults),
        all: metricsFor(results),
        byClass: {
            standard: metricsFor(byClassResults.standard),
            bulb: metricsFor(byClassResults.bulb),
            tape: metricsFor(byClassResults.tape),
            rfi: metricsFor(byClassResults.rfi),
        },
        bySpecStyle: {
            catalog: metricsFor(byStyleResults.catalog),
            prose: metricsFor(byStyleResults.prose),
        },
        byLabelSource: {
            premier: metricsFor(bySourceResults.premier),
            third_party: metricsFor(bySourceResults.third_party),
        },
        byProject: [...byProjectResults.entries()]
            .map(([project, rs]) => ({ project, ...metricsFor(rs) }))
            .sort((a, b) => b.cases - a.cases),
        skipped,
        caseOutcomes,
        results,
    };
}

// ── Baseline comparison (the regression ratchet) ─────────────────────────────

export interface BaselineMetrics {
    cases: number;
    top1Rate: number;
    top3Rate: number;
    junkRate: number;
    silentRate: number;
    autoWrongRate: number;
}

export interface Baseline {
    datasetFingerprint: string;
    generatedAt: string;
    headline: BaselineMetrics;
    caseOutcomes: Record<string, Outcome>;
}

export function toBaseline(report: EvalReport, datasetFingerprint: string, generatedAt: string): Baseline {
    const h = report.headline;
    return {
        datasetFingerprint,
        generatedAt,
        headline: {
            cases: h.cases,
            top1Rate: h.top1Rate,
            top3Rate: h.top3Rate,
            junkRate: h.junkRate,
            silentRate: h.silentRate,
            autoWrongRate: h.autoWrongRate,
        },
        caseOutcomes: report.caseOutcomes,
    };
}

export interface RegressionCheck {
    ok: boolean;
    /** Human-readable failures (empty when ok). */
    failures: string[];
    /** Cases whose outcome differs from the baseline (informational when ok). */
    flips: Array<{ id: string; from: string; to: string }>;
    /** True when the run beats the baseline somewhere — advisory to re-baseline. */
    improved: boolean;
}

/** Allowed metric drift before the guard fails, in percentage points. */
export const REGRESSION_EPSILON_PP = 0.25;

/**
 * Ratchet: fail on any headline metric moving the WRONG way beyond epsilon
 * (hit rates down, junk/silent/auto-wrong up). Improvements pass — refresh the
 * baseline via `npm run eval:update` to lock them in.
 */
export function checkRegression(report: EvalReport, baseline: Baseline): RegressionCheck {
    const failures: string[] = [];
    const h = report.headline;
    const b = baseline.headline;

    if (h.cases !== b.cases) {
        failures.push(
            `headline case count changed: baseline ${b.cases} → current ${h.cases} ` +
            '(dataset or case-selection change — regenerate the baseline deliberately)',
        );
    }

    const drops: Array<[string, number, number]> = [
        ['top1Rate', b.top1Rate, h.top1Rate],
        ['top3Rate', b.top3Rate, h.top3Rate],
    ];
    for (const [name, base, cur] of drops) {
        if (cur < base - REGRESSION_EPSILON_PP) {
            failures.push(`${name} regressed: ${base}% → ${cur}%`);
        }
    }
    const rises: Array<[string, number, number]> = [
        ['junkRate', b.junkRate, h.junkRate],
        ['silentRate', b.silentRate, h.silentRate],
        ['autoWrongRate', b.autoWrongRate, h.autoWrongRate],
    ];
    for (const [name, base, cur] of rises) {
        if (cur > base + REGRESSION_EPSILON_PP) {
            failures.push(`${name} regressed: ${base}% → ${cur}%`);
        }
    }

    const flips: RegressionCheck['flips'] = [];
    for (const [id, outcome] of Object.entries(report.caseOutcomes)) {
        const was = baseline.caseOutcomes[id];
        if (was && was !== outcome) flips.push({ id, from: was, to: outcome });
    }

    const improved =
        h.top1Rate > b.top1Rate + REGRESSION_EPSILON_PP ||
        h.top3Rate > b.top3Rate + REGRESSION_EPSILON_PP ||
        h.junkRate < b.junkRate - REGRESSION_EPSILON_PP ||
        h.silentRate < b.silentRate - REGRESSION_EPSILON_PP ||
        h.autoWrongRate < b.autoWrongRate - REGRESSION_EPSILON_PP;

    return { ok: failures.length === 0, failures, flips, improved };
}
