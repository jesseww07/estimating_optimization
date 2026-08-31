/**
 * Learning the series → category map, as a pure function of a history corpus.
 *
 * This logic used to live only in scripts/build-series-map.ts, which reads the
 * frozen snapshot once and writes the committed lib/engine/series-categories.ts.
 * It has to live here instead, because TWO callers need it and they need it over
 * DIFFERENT corpora:
 *
 *   scripts/build-series-map.ts — the whole snapshot → the committed map that
 *                                 production runs on.
 *   lib/eval/harness.ts         — one leave-one-project-out fold at a time.
 *
 * ── Why the harness has to rebuild it per fold ───────────────────────────────
 * The eval is leave-one-project-out, but it only ever withheld history ROWS. The
 * series map was a committed artifact built from the WHOLE corpus, so a fold
 * evaluating project P still consulted series knowledge learned from P's own
 * rows. That is the label leaking into the input through a side channel, and it
 * was not small: measured on the frozen snapshot (2026-08-31), 77 of the 129
 * keys in the widened map had support from only ONE project, and hits resting on
 * those keys accounted for 3.93 of a reported 16.87% top1. Widening the map
 * looked like +2.27pp of accuracy and was ~95% measurement artifact.
 *
 * Rebuilding per fold fixes the measurement without costing production anything:
 * a series learned from a single past job is perfectly good knowledge for the
 * NEXT bid — it just cannot be used to score that same job. The alternative
 * (refusing to learn single-project series at all) would have thrown away real
 * knowledge to satisfy an artifact of how we measure.
 *
 * Pure module: no I/O, no env, no Airtable SDK — same contract as the rest of
 * lib/engine.
 */

import { groupOfCatalogCategory, splitCategoryList } from './categories';
import { CATEGORY_GROUPS, looksLikeProse, normalizeProductId } from './matcher';
import type { EngineContext, HistoryRow, PremierItemRow, ThirdPartyItemRow } from '../types';

/** Minimum linked rows for a series to be considered known. */
export const MIN_SUPPORT = 2;
/** Minimum share of those rows agreeing on one category label. */
export const MIN_AGREEMENT = 0.8;

// First tokens that are vocabulary, not series identity — never map keys.
// (Mirrors the GENERIC_MATCH_TOKENS posture in matcher.ts.)
const KEY_STOPLIST = new Set([
    'led', 'light', 'lamp', 'bulb', 'fixture', 'type', 'custom', 'mini',
    'wall', 'ceiling', 'surface', 'recessed', 'pendant', 'sconce', 'vanity',
    'linear', 'strip', 'exit', 'emergency', 'outdoor', 'indoor', 'mount',
    'black', 'white', 'bronze', 'nickel', 'brass', 'chrome',
]);

/**
 * The labels detectFixtureCategory is allowed to return, most specific first (a
 * category appearing in several groups maps to the most specific label:
 * 'Surface Mount' → Linear). Deliberately the 12 FIXTURE labels — the taxonomy
 * also defines 'LED Tape' and 'Light Bulb', but the detector has never emitted
 * those and the pipeline treats tape and lamp lines through their own guards
 * (isLedTape / isBulbLampLine, both upstream of category inference). Learning
 * them here would hand the fixture path a category whose gate admits only tape
 * or only lamps — the exact cross-category swap the Candlewood tuning forbids.
 */
export const LABEL_PRIORITY = [
    'Ceiling Fan', 'Vanity', 'Mirror', 'Pendant', 'Sconce', 'Outdoor Pole',
    'Outdoor', 'Exit/Emergency', 'Recessed', 'Linear', 'Undercabinet', 'Ceiling',
];

/** Detector label for a Premier "Fixture Category" value — the inverse of CATEGORY_GROUPS. */
export function detectorLabelForPremier(fixtureCategory: string): string | null {
    const cat = fixtureCategory.trim().toLowerCase();
    if (!cat) return null;
    for (const label of LABEL_PRIORITY) {
        if (CATEGORY_GROUPS[label]!.some(g => g.toLowerCase() === cat)) return label;
    }
    return null;
}

/**
 * Detector label for a 3rd Party "Product Categories" cell. The cell is a
 * linked-record display string that may list several categories, so each name is
 * resolved through the shared taxonomy and the most specific surviving label
 * wins — the same LABEL_PRIORITY tie-break the Premier side uses, so both
 * catalogs vote in one vocabulary. Names outside the fixture labels ("Light
 * Bulb", "Connector / Hardware", "Other / Uncategorized") resolve to null and
 * the row is not evidence, exactly as Premier's "Lamp" is not.
 */
