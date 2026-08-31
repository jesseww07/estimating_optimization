/**
 * Series → category knowledge, learned from History (Phase 4 backlog item 4).
 *
 * Reads the frozen eval snapshot (__tests__/eval.context.json.gz) and derives a
 * map from manufacturer SERIES PREFIX → detector category label: every History
 * row that links to a catalog record is a real estimator decision whose linked
 * item carries an authoritative category. The first token of the ORIGINAL SPEC
 * ("BS100LED-4-SA-HO-…" → "BS100LED") is the series key; when MIN_SUPPORT
 * linked rows agree ≥80% on the category, the series is considered known.
 *
 * BOTH catalogs are evidence. The two sides speak different vocabularies and
 * resolve differently:
 *
 *   Premier Items  — "Fixture Category" singleSelect, one value per item,
 *                    inverted through CATEGORY_GROUPS by LABEL_PRIORITY.
 *   3rd Party      — "Product Categories" linked records, a cell can list
 *                    SEVERAL ("Wall Sconce, Chandelier"), so it is split with
 *                    splitCategoryList and each name resolved through the
 *                    shared taxonomy (groupOfCatalogCategory).
 *
 * Learning from Premier links alone discarded the 1,471 History rows linked to
 * 3rd Party items — and roughly 60% of labeled estimator decisions resolve to a
 * resold third-party item, so the map was built from a minority of the corpus
 * (480 usable rows of 9,479 → 62 series). Adding the third-party side takes it
 * to 653 usable rows → 70 series at support ≥ 3, 129 at support ≥ 2.
 *
 * The map would have categorized all three Largo Station null-category
 * exemplars (S7R → Disk Light → Recessed, BS100LED → Surface Mount → Linear)
 * from data that already existed. It scales with the learning loop: every
 * export adds rows, every snapshot refresh + rerun of this script adds series.
 *
 * Output: lib/engine/series-categories.ts (generated, committed — review the
 * diff like any code change; the eval ratchet measures its effect).
 *
 * Usage: npx tsx scripts/build-series-map.ts   (regenerate after eval:fetch)
 */

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { defaultSnapshotPath, loadSnapshot } from '../lib/eval/dataset';
import { groupOfCatalogCategory, splitCategoryList } from '../lib/engine/categories';
import { CATEGORY_GROUPS, looksLikeProse, normalizeProductId } from '../lib/engine/matcher';

/**
 * Minimum linked rows for a series to be considered known.
 *
 * Lowered 3 → 2 on measurement, not on series count (2026-08-31, third-party
 * widening). Both thresholds were run through `npm run eval` on the frozen
 * snapshot; the difference is the trade each one buys:
 *
 *   support ≥ 3 (70 series):  top1 14.60% top3 18.32% junk 40.58% silent 41.10%
 *                             — 7 flips: 1 win, 6 silent→junk. A bad trade.
 *   support ≥ 2 (129 series): top1 16.87% top3 21.12% junk 41.30% silent 37.58%
 *                             — 48 flips: 28 wins, 20 silent→junk, ZERO
 *                               previously-hit cases lost, autoWrong 8 → 9.
 *
 * Junk rises either way because category coverage rises (49% → 57% of headline
 * cases) and a category-fallback card is scored junk by design — but at
 * support 2 the widening pays for that junk and at support 3 it does not.
 */
const MIN_SUPPORT = 2;
/** Minimum share of rows agreeing on one category label. */
const MIN_AGREEMENT = 0.8;

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
const LABEL_PRIORITY = [
    'Ceiling Fan', 'Vanity', 'Mirror', 'Pendant', 'Sconce', 'Outdoor Pole',
    'Outdoor', 'Exit/Emergency', 'Recessed', 'Linear', 'Undercabinet', 'Ceiling',
];

/** Detector label for a Premier "Fixture Category" value — the inverse of CATEGORY_GROUPS. */
function detectorLabelFor(fixtureCategory: string): string | null {
    const cat = fixtureCategory.trim().toLowerCase();
    if (!cat) return null;
    for (const label of LABEL_PRIORITY) {
        if (CATEGORY_GROUPS[label]!.some(g => g.toLowerCase() === cat)) return label;
    }
    return null;
}

/**
 * Detector label for a 3rd Party "Product Categories" cell. The cell is a
 * linked-record display string that may list several categories, so each name
 * is resolved through the shared taxonomy and the most specific surviving label
 * wins — the same LABEL_PRIORITY tie-break the Premier side uses, so both
 * catalogs vote in one vocabulary. Names outside the fixture labels
 * ("Light Bulb", "Connector / Hardware", "Other / Uncategorized") resolve to
 * null and the row is not evidence, exactly as Premier's "Lamp" is not.
 */
