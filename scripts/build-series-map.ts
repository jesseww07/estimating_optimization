/**
 * Series → category knowledge, learned from History (Phase 4 backlog item 4).
 *
 * Reads the frozen eval snapshot and writes lib/engine/series-categories.ts —
 * the map PRODUCTION runs on. The learning rules themselves live in
 * lib/engine/series-learning.ts, because the eval harness needs the same logic
 * over a different corpus: it relearns the map per leave-one-project-out fold so
 * a project is never scored using series knowledge derived from its own rows.
 * See that module's header for the leak this arrangement fixes.
 *
 * Both catalogs are evidence. Learning from Premier links alone discarded the
 * 1,471 History rows linked to 3rd Party items — and roughly 60% of labeled
 * estimator decisions resolve to a resold third-party item, so the map was built
 * from a minority of the corpus (480 usable rows of 9,479 → 62 series).
 *
 * Measured honestly (per-fold relearning, frozen snapshot, 2026-08-31):
 *   support ≥ 3, Premier only:   top1 12.01%  top3 15.22%  junk 40.79%  silent 44.00%
 *   support ≥ 2, both catalogs:  top1 13.04%  top3 16.36%  junk 40.06%  silent 43.58%
 * Better on every metric, with autoWrong flat — no trade-off to weigh.
 *
 * Output is committed. Review the diff like any code change.
 *
 * Usage: npx tsx scripts/build-series-map.ts   (regenerate after eval:fetch)
 */

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { defaultSnapshotPath, loadSnapshot } from '../lib/eval/dataset';
import {
    MIN_AGREEMENT,
    MIN_SUPPORT,
    learnSeriesCategories,
} from '../lib/engine/series-learning';

function main(): void {
    const repoRoot = path.resolve(__dirname, '..');
    const snapshot = loadSnapshot(defaultSnapshotPath(repoRoot));
    const ctx = snapshot.context;

    const { entries, usableRows, premierRows, thirdPartyRows } = learnSeriesCategories(ctx.history, ctx);
    const singleProject = entries.filter(e => e.projects < 2).length;

    const lines: string[] = [
        '/**',
        ' * GENERATED FILE — do not edit by hand. Regenerate with:',
        ' *   npx tsx scripts/build-series-map.ts',
        ' *',
        ' * Series prefix → detector category label, learned from History rows whose',
        ' * Bid Item links to a catalog record — Premier Items (its Fixture Category)',
        ' * or 3rd Party Domestic Items (its linked Product Categories, resolved',
        ' * through the shared taxonomy). Rules live in lib/engine/series-learning.ts.',
        ' *',
        ' * This is the PRODUCTION map, built from the whole corpus. The eval harness',
        ' * does NOT use it — it relearns per leave-one-project-out fold, so that a',
        ' * series learned from one past job (real knowledge for the next bid) cannot',
        ' * be used to score that same job.',
        ' *',
        ` * Source snapshot: fetched ${snapshot.meta.fetchedAt} (${snapshot.meta.counts.history} history rows)`,
        ` * Series learned: ${entries.length} (from ${usableRows} usable linked rows —`,
        ` * ${premierRows} Premier-linked, ${thirdPartyRows} 3rd-party-linked;`,
        ` * support ≥ ${MIN_SUPPORT} rows, agreement ≥ ${MIN_AGREEMENT * 100}%).`,
        ` * ${singleProject} of them rest on a single project — legitimate for the next`,
        ' * bid, and invisible to the eval by construction.',
        ' */',
        '',
        'export const SERIES_CATEGORY_MAP: Record<string, string> = {',
        ...entries.map(e =>
            `    ${JSON.stringify(e.key)}: ${JSON.stringify(e.label)}, // ${e.support}/${e.total} rows, ${e.projects} project${e.projects === 1 ? '' : 's'}`),
        '};',
        '',
    ];

    const outPath = path.join(repoRoot, 'lib', 'engine', 'series-categories.ts');
    writeFileSync(outPath, lines.join('\n'));
    console.log(`Wrote ${entries.length} series to ${outPath}`);
    console.log(`  usable linked rows: ${usableRows} (${premierRows} premier, ${thirdPartyRows} 3rd-party)`);
    console.log(`  single-project series: ${singleProject} (kept for production, invisible to the eval)`);
    for (const e of entries) console.log(`  ${e.key} → ${e.label} (${e.support}/${e.total}, ${e.projects} proj)`);
}

main();