export function detectorLabelForThirdParty(productCategories: string): string | null {
    const found = new Set<string>();
    for (const entry of splitCategoryList(productCategories)) {
        const group = groupOfCatalogCategory(entry);
        if (group) found.add(group);
    }
    for (const label of LABEL_PRIORITY) {
        if (found.has(label)) return label;
    }
    return null;
}

/** Normalized series key from a spec's first token; null when it carries no identity. */
export function seriesKeyOf(originalSpec: string): string | null {
    const firstToken = (originalSpec || '').trim().split(/[\s\-_/,;:()]+/)[0] ?? '';
    const norm = normalizeProductId(firstToken);
    if (norm.length < 3) return null;             // too short to be a series
    if (!/[a-z]/.test(norm)) return null;         // pure numbers carry no identity
    if (KEY_STOPLIST.has(norm)) return null;      // vocabulary, not identity
    return norm;
}

export interface LearnedSeries {
    key: string;
    label: string;
    /** Rows agreeing on `label`. */
    support: number;
    /** All rows contributing evidence for `key`. */
    total: number;
    /** Distinct projects contributing evidence — provenance, not a filter. */
    projects: number;
}

export interface SeriesLearningResult {
    entries: LearnedSeries[];
    usableRows: number;
    premierRows: number;
    thirdPartyRows: number;
}

type CatalogContext = Pick<EngineContext, 'premierItems' | 'thirdPartyItems'>;

/**
 * Learn series → category from a history corpus. Both catalogs are evidence:
 * a Premier link resolves through "Fixture Category", a 3rd Party link through
 * its linked "Product Categories". Premier wins when a row somehow has both,
 * mirroring the label precedence the eval harness uses to pick ground truth.
 */
export function learnSeriesCategories(history: HistoryRow[], catalogs: CatalogContext): SeriesLearningResult {
    const premierById = new Map<string, PremierItemRow>(catalogs.premierItems.map(p => [p.id, p]));
    const thirdPartyById = new Map<string, ThirdPartyItemRow>(catalogs.thirdPartyItems.map(t => [t.id, t]));

    const tally = new Map<string, Map<string, number>>();
    const keyProjects = new Map<string, Set<string>>();
    let usableRows = 0;
    let premierRows = 0;
    let thirdPartyRows = 0;

    for (const row of history) {
        if (row.matchType === 'NON-ITEM') continue;
        if (looksLikeProse(row.originalSpec)) continue;   // prose first words aren't series

        const premier = row.premierLinkIds[0] ? premierById.get(row.premierLinkIds[0]) : undefined;
        const thirdParty = premier ? undefined
            : row.thirdPartyLinkIds[0] ? thirdPartyById.get(row.thirdPartyLinkIds[0]) : undefined;
        if (!premier && !thirdParty) continue;             // unlinked rows carry no ground truth

        const label = premier
            ? detectorLabelForPremier(premier.fixtureCategory)
            : detectorLabelForThirdParty(thirdParty!.productCategories);
        if (!label) continue;

        const key = seriesKeyOf(row.originalSpec);
        if (!key) continue;

        usableRows++;
        if (premier) premierRows++; else thirdPartyRows++;

        const labels = tally.get(key) ?? new Map<string, number>();
        labels.set(label, (labels.get(label) ?? 0) + 1);
        tally.set(key, labels);

        const projects = keyProjects.get(key) ?? new Set<string>();
        projects.add(row.project);
        keyProjects.set(key, projects);
    }

    const entries: LearnedSeries[] = [];
    for (const [key, labels] of tally) {
        const total = [...labels.values()].reduce((a, b) => a + b, 0);
        if (total < MIN_SUPPORT) continue;
        const [topLabel, topCount] = [...labels.entries()].sort((a, b) => b[1] - a[1])[0]!;
        if (topCount / total < MIN_AGREEMENT) continue;
        entries.push({ key, label: topLabel, support: topCount, total, projects: keyProjects.get(key)?.size ?? 0 });
    }
    entries.sort((a, b) => (a.key < b.key ? -1 : 1));

    return { entries, usableRows, premierRows, thirdPartyRows };
}

/** The learned entries as the flat lookup shape SERIES_CATEGORY_MAP uses. */
export function toSeriesCategoryMap(result: SeriesLearningResult): Record<string, string> {
    const map: Record<string, string> = {};
    for (const e of result.entries) map[e.key] = e.label;
    return map;
}
