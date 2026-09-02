/**
 * Make the Manufacturers table the single brand registry.
 *
 *   npx tsx --env-file=.env scripts/base-cleanup/manufacturers.ts           # dry run
 *   npx tsx --env-file=.env scripts/base-cleanup/manufacturers.ts --apply
 *
 * Today 3rd Party carries a free-text "Manufacturer" — 83 brands, 41 of which
 * have no record in the 650-row Manufacturers table, and several spelled more
 * than one way on the SAME item ("Globalux" / "GLOBALUX LIGHTING, LLC",
 * "Satco" / "SATCO", "WAC LIGHTING" / "W.A.C. Lighting"). Nothing can join on a
 * name that is written three ways.
 *
 * What this does:
 *   1. Resolves each free-text brand to a canonical Manufacturers record —
 *      exact, then corporate-suffix-insensitive, then alias, then a guarded
 *      prefix match (that last one is what pairs GLOBALUX with
 *      GLOBALUX LIGHTING, LLC).
 *   2. Creates a record for every brand that still has no home.
 *   3. Records every non-canonical spelling in that record's Aliases, so the
 *      variants stay searchable instead of being erased.
 *   4. Adds a real link field on 3rd Party and points every row at its brand.
 *   5. Renames the old text column to `zz_RETIRED …` and gives the link the
 *      plain name. Airtable's API cannot DELETE a field — that last step is
 *      yours, and the rename is what makes it obvious and safe.
 */

import { APPLY, TABLE, allRecords, api, banner, createField, createRecords, updateField, updateRecords, val } from './client';

const MFR_TEXT_FIELD = 'Manufacturer';
const LINK_FIELD = 'Manufacturer Link';
const RETIRED_NAME = 'zz_RETIRED Manufacturer (text)';

const norm = (s: string): string => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Corporate noise that does not distinguish two brands. */
const SUFFIX = /(LLC|INC|INCORPORATED|CORP|CORPORATION|INTERNATIONAL|INTL|COMPANY|CO|INDUSTRIES|MANUFACTURING|MFG|BRANDS|GROUP|USA|LTD|LP)$/;

/** Normalized form with trailing corporate suffixes stripped (repeatedly). */
function core(s: string): string {
    let v = norm(s);
    for (let i = 0; i < 3; i++) {
        const next = v.replace(SUFFIX, '');
        if (next === v || next.length < 4) break;
        v = next;
    }
    return v;
}

/**
 * True when `long` is `short` plus only corporate/industry noise —
 * GLOBALUX ⊂ GLOBALUXLIGHTINGLLC, but not ELCO ⊂ ELCOLIGHTINGSOMETHINGELSE
 * unless the remainder is recognised noise.
 */
function isBrandExtension(short: string, long: string): boolean {
    if (short.length < 5 || !long.startsWith(short) || long === short) return false;
    const rest = long.slice(short.length);
    return /^(LIGHTING|LIGHT|LLC|INC|CORP|CO|COMPANY|MANUFACTURING|MFG|USA|GROUP|BRANDS|INTERNATIONAL|INDUSTRIES|LTD)+$/.test(rest);
}

interface Canon { id: string; name: string; aliases: string[] }

function resolve(brand: string, canon: Canon[]): Canon | null {
    const n = norm(brand);
    const c = core(brand);
    return canon.find(m => norm(m.name) === n)
        ?? canon.find(m => m.aliases.some(a => norm(a) === n))
        ?? canon.find(m => core(m.name) === c && c.length >= 4)
        ?? canon.find(m => isBrandExtension(core(m.name), c) || isBrandExtension(c, core(m.name)))
        ?? null;
}

