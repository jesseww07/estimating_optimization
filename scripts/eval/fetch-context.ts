/**
 * Refresh the eval dataset from the live Airtable base.
 *
 *   AIRTABLE_PAT=pat… npm run eval:fetch
 *   npm run eval:fetch -- --note="post catalog cleanup"
 *
 * Writes __tests__/eval.context.json.gz (+ .meta.json mirror) using the exact
 * same adapter the production app uses (lib/airtable/fetch.ts), so the frozen
 * context matches what the engine sees in production field-for-field.
 *
 * After refreshing: run `npm run eval`, review the numbers and case flips, then
 * `npm run eval:update` to re-baseline. The regression guard intentionally
 * fails on a fingerprint mismatch until the baseline is regenerated.
 *
 * NOTE (initial dataset, 2026-07-29): the first snapshot was assembled via the
 * Airtable MCP connector because sessions don't hold AIRTABLE_PAT; this script
 * is the canonical refresh path whenever a PAT is available. One known
 * difference: this adapter emits ThirdPartyItemRow.productCategories by
 * stringifying the linked-record cell, which over the REST API yields record
 * IDs, not category names (see docs/EVAL-HARNESS.md "Data notes").
 */

import { existsSync } from 'node:fs';
import { fetchEngineContext, isLiveDataAvailable } from '../../lib/airtable/fetch';
import { BASE_ID } from '../../lib/airtable/schema';
import { defaultSnapshotPath, saveSnapshot, type Snapshot } from '../../lib/eval/dataset';

const args = process.argv.slice(2);
const noteArg = args.find(a => a.startsWith('--note='))?.slice(7);

async function main(): Promise<void> {
    if (!isLiveDataAvailable()) {
        console.error('AIRTABLE_PAT is not set — cannot fetch the live base.');
        console.error('Run as: AIRTABLE_PAT=pat… npm run eval:fetch');
        process.exit(2);
    }

    console.log(`Fetching full engine context from ${BASE_ID} (sequential, ~30s cold)…`);
    const context = await fetchEngineContext();

    const snapshot: Snapshot = {
        meta: {
            fetchedAt: new Date().toISOString(),
            source: 'airtable-pat',
            baseId: BASE_ID,
            counts: {
                history: context.history.length,
                premierItems: context.premierItems.length,
                thirdPartyItems: context.thirdPartyItems.length,
                fans: context.fans.length,
            },
            notes: noteArg ? [noteArg] : [],
        },
        context,
    };

    const target = defaultSnapshotPath();
    const existed = existsSync(target);
    const fingerprint = saveSnapshot(target, snapshot);

    console.log(`${existed ? 'Replaced' : 'Wrote'} ${target}`);
    console.log(`  rows: history=${snapshot.meta.counts.history} premier=${snapshot.meta.counts.premierItems} ` +
        `thirdParty=${snapshot.meta.counts.thirdPartyItems} fans=${snapshot.meta.counts.fans}`);
    console.log(`  fingerprint: ${fingerprint}`);
    console.log('Next: npm run eval  → review → npm run eval:update');
}

main().catch(err => {
    console.error('Fetch failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
