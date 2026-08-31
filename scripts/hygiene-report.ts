/**
 * Airtable data-hygiene report — a prioritized worklist of things a human
 * should fix in the live base, derived entirely from the frozen eval snapshot.
 *
 *   npx tsx scripts/hygiene-report.ts
 *   npx tsx scripts/hygiene-report.ts --out=some/other/path.md --top=100
 *
 * READ-ONLY. This reads `__tests__/eval.context.json.gz` and writes a markdown
 * file. It never touches Airtable — no SDK, no PAT, no writes. The snapshot is
 * a point-in-time freeze (see the provenance line in the report header), so
 * always confirm a row still looks that way in the live base before editing it.
 *
 * OUTPUT IS NOT COMMITTABLE. This repo is public and the report necessarily
 * contains bid item text, project names, and catalog Item IDs. The default
 * output path is covered by the `hygiene-report.*` rule in `.gitignore`;
 * stdout gets counts only. Keep it that way.
 *
 * What it reports, in the order a human should work it:
 *   1. History rows with no catalog link at all (44.9% of the table), grouped
 *      by normalized Bid Item and split into "the catalog already has this,
 *      just link it" vs "this item does not exist in the catalog yet" — two
 *      different jobs with two different owners.
 *   2. History rows with no Bid Date, summarized per project, because the fix
 *      is a per-project backfill and not a 7,621-row click-through.
 *   3. 3rd Party items with no Product Categories link, ranked by how often
 *      History actually bid them.
 *   4. Premier items with no Fixture Category, same treatment.
 */

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { defaultSnapshotPath, loadSnapshot } from '../lib/eval/dataset';
import { normalizeProductId } from '../lib/engine/matcher';
import type { EngineContext, HistoryRow } from '../lib/types';

// ── CLI args (same shape as scripts/eval/run.ts) ──────────────────────────────

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
};

/** How many rows of each ranked list reach the report. */
const TOP_N = value('top') ? Number(value('top')) : 50;
/**
 * Shortest normalized key allowed to carry a prefix relationship. Below this a
 * "variant of" claim is noise ("emg" prefixes half the catalog).
 */
const MIN_VARIANT_KEY_LEN = 6;

/** Stand-in for a catalog record whose primary Item ID field is empty. */
const BLANK_ITEM_ID = '(blank Item ID)';

// ── Types ─────────────────────────────────────────────────────────────────────

type CatalogSource = 'Premier' | '3rd Party' | 'Fans';

interface CatalogEntry {
    itemId: string;
    sources: CatalogSource[];
}

interface UnlinkedGroup {
    key: string;                       // normalized Bid Item
    label: string;                     // most common raw Bid Item text
    rows: number;
    projects: number;
    /** Catalog record whose Item ID normalizes to exactly this key, if any. */
    exact?: CatalogEntry;
    /** Nearest catalog Item ID that is a prefix of this key (or vice versa). */
    variantOf?: CatalogEntry;
}

interface ProjectDateGap {
    project: string;
    total: number;
    missing: number;
}

interface CatalogGap {
    itemId: string;                    // BLANK_ITEM_ID when the record has no Item ID at all

