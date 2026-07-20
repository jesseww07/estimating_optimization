/**
 * POST /api/identify — per-line spec identification (Phase 2).
 *
 * Modes:
 *   url  (JSON body):      { mode: 'url', url: string, lineItem: ParsedLineItem }
 *      Fetch the pasted spec link server-side → Claude extraction → re-run the
 *      engine on the identified line.
 *   web  (JSON body):      { mode: 'web', lineItem: ParsedLineItem }
 *      Claude with web search → cited findings → extraction → re-run engine.
 *
 * Response: { identified: IdentifiedSpec, result: LineItemAnalysis, liveData: boolean }
 *
 * Cost guardrail: strictly one line per request, user-triggered — never called
 * in a sweep over a whole sheet.
 */

import { NextResponse } from 'next/server';
import { getEngineContext } from '@/lib/airtable/cached';
import { isLiveDataAvailable } from '@/lib/airtable/fetch';
import { analyzeLineItem } from '@/lib/engine/recommend';
import { applyIdentifiedSpec } from '@/lib/identify/apply';
import { identifyFromPdf, identifyFromText, identifyFromWeb, isIdentifyAvailable } from '@/lib/identify/claude';
import { fetchSpecUrl } from '@/lib/identify/fetchUrl';
import { coerceLineItem, str } from '@/lib/parse/coerce';
import type { IdentifiedSpec } from '@/lib/identify/types';
import type { ParsedLineItem } from '@/lib/types';

export const runtime = 'nodejs';
// Synchronous identification (handoff decision): vision over a real cut sheet
// can take a while — run on the extended budget rather than a job queue.
export const maxDuration = 300;

function err(status: number, message: string): NextResponse {
    return NextResponse.json({ error: message }, { status });
}

async function respondWith(identified: IdentifiedSpec, lineItem: ParsedLineItem): Promise<NextResponse> {
    const merged = applyIdentifiedSpec(lineItem, identified);
    const ctx = await getEngineContext();
    const result = analyzeLineItem(merged, ctx);
    return NextResponse.json({ identified, result, liveData: isLiveDataAvailable() });
}

export async function POST(request: Request): Promise<NextResponse> {
    if (!isIdentifyAvailable()) {
        return err(503, 'Identification is unavailable: ANTHROPIC_API_KEY is not configured.');
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return err(400, 'Request body must be JSON with { mode, lineItem, ... }.');
    }
    const o = (body ?? {}) as Record<string, unknown>;
    const mode = str(o.mode);
    const lineItem = coerceLineItem(o.lineItem, 0);
    if (!lineItem) {
        return err(400, 'Body must include the lineItem being identified.');
    }

    try {
        if (mode === 'url') {
            const url = str(o.url).trim();
            if (!url) return err(400, 'mode "url" requires a url field.');
            const fetched = await fetchSpecUrl(url);
            const identified = fetched.kind === 'pdf'
                ? await identifyFromPdf(fetched.base64, lineItem)
                : await identifyFromText(fetched.text, lineItem, 'url');
            return await respondWith(identified, lineItem);
        }
        if (mode === 'web') {
            if (!lineItem.manufacturer && !lineItem.catalogNumber) {
                return err(400, 'mode "web" needs at least a manufacturer or catalog value on the line.');
            }
            const identified = await identifyFromWeb(lineItem);
            return await respondWith(identified, lineItem);
        }
        return err(400, `Unknown identify mode "${mode}". Expected "url" or "web".`);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`identify route failure (mode=${mode}):`, e);
        return err(502, `Identification failed: ${message}`);
    }
}
