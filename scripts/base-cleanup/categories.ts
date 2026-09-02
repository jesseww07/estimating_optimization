/**
 * Make Product Categories the single category vocabulary, linked from every
 * catalog table.
 *
 *   npx tsx --env-file=.env scripts/base-cleanup/categories.ts           # dry run
 *   npx tsx --env-file=.env scripts/base-cleanup/categories.ts --apply
 *
 * Before this, the base had four parallel category systems and the intended hub
 * was the emptiest of them:
 *
 *   Premier Items   "Fixture Category" select, 35 choices, 2,245 filled
 *   Premier Items   "Product Categories" link ................ 0 filled
 *   Fans            "Product Categories" link ................ 0 filled
 *   3rd Party       "Product Categories" link .............. 637 filled
 *   3rd Party       "Product Name" (really a category) ..... 637 filled
 *   History         four different category fields
 *
 * Three jobs, in order:
 *
 *   1. STREAMLINE the vocabulary itself. It carries its own near-duplicates
 *      ("Bollard" and "Bollards", "Ceiling Fan" and "Ceiling Fans") and one
 *      record with no name at all. Near-duplicates are merged by relinking
 *      everything that points at the loser and then deleting it.
 *   2. RECONCILE the two vocabularies. Twenty-one of the 35 select choices have
 *      an identically-named category record; the other fourteen need a decision,
 *      and those decisions are written out below rather than inferred, because a
 *      wrong one silently mis-files thousands of items.
 *   3. LINK. Populate Premier and Fans from the reconciliation, then retire the
 *      select by renaming it (Airtable's API cannot delete a field — that is the
 *      one manual step this leaves behind).
 */

import { APPLY, TABLE, allRecords, api, banner, createRecords, deleteRecords, linkIds, updateRecords, val } from './client';

/**
 * Near-duplicate category records: everything pointing at a loser is relinked to
 * the survivor, then the loser is deleted. Singular/plural pairs only — genuinely
 * different concepts (Wall Sconce vs Wall Sconce — Outdoor, Disk Light vs
 * Recessed Light) are deliberately left alone.
 */
const MERGE_CATEGORIES: Array<{ keep: string; absorb: string[] }> = [
    { keep: 'Bollards', absorb: ['Bollard'] },
    { keep: 'Ceiling Fan', absorb: ['Ceiling Fans'] },
];

/** Category records with no name and no links — remove. */
const DELETE_BLANK_NAMES = true;

/**
 * Premier "Fixture Category" choice -> Product Categories record.
 *
 * `null` means the choice is an ACCESSORY or non-fixture and gets no category
 * link, matching lib/engine/categories.ts, which deliberately keeps accessories
 * out of every group so they are never offered as a substitute for a fixture.
 * Names not listed here map to themselves.
 */
const SELECT_TO_CATEGORY: Record<string, string | null> = {
    'Downlight': 'Recessed Light',
    'Exit Sign / EMG': 'Exit / Emergency',
    'Fan Controls': 'Switch / Control',
    'Flush / Surface Mount': 'Flush Mount',
    'Lamp': 'Light Bulb',
    'Linear / Island Chandeliers': 'Chandelier',
    'Outdoor Wall Sconce': 'Wall Sconce — Outdoor',
    'Sconce': 'Wall Sconce',
    'Step Light': 'Step / Path Light',
    // Generic "Surface Mount" is the flush/ceiling kind; the linear kind has its
    // own choice, so sending both to Linear Surface Mount would lose that split.
    'Surface Mount': 'Flush Mount',
    'Trim': 'Recessed Accessory',
    'Undercabinet / Tape Light + Connectors': 'Undercabinet Lighting',
    'Ceiling Fans': 'Ceiling Fan',
    'Bollard': 'Bollards',
};

/** Category records to create because no equivalent exists yet. */
const CREATE_CATEGORIES = ['LED Mirror', 'Accent'];

interface Cat { id: string; name: string }

