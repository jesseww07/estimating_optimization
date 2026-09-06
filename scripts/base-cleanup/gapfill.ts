/**
 * Give a category to every catalog row that has none.
 *
 *   npx tsx --env-file=.env scripts/base-cleanup/gapfill.ts              # dry run, pattern only
 *   npx tsx --env-file=.env scripts/base-cleanup/gapfill.ts --ai         # dry run, pattern + Claude
 *   npx tsx --env-file=.env scripts/base-cleanup/gapfill.ts --ai --apply
 *
 * ~635 rows across Premier and 3rd Party carry no category at all and no other
 * field to derive one from, which makes them invisible to every category-gated
 * match. Two passes:
 *
 *   1. PATTERN — the engine's own detectFixtureCategory over the item number and
 *      description. Free, deterministic, and it agrees with the matching code by
 *      construction, because it IS the matching code.
 *   2. AI — Claude, for what the patterns cannot place, in batches, constrained
 *      to the live category vocabulary. Only runs with --ai.
 *
 * Everything written is marked in a "Category Source" field so an inferred value
 * is never mistaken for one a human set. Rows neither pass can place are left
 * blank and listed, ranked by how often the item has actually been bid — that
 * ranking is the worklist.
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { APPLY, TABLE, allRecords, api, banner, createField, linkIds, sleep, updateRecords, val } from './client';
import { detectFixtureCategory } from '../../lib/engine/matcher';

const USE_AI = process.argv.includes('--ai');

/**
 * `--csv` writes the WHOLE worklist out, not just the 25 rows the console shows.
 * It defaults to the OS temp directory on purpose: the file is a catalog export
 * (item numbers and descriptions) and this repository is public, so the default
 * must never land inside the working tree. `--csv=<path>` overrides it.
 */
const CSV_PATH: string | null = (() => {
    const arg = process.argv.find(a => a === '--csv' || a.startsWith('--csv='));
    if (!arg) return null;
    const given = arg.startsWith('--csv=') ? arg.slice('--csv='.length).trim() : '';
    return given || join(tmpdir(), 'category-worklist.csv');
})();
const SOURCE_FIELD = 'Category Source';
const SOURCE_CHOICES = ['Verified', 'Inferred (pattern)', 'Inferred (AI)'];

/**
 * The engine's broad group label -> the category record that best represents it.
 * Groups whose members span several categories ("Outdoor" covers wall packs,
 * floods, poles and step lights) are deliberately absent: a coarse guess written
 * into the catalog is worse than a blank a human can see and fill.
 */
const GROUP_TO_CATEGORY: Record<string, string> = {
    'Ceiling Fan': 'Ceiling Fan',
    'Vanity': 'Vanity',
    'Mirror': 'LED Mirror',
    'Pendant': 'Pendant',
    'Sconce': 'Wall Sconce',
    'Outdoor Pole': 'Pole Heads',
    'Exit/Emergency': 'Exit / Emergency',
    'Recessed': 'Recessed Light',
    'Linear': 'Linear Surface Mount',
    'Undercabinet': 'Undercabinet Lighting',
    'Ceiling': 'Flush Mount',
    'LED Tape': 'Led Tape',
    'Light Bulb': 'Light Bulb',
};

interface Target {
    table: string;
    tableLabel: string;
    id: string;
    itemId: string;
    text: string;
    timesUsed: number;
}

async function ensureSourceField(tableId: string): Promise<void> {
    const { tables } = await api<{ tables: Array<{ id: string; fields: Array<{ name: string }> }> }>(
        'meta/bases/appWj912AEOvtxqJF/tables');
    const table = tables.find(t => t.id === tableId)!;
    if (table.fields.some(f => f.name === SOURCE_FIELD)) return;
    console.log(`  creating "${SOURCE_FIELD}" on ${tableId}…`);
    await createField(tableId, {
        name: SOURCE_FIELD,
        type: 'singleSelect',
        description: 'How this row got its category. Blank = set by a human. Inferred values were written by scripts/base-cleanup/gapfill.ts and are worth a look.',
        options: { choices: SOURCE_CHOICES.map(name => ({ name })) },
    });
}

