/**
 * POST /api/identify-batch — sheet-level category identification (Phase 4).
 *
 * Body:     { lineItems: ParsedLineItem[], rowIndexes?: number[] }
 *            lineItems is the whole uploaded document. `rowIndexes`, when given,
 *            is the estimator's explicit selection of which lines to spend calls
 *            on — see the cost note below.
 * Response: {
 *             liveData: boolean,
 *             stats:    BatchStats,
 *             results:  LineItemAnalysis[],   // only the lines that got a spec, re-analyzed
 *             failures: { rowIndex, reason, note? }[]
 *           }
 *
 * The route hands the WHOLE sheet over; `lib/identify/batch.ts` decides which
 * lines actually need a Claude call (`detectFixtureCategory` returns null, and
 * the line isn't an RFI placeholder or LED tape) and chunks them. A sheet the
 * engine already understands costs zero calls and comes back with empty results.
 *
 * `rowIndexes` narrows that further, and the reason is the estimator's, not the
 * engine's: on Aura Santan, 21 of the 33 unrecognized lines were `TBD` +
 * "9\" UNDER CABINET" — no manufacturer, no part number, nothing for Claude to
 * identify. Which lines are worth a call is a judgement about the document that
 * only the person reading it can make, so the UI lists the candidates and this
 * honours the selection. Omitted = every candidate, as before.
 *
 * Cost guardrail. The Phase 2 rule in lib/identify/claude.ts — "every call is
 * user-triggered per line — routes must never sweep a whole sheet" — is amended,
 * not ignored: see the block at the top of that file. This IS a sheet sweep, but
 * at ~18 lines per call with a hard 12-call ceiling and no web-search turns, and
 * it still only ever runs because the estimator pressed "Identify N unrecognized
 * lines". Nothing calls this on upload.
 *
 * Latency budget (mirrors the chain documented in lib/identify/claude.ts):
 *   120s per Claude call × at most 2 waves of 6 concurrent calls = 240s worst
 *   case inside the module, then the (usually warm, module-cached) engine
 *   context and a fast re-analysis of the identified lines. The client aborts at
 *   270s; maxDuration is 300s, the same ceiling /api/identify already runs on.
 *   The engine context is prefetched concurrently with the Claude calls so a
 *   cold Airtable pull overlaps the identification instead of stacking on it.
 */

import { NextResponse } from 'next/server';
import { getEngineContext } from '@/lib/airtable/cached';
import { isLiveDataAvailable } from '@/lib/airtable/fetch';
import { analyzeLineItem } from '@/lib/engine/recommend';
import { applyIdentifiedSpec } from '@/lib/identify/apply';
import { identifyCategoriesInBatch, isBatchIdentifyAvailable } from '@/lib/identify/batch';
import { coerceLineItem } from '@/lib/parse/coerce';
import type { LineItemAnalysis } from '@/lib/engine/recommend';
import type { ParsedLineItem } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Same ceiling the recommendations route enforces — one uploaded document, not a corpus. */
const MAX_LINE_ITEMS = 2000;

function err(status: number, message: string): NextResponse {
    return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
    if (!isBatchIdentifyAvailable()) {
        return err(503, 'Batch identification is unavailable: ANTHROPIC_API_KEY is not configured.');
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return err(400, 'Request body must be JSON with { lineItems }.');
    }
    const rawItems = (body as { lineItems?: unknown })?.lineItems;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
        return err(400, 'Body must include a non-empty lineItems array.');
    }
    if (rawItems.length > MAX_LINE_ITEMS) {
        return err(400, `Too many line items (max ${MAX_LINE_ITEMS} per request).`);
    }
    const allLines = rawItems
        .map((raw, i) => coerceLineItem(raw, i))
        .filter((item): item is ParsedLineItem => item !== null);
    if (allLines.length === 0) {
        return err(400, 'No valid line items in request.');
    }

    // The estimator's selection, when they made one. Filtering HERE rather than
    // in the module keeps `lib/identify/batch.ts` the single authority on which
    // lines are candidates at all — this only ever narrows that set.
    //
    // A PRESENT but malformed selection is rejected rather than ignored. Omission
    // means "every candidate", so treating `rowIndexes: null` or a stray string
    // as omission would turn a client typo into a silent full sweep of a paid
    // service — the opposite of what asking for a selection is for.
    const o = (body ?? {}) as Record<string, unknown>;
    let lineItems = allLines;
    if ('rowIndexes' in o && o.rowIndexes !== undefined) {
        const rawSelection = o.rowIndexes;
        if (!Array.isArray(rawSelection)) {
            return err(400, 'rowIndexes must be an array of row numbers (omit it to identify every candidate line).');
        }
        if (!rawSelection.every(n => typeof n === 'number' && Number.isInteger(n))) {
            return err(400, 'rowIndexes must contain only whole numbers.');
        }
        const wanted = new Set(rawSelection);
        if (wanted.size === 0) {
            return err(400, 'rowIndexes was empty — select at least one line to identify.');
        }
        lineItems = allLines.filter(line => wanted.has(line.rowIndex));
        if (lineItems.length === 0) {
            return err(400, 'None of the requested rowIndexes are in the submitted lineItems.');
        }
    }

    // Warm the engine context alongside the Claude calls rather than after them.
    // The catch is attached immediately so a failing prefetch can never surface
    // as an unhandled rejection while the batch is still in flight; the real
    // handling happens where it is awaited below.
    const ctxPrefetch = getEngineContext().then(
        ctx => ({ ok: true as const, ctx }),
        error => ({ ok: false as const, error }),
    );

    try {
        const report = await identifyCategoriesInBatch(lineItems);

        const ctxResult = await ctxPrefetch;
        if (!ctxResult.ok) throw ctxResult.error;
        const ctx = ctxResult.ctx;

        // Re-analyze ONLY the lines identification actually changed. Everything
        // else the client already has, and re-running the whole sheet would
        // discard per-line identifications the estimator made earlier.
        const results: LineItemAnalysis[] = [];
        const failures: Array<{ rowIndex: number; reason: string; note?: string }> = [];
        for (const outcome of report.outcomes) {
            const line = lineItems[outcome.index];
            if (!line) continue;
            if (outcome.spec) {
                results.push(analyzeLineItem(applyIdentifiedSpec(line, outcome.spec), ctx));
            } else if (outcome.lineId !== undefined && outcome.skipped) {
                // Only lines that were genuinely candidates are failures; a line
                // the engine already understood is not a failure to report.
                failures.push({ rowIndex: outcome.rowIndex, reason: outcome.skipped, ...(outcome.note ? { note: outcome.note } : {}) });
            }
        }

        return NextResponse.json({
            liveData: isLiveDataAvailable(),
            stats: report.stats,
            results,
            failures,
        });
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error('identify-batch route failure:', e);
        return err(502, `Batch identification failed: ${message}`);
    }
}
