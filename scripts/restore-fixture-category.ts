/**
 * Restore Premier Items "Fixture Category" from the frozen eval snapshot.
 *
 *   npx tsx scripts/restore-fixture-category.ts            # DRY RUN — reports only
 *   npx tsx scripts/restore-fixture-category.ts --apply    # writes to the live base
 *
 * WHY THIS EXISTS (2026-09-01): a mass update in the Airtable UI was left
 * pointing at the wrong table and overwrote every Premier Items row's Fixture
 * Category with a single value; the undo window was lost by navigating away.
 * `__tests__/eval.context.json.gz` is a full freeze of the table taken
 * 2026-08-31 22:59 UTC — record IDs included — so the correct value for every
 * row that existed then is already in the repo.
 *
 * Scope is deliberately ONE FIELD. It restores Fixture Category and nothing
 * else, keyed by Airtable record ID, and only where the live value actually
 * differs from the snapshot. Rows added since the snapshot are reported and
 * left alone — the snapshot cannot know what they should be.
 *
 * A snapshot-blank category is restored as blank (the field is cleared), which
 * is the honest reading of "this is what the row looked like". 157 rows were
 * blank at freeze time; leaving them set would be inventing data.
 */

import { defaultSnapshotPath, loadSnapshot } from '../lib/eval/dataset';

const BASE_ID = 'appWj912AEOvtxqJF';
const TABLE_ID = 'tblXfEOWWjDkpt5tw';        // Premier Items
const FIELD_ID = 'fldvrEsaVx6MWg1to';        // Fixture Category (singleSelect)
const MODIFIED_FIELD = 'Last Modified';

const APPLY = process.argv.includes('--apply');
const PAT = (process.env.AIRTABLE_PAT ?? '').trim();
if (!PAT) throw new Error('AIRTABLE_PAT is not set - put it in .env or the environment.');

/** Airtable allows 5 requests/second per base; stay under it. */
const REQUEST_SPACING_MS = 220;
/** The API caps a write at 10 records per request. */
const WRITE_BATCH = 10;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

interface LiveRecord { id: string; category: string; itemId: string; modified: string }