/** One Claude call: item lines in, {ref -> category} out. */
async function askBatch(
    client: { messages: { stream: (b: Record<string, unknown>) => { finalMessage: () => Promise<{ content: Array<{ type: string; text?: string }>; stop_reason: string | null; usage: { input_tokens: number; output_tokens: number } }> } } },
    lines: string,
    vocabulary: string[],
): Promise<{ items: Array<{ ref: string; category: string | null }>; input: number; output: number } | null> {
    const schema = {
        type: 'object', additionalProperties: false, required: ['items'],
        properties: {
            items: {
                type: 'array',
                items: {
                    type: 'object', additionalProperties: false, required: ['ref', 'category'],
                    properties: {
                        ref: { type: 'string' },
                        category: { anyOf: [{ type: 'string', enum: vocabulary }, { type: 'null' }] },
                    },
                },
            },
        },
    };
    const res = await client.messages.stream({
        model: (process.env.IDENTIFY_MODEL ?? '').trim() || 'claude-sonnet-5',
        max_tokens: 4096,
        system: 'You categorize lighting products for a lighting distributor catalog. Given an item number and description, choose the ONE category that best describes what the product IS. Use null when the text does not identify the product type — a wrong category is worse than a blank one. Accessories, drivers, trims and hardware belong in their accessory categories, not the fixture category they attach to.',
        output_config: { format: { type: 'json_schema', schema } },
        messages: [{
            role: 'user',
            content: [
                'Categories available:',
                vocabulary.join('\n'),
                '',
                'Items (answer with "ref" = the leading number):',
                lines,
            ].join('\n'),
        }],
    }).finalMessage();
    if (res.stop_reason === 'max_tokens') return null;
    const raw = res.content.find(b => b.type === 'text')?.text ?? '';
    if (!raw.trim()) return null;
    try {
        const parsed = JSON.parse(raw) as { items?: Array<{ ref: string; category: string | null }> };
        return { items: parsed.items ?? [], input: res.usage.input_tokens, output: res.usage.output_tokens };
    } catch {
        return null;
    }
}

/**
 * Ask Claude for a category per item, constrained to the live vocabulary.
 *
 * One flaky call must not cost the whole pass — a 500 partway through ended a
 * 354-row run once. Each batch retries once and then gives up on itself; its
 * rows stay blank and land on the worklist like any other gap.
 */
async function askClaude(items: Target[], vocabulary: string[]): Promise<Map<string, string>> {
    const { createAnthropicClient } = await import('../../lib/identify/anthropic');
    // Structured output over a 40-value enum is slower than the payload size
    // suggests; a 40-item batch on a 120s ceiling timed out outright.
    const client = createAnthropicClient({ timeoutMs: 240_000 }) as unknown as Parameters<typeof askBatch>[0];
    const out = new Map<string, string>();
    const BATCH = 10;
    let failed = 0;
    for (let i = 0; i < items.length; i += BATCH) {
        const batch = items.slice(i, i + BATCH);
        const lines = batch.map((t, n) => `${n}. ${t.itemId} — ${t.text.slice(0, 160)}`).join('\n');
        let res: Awaited<ReturnType<typeof askBatch>> = null;
        for (let attempt = 0; attempt < 2 && !res; attempt++) {
            try {
                res = await askBatch(client, lines, vocabulary);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.log(`    batch @${i}: ${msg.slice(0, 70)}${attempt === 0 ? ' — retrying' : ' — giving up on this batch'}`);
                await sleep(2000);
            }
        }
        if (!res) { failed += batch.length; continue; }
        for (const r of res.items) {
            const t = batch[Number(r.ref)];
            if (t && r.category) out.set(t.id, r.category);
        }
        console.log(`    Claude: ${Math.min(i + BATCH, items.length)}/${items.length}  (in ${res.input} / out ${res.output})`);
    }
    if (failed) console.log(`    ${failed} rows left unplaced by failed batches`);
    return out;
}

/** The full worklist as CSV — every uncategorized row, most-bid first. */
function writeWorklist(unplaced: Target[]): void {
    const cell = (v: string): string => `"${v.replace(/"/g, '""')}"`;
    const csv = [
        'times_bid,table,item_id,description',
        ...unplaced.map(t => [t.timesUsed, cell(t.tableLabel), cell(t.itemId), cell(t.text)].join(',')),
    ].join('\n');
    writeFileSync(CSV_PATH!, `${csv}\n`, 'utf8');
    console.log(`\nwrote all ${unplaced.length} rows to ${CSV_PATH}`);
}

