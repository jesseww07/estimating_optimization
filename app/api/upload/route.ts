/**
 * POST /api/upload
 * Body:     multipart/form-data, either
 *           - a "file" field — a pre-converted CSV / single-sheet XLSX
 *             (known-column parser), a fixture schedule as a PDF or an image, or
 *             a Word (.docx) schedule (Claude reads all three natively and they
 *             return the same line-item shape); or
 *           - repeated "page" fields — a document the BROWSER already split into
 *             pages, with parallel "pageLabel" fields, plus optional "docText"
 *             and "fileName". This is how a Word schedule normally arrives: see
 *             the size note below.
 * Response: { fileName: string, lineItems: ParsedLineItem[], source: 'sheet' | 'pdf' }
 *
 * `source: 'pdf'` means "read by Claude" for PDFs, images and Word files alike —
 * the value is part of the route's contract and stays as it is.
 *
 * ── Why the browser may pre-split a document ────────────────────────────────
 * Vercel refuses a request body over 4.5 MB at the platform edge, before this
 * route runs, and the browser reports that as a bare "Failed to fetch" — which
 * is exactly what a 4.9 MB Word schedule did in live use (2026-09-01). A Word
 * file's bulk is its embedded page screenshots, so the browser reads the .docx
 * (lib/parse/docx.ts is isomorphic for this reason), recompresses the pages, and
 * posts them as separate parts. The raw-".docx"-in-"file" path below still works
 * and is the same code — it is simply reachable only for files small enough to
 * arrive intact.
 *
 * PDF schedules were pulled forward from Phase 3 (2026-07-28): user-triggered,
 * token usage logged. Images and long-schedule chunking followed 2026-08-31;
 * Word documents 2026-09-01.
 */

import { NextResponse } from 'next/server';
import { extractScheduleFromDocument, extractScheduleFromPages, MAX_PAGES, type SchedulePage } from '@/lib/identify/schedule';
import { planDocxPages } from '@/lib/identify/docxPages';
import { isIdentifyAvailable } from '@/lib/identify/claude';
import { ACCEPTED_MEDIA_LABEL, detectSupportedMedia } from '@/lib/identify/media';
import { isDocxContainer, readDocx } from '@/lib/parse/docx';
import { parseWorkbook } from '@/lib/parse/workbook';

export const runtime = 'nodejs';
// A long fixture schedule can take a while to read — same budget as /api/identify.
export const maxDuration = 300;

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;     // 10 MB — far above any converted bid sheet
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;   // matches the per-line cut-sheet cap

const ACCEPTED_EXTENSIONS = ['.csv', '.txt', '.tsv', '.xlsx', '.xls', '.xlsm', '.xlsb'];

/** What the estimator may upload, spelled out for the 415 message. */
const ACCEPTED_DOCUMENT_LABEL = `${ACCEPTED_MEDIA_LABEL}, or Word (.docx)`;

function unavailable(): NextResponse {
    return NextResponse.json(
        { error: `Schedule parsing is unavailable: ANTHROPIC_API_KEY is not configured. Upload a pre-converted CSV/Excel sheet instead (${ACCEPTED_EXTENSIONS.join(', ')}).` },
        { status: 503 },
    );
}

function scheduleFailure(err: unknown, what: string): NextResponse {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`schedule extraction failed (${what}):`, err);
    return NextResponse.json({ error: `Schedule parsing failed: ${message}` }, { status: 502 });
}

/**
 * The browser-prepared path: pages already split out of a document, each one
 * sniffed here like any other upload — a page the browser mislabels must not
 * reach the API with the wrong media type.
 */
async function handlePreparedPages(form: FormData): Promise<NextResponse> {
    const files = form.getAll('page').filter((p): p is File => p instanceof File);
    if (files.length === 0) {
        return NextResponse.json({ error: 'No "page" parts in the request.' }, { status: 400 });
    }
    if (files.length > MAX_PAGES) {
        return NextResponse.json(
            { error: `That document holds ${files.length} pages of schedule — more than the ${MAX_PAGES}-page limit for one upload. Split it and upload the parts one at a time.` },
            { status: 413 },
        );
    }
    if (!isIdentifyAvailable()) return unavailable();

    const labels = form.getAll('pageLabel').map(label => (typeof label === 'string' ? label : ''));
    const name = (() => {
        const raw = form.get('fileName');
        return typeof raw === 'string' && raw.trim() ? raw.trim() : 'schedule.docx';
    })();
    const context = (() => {
        const raw = form.get('docText');
        return typeof raw === 'string' ? raw : '';
    })();

    const pages: SchedulePage[] = [];
    for (const [index, file] of files.entries()) {
        const buffer = Buffer.from(await file.arrayBuffer());
        const media = detectSupportedMedia(buffer);
        if (!media) {
            return NextResponse.json(
                { error: `Page ${index + 1} of the document is not a readable image (${file.name || 'unnamed'}).` },
                { status: 415 },
            );
        }
        pages.push({ kind: 'media', media, base64: buffer.toString('base64'), label: labels[index] || undefined });
    }

    try {
        const lineItems = await extractScheduleFromPages(pages, { context });
        if (lineItems.length === 0) {
            return NextResponse.json({
                fileName: name,
                lineItems: [],
                source: 'pdf',
                warning: `No fixture line items found across the ${pages.length} pages read from ${name} — is this a fixture schedule?`,
            });
        }
        return NextResponse.json({ fileName: name, lineItems, source: 'pdf' });
    } catch (err) {
        return scheduleFailure(err, `${pages.length} prepared pages`);
    }
}

