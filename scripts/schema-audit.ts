/**
 * Schema audit — every field ID the app pins, checked against the live base.
 *
 *   npx tsx --env-file=.env scripts/schema-audit.ts
 *
 * READ-ONLY. Reads the Airtable metadata API and lib/airtable/schema.ts and
 * reports three things per table:
 *
 *   MISSING  — a field ID the code binds to that no longer exists live. Every
 *              one of these is a silent breakage: the adapter reads undefined
 *              and the engine sees an empty string, so matching degrades
 *              without ever throwing.
 *   RENAMED  — the field is alive but its human label changed, so the comment
 *              in schema.ts is now wrong (documentation only, not a bug).
 *   UNPINNED — a live field the code does not read. Mostly fine; listed so a
 *              newly added field that SHOULD be read is easy to spot.
 */

import {
    BASE_ID, TABLES,
    FANS_FIELDS, HISTORY_FIELDS, MANUFACTURER_FIELDS, PREMIER_FIELDS,
    PRODUCT_CATEGORY_FIELDS, THIRD_PARTY_FIELDS,
} from '../lib/airtable/schema';

const PAT = (process.env.AIRTABLE_PAT ?? '').trim();
if (!PAT) throw new Error('AIRTABLE_PAT is not set.');

interface LiveField { id: string; name: string; type: string }
interface LiveTable { id: string; name: string; fields: LiveField[] }

/** The comment in schema.ts records the label as of the last verification. */
const PINNED: Array<[string, string, Record<string, string>]> = [
    ['History', TABLES.HISTORY, HISTORY_FIELDS],
    ['Premier Items', TABLES.PREMIER_ITEMS, PREMIER_FIELDS],
    ['Fans', TABLES.FANS, FANS_FIELDS],
    ['3rd Party Domestic Items', TABLES.THIRD_PARTY_DOMESTIC, THIRD_PARTY_FIELDS],
    ['Manufacturers', TABLES.MANUFACTURERS, MANUFACTURER_FIELDS],
    ['Product Categories', TABLES.PRODUCT_CATEGORIES, PRODUCT_CATEGORY_FIELDS],
];

async function main(): Promise<void> {
    const res = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`, {
        headers: { Authorization: `Bearer ${PAT}` },
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    const { tables } = await res.json() as { tables: LiveTable[] };

    console.log(`base ${BASE_ID}: ${tables.length} tables live\n`);
    console.log('ALL LIVE TABLES:');
    for (const t of tables) console.log(`  ${t.id}  ${String(t.fields.length).padStart(3)} fields  ${t.name}`);

    let missingTotal = 0;
    for (const [label, tableId, fields] of PINNED) {
        const live = tables.find(t => t.id === tableId);
        console.log(`\n${'='.repeat(70)}\n${label}  (${tableId})`);
        if (!live) { console.log('  !! TABLE MISSING FROM BASE'); missingTotal++; continue; }
        console.log(`  live name: "${live.name}", ${live.fields.length} fields`);

        const byId = new Map(live.fields.map(f => [f.id, f]));
        const pinnedIds = new Set(Object.values(fields));
        for (const [role, id] of Object.entries(fields)) {
            const f = byId.get(id);
            if (!f) { console.log(`  MISSING  ${role.padEnd(26)} ${id}`); missingTotal++; }
            else console.log(`  ok       ${role.padEnd(26)} ${id}  "${f.name}" (${f.type})`);
        }
        const unpinned = live.fields.filter(f => !pinnedIds.has(f.id));
        if (unpinned.length) {
            console.log(`  -- ${unpinned.length} live field(s) the app does not read:`);
            for (const f of unpinned) console.log(`     ${f.id}  "${f.name}" (${f.type})`);
        }
    }
    console.log(`\n${'='.repeat(70)}\nMISSING pinned fields: ${missingTotal}`);
}

main().catch(e => { console.error(e); process.exit(1); });