async function main(): Promise<void> {
    banner('Manufacturers — one registry, linked from 3rd Party');

    const mfrRows = await allRecords(TABLE.MANUFACTURERS, ['Manufacturer Name', 'Aliases']);
    const canon: Canon[] = mfrRows.map(r => ({
        id: r.id,
        name: val(r.fields['Manufacturer Name']).trim(),
        aliases: val(r.fields['Aliases']).split(/[\n,]/).map(a => a.trim()).filter(Boolean),
    })).filter(m => m.name);
    console.log(`Manufacturers table: ${canon.length} named records`);

    const items = await allRecords(TABLE.THIRD_PARTY, ['Item ID', MFR_TEXT_FIELD]);
    const spellings = new Map<string, string[]>();   // exact spelling -> item ids
    for (const r of items) {
        const brand = val(r.fields[MFR_TEXT_FIELD]).trim();
        if (!brand) continue;
        spellings.set(brand, [...(spellings.get(brand) ?? []), r.id]);
    }
    console.log(`3rd Party: ${items.length} rows, ${spellings.size} distinct spellings, ${items.filter(r => !val(r.fields[MFR_TEXT_FIELD]).trim()).length} blank`);

    // Group spellings by the canonical record they resolve to (or by core, for new ones).
    const matched = new Map<string, { canon: Canon; spellings: string[]; rows: string[] }>();
    const unmatched = new Map<string, { spellings: string[]; rows: string[] }>();
    for (const [brand, rows] of spellings) {
        const hit = resolve(brand, canon);
        if (hit) {
            const e = matched.get(hit.id) ?? { canon: hit, spellings: [], rows: [] };
            e.spellings.push(brand); e.rows.push(...rows);
            matched.set(hit.id, e);
        } else {
            const key = core(brand);
            const e = unmatched.get(key) ?? { spellings: [], rows: [] };
            e.spellings.push(brand); e.rows.push(...rows);
            unmatched.set(key, e);
        }
    }
    console.log(`\nresolved to an existing manufacturer: ${matched.size} brands`);
    console.log(`no record yet — will be created:      ${unmatched.size} brands`);

    const merges = [...matched.values()].filter(m => m.spellings.length > 1 || norm(m.spellings[0]!) !== norm(m.canon.name));
    console.log(`\nspelling variants folded into an existing record: ${merges.length}`);
    merges.slice(0, 15).forEach(m => console.log(`   "${m.canon.name}" <- ${m.spellings.map(s => `"${s}"`).join(', ')}  (${m.rows.length} rows)`));

    const creates = [...unmatched.entries()].sort((a, b) => b[1].rows.length - a[1].rows.length);
    console.log(`\nnew manufacturer records (${creates.length}):`);
    creates.slice(0, 20).forEach(([, e]) => console.log(`   ${String(e.rows.length).padStart(4)} rows  ${e.spellings.map(s => `"${s}"`).join(' / ')}`));
    if (creates.length > 20) console.log(`   … and ${creates.length - 20} more`);

    if (!APPLY) { console.log('\nDRY RUN — nothing written.'); return; }

    // 1. Create the missing manufacturers (longest spelling wins as the name —
    //    it is the most complete legal form; the rest become aliases).
    console.log('\ncreating missing manufacturers…');
    const created = await createRecords(TABLE.MANUFACTURERS, creates.map(([, e]) => {
        const name = [...e.spellings].sort((a, b) => b.length - a.length)[0]!;
        const aliases = e.spellings.filter(s => s !== name);
        return { fields: { 'Manufacturer Name': name, ...(aliases.length ? { Aliases: aliases.join('\n') } : {}) } };
    }));
    creates.forEach(([, e], i) => {
        const rec = created[i];
        if (rec) matched.set(rec.id, { canon: { id: rec.id, name: val(rec.fields['Manufacturer Name']), aliases: [] }, spellings: e.spellings, rows: e.rows });
    });

    // 2. Record variant spellings as aliases on the records that already existed.
    const aliasUpdates = merges
        .map(m => {
            const extra = m.spellings.filter(s => norm(s) !== norm(m.canon.name) && !m.canon.aliases.some(a => norm(a) === norm(s)));
            if (!extra.length) return null;
            return { id: m.canon.id, fields: { Aliases: [...m.canon.aliases, ...extra].join('\n') } };
        })
        .filter((u): u is { id: string; fields: { Aliases: string } } => u !== null);
    console.log(`recording ${aliasUpdates.length} alias sets…`);
    await updateRecords(TABLE.MANUFACTURERS, aliasUpdates);

    // 3. Create the link field if it isn't there yet, then point every row at its brand.
    const tables = await api<{ tables: Array<{ id: string; fields: Array<{ id: string; name: string }> }> }>(
        `meta/bases/appWj912AEOvtxqJF/tables`);
    const third = tables.tables.find(t => t.id === TABLE.THIRD_PARTY)!;
    let linkField = third.fields.find(f => f.name === LINK_FIELD || f.name === MFR_TEXT_FIELD && false)?.name;
    if (!linkField) {
        console.log(`creating link field "${LINK_FIELD}"…`);
        await createField(TABLE.THIRD_PARTY, {
            name: LINK_FIELD,
            type: 'multipleRecordLinks',
            description: 'Canonical brand. Replaces the free-text Manufacturer column; spelling variants live in Manufacturers.Aliases.',
            options: { linkedTableId: TABLE.MANUFACTURERS },
        });
        linkField = LINK_FIELD;
    }

    const rowToMfr = new Map<string, string>();
    for (const m of matched.values()) for (const row of m.rows) rowToMfr.set(row, m.canon.id);
    const linkUpdates = [...rowToMfr.entries()].map(([id, mfrId]) => ({ id, fields: { [LINK_FIELD]: [mfrId] } }));
    console.log(`linking ${linkUpdates.length} 3rd-party rows…`);
    await updateRecords(TABLE.THIRD_PARTY, linkUpdates);

    // 4. Retire the text column by renaming it. Deleting a field is not
    //    something Airtable's API can do — the rename makes it unmistakable.
    const textField = third.fields.find(f => f.name === MFR_TEXT_FIELD);
    if (textField) {
        console.log(`renaming "${MFR_TEXT_FIELD}" -> "${RETIRED_NAME}"…`);
        await updateField(TABLE.THIRD_PARTY, textField.id, {
            name: RETIRED_NAME,
            description: 'Superseded by the Manufacturer link on 2026-09-02. Safe to delete once verified.',
        });
        const link = (await api<{ tables: Array<{ id: string; fields: Array<{ id: string; name: string }> }> }>(
            `meta/bases/appWj912AEOvtxqJF/tables`)).tables.find(t => t.id === TABLE.THIRD_PARTY)!
            .fields.find(f => f.name === LINK_FIELD);
        if (link) {
            console.log(`renaming "${LINK_FIELD}" -> "${MFR_TEXT_FIELD}"…`);
            await updateField(TABLE.THIRD_PARTY, link.id, { name: MFR_TEXT_FIELD });
        }
    }
    console.log('\ndone.');
}

main().catch(e => { console.error(e); process.exit(1); });