/** A Word document that arrived whole: read it here, same page machinery. */
async function handleDocx(buffer: Buffer, name: string): Promise<NextResponse> {
    if (!isIdentifyAvailable()) return unavailable();
    let plan: ReturnType<typeof planDocxPages>;
    try {
        plan = planDocxPages(await readDocx(buffer));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: `Could not read that Word file: ${message}` }, { status: 415 });
    }
    if (plan.shape === 'empty') {
        return NextResponse.json({
            fileName: name,
            lineItems: [],
            source: 'pdf',
            warning: 'That Word file has no readable schedule content — no text and no page images.',
        });
    }
    console.log(`[identify] source=docx shape=${plan.shape} pages=${plan.pages.length} file=${name}`);
    try {
        const lineItems = await extractScheduleFromPages(plan.pages, { context: plan.context });
        if (lineItems.length === 0) {
            return NextResponse.json({
                fileName: name,
                lineItems: [],
                source: 'pdf',
                warning: `No fixture line items found in the Word file — is this a fixture schedule / bid sheet?`,
            });
        }
        return NextResponse.json({ fileName: name, lineItems, source: 'pdf' });
    } catch (err) {
        return scheduleFailure(err, `docx ${plan.shape}`);
    }
}

export async function POST(request: Request): Promise<NextResponse> {
    let form: FormData;
    try {
        form = await request.formData();
    } catch {
        return NextResponse.json({ error: 'Request must be multipart/form-data with a "file" field.' }, { status: 400 });
    }

    // A browser-prepared document arrives as repeated "page" parts instead.
    if (form.getAll('page').length > 0) {
        return handlePreparedPages(form);
    }

    const file = form.get('file');
    if (!(file instanceof File)) {
        return NextResponse.json({ error: 'Missing "file" field.' }, { status: 400 });
    }
    if (file.size === 0) {
        return NextResponse.json({ error: 'Uploaded file is empty.' }, { status: 400 });
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
        return NextResponse.json(
            { error: `File too large (max ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB for a ${ACCEPTED_DOCUMENT_LABEL} schedule, ${MAX_UPLOAD_BYTES / 1024 / 1024} MB for a CSV/Excel sheet).` },
            { status: 413 },
        );
    }

    const name = file.name || 'upload.csv';
    const buffer = Buffer.from(await file.arrayBuffer());
    // Sniffed from the bytes, not the extension: a schedule photo saved as
    // "schedule.pdf" (or a .jpg that is really a PNG) still has to be sent with
    // the right media type.
    const media = detectSupportedMedia(buffer);

    // ── Fixture-schedule document path (PDF or image) ─────────────────────────
    if (media) {
        if (!isIdentifyAvailable()) return unavailable();
        try {
            const lineItems = await extractScheduleFromDocument(buffer.toString('base64'), media);
            if (lineItems.length === 0) {
                return NextResponse.json(
                    { fileName: name, lineItems: [], source: 'pdf', warning: `No fixture line items found in the ${media.label} — is this a fixture schedule / bid sheet?` },
                );
            }
            return NextResponse.json({ fileName: name, lineItems, source: 'pdf' });
        } catch (err) {
            return scheduleFailure(err, media.label);
        }
    }

    // ── Word-document path ────────────────────────────────────────────────────
    // Checked from the ZIP directory, not the extension: .docx and .xlsx are both
    // ZIPs, and handing either to the other's parser fails in a way that reads
    // like a broken file rather than a wrong path.
    if (isDocxContainer(buffer)) {
        return handleDocx(buffer, name);
    }

    // ── Pre-converted sheet path (Phase 1 parser) ─────────────────────────────
    if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json({ error: `Sheet too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` }, { status: 413 });
    }
    if (!ACCEPTED_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext))) {
        return NextResponse.json(
            { error: `Unsupported file type. Upload a fixture schedule as ${ACCEPTED_DOCUMENT_LABEL}, or a pre-converted CSV / single-sheet Excel file (${ACCEPTED_EXTENSIONS.join(', ')}).` },
            { status: 415 },
        );
    }

    const lineItems = parseWorkbook(buffer, name, file.type);

    if (lineItems.length === 0) {
        return NextResponse.json(
            { fileName: name, lineItems: [], source: 'sheet', warning: 'No line items detected — check that the sheet matches the known column layout (Mark / Qty / Manufacturer / Catalog #).' },
        );
    }

    return NextResponse.json({ fileName: name, lineItems, source: 'sheet' });
}
