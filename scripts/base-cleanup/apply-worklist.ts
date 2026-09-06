/**
 * Write a human-reviewed category worklist back into the catalog.
 *
 *   npx tsx --env-file=.env scripts/base-cleanup/apply-worklist.ts <file.tsv>           # dry run
 *   npx tsx --env-file=.env scripts/base-cleanup/apply-worklist.ts <file.tsv> --apply
 *
 * `gapfill.ts --csv` exports the rows no pass could categorize; an estimator fills
 * a category column in by hand and this reads it back. Everything it writes is
 * marked `Category Source = Verified`, because a human really did decide it —
 * that is the whole point of taking the round trip.
 *
 * The names in a hand-filled sheet are the names a person uses, not the exact
 * strings in the Product Categories table ("Bollard" for "Bollards", "Disc" for
 * "Disk Light", typos like "Glsass" for "Glass / Shade"). SYNONYM below spells out every
 * such mapping instead of fuzzy-matching, for the same reason the select
 * reconciliation did: a wrong guess silently mis-files a real product, and the
 * mis-filing is invisible afterwards.
 *
 * A `null` in SYNONYM means DO NOT WRITE — the name is genuinely ambiguous and
 * the rows are reported for a second look rather than resolved on a guess.
 */

import { readFileSync } from 'node:fs';

import { APPLY, TABLE, allRecords, banner, createRecords, linkIds, updateRecords, val } from './client';

const FILE = process.argv.slice(2).find(a => !a.startsWith('--'));

/**
 * By default a row that already has a category is left alone — the sheet is for
 * filling gaps, and silently overwriting a category someone set is the one thing
 * this must not do. `--recategorize` opts in, and every change is printed as
 * `old -> new` so the move is reviewable before it happens.
 */
const RECATEGORIZE = process.argv.includes('--recategorize');
const norm = (s: string): string => s.trim().toUpperCase().replace(/\s+/g, ' ');

/** Hand-written name -> Product Categories record. `null` = ambiguous, report only. */
const SYNONYM = new Map<string, string | null>(Object.entries({
    'Linear Fixture': 'Linear Surface Mount',
    'Bollard': 'Bollards',
    'Pole Head': 'Pole Heads',
    'Driver': 'Driver / Power Supply',
    'Tape accessories': 'Tape / Strip / Channel',
    'Glass': 'Glass / Shade',
    'Glsass': 'Glass / Shade',
    'Sconce': 'Wall Sconce',
    'Disc': 'Disk Light',
    'Emergency light': 'Exit / Emergency',
    'Track Lighting': 'Track Light',
    'Specialty Fixture': 'Specialty Item',
    'Bulb': 'Light Bulb',
    // Jesse's own rule, confirmed 2026-09-02: a generic "surface mount" is the
    // flush ceiling kind. Linear Surface Mount is the separate EFS/EFV product.
    'Surface Mount': 'Flush Mount',
    // Freight, allowances and lot lines are not products. They get a category of
    // their own so they are explicitly excluded rather than merely unclassified —
    // and it is deliberately absent from CATEGORY_TAXONOMY, so nothing in the
    // engine can ever offer one as a substitution.
    'Accounting function- ignore all': 'Non-Item / Accounting',

    // ── Reported, not written ────────────────────────────────────────────────
    // "Outdoor Wall pack" was used for the whole exterior spread — in-grade
    // uplights, bullet spots, floods, step lights and one pendant. Filing an
    // accent light as a wall pack is the WP2 failure in reverse.
    'Outdoor Wall pack': null,
    // "Lamp" means both a light bulb and a portable table lamp, and the two rows
    // marked with it are one of each.
    'Lamp': null,
    // No equivalent exists yet; needs a decision about a Landscape category.
    'Landscape lighting': null,
    'Landscape lighring': null, // compatibility alias for an already-exported typo
}).map(([name, value]) => [norm(name), value]));

/** Categories to create if they are not there yet. */
const CREATE = ['Non-Item / Accounting'];

const SOURCE_FIELD = 'Category Source';
const KEY_SEPARATOR = '\0';

interface Row { table: string; itemId: string; category: string }

function readTsv(path: string): Row[] {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(l => l.trim());
    const header = lines[0]!.split('\t').map(h => h.trim().toLowerCase());
    const iTable = header.indexOf('table');
    const iItem = header.indexOf('item_id');
    const iCat = header.indexOf('category');
    if (iTable < 0 || iItem < 0 || iCat < 0) throw new Error('need table, item_id and category columns');
    return lines.slice(1).map(l => {
        const c = l.split('\t');
        return { table: (c[iTable] ?? '').trim(), itemId: (c[iItem] ?? '').trim(), category: (c[iCat] ?? '').trim() };
    }).filter(r => r.itemId && r.category);
}