function detectorLabelForCategories(productCategories: string): string | null {
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
function seriesKeyOf(originalSpec: string): string | null {
    const firstToken = originalSpec.trim().split(/[\s\-_/,;:()]+/)[0] ?? '';
    const norm = normalizeProductId(firstToken);
    if (norm.length < 3) return null;             // too short to be a series
    if (!/[a-z]/.test(norm)) return null;         // pure numbers carry no identity
    if (KEY_STOPLIST.has(norm)) return null;      // vocabulary, not identity
    return norm;
}

function main(): void {
    const repoRoot = path.resolve(__dirname, '..');
    const snapshot = loadSnapshot(defaultSnapshotPath(repoRoot));
    const ctx = snapshot.context;
    const premierById = new Map(ctx.premierItems.map(p => [p.id, p]));
    const thirdPartyById = new Map(ctx.thirdPartyItems.map(t => [t.id, t]));

    // key → detector label → supporting row count
    const tally = new Map<string, Map<string, number>>();
    let usableRows = 0;
    let premierRows = 0;
    let thirdPartyRows = 0;

    for (const row of ctx.history) {
        if (row.matchType === 'NON-ITEM') continue;
        if (looksLikeProse(row.originalSpec)) continue;   // prose first words aren't series

        // Premier link preferred, else the 3rd Party link — the same label
        // precedence the eval harness uses to pick a case's ground truth.
        const premier = row.premierLinkIds[0] ? premierById.get(row.premierLinkIds[0]) : undefined;
        const thirdParty = premier ? undefined
            : row.thirdPartyLinkIds[0] ? thirdPartyById.get(row.thirdPartyLinkIds[0]) : undefined;
        if (!premier && !thirdParty) continue;             // unlinked rows carry no ground truth
        const label = premier
            ? detectorLabelFor(premier.fixtureCategory)
            : detectorLabelForCategories(thirdParty!.productCategories);
        if (!label) continue;
        const key = seriesKeyOf(row.originalSpec);
        if (!key) continue;

        usableRows++;
        if (premier) premierRows++; else thirdPartyRows++;
        const labels = tally.get(key) ?? new Map<string, number>();
        labels.set(label, (labels.get(label) ?? 0) + 1);
        tally.set(key, labels);
    }

    const entries: Array<{ key: string; label: string; support: number; total: number }> = [];
    for (const [key, labels] of tally) {
        const total = [...labels.values()].reduce((a, b) => a + b, 0);
        if (total < MIN_SUPPORT) continue;
        const [topLabel, topCount] = [...labels.entries()].sort((a, b) => b[1] - a[1])[0]!;
        if (topCount / total < MIN_AGREEMENT) continue;
        entries.push({ key, label: topLabel, support: topCount, total });
    }
    entries.sort((a, b) => (a.key < b.key ? -1 : 1));

    const lines: string[] = [
        '/**',
        ' * GENERATED FILE — do not edit by hand. Regenerate with:',
        ' *   npx tsx scripts/build-series-map.ts',
        ' *',
        ' * Series prefix → detector category label, learned from History rows whose',
        ' * Bid Item links to a catalog record — Premier Items (its Fixture Category)',
        ' * or 3rd Party Domestic Items (its linked Product Categories, resolved',
        ' * through the shared taxonomy). See the script header for the rules.',
        ' *',
        ` * Source snapshot: fetched ${snapshot.meta.fetchedAt} (${snapshot.meta.counts.history} history rows)`,
        ` * Series learned: ${entries.length} (from ${usableRows} usable linked rows —`,
        ` * ${premierRows} Premier-linked, ${thirdPartyRows} 3rd-party-linked;`,
        ` * support ≥ ${MIN_SUPPORT} rows, agreement ≥ ${MIN_AGREEMENT * 100}%)`,
        ' */',
        '',
        'export const SERIES_CATEGORY_MAP: Record<string, string> = {',
        ...entries.map(e =>
            `    ${JSON.stringify(e.key)}: ${JSON.stringify(e.label)}, // ${e.support}/${e.total} rows`),
        '};',
        '',
    ];

    const outPath = path.join(repoRoot, 'lib', 'engine', 'series-categories.ts');
    writeFileSync(outPath, lines.join('\n'));
    console.log(`Wrote ${entries.length} series to ${outPath}`);
    console.log(`  usable linked rows: ${usableRows} (${premierRows} premier, ${thirdPartyRows} 3rd-party)`);
    for (const e of entries) console.log(`  ${e.key} → ${e.label} (${e.support}/${e.total})`);
}

main();
