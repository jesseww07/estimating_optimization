/**
 * Last pass: unify History's category, then mark every superseded field.
 *
 *   npx tsx --env-file=.env scripts/base-cleanup/finalize.ts           # dry run
 *   npx tsx --env-file=.env scripts/base-cleanup/finalize.ts --apply
 *
 * 1. HISTORY HAD FOUR CATEGORY FIELDS and each covered a different slice:
 *
 *      Product Category            link,   3,758 rows  (the Premier-linked ones)
 *      Product Category 3rd Party  lookup, 1,122 rows  (the resold-linked ones)
 *      Product Name (from 3rd…)    lookup, 1,122 rows
 *      Catategory                  formula, 4,880 rows  (and misspelt)
 *
 *    Now that BOTH catalogs link to the same Product Categories table, the link
 *    can cover every row: for a history row linked to a resold item, this copies
 *    that item's category into it. One field, every row, one vocabulary — which
 *    is what makes the other three redundant rather than merely untidy.
 *
 * 2. RENAME what is superseded to `zz_RETIRED …`. Airtable's API cannot delete a
 *    field, so the rename is the handoff: it makes a dead column unmistakable in
 *    the UI and safe for a human to remove, without breaking anything in the
 *    meantime (the app binds by field ID, never by name).
 */

import { APPLY, TABLE, allRecords, api, banner, linkIds, updateField, updateRecords, val } from './client';

/** Fields the consolidation superseded. Renamed, never deleted — see above. */
const RETIRE: Array<{ table: string; tableLabel: string; field: string; because: string }> = [
    {
        table: TABLE.PREMIER, tableLabel: 'Premier Items', field: 'Fixture Category',
        because: 'Superseded by the Product Categories link on 2026-09-02.',
    },
    {
        table: TABLE.THIRD_PARTY, tableLabel: '3rd Party Domestic Items', field: 'Product Name',
        because: 'Not a product name — a second category vocabulary from NetSuite, on the same rows the Product Categories link already covers.',
    },
    {
        table: TABLE.HISTORY, tableLabel: 'History', field: 'Catategory',
        because: 'Misspelt formula duplicating the category fields it was built from; Product Category now covers every row.',
    },
    {
        table: TABLE.HISTORY, tableLabel: 'History', field: 'Product Category 3rd Party',
        because: 'Folded into Product Category, which now carries the resold rows too.',
    },
    {
        table: TABLE.HISTORY, tableLabel: 'History', field: 'Product Name (from 3rd Party Items)',
        because: 'Lookup of the retired 3rd Party "Product Name".',
    },
];

async function main(): Promise<void> {
    banner('Finalize — unify History.Product Category, mark superseded fields');

    // ── 1. Give every history row its category through the one link ─────────
    const thirdParty = await allRecords(TABLE.THIRD_PARTY, ['Product Categories']);
    const categoryOfItem = new Map<string, string[]>();
    for (const r of thirdParty) {
        const ids = linkIds(r.fields['Product Categories']);
        if (ids.length) categoryOfItem.set(r.id, ids);
    }

    const history = await allRecords(TABLE.HISTORY, ['3rd Party Items', 'Product Category']);
    const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
    let alreadySet = 0, noItemCategory = 0;
    for (const row of history) {
        if (linkIds(row.fields['Product Category']).length) { alreadySet++; continue; }
        const items = linkIds(row.fields['3rd Party Items']);
        if (!items.length) continue;
        const cats = items.flatMap(id => categoryOfItem.get(id) ?? []);
        if (!cats.length) { noItemCategory++; continue; }
        updates.push({ id: row.id, fields: { 'Product Category': [...new Set(cats)] } });
    }
    console.log(`History: ${history.length} rows`);
    console.log(`  already carry a category link:            ${alreadySet}`);
    console.log(`  resold-linked, category can be filled in: ${updates.length}`);
    console.log(`  resold-linked but the item has no category yet: ${noItemCategory}`);
    console.log(`  after this, rows with a category: ${alreadySet + updates.length} / ${history.length}`);

    // ── 2. What would be renamed ────────────────────────────────────────────
    const { tables } = await api<{ tables: Array<{ id: string; fields: Array<{ id: string; name: string }> }> }>(
        'meta/bases/appWj912AEOvtxqJF/tables');
    console.log('\nfields to mark retired (rename only — deleting is yours to do):');
    const renames: Array<{ table: string; id: string; from: string; to: string; because: string }> = [];
    for (const r of RETIRE) {
        const table = tables.find(t => t.id === r.table)!;
        const field = table.fields.find(f => f.name === r.field);
        if (!field) { console.log(`   ${r.tableLabel.padEnd(26)} "${r.field}" — already gone`); continue; }
        const to = `zz_RETIRED ${r.field}`;
        renames.push({ table: r.table, id: field.id, from: r.field, to, because: r.because });
        console.log(`   ${r.tableLabel.padEnd(26)} "${r.field}" -> "${to}"`);
        console.log(`   ${' '.repeat(26)}   ${r.because}`);
    }

    if (!APPLY) { console.log('\nDRY RUN — nothing written.'); return; }

    console.log(`\nfilling ${updates.length} History category links…`);
    await updateRecords(TABLE.HISTORY, updates);
    for (const r of renames) {
        console.log(`renaming "${r.from}" -> "${r.to}"…`);
        await updateField(r.table, r.id, { name: r.to, description: `${r.because} Safe to delete once verified.` });
    }
    console.log('\ndone.');
    void val;
}

main().catch(e => { console.error(e); process.exit(1); });