async function main(): Promise<void> {
    if (!FILE) throw new Error('usage: apply-worklist.ts <file.tsv> [--apply]');
    banner('Apply a reviewed category worklist');

    const cats = (await allRecords(TABLE.PRODUCT_CATEGORIES, ['Category Name']))
        .map(r => ({ id: r.id, name: val(r.fields['Category Name']).trim() }))
        .filter(c => c.name);
    const catByName = new Map(cats.map(c => [norm(c.name), c]));

    // Index the catalog by item number, per table.
    const premier = await allRecords(TABLE.PREMIER, ['Item ID', 'Item Description', 'Product Categories']);
    const third = await allRecords(TABLE.THIRD_PARTY, ['Item ID', 'Item Description', 'Product Categories']);
    // Keyed on table + item number. The separator is NUL because item numbers
    // contain spaces, slashes and quotes ("50\" AIRCRAFT CABLE", "LOT PRICING")
    // but never a control character.
    const index = new Map<string, { table: string; id: string; itemId: string; desc: string; current: string }>();
    const key = (table: string, itemId: string): string => `${norm(table)}${KEY_SEPARATOR}${norm(itemId)}`;
    const add = (table: string, label: string, rows: typeof premier) => {
        for (const r of rows) {
            const itemId = val(r.fields['Item ID']).trim();
            if (!itemId) continue;
            index.set(key(label, itemId), {
                table, id: r.id, itemId,
                desc: val(r.fields['Item Description']).replace(/\s+/g, ' ').trim(),
                current: linkIds(r.fields['Product Categories'])
                    .map(id => cats.find(c => c.id === id)?.name ?? '?').join(' + '),
            });
        }
    };
    add(TABLE.PREMIER, 'PREMIER', premier);
    add(TABLE.THIRD_PARTY, '3RD PARTY', third);

    const rows = readTsv(FILE);
    console.log(`worklist rows with a category filled in: ${rows.length}`);

    const writes: Array<{ table: string; id: string; itemId: string; category: string }> = [];
    const hold = new Map<string, Array<{ itemId: string; desc: string }>>();
    const unknownName = new Map<string, string[]>();
    const notFound: Row[] = [];
    const alreadySet: string[] = [];
    const moves: Array<{ itemId: string; from: string; to: string }> = [];

    for (const row of rows) {
        const hit = index.get(key(row.table, row.itemId));
        if (!hit) { notFound.push(row); continue; }
        if (hit.current && !RECATEGORIZE) { alreadySet.push(hit.itemId); continue; }

        const rowCategory = norm(row.category);
        const mapped = SYNONYM.has(rowCategory) ? SYNONYM.get(rowCategory)! : row.category;
        if (mapped === null) {
            const e = hold.get(row.category) ?? [];
            e.push({ itemId: hit.itemId, desc: hit.desc });
            hold.set(row.category, e);
            continue;
        }
        if (!catByName.has(norm(mapped)) && !CREATE.includes(mapped)) {
            unknownName.set(row.category, [...(unknownName.get(row.category) ?? []), hit.itemId]);
            continue;
        }
        if (norm(hit.current) === norm(mapped)) { alreadySet.push(hit.itemId); continue; }
        if (hit.current) moves.push({ itemId: hit.itemId, from: hit.current, to: mapped });
        writes.push({ table: hit.table, id: hit.id, itemId: hit.itemId, category: mapped });
    }

    const spread = new Map<string, number>();
    for (const w of writes) spread.set(w.category, (spread.get(w.category) ?? 0) + 1);
    console.log(`\nwould write ${writes.length} rows:`);
    [...spread.entries()].sort((a, b) => b[1] - a[1])
        .forEach(([k, v]) => console.log(`   ${String(v).padStart(4)}  ${k}${CREATE.includes(k) ? '   (new category)' : ''}`));

    if (alreadySet.length) console.log(`\nskipped, already carry this category: ${alreadySet.length}`);

    if (moves.length) {
        console.log(`\nRECATEGORIZING ${moves.length} row(s) that already had a category:`);
        moves.forEach(m => console.log(`   ${m.itemId.slice(0, 32).padEnd(34)}${m.from}  ->  ${m.to}`));
    }

    if (notFound.length) {
        console.log(`\n!! ${notFound.length} item number(s) did not match any catalog row:`);
        notFound.forEach(r => console.log(`   ${r.table.padEnd(10)} ${r.itemId}`));
    }

    if (unknownName.size) {
        console.log(`\n!! ${unknownName.size} category name(s) have no record and no mapping — add them to SYNONYM:`);
        for (const [name, items] of unknownName) console.log(`   "${name}" (${items.length}): ${items.slice(0, 4).join(', ')}`);
    }

    for (const [name, items] of hold) {
        console.log(`\nON HOLD — "${name}" (${items.length} rows), needs a decision:`);
        items.forEach(i => console.log(`   ${i.itemId.slice(0, 34).padEnd(36)}${i.desc.slice(0, 78)}`));
    }

    if (!APPLY) { console.log('\nDRY RUN — nothing written.'); return; }
    if (unknownName.size) throw new Error('Refusing to apply with unmapped category names.');
    if (hold.size) throw new Error('Refusing to apply while ambiguous category names are still on hold.');
    if (notFound.length) throw new Error('Refusing to apply while worklist rows still fail to match catalog items.');

    for (const name of CREATE) {
        if (catByName.has(norm(name))) continue;
        console.log(`\ncreating category "${name}"…`);
        const [rec] = await createRecords(TABLE.PRODUCT_CATEGORIES, [{ fields: { 'Category Name': name } }]);
        if (rec) catByName.set(norm(name), { id: rec.id, name });
    }

    for (const [tableId, label] of [[TABLE.PREMIER, 'Premier'], [TABLE.THIRD_PARTY, '3rd Party']] as const) {
        const updates = writes.filter(w => w.table === tableId).map(w => ({
            id: w.id,
            fields: { 'Product Categories': [catByName.get(norm(w.category))!.id], [SOURCE_FIELD]: 'Verified' },
        }));
        console.log(`\nwriting ${updates.length} ${label} rows…`);
        await updateRecords(tableId, updates);
    }
    console.log('\ndone.');
}

main().catch(e => { console.error(e); process.exit(1); });
