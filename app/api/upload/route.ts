/**
 * POST /api/upload
 * Body:     multipart/form-data with a "file" field — a pre-converted CSV /
 *           single-sheet XLSX (known-column parser), or a fixture-schedule PDF
 *           (Claude reads it natively and returns the same line-item shape).
 * Response: { fileName: string, lineItems: ParsedLineItem[], source: 'sheet' | 'pdf' }
 *
 * PDF schedules were pulled forward from Phase 3 (2026-07-28): one extraction
 * call per uploaded document, user-triggered, token usage logged.
 */

import { NextResponse } from 'next/server';
import { extractScheduleFromPdf } from '@/lib/identify/schedule';
import { isIdentifyAvailable } from '@/lib/identify/claude';
import { parseWorkbook } from '@/lib/parse/workbook';

export const runtime = 'nodejs';
// A long fixture-schedule PDF can take a while to read — same budget as /api/identify.
export const maxDuration = 300;

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;     // 10 MB — far above any converted bid sheet
const MAX_PDF_BYTES = 15 * 1024 * 1024;        // matches the per-line cut-sheet cap

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

    const name = file.name || 'upload.csv';
    const isPdf = name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';

    // ── Fixture-schedule PDF path ─────────────────────────────────────────────
    if (isPdf) {
        if (file.size > MAX_PDF_BYTES) {
            return NextResponse.json({ error: `PDF too large (max ${MAX_PDF_BYTES / 1024 / 1024} MB).` }, { status: 413 });
        }
        if (!isIdentifyAvailable()) {
            return NextResponse.json(
                { error: 'PDF schedule parsing is unavailable: ANTHROPIC_API_KEY is not configured. Upload a pre-converted CSV/Excel sheet instead.' },
                { status: 503 },
            );
        }
        try {
            const base64 = Buffer.from(await file.arrayBuffer()).toString('base64');
            const lineItems = await extractScheduleFromPdf(base64);
            if (lineItems.length === 0) {
                return NextResponse.json(
                    { fileName: name, lineItems: [], source: 'pdf', warning: 'No fixture line items found in the PDF — is this a fixture schedule / bid sheet?' },
                );
            }
            return NextResponse.json({ fileName: name, lineItems, source: 'pdf' });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('schedule PDF extraction failed:', err);
            return NextResponse.json({ error: `PDF schedule parsing failed: ${message}` }, { status: 502 });
        }
    }

    // ── Pre-converted sheet path (Phase 1 parser) ─────────────────────────────
    if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json({ error: 'File too large (max 10 MB).' }, { status: 413 });
    }
    if (!ACCEPTED_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext))) {
        return NextResponse.json(
            { error: `Unsupported file type. Upload a fixture-schedule PDF, or a pre-converted CSV / single-sheet Excel file (${ACCEPTED_EXTENSIONS.join(', ')}).` },
            { status: 415 },
        );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const lineItems = parseWorkbook(buffer, name, file.type);

    if (lineItems.length === 0) {
        return NextResponse.json(
            { fileName: name, lineItems: [], source: 'sheet', warning: 'No line items detected — check that the sheet matches the known column layout (Mark / Qty / Manufacturer / Catalog #).' },
        );
    }

    return NextResponse.json({ fileName: name, lineItems, source: 'sheet' });
}