    description: string;
    extra: string;                     // manufacturer (3rd party) / "Times Used" (premier)
    historyRows: number;
    projects: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const pct = (n: number, of: number): string => (of === 0 ? 'n/a' : `${((100 * n) / of).toFixed(1)}%`);

/** Markdown table cells: kill pipes and newlines, clamp length. */
function cell(text: string, max = 70): string {
    const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isUnlinked(row: HistoryRow): boolean {
    return row.premierLinkIds.length === 0 && row.thirdPartyLinkIds.length === 0;
}

/** Item ID → catalog entry, across all three catalogs, keyed by normalized id. */
function buildCatalogIndex(ctx: EngineContext): Map<string, CatalogEntry> {
    const index = new Map<string, CatalogEntry>();
    const add = (rawId: string, source: CatalogSource): void => {
        const key = normalizeProductId(rawId);
        if (!key) return;
        const existing = index.get(key);
        if (existing) {
            if (!existing.sources.includes(source)) existing.sources.push(source);
            return;
        }
        index.set(key, { itemId: rawId, sources: [source] });
    };
    for (const item of ctx.premierItems) add(item.itemId, 'Premier');
    for (const item of ctx.thirdPartyItems) add(item.itemId, '3rd Party');
    for (const fan of ctx.fans) add(fan.itemNumber, 'Fans');
    return index;
}

/**
 * Catalog keys bucketed by their first MIN_VARIANT_KEY_LEN characters. A prefix
 * relationship in either direction forces those characters to be equal, so this
 * bucket is the complete candidate set — no full scan needed.
 */
function bucketByPrefix(index: Map<string, CatalogEntry>): Map<string, string[]> {
    const buckets = new Map<string, string[]>();
    for (const key of index.keys()) {
        if (key.length < MIN_VARIANT_KEY_LEN) continue;
        const head = key.slice(0, MIN_VARIANT_KEY_LEN);
        const bucket = buckets.get(head);
        if (bucket) bucket.push(key);
        else buckets.set(head, [key]);
    }
    return buckets;
}

/** Longest catalog key that prefixes `key` or is prefixed by it. */
function findVariant(
    key: string,
    buckets: Map<string, string[]>,
    index: Map<string, CatalogEntry>,
): CatalogEntry | undefined {
    if (key.length < MIN_VARIANT_KEY_LEN) return undefined;
    const candidates = buckets.get(key.slice(0, MIN_VARIANT_KEY_LEN));
    if (!candidates) return undefined;
    let best: string | undefined;
    for (const candidate of candidates) {
        if (candidate === key) continue;
        if (!key.startsWith(candidate) && !candidate.startsWith(key)) continue;
        if (!best || candidate.length > best.length) best = candidate;
    }
    return best ? index.get(best) : undefined;
}

// ── Section 1: unlinked History rows ─────────────────────────────────────────

function groupUnlinked(rows: HistoryRow[], index: Map<string, CatalogEntry>): UnlinkedGroup[] {
    const buckets = bucketByPrefix(index);
    const acc = new Map<string, { labels: Map<string, number>; rows: number; projects: Set<string> }>();

    for (const row of rows) {
        const key = normalizeProductId(row.bidItem);
        if (!key) continue;
        const entry = acc.get(key) ?? { labels: new Map<string, number>(), rows: 0, projects: new Set<string>() };
        entry.rows++;
        entry.projects.add(row.project || '(no project)');
        entry.labels.set(row.bidItem, (entry.labels.get(row.bidItem) ?? 0) + 1);
        acc.set(key, entry);
    }

    const groups: UnlinkedGroup[] = [];
    for (const [key, entry] of acc) {
        const label = [...entry.labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
        const exact = index.get(key);
        groups.push({
            key,
            label,
            rows: entry.rows,
            projects: entry.projects.size,
            exact,
            variantOf: exact ? undefined : findVariant(key, buckets, index),
        });
    }
    // Deterministic: rows desc, then key asc.
    groups.sort((a, b) => b.rows - a.rows || a.key.localeCompare(b.key));
    return groups;
}

// ── Section 2: missing Bid Date ──────────────────────────────────────────────

function bidDateGapsByProject(history: HistoryRow[]): ProjectDateGap[] {
    const acc = new Map<string, ProjectDateGap>();
    for (const row of history) {
        const project = row.project || '(no project)';
        const entry = acc.get(project) ?? { project, total: 0, missing: 0 };
        entry.total++;
        if (!row.bidDate.trim()) entry.missing++;
        acc.set(project, entry);
    }
    return [...acc.values()]
        .filter(e => e.missing > 0)
        .sort((a, b) => b.missing - a.missing || a.project.localeCompare(b.project));
}

// ── Sections 3 & 4: catalog rows missing their category link ─────────────────

/** recordId → { rows, projects } for every History link into one catalog. */
function historyUsage(
    history: HistoryRow[],
    pick: (row: HistoryRow) => string[],
): Map<string, { rows: number; projects: Set<string> }> {
    const usage = new Map<string, { rows: number; projects: Set<string> }>();
    for (const row of history) {
        for (const id of pick(row)) {
            const entry = usage.get(id) ?? { rows: 0, projects: new Set<string>() };
            entry.rows++;
            entry.projects.add(row.project || '(no project)');
            usage.set(id, entry);
        }
    }
    return usage;
}

function rankCatalogGaps(gaps: CatalogGap[]): CatalogGap[] {
    return gaps.sort(
        (a, b) => b.historyRows - a.historyRows || b.projects - a.projects || a.itemId.localeCompare(b.itemId),
    );
}

// ── Report ────────────────────────────────────────────────────────────────────

function main(): void {
    const repoRoot = path.resolve(__dirname, '..');
    const snapshot = loadSnapshot(defaultSnapshotPath(repoRoot));
    const ctx = snapshot.context;
    const out = value('out') ?? path.join(repoRoot, 'hygiene-report.md');

    const catalog = buildCatalogIndex(ctx);

    // 1 ── unlinked History rows.
    const unlinked = ctx.history.filter(isUnlinked);
    const nonItem = unlinked.filter(r => r.matchType === 'NON-ITEM');
    const blankBidItem = unlinked.filter(r => !normalizeProductId(r.bidItem));
    // NON-ITEM rows (freight, allowances) are *correctly* unlinked — they are
    // not a hygiene defect and would only pad the worklist. Rows with no Bid
    // Item text at all cannot be grouped or acted on.
    const actionable = unlinked.filter(r => r.matchType !== 'NON-ITEM' && normalizeProductId(r.bidItem));
    const groups = groupUnlinked(actionable, catalog);
    const linkable = groups.filter(g => g.exact);
    const missing = groups.filter(g => !g.exact);
    const linkableRows = linkable.reduce((sum, g) => sum + g.rows, 0);
    const missingRows = missing.reduce((sum, g) => sum + g.rows, 0);
    const variants = missing.filter(g => g.variantOf);
    const variantRows = variants.reduce((sum, g) => sum + g.rows, 0);

    // 2 ── missing Bid Date.
    const dateGaps = bidDateGapsByProject(ctx.history);
    const missingDateRows = ctx.history.filter(r => !r.bidDate.trim()).length;
    const fullyUndated = dateGaps.filter(g => g.missing === g.total);
    const top10ProjectRows = dateGaps.slice(0, 10).reduce((sum, g) => sum + g.missing, 0);

    // 3 ── 3rd Party items with no Product Categories link.
    const thirdPartyUsage = historyUsage(ctx.history, r => r.thirdPartyLinkIds);
    const thirdPartyGaps = rankCatalogGaps(
        ctx.thirdPartyItems
            .filter(item => !item.productCategories.trim())
            .map(item => {
                const use = thirdPartyUsage.get(item.id);
                return {
                    itemId: item.itemId.trim() || BLANK_ITEM_ID,
                    description: item.itemDescription,
                    extra: item.manufacturer,
                    historyRows: use?.rows ?? 0,
                    projects: use?.projects.size ?? 0,
                };
            }),
    );
    const thirdPartyBid = thirdPartyGaps.filter(g => g.historyRows > 0);
    const thirdPartyBidRows = thirdPartyBid.reduce((sum, g) => sum + g.historyRows, 0);
    const thirdPartyBlankId = thirdPartyGaps.filter(g => g.itemId === BLANK_ITEM_ID).length;

    // 4 ── Premier items with no Fixture Category.
    const premierUsage = historyUsage(ctx.history, r => r.premierLinkIds);
    const premierGaps = rankCatalogGaps(
        ctx.premierItems
            .filter(item => !item.fixtureCategory.trim())
            .map(item => {
                const use = premierUsage.get(item.id);
                return {
                    itemId: item.itemId.trim() || BLANK_ITEM_ID,
                    description: item.itemDescription,
                    extra: `${item.timesUsed}`,
                    historyRows: use?.rows ?? 0,
                    projects: use?.projects.size ?? 0,
                };
            }),
    );
    const premierBid = premierGaps.filter(g => g.historyRows > 0);
    const premierBidRows = premierBid.reduce((sum, g) => sum + g.historyRows, 0);
    const premierBlankId = premierGaps.filter(g => g.itemId === BLANK_ITEM_ID).length;

    /** Empty primary field = an empty record someone should delete, not categorize. */
    const blankIdNote = (n: number, table: string): string =>
        n === 0 ? '' : ` ${n} of them also have a blank **Item ID** — those are empty ${table} records, delete rather than categorize.`;

    // ── Markdown ─────────────────────────────────────────────────────────────
    const md: string[] = [];
    const p = (line = ''): void => void md.push(line);

    p('# Airtable hygiene worklist');
    p();
    p('> Generated by `npx tsx scripts/hygiene-report.ts` from the frozen eval');
    p('> snapshot — **read-only, point-in-time, never committed** (this repo is');
    p('> public; the file is gitignored). Confirm each row in the live base');
    p('> before editing: the snapshot may have drifted.');
    p();
    p(`Snapshot: fetched ${snapshot.meta.fetchedAt} from ${snapshot.meta.baseId} via ${snapshot.meta.source}`);
    p(
        `History ${ctx.history.length} · Premier ${ctx.premierItems.length} · ` +
        `3rd Party ${ctx.thirdPartyItems.length} · Fans ${ctx.fans.length}`,
    );
    p();
    p('## Summary');
    p();
    p('| # | Gap | Size | Payoff if fixed |');
    p('|---|---|---|---|');
    p(
        `| 1a | Unlinked History rows whose Bid Item **already matches a catalog Item ID** | ` +
        `${linkableRows} rows / ${linkable.length} items | ${linkableRows} rows become labeled ` +
        `evidence for the History tier and the eval harness — one link click each |`,
    );
    p(
        `| 1b | Unlinked History rows with **no catalog record to link to** | ` +
        `${missingRows} rows / ${missing.length} items | catalog coverage; ${variantRows} of those ` +
        `rows (${variants.length} items) look like option-variants of an item the catalog already has |`,
    );
    p(
        `| 2 | History rows with **no Bid Date** | ${missingDateRows} rows ` +
        `(${pct(missingDateRows, ctx.history.length)}) across ${dateGaps.length} projects | ` +
        `recency weighting starts working; ${fullyUndated.length} projects are 100% undated, and the ` +
        `10 worst alone account for ${top10ProjectRows} rows |`,
    );
    p(
        `| 3 | 3rd Party items with **no Product Categories link** | ${thirdPartyGaps.length} items ` +
        `(${pct(thirdPartyGaps.length, ctx.thirdPartyItems.length)}) | category fallback can reach them; ` +
        `${thirdPartyBid.length} have been bid before (${thirdPartyBidRows} History rows) — do those first |`,
    );
    p(
        `| 4 | Premier items with **no Fixture Category** | ${premierGaps.length} items ` +
        `(${pct(premierGaps.length, ctx.premierItems.length)}) | same; only ${premierBid.length} have ever ` +
        `been bid (${premierBidRows} History rows), so this is the smallest bucket |`,
    );
    p();
    p(
        `Unlinked History rows overall: **${unlinked.length}** ` +
        `(${pct(unlinked.length, ctx.history.length)} of ${ctx.history.length}). ` +
        `${nonItem.length} are Match Type \`NON-ITEM\` (freight and allowance lines — correctly unlinked) ` +
        `and ${blankBidItem.length} have no Bid Item text to act on, leaving **${actionable.length}** ` +
        `actionable rows in ${groups.length} distinct normalized bid items.`,
    );
    p();

    p('## 1a. Unlinked, but the catalog already has this item — just link it');
    p();
    p(
        'The normalized Bid Item is byte-for-byte a catalog Item ID once case and ' +
        'punctuation are stripped (`normalizeProductId`). No judgment call: open the ' +
        'History row, set the link, done.',
    );
    p();
    if (linkable.length === 0) {
        p('_None._');
    } else {
        p(`Showing ${Math.min(TOP_N, linkable.length)} of ${linkable.length} (${linkableRows} rows).`);
        p();
        p('| Bid Item | Rows | Projects | Link to | Catalog |');
        p('|---|---:|---:|---|---|');
        for (const g of linkable.slice(0, TOP_N)) {
            p(`| ${cell(g.label)} | ${g.rows} | ${g.projects} | ${cell(g.exact!.itemId)} | ${g.exact!.sources.join(', ')} |`);
        }
    }
    p();

    p('## 1b. Unlinked and genuinely absent from the catalog');
    p();
    p(
        'Nothing in Premier Items, 3rd Party Domestic Items, or Fans normalizes to ' +
        'this Bid Item. Each one is a catalog decision, not a link click: add the ' +
        'record, point it at an existing record it is a variant of, or mark the ' +
        'History row `NON-ITEM` if it was never a product (freight, allowances, ' +
        '"TBD", "NOT SHOWN ON PLANS").',
    );
    p();
    p(
        '**Variant of** is a hint, not a verdict: the catalog Item ID is a prefix of ' +
        'this key or vice versa (≥ ' + MIN_VARIANT_KEY_LEN + ' chars), which usually means ' +
        'an option suffix — a wattage, an EM battery, a color temperature — that the ' +
        'catalog record does not carry. Those are the cheapest ones to resolve.',
    );
    p();
    p(`Showing ${Math.min(TOP_N, missing.length)} of ${missing.length} (${missingRows} rows).`);
    p();
    p('| Bid Item | Rows | Projects | Variant of? |');
    p('|---|---:|---:|---|');
    for (const g of missing.slice(0, TOP_N)) {
        p(`| ${cell(g.label)} | ${g.rows} | ${g.projects} | ${g.variantOf ? cell(g.variantOf.itemId, 40) : '—'} |`);
    }
    p();

    p('## 2. History rows with no Bid Date, by project');
    p();
    p(
        'Bid Date drives recency weighting in the History tier; an undated row is ' +
        'evidence the engine cannot age. The gap is project-shaped, not row-shaped — ' +
        'a project imported without dates is missing all of them, so one date per ' +
        'project fixes hundreds of rows at once.',
    );
    p();
    p(
        `${missingDateRows} of ${ctx.history.length} rows (${pct(missingDateRows, ctx.history.length)}) ` +
        `have no Bid Date. ${fullyUndated.length} of ${dateGaps.length} affected projects are 100% undated.`,
    );
    p();
    p('| Project | Missing | Total | Share |');
    p('|---|---:|---:|---:|');
    for (const g of dateGaps) {
        p(`| ${cell(g.project, 50)} | ${g.missing} | ${g.total} | ${pct(g.missing, g.total)} |`);
    }
    p();

    p('## 3. 3rd Party items with a blank Product Categories link');
    p();
    p(
        'Without a category link the item is invisible to the category-fallback tier ' +
        'and to the lamp gate. Ranked by how many History rows already link to it — ' +
        'an item nobody has bid is worth less than one bid on five projects.',
    );
    p();
    p(
        `${thirdPartyGaps.length} of ${ctx.thirdPartyItems.length} items ` +
        `(${pct(thirdPartyGaps.length, ctx.thirdPartyItems.length)}) have no category. ` +
        `${thirdPartyBid.length} of them appear in History (${thirdPartyBidRows} rows); ` +
        `the other ${thirdPartyGaps.length - thirdPartyBid.length} have never been bid.` +
        blankIdNote(thirdPartyBlankId, '3rd Party Domestic Items'),
    );
    p();
    p(`Showing ${Math.min(TOP_N, thirdPartyGaps.length)} of ${thirdPartyGaps.length}.`);
    p();
    p('| Item ID | Manufacturer | Description | History rows | Projects |');
    p('|---|---|---|---:|---:|');
    for (const g of thirdPartyGaps.slice(0, TOP_N)) {
        p(`| ${cell(g.itemId, 40)} | ${cell(g.extra, 25)} | ${cell(g.description, 55)} | ${g.historyRows} | ${g.projects} |`);
    }
    p();

    p('## 4. Premier items with a blank Fixture Category');
    p();
    p(
        'Same failure mode on the Premier side, and additionally the Fixture Category ' +
        'is the ground truth `scripts/build-series-map.ts` learns series→category from, ' +
        'so a blank one costs twice. "Times Used" is the catalog\'s own count field, ' +
        'shown alongside the snapshot\'s History link count.',
    );
    p();
    p(
        `${premierGaps.length} of ${ctx.premierItems.length} items ` +
        `(${pct(premierGaps.length, ctx.premierItems.length)}) have no Fixture Category. ` +
        `${premierBid.length} of them appear in History (${premierBidRows} rows).` +
        blankIdNote(premierBlankId, 'Premier Items'),
    );
    p();
    p(`Showing ${Math.min(TOP_N, premierGaps.length)} of ${premierGaps.length}.`);
    p();
    p('| Item ID | Times Used | Description | History rows | Projects |');
    p('|---|---:|---|---:|---:|');
    for (const g of premierGaps.slice(0, TOP_N)) {
        p(`| ${cell(g.itemId, 40)} | ${cell(g.extra, 10)} | ${cell(g.description, 55)} | ${g.historyRows} | ${g.projects} |`);
    }
    p();

    writeFileSync(out, md.join('\n'));

    // stdout: counts only. The detail contains bid item text and project names,
    // which must not end up in a terminal transcript or CI log.
    console.log(`Airtable hygiene report — snapshot fetched ${snapshot.meta.fetchedAt}`);
    console.log(
        `  History ${ctx.history.length}  Premier ${ctx.premierItems.length}  ` +
        `3rd Party ${ctx.thirdPartyItems.length}  Fans ${ctx.fans.length}`,
    );
    console.log('');
    console.log(`  Unlinked History rows       ${unlinked.length} (${pct(unlinked.length, ctx.history.length)})`);
    console.log(`    NON-ITEM (not a defect)   ${nonItem.length}`);
    console.log(`    blank Bid Item            ${blankBidItem.length}`);
    console.log(`    actionable                ${actionable.length} rows / ${groups.length} distinct bid items`);
    console.log(`      1a already in catalog   ${linkableRows} rows / ${linkable.length} items`);
    console.log(`      1b absent from catalog  ${missingRows} rows / ${missing.length} items`);
    console.log(`         …look like variants  ${variantRows} rows / ${variants.length} items`);
    console.log(
        `  No Bid Date                 ${missingDateRows} rows ` +
        `(${pct(missingDateRows, ctx.history.length)}) over ${dateGaps.length} projects, ` +
        `${fullyUndated.length} of them 100% undated`,
    );
    console.log(
        `  3rd Party, no category      ${thirdPartyGaps.length} items ` +
        `(${pct(thirdPartyGaps.length, ctx.thirdPartyItems.length)}); ` +
        `${thirdPartyBid.length} bid before (${thirdPartyBidRows} rows)`,
    );
    console.log(
        `  Premier, no category        ${premierGaps.length} items ` +
        `(${pct(premierGaps.length, ctx.premierItems.length)}); ` +
        `${premierBid.length} bid before (${premierBidRows} rows)`,
    );
    console.log('');
    console.log(`Detail (top ${TOP_N} per list) written to ${out} — gitignored, do not commit.`);
}

main();
