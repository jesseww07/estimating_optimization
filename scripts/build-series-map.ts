/**
 * Series → category knowledge, learned from History (Phase 4 backlog item 4).
 *
 * Reads the frozen eval snapshot (__tests__/eval.context.json.gz) and derives a
 * map from manufacturer SERIES PREFIX → detector category label: every History
 * row that links to a Premier Items record is a real estimator decision whose
 * linked item carries an authoritative Fixture Category. The first token of the
 * ORIGINAL SPEC ("BS100LED-4-SA-HO-…" → "BS100LED") is the series key; when 3+
 * linked rows agree ≥80% on the category, the series is considered known.
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
import { CATEGORY_GROUPS, looksLikeProse, normalizeProductId } from '../lib/engine/matcher';

/** Minimum linked rows for a series to be considered known. */
const MIN_SUPPORT = 3;
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
 * Detector label for a Premier "Fixture Category" value — the inverse of
 * CATEGORY_GROUPS, resolved in a fixed priority order (a category appearing in
 * several groups maps to the most specific label: 'Surface Mount' → Linear).
 */
const LABEL_PRIORITY = [
    'Ceiling Fan', 'Vanity', 'Mirror', 'Pendant', 'Sconce', 'Outdoor Pole',
    'Outdoor', 'Exit/Emergency', 'Recessed', 'Linear', 'Undercabinet', 'Ceiling',
];

function detectorLabelFor(fixtureCategory: string): string | null {
    const cat = fixtureCategory.trim().toLowerCase();
    if (!cat) return null;
    for (const label of LABEL_PRIORITY) {
        if (CATEGORY_GROUPS[label]!.some(g => g.toLowerCase() === cat)) return label;
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

    // key → detector label → supporting row count
    const tally = new Map<string, Map<string, number>>();
    let usableRows = 0;

    for (const row of ctx.history) {
        if (row.matchType === 'NON-ITEM') continue;
        if (looksLikeProse(row.originalSpec)) continue;   // prose first words aren't series
        const premier = row.premierLinkIds[0] ? premierById.get(row.premierLinkIds[0]) : undefined;
        if (!premier) continue;                            // only Premier links carry the exact category vocabulary
        const label = detectorLabelFor(premier.fixtureCategory);
        if (!label) continue;
        const key = seriesKeyOf(row.originalSpec);
        if (!key) continue;

        usableRows++;
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
        ' * Bid Item links to a Premier Items record (the linked item\'s Fixture',
        ' * Category is the ground truth). See the script header for the rules.',
        ' *',
        ` * Source snapshot: fetched ${snapshot.meta.fetchedAt} (${snapshot.meta.counts.history} history rows)`,
        ` * Series learned: ${entries.length} (from ${usableRows} usable linked rows;`,
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
    for (const e of entries) console.log(`  ${e.key} → ${e.label} (${e.support}/${e.total})`);
}

main();
