/**
 * POST /api/upload
 * Body:     multipart/form-data with a "file" field (pre-converted CSV or
 *           single-sheet XLSX matching the history-source column contract)
 * Response: { fileName: string, lineItems: ParsedLineItem[] }
 *
 * Thin handler: read the file, run the known-column parser, return JSON.
 * Phase 1 scope: no PDF/DOCX/OCR — those are a Phase 2 background-job design.
 */

import { NextResponse } from 'next/server';
import { parseWorkbook } from '@/lib/parse/workbook';

export const runtime = 'nodejs';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB — far above any converted bid sheet

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
    if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json({ error: 'File too large (max 10 MB).' }, { status: 413 });
    }

    const name = file.name || 'upload.csv';
    if (!ACCEPTED_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext))) {
        return NextResponse.json(
            { error: `Unsupported file type. Phase 1 accepts a pre-converted CSV or single-sheet Excel file (${ACCEPTED_EXTENSIONS.join(', ')}).` },
            { status: 415 },
        );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const lineItems = parseWorkbook(buffer, name, file.type);

    if (lineItems.length === 0) {
        return NextResponse.json(
            { fileName: name, lineItems: [], warning: 'No line items detected — check that the sheet matches the known column layout (Mark / Qty / Manufacturer / Catalog #).' },
        );
    }

    return NextResponse.json({ fileName: name, lineItems });
}