async function main(): Promise<void> {
    banner(`Category gap-fill${USE_AI ? ' (pattern + Claude)' : ' (pattern only)'}`);

    const cats = (await allRecords(TABLE.PRODUCT_CATEGORIES, ['Category Name']))
        .map(r => ({ id: r.id, name: val(r.fields['Category Name']).trim() }))
        .filter(c => c.name);
    const catId = (n: string) => cats.find(c => c.name.toLowerCase() === n.toLowerCase())?.id;
    const vocabulary = cats.map(c => c.name).sort();

    const targets: Target[] = [];
    const premier = await allRecords(TABLE.PREMIER, ['Item ID', 'Item Description', 'Product Categories', 'Times Used']);
    for (const r of premier) {
        if (linkIds(r.fields['Product Categories']).length) continue;
        targets.push({
            table: TABLE.PREMIER, tableLabel: 'Premier', id: r.id,
            itemId: val(r.fields['Item ID']),
            text: val(r.fields['Item Description']),
            timesUsed: Number(val(r.fields['Times Used']) || 0),
        });
    }
    const third = await allRecords(TABLE.THIRD_PARTY, ['Item ID', 'Item Description', 'Purchase Description', 'Product Categories', 'History']);
    for (const r of third) {
        if (linkIds(r.fields['Product Categories']).length) continue;
        targets.push({
            table: TABLE.THIRD_PARTY, tableLabel: '3rd Party', id: r.id,
            itemId: val(r.fields['Item ID']),
            text: [val(r.fields['Item Description']), val(r.fields['Purchase Description'])].filter(Boolean).join(' — '),
            timesUsed: linkIds(r.fields['History']).length,
        });
    }
    console.log(`rows with no category: ${targets.length}  (Premier ${targets.filter(t => t.tableLabel === 'Premier').length}, 3rd Party ${targets.filter(t => t.tableLabel === '3rd Party').length})`);

    // ── Pass 1: the engine's own detector ───────────────────────────────────
    const decided = new Map<string, { category: string; how: string }>();
    for (const t of targets) {
        const group = detectFixtureCategory('', `${t.itemId} ${t.text}`, '');
        const name = group ? GROUP_TO_CATEGORY[group] : undefined;
        if (name && catId(name)) decided.set(t.id, { category: name, how: 'Inferred (pattern)' });
    }
    console.log(`  pattern pass placed: ${decided.size}`);

    // ── Pass 2: Claude on the remainder ─────────────────────────────────────
    const remaining = targets.filter(t => !decided.has(t.id) && t.text.trim().length > 3);
    if (USE_AI && remaining.length) {
        console.log(`  asking Claude about ${remaining.length} rows…`);
        const ai = await askClaude(remaining, vocabulary);
        for (const [id, name] of ai) if (catId(name)) decided.set(id, { category: name, how: 'Inferred (AI)' });
        console.log(`  Claude placed: ${ai.size}`);
    }

    const unplaced = targets.filter(t => !decided.has(t.id));
    console.log(`\nplaced: ${decided.size}   still blank: ${unplaced.length}`);
    const spread = new Map<string, number>();
    for (const d of decided.values()) spread.set(d.category, (spread.get(d.category) ?? 0) + 1);
    console.log('\nwould write:');
    [...spread.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`   ${String(v).padStart(4)}  ${k}`));

    console.log(`\nstill blank, ranked by how often the item has been bid (this is the worklist):`);
    unplaced.sort((a, b) => b.timesUsed - a.timesUsed);
    unplaced.slice(0, 25)
        .forEach(t => console.log(`   used=${String(t.timesUsed).padStart(3)}  ${t.tableLabel.padEnd(10)} ${t.itemId.slice(0, 32).padEnd(34)} ${t.text.slice(0, 44)}`));
    if (unplaced.length > 25) console.log(`   … and ${unplaced.length - 25} more — pass --csv to get all of them`);
    if (CSV_PATH) writeWorklist(unplaced);

    if (!APPLY) { console.log('\nDRY RUN — nothing written.'); return; }

    for (const tableId of [TABLE.PREMIER, TABLE.THIRD_PARTY]) await ensureSourceField(tableId);
    for (const [tableId, label] of [[TABLE.PREMIER, 'Premier'], [TABLE.THIRD_PARTY, '3rd Party']] as const) {
        const updates = targets
            .filter(t => t.table === tableId && decided.has(t.id))
            .map(t => {
                const d = decided.get(t.id)!;
                return { id: t.id, fields: { 'Product Categories': [catId(d.category)!], [SOURCE_FIELD]: d.how } };
            });
        console.log(`\nwriting ${updates.length} ${label} rows…`);
        await updateRecords(tableId, updates);
    }
    console.log('\ndone.');
}

main().catch(e => { console.error(e); process.exit(1); });
