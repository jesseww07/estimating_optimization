/**
 * POST /api/upload
 * Body:     multipart/form-data with a "file" field — a pre-converted CSV /
 *           single-sheet XLSX (known-column parser), or a fixture schedule as a
 *           PDF or an image (Claude reads it natively and returns the same
 *           line-item shape).
 * Response: { fileName: string, lineItems: ParsedLineItem[], source: 'sheet' | 'pdf' }
 *
 * `source: 'pdf'` means "read by Claude" for both PDFs and images — the value is
 * part of the route's contract and stays as it is.
 *
 * PDF schedules were pulled forward from Phase 3 (2026-07-28): user-triggered,
 * token usage logged. Images and long-schedule chunking followed 2026-08-31.
 */

import { NextResponse } from 'next/server';
import { extractScheduleFromDocument } from '@/lib/identify/schedule';
import { isIdentifyAvailable } from '@/lib/identify/claude';
import { ACCEPTED_MEDIA_LABEL, detectSupportedMedia } from '@/lib/identify/media';
import { parseWorkbook } from '@/lib/parse/workbook';

export const runtime = 'nodejs';
// A long fixture schedule can take a while to read — same budget as /api/identify.
export const maxDuration = 300;

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;     // 10 MB — far above any converted bid sheet
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;   // matches the per-line cut-sheet cap

const ACCEPTED_EXTENSIONS = ['.csv', '.txt', '.tsv', '.xlsx', '.xls', '.xlsm', '.xlsb'];

export async function POST(request: Request): Promise<NextResponse> {
    let form: FormData;
    try {
        form = await request.formData();
    } catch {
        return NextResponse.json({ error: 'Request must be multipart/form-data with a "file" field.' }, { status: 400 });
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
            { error: `File too large (max ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB for a ${ACCEPTED_MEDIA_LABEL} schedule, ${MAX_UPLOAD_BYTES / 1024 / 1024} MB for a CSV/Excel sheet).` },
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
        if (!isIdentifyAvailable()) {
            return NextResponse.json(
                { error: `Schedule parsing is unavailable: ANTHROPIC_API_KEY is not configured. Upload a pre-converted CSV/Excel sheet instead (${ACCEPTED_EXTENSIONS.join(', ')}).` },
                { status: 503 },
            );
        }
        try {
            const lineItems = await extractScheduleFromDocument(buffer.toString('base64'), media);
            if (lineItems.length === 0) {
                return NextResponse.json(
                    { fileName: name, lineItems: [], source: 'pdf', warning: `No fixture line items found in the ${media.label} — is this a fixture schedule / bid sheet?` },
                );
            }
            return NextResponse.json({ fileName: name, lineItems, source: 'pdf' });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('schedule extraction failed:', err);
            return NextResponse.json({ error: `Schedule parsing failed: ${message}` }, { status: 502 });
        }
    }

    // ── Pre-converted sheet path (Phase 1 parser) ─────────────────────────────
    if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json({ error: `Sheet too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` }, { status: 413 });
    }
    if (!ACCEPTED_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext))) {
        return NextResponse.json(
            { error: `Unsupported file type. Upload a fixture schedule as ${ACCEPTED_MEDIA_LABEL}, or a pre-converted CSV / single-sheet Excel file (${ACCEPTED_EXTENSIONS.join(', ')}).` },
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