async function airtable(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetch(`https://api.airtable.com/v0/${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
    return res.json() as Promise<Record<string, unknown>>;
}

async function fetchLive(): Promise<LiveRecord[]> {
    const out: LiveRecord[] = [];
    let offset: string | undefined;
    do {
        const params = new URLSearchParams({ pageSize: '100' });
        for (const f of ['Item ID', 'Fixture Category', MODIFIED_FIELD]) params.append('fields[]', f);
        if (offset) params.set('offset', offset);
        const page = await airtable(`${BASE_ID}/${TABLE_ID}?${params}`);
        for (const rec of page.records as Array<{ id: string; fields: Record<string, string> }>) {
            out.push({
                id: rec.id,
                itemId: rec.fields['Item ID'] ?? '',
                category: rec.fields['Fixture Category'] ?? '',
                modified: rec.fields[MODIFIED_FIELD] ?? '',
            });
        }
        offset = page.offset as string | undefined;
        if (offset) await sleep(REQUEST_SPACING_MS);
    } while (offset);
    return out;
}

async function main(): Promise<void> {
    const snapshot = loadSnapshot(defaultSnapshotPath());
    const wanted = new Map(snapshot.context.premierItems.map(i => [i.id, i]));
    console.log(`snapshot: ${wanted.size} Premier items, frozen ${snapshot.meta.fetchedAt}`);

    // Pre-flight: every category we intend to write must still exist as a choice.
    const schema = await airtable(`meta/bases/${BASE_ID}/tables`);
    const table = (schema.tables as Array<Record<string, unknown>>).find(t => t.id === TABLE_ID)!;
    const field = (table.fields as Array<Record<string, unknown>>).find(f => f.id === FIELD_ID)!;
    const choices = new Set(
        ((field.options as { choices?: Array<{ name: string }> })?.choices ?? []).map(c => c.name),
    );
    const missing = [...new Set([...wanted.values()].map(i => i.fixtureCategory).filter(Boolean))]
        .filter(name => !choices.has(name));
    console.log(`select choices live: ${choices.size}; snapshot values missing from them: ${missing.length}`);
    if (missing.length) {
        console.log('  MISSING (would need re-adding as choices first):', missing.join(', '));
    }

    const live = await fetchLive();
    console.log(`live: ${live.length} Premier items\n`);

    const liveByCategory = new Map<string, number>();
    for (const r of live) liveByCategory.set(r.category || '(blank)', (liveByCategory.get(r.category || '(blank)') ?? 0) + 1);
    console.log('LIVE Fixture Category distribution now:');
    [...liveByCategory.entries()].sort((a, b) => b[1] - a[1])
        .forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${k}`));

    const toFix: Array<{ id: string; itemId: string; from: string; to: string }> = [];
    const newSinceSnapshot: LiveRecord[] = [];
    let alreadyCorrect = 0;
    for (const r of live) {
        const want = wanted.get(r.id);
        if (!want) { newSinceSnapshot.push(r); continue; }
        if ((want.fixtureCategory || '') === r.category) { alreadyCorrect++; continue; }
        toFix.push({ id: r.id, itemId: r.itemId, from: r.category || '(blank)', to: want.fixtureCategory || '(blank)' });
    }
    const liveIds = new Set(live.map(r => r.id));
    const deleted = [...wanted.keys()].filter(id => !liveIds.has(id));

    console.log(`\nalready correct:        ${alreadyCorrect}`);
    console.log(`differ from snapshot:   ${toFix.length}   <- would be restored`);
    console.log(`new since snapshot:     ${newSinceSnapshot.length}   <- left alone, listed below`);
    console.log(`in snapshot, not live:  ${deleted.length}`);

    const modifiedDays = new Map<string, number>();
    for (const r of live) {
        const day = (r.modified || '(none)').slice(0, 16);
        modifiedDays.set(day, (modifiedDays.get(day) ?? 0) + 1);
    }
    console.log('\nLast Modified clustering (top 8) - confirms the blast radius:');
    [...modifiedDays.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        .forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${k}`));

    if (newSinceSnapshot.length) {
        console.log('\nRows added since the snapshot (set these by hand - the snapshot cannot know them):');
        for (const r of newSinceSnapshot) console.log(`  ${r.id}  ${r.itemId}  now="${r.category || '(blank)'}"`);
    }

    const restoreCounts = new Map<string, number>();
    for (const f of toFix) restoreCounts.set(f.to, (restoreCounts.get(f.to) ?? 0) + 1);
    console.log('\nWould restore to:');
    [...restoreCounts.entries()].sort((a, b) => b[1] - a[1])
        .forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${k}`));
    console.log('\nsample of the changes:');
    toFix.slice(0, 8).forEach(f => console.log(`  ${f.itemId.slice(0, 42).padEnd(44)} "${f.from}" -> "${f.to}"`));

    if (!APPLY) {
        console.log(`\nDRY RUN - nothing written. Re-run with --apply to restore ${toFix.length} rows.`);
        return;
    }
    if (missing.length) throw new Error('Refusing to write: some snapshot categories no longer exist as choices.');

    console.log(`\nAPPLYING to ${toFix.length} rows...`);
    let done = 0;
    for (let i = 0; i < toFix.length; i += WRITE_BATCH) {
        const batch = toFix.slice(i, i + WRITE_BATCH);
        await airtable(`${BASE_ID}/${TABLE_ID}`, {
            method: 'PATCH',
            body: JSON.stringify({
                records: batch.map(f => ({ id: f.id, fields: { [FIELD_ID]: f.to === '(blank)' ? null : f.to } })),
            }),
        });
        done += batch.length;
        if (done % 200 === 0 || done === toFix.length) console.log(`  ${done}/${toFix.length}`);
        await sleep(REQUEST_SPACING_MS);
    }
    console.log(`\nRestored ${done} rows. Re-run without --apply to confirm 0 differ.`);
}

main().catch(err => { console.error(err); process.exit(1); });
