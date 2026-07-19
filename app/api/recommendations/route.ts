/**
 * POST /api/recommendations
 * Body:     { lineItems: ParsedLineItem[] }
 * Response: { liveData: boolean, results: LineItemAnalysis[] }
 *
 * Thin handler: validate the request, pull the (cached) engine context, run the
 * engine, return JSON. All logic lives in lib/**.
 */

import { unstable_cache } from 'next/cache';
import { NextResponse } from 'next/server';
import { fetchEngineContext, isLiveDataAvailable } from '@/lib/airtable/fetch';
import { analyzeLineItems } from '@/lib/engine/recommend';
import type { ParsedLineItem } from '@/lib/types';

export const runtime = 'nodejs';

// Cache the full catalog + history read so estimator requests don't re-pull the
// whole base each time (and stay clear of Airtable rate limits).
const getCachedEngineContext = unstable_cache(fetchEngineContext, ['engine-context'], {
    revalidate: 300,
});

function coerceLineItem(raw: unknown, index: number): ParsedLineItem | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
    const rawRow: Record<string, string> = {};
    if (o.rawRow && typeof o.rawRow === 'object') {
        for (const [k, v] of Object.entries(o.rawRow as Record<string, unknown>)) {
            rawRow[k] = str(v);
        }
    }
    return {
        rowIndex: typeof o.rowIndex === 'number' ? o.rowIndex : index,
        section: str(o.section),
        mark: str(o.mark),
        quantity: str(o.quantity),
        manufacturer: str(o.manufacturer),
        catalogNumber: str(o.catalogNumber),
        rawRow,
    };
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

    const ctx = await getCachedEngineContext();
    const results = analyzeLineItems(lineItems, ctx);

    return NextResponse.json({ liveData: isLiveDataAvailable(), results });
}
