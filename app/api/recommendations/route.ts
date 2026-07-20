/**
 * POST /api/recommendations
 * Body:     { lineItems: ParsedLineItem[] }
 * Response: { liveData: boolean, results: LineItemAnalysis[] }
 *
 * Thin handler: validate the request, pull the (cached) engine context, run the
 * engine, return JSON. All logic lives in lib/**.
 */

import { NextResponse } from 'next/server';
import { getEngineContext } from '@/lib/airtable/cached';
import { isLiveDataAvailable } from '@/lib/airtable/fetch';
import { analyzeLineItems } from '@/lib/engine/recommend';
import { coerceLineItem } from '@/lib/parse/coerce';
import type { ParsedLineItem } from '@/lib/types';

export const runtime = 'nodejs';
// A cold-start context fetch pages through the whole base (~130 Airtable requests
// at 5 req/s) — allow well past the 10s default.
export const maxDuration = 60;

function errorResponse(err: unknown): NextResponse {
    const message = err instanceof Error ? err.message : String(err);
    console.error('recommendations route failure:', err);
    return NextResponse.json({ error: `Upstream data fetch failed: ${message}` }, { status: 502 });
}

/**
 * GET /api/recommendations — data-path healthcheck.
 * Returns row counts only (no record data, no secrets): proves AIRTABLE_PAT is
 * wired and the four tables are readable from the deployed environment.
 */
export async function GET(): Promise<NextResponse> {
    const live = isLiveDataAvailable();
    if (!live) {
        return NextResponse.json({ liveData: false, note: 'AIRTABLE_PAT is not set — engine runs on an empty context.' });
    }
    try {
        const ctx = await getEngineContext();
        return NextResponse.json({
            liveData: true,
            counts: {
                history: ctx.history.length,
                premierItems: ctx.premierItems.length,
                thirdPartyItems: ctx.thirdPartyItems.length,
                fans: ctx.fans.length,
            },
        });
    } catch (err) {
        return errorResponse(err);
    }
}

export async function POST(request: Request): Promise<NextResponse> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
    }

    const rawItems = (body as { lineItems?: unknown })?.lineItems;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
        return NextResponse.json({ error: 'Body must include a non-empty lineItems array.' }, { status: 400 });
    }
    if (rawItems.length > 2000) {
        return NextResponse.json({ error: 'Too many line items (max 2000 per request).' }, { status: 400 });
    }

    const lineItems = rawItems
        .map((raw, i) => coerceLineItem(raw, i))
        .filter((item): item is ParsedLineItem => item !== null);
    if (lineItems.length === 0) {
        return NextResponse.json({ error: 'No valid line items in request.' }, { status: 400 });
    }

    try {
        const ctx = await getEngineContext();
        const results = analyzeLineItems(lineItems, ctx);
        return NextResponse.json({ liveData: isLiveDataAvailable(), results });
    } catch (err) {
        return errorResponse(err);
    }
}