async function main(): Promise<void> {
    banner('Categories — one vocabulary, linked from every catalog');

    let cats = (await allRecords(TABLE.PRODUCT_CATEGORIES, ['Category Name']))
        .map(r => ({ id: r.id, name: val(r.fields['Category Name']).trim() }));
    console.log(`Product Categories: ${cats.length} records (${cats.filter(c => !c.name).length} unnamed)`);

    // ── 1. Streamline the vocabulary ────────────────────────────────────────
    console.log('\n--- vocabulary cleanup ---');
    const byName = (n: string): Cat | undefined => cats.find(c => c.name.toLowerCase() === n.toLowerCase());

    const relinkPlan: Array<{ table: string; field: string; id: string; from: string; to: string }> = [];
    const catDeletes: string[] = [];
    const linkSources: Array<[string, string, string]> = [
        [TABLE.PREMIER, 'Product Categories', 'Premier'],
        [TABLE.THIRD_PARTY, 'Product Categories', '3rd Party'],
        [TABLE.FANS, 'Product Categories', 'Fans'],
        [TABLE.HISTORY, 'Product Category', 'History'],
    ];
    const sourceRows = new Map<string, Awaited<ReturnType<typeof allRecords>>>();
    // Only the link field — the four tables do not share a primary field name
    // (Fans is "Item_Number", History is a formula).
    for (const [tableId, field] of linkSources) sourceRows.set(tableId, await allRecords(tableId, [field]));

    for (const { keep, absorb } of MERGE_CATEGORIES) {
        const survivor = byName(keep);
        if (!survivor) { console.log(`   ! "${keep}" not found — skipping merge`); continue; }
        for (const loserName of absorb) {
            const loser = byName(loserName);
            if (!loser) continue;
            let moved = 0;
            for (const [tableId, field, label] of linkSources) {
                for (const row of sourceRows.get(tableId) ?? []) {
                    const ids = linkIds(row.fields[field]);
                    if (!ids.includes(loser.id)) continue;
                    const next = [...new Set(ids.map(i => (i === loser.id ? survivor.id : i)))];
                    relinkPlan.push({ table: tableId, field, id: row.id, from: loser.id, to: survivor.id });
                    row.fields[field] = next;
                    moved++;
                }
                void label;
            }
            console.log(`   merge "${loserName}" -> "${keep}"  (${moved} rows relinked)`);
            catDeletes.push(loser.id);
        }
    }
    const blanks = cats.filter(c => !c.name);
    if (DELETE_BLANK_NAMES && blanks.length) {
        console.log(`   delete ${blanks.length} unnamed category record(s)`);
        catDeletes.push(...blanks.map(b => b.id));
    }

    const missing = CREATE_CATEGORIES.filter(n => !byName(n));
    console.log(`   create ${missing.length} missing categories: ${missing.join(', ') || '(none)'}`);

    // ── 2. Reconcile the Premier select against the vocabulary ──────────────
    console.log('\n--- Premier "Fixture Category" -> Product Categories ---');
    const tables = await api<{ tables: Array<{ id: string; fields: Array<{ id: string; name: string; options?: { choices?: Array<{ name: string }> } }> }> }>(
        'meta/bases/appWj912AEOvtxqJF/tables');
    const premierTable = tables.tables.find(t => t.id === TABLE.PREMIER)!;
    const selectField = premierTable.fields.find(f => f.name === 'Fixture Category');
    const choices = (selectField?.options?.choices ?? []).map(c => c.name);

    const resolveName = (choice: string): string | null =>
        choice in SELECT_TO_CATEGORY ? SELECT_TO_CATEGORY[choice]! : choice;

    const mapping: Array<{ choice: string; target: string | null; exists: boolean }> = choices.map(choice => {
        const target = resolveName(choice);
        return { choice, target, exists: target === null || !!byName(target) || missing.includes(target) };
    });
    for (const m of mapping.sort((a, b) => a.choice.localeCompare(b.choice))) {
        const flag = m.target === null ? '(no link — accessory)' : m.exists ? '' : '  !! NO SUCH CATEGORY';
        const arrow = m.target === m.choice ? '=' : '->';
        console.log(`   ${m.choice.padEnd(38)} ${arrow} ${String(m.target ?? '').padEnd(24)}${flag}`);
    }
    const broken = mapping.filter(m => !m.exists);
    if (broken.length) {
        console.log(`\n   ${broken.length} choice(s) map to a category that does not exist — fix SELECT_TO_CATEGORY before applying.`);
    }

    // ── 3. What linking would do ────────────────────────────────────────────
    const premierRows = sourceRows.get(TABLE.PREMIER)!;
    const premierWithSelect = await allRecords(TABLE.PREMIER, ['Item ID', 'Fixture Category', 'Product Categories']);
    let willLink = 0, noCategory = 0, accessory = 0;
    for (const r of premierWithSelect) {
        const choice = val(r.fields['Fixture Category']).trim();
        if (!choice) { noCategory++; continue; }
        const target = resolveName(choice);
        if (target === null) { accessory++; continue; }
        willLink++;
    }
    console.log(`\nPremier: ${willLink} rows to link, ${accessory} accessory rows left unlinked, ${noCategory} rows with no category at all (gap-fill handles those)`);
    const fanRows = await allRecords(TABLE.FANS, ['Item_Number', 'Product Categories']);
    console.log(`Fans: ${fanRows.length} rows, all get "Ceiling Fan"`);
    void premierRows;

    if (!APPLY) { console.log('\nDRY RUN — nothing written.'); return; }
    if (broken.length) throw new Error('Refusing to apply with an unresolved category mapping.');

    // Apply 1: relink, delete merged/blank categories, create missing ones.
    console.log('\napplying vocabulary cleanup…');
    const relinkByTable = new Map<string, Map<string, { id: string; fields: Record<string, unknown> }>>();
    for (const r of relinkPlan) {
        const perTable = relinkByTable.get(r.table) ?? new Map();
        const row = (sourceRows.get(r.table) ?? []).find(x => x.id === r.id)!;
        perTable.set(r.id, { id: r.id, fields: { [r.field]: row.fields[r.field] } });
        relinkByTable.set(r.table, perTable);
    }
    for (const [tableId, updates] of relinkByTable) {
        console.log(`  relinking ${updates.size} rows in ${tableId}…`);
        await updateRecords(tableId, [...updates.values()]);
    }
    if (missing.length) {
        const created = await createRecords(TABLE.PRODUCT_CATEGORIES, missing.map(name => ({ fields: { 'Category Name': name } })));
        cats = [...cats, ...created.map(r => ({ id: r.id, name: val(r.fields['Category Name']).trim() }))];
    }
    if (catDeletes.length) {
        console.log(`  deleting ${catDeletes.length} redundant category records…`);
        await deleteRecords(TABLE.PRODUCT_CATEGORIES, catDeletes);
        cats = cats.filter(c => !catDeletes.includes(c.id));
    }

    // Apply 2: link Premier and Fans.
    const catId = (n: string): string | undefined => cats.find(c => c.name.toLowerCase() === n.toLowerCase())?.id;
    const premierUpdates: Array<{ id: string; fields: Record<string, unknown> }> = [];
    for (const r of premierWithSelect) {
        const choice = val(r.fields['Fixture Category']).trim();
        if (!choice) continue;
        const target = resolveName(choice);
        if (target === null) continue;
        const id = catId(target);
        if (!id) continue;
        if (linkIds(r.fields['Product Categories']).includes(id)) continue;
        premierUpdates.push({ id: r.id, fields: { 'Product Categories': [id] } });
    }
    console.log(`  linking ${premierUpdates.length} Premier rows…`);
    await updateRecords(TABLE.PREMIER, premierUpdates);

    const fanCat = catId('Ceiling Fan');
    if (fanCat) {
        const fanUpdates = fanRows
            .filter(r => !linkIds(r.fields['Product Categories']).includes(fanCat))
            .map(r => ({ id: r.id, fields: { 'Product Categories': [fanCat] } }));
        console.log(`  linking ${fanUpdates.length} Fans rows…`);
        await updateRecords(TABLE.FANS, fanUpdates);
    }
    console.log('\ndone. The select is left in place until the gap-fill has run; finalize.ts renames it.');
}

main().catch(e => { console.error(e); process.exit(1); });
