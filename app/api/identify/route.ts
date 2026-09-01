/**
 * POST /api/identify — per-line spec identification (Phase 2).
 *
 * Modes:
 *   url  (JSON body):      { mode: 'url', url: string, lineItem: ParsedLineItem }
 *      Fetch the pasted spec link server-side → Claude extraction → re-run the
 *      engine on the identified line.
 *   web  (JSON body):      { mode: 'web', lineItem: ParsedLineItem }
 *      Claude with web search → cited findings → extraction → re-run engine.
 *   pdf  (multipart/form-data): mode=pdf, lineItem=<JSON>, file=<cut sheet>
 *      Claude reads the file natively (vision) → extraction → re-run engine.
 *      The file may be a PDF or an image (PNG/JPEG/WebP/GIF) — cut sheets arrive
 *      as phone photos and screenshots as often as PDFs. The mode name stays
 *      "pdf" because it is the route's public contract.
 *      Synchronous on maxDuration=300 per the handoff — no job queue until
 *      real cut sheets prove they blow the budget.
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
import { identifyFromDocument, identifyFromText, identifyFromWeb, isIdentifyAvailable } from '@/lib/identify/claude';
import { fetchSpecUrl, isFetchableSpecUrl } from '@/lib/identify/fetchUrl';
import { ACCEPTED_MEDIA_LABEL, PDF_MEDIA, detectSupportedMedia } from '@/lib/identify/media';
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

const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

async function handleDocumentUpload(request: Request): Promise<NextResponse> {
    let form: FormData;
    try {
        form = await request.formData();
    } catch {
        return err(400, 'mode "pdf" requires multipart/form-data with lineItem and file fields.');
    }
    let lineItem: ParsedLineItem | null = null;
    try {
        lineItem = coerceLineItem(JSON.parse(str(form.get('lineItem'))), 0);
    } catch {
        /* fall through to the null check */
    }
    if (!lineItem) return err(400, 'Missing or invalid "lineItem" field (JSON).');

    const file = form.get('file');
    if (!(file instanceof File)) return err(400, 'Missing "file" field (the cut sheet).');
    if (file.size === 0) return err(400, 'Uploaded cut sheet is empty.');
    if (file.size > MAX_DOCUMENT_BYTES) return err(413, `Cut sheet too large (max ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB).`);

    // Sniffed from the bytes: the filename and the browser-supplied MIME are
    // both routinely wrong, and the API rejects a mislabelled media type.
    const buffer = Buffer.from(await file.arrayBuffer());
    const media = detectSupportedMedia(buffer);
    if (!media) return err(415, `Unsupported cut-sheet type. Upload ${ACCEPTED_MEDIA_LABEL} — a photo or screenshot of the spec sheet works.`);

    try {
        const identified = await identifyFromDocument(buffer.toString('base64'), media, lineItem);
        return await respondWith(identified, lineItem);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error('identify route failure (mode=pdf):', e);
        return err(502, `Identification failed: ${message}`);
    }
}

export async function POST(request: Request): Promise<NextResponse> {
    if (!isIdentifyAvailable()) {
        return err(503, 'Identification is unavailable: ANTHROPIC_API_KEY is not configured.');
    }

    // Cut-sheet uploads arrive as multipart; url/web modes as JSON.
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
        return handleDocumentUpload(request);
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
            // Validate BEFORE fetching so the SSRF/junk guard stays a hard 400 —
            // the web fallback below is reserved for real pages that refuse us.
            if (!isFetchableSpecUrl(url)) {
                return err(400, 'URL must be a public http(s) address.');
            }
            let fetched: Awaited<ReturnType<typeof fetchSpecUrl>>;
            try {
                fetched = await fetchSpecUrl(url);
            } catch (fetchErr) {
                // Manufacturer sites routinely bot-block direct fetches (403 was
                // the whole outcome of a live run, 2026-08-05). The pasted link
                // still names the product — fall back to web identification with
                // the URL as the lead instead of failing the line.
                const fetchMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
                console.warn(`identify url fetch failed (${fetchMsg}) — falling back to web lookup: ${url}`);
                try {
                    const identified = await identifyFromWeb(lineItem, url);
                    return await respondWith(identified, lineItem);
                } catch (webErr) {
                    const webMsg = webErr instanceof Error ? webErr.message : String(webErr);
                    return err(502, `Identification failed: the page could not be fetched (${fetchMsg}) and the web-lookup fallback also failed: ${webMsg}`);
                }
            }
            const identified = fetched.kind === 'pdf'
                ? await identifyFromDocument(fetched.base64, PDF_MEDIA, lineItem)
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
