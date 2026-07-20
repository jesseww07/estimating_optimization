/**
 * POST /api/export
 * Body:     ExportRequest (see lib/export/corporate.ts) — jobName, jobLocation,
 *           customer, rows[{ lineItem, substitution|null, note? }]
 * Response: corporate-template .xlsx (VE DRAFT + ORIGINAL SPEC sheets)
 *
 * Thin handler: validate, delegate to lib/export/corporate, stream the buffer.
 * Pricing columns are left blank on purpose — this is a takeoff draft for the
 * estimator, never a customer-facing quote.
 */

import { NextResponse } from 'next/server';
import { getEngineContext, invalidateEngineContext } from '@/lib/airtable/cached';
import { isLiveDataAvailable } from '@/lib/airtable/fetch';
import { getWritebackMode, writeSelectionsToHistory, type WritebackRow } from '@/lib/airtable/writeback';
import { isLedTape, isRfiPlaceholder } from '@/lib/engine/matcher';
import { buildCorporateWorkbook, inferSubManufacturer, workbookToBuffer, type ExportRow } from '@/lib/export/corporate';
import type { ParsedLineItem } from '@/lib/types';

export const runtime = 'nodejs';
// Write-back adds sequential Airtable create batches after the workbook build.
export const maxDuration = 60;

const MAX_ROWS = 2000;

function str(v: unknown): string {
    return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function coerceLineItem(raw: unknown, index: number): ParsedLineItem {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
        rowIndex: typeof o.rowIndex === 'number' ? o.rowIndex : index,
        section: str(o.section),
        mark: str(o.mark),
        quantity: str(o.quantity),
        manufacturer: str(o.manufacturer),
        catalogNumber: str(o.catalogNumber),
        rawRow: {},
    };
}

function coerceRow(raw: unknown, index: number): ExportRow | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (!o.lineItem || typeof o.lineItem !== 'object') return null;
    const subRaw = o.substitution;
    let substitution: ExportRow['substitution'] = null;
    if (subRaw && typeof subRaw === 'object') {
        const s = subRaw as Record<string, unknown>;
        const item = str(s.item).trim();
        if (item !== '') {
            substitution = {
                item,
                manufacturer: str(s.manufacturer).trim(),
                source: str(s.source),
                confidence: typeof s.confidence === 'number' ? s.confidence : 0,
                matchReason: str(s.matchReason),
                premierLinkId: str(s.premierLinkId).trim() || undefined,
                thirdPartyLinkId: str(s.thirdPartyLinkId).trim() || undefined,
            };
        }
    }
    return { lineItem: coerceLineItem(o.lineItem, index), substitution, note: str(o.note) || undefined };
}

export async function POST(request: Request): Promise<NextResponse> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
    }

    const o = (body ?? {}) as Record<string, unknown>;
    const rawRows = o.rows;
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
        return NextResponse.json({ error: 'Body must include a non-empty rows array.' }, { status: 400 });
    }
    if (rawRows.length > MAX_ROWS) {
        return NextResponse.json({ error: `Too many rows (max ${MAX_ROWS}).` }, { status: 400 });
    }

    const rows = rawRows
        .map((raw, i) => coerceRow(raw, i))
        .filter((r): r is ExportRow => r !== null);
    if (rows.length === 0) {
        return NextResponse.json({ error: 'No valid rows in request.' }, { status: 400 });
    }

    const jobName = str(o.jobName).trim() || 'UNTITLED JOB';
    const wb = buildCorporateWorkbook({
        jobName,
        jobLocation: str(o.jobLocation).trim(),
        customer: str(o.customer).trim(),
        sourceFileName: str(o.sourceFileName).trim() || undefined,
        bidDate: str(o.bidDate).trim() || undefined,
        salesRep: str(o.salesRep).trim() || undefined,
        estimator: str(o.estimator).trim() || undefined,
        rows,
    });
    const buf = workbookToBuffer(wb);

    // ── Learning loop: record selections to bid history (create-only) ────────
    const headers: Record<string, string> = {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="VE DRAFT - ${jobName.replace(/[^\w\- ]+/g, '').trim() || 'ESTIMATE'}.xlsx"`,
    };

    const recordToHistory = o.recordToHistory === true;
    const mode = getWritebackMode();
    if (recordToHistory && mode !== 'off') {
        if (!isLiveDataAvailable()) {
            headers['X-Writeback-Mode'] = 'unavailable';
        } else {
            const today = new Date().toISOString().slice(0, 10); // Bid Date = export date
            const writebackRows: WritebackRow[] = rows
                .filter(r => r.substitution !== null)
                // Never write RFI / tape lines (they should never carry a selection,
                // but the guard is cheap and the contract explicit).
                .filter(r => !isRfiPlaceholder(r.lineItem.mark, r.lineItem.catalogNumber, r.lineItem.manufacturer))
                .filter(r => !isLedTape(r.lineItem.mark, r.lineItem.catalogNumber, r.lineItem.manufacturer))
                .map(r => {
                    const sub = r.substitution!;
                    return {
                        project: jobName,
                        mark: r.lineItem.mark,
                        originalSpec: r.lineItem.catalogNumber,
                        bidItem: sub.item,
                        specManufacturer: r.lineItem.manufacturer,
                        bidManufacturer: sub.manufacturer || inferSubManufacturer(sub.item),
                        bidDate: today,
                        premierLinkId: sub.premierLinkId,
                        thirdPartyLinkId: sub.thirdPartyLinkId,
                    };
                });
            try {
                const ctx = await getEngineContext();
                const result = await writeSelectionsToHistory(writebackRows, ctx.history);
                if (result.mode === 'live' && result.written > 0) {
                    // Next analysis must see the new history immediately.
                    invalidateEngineContext();
                }
                headers['X-Writeback-Mode'] = result.mode;
                headers['X-Writeback-Written'] = String(result.written);
                headers['X-Writeback-Skipped'] = String(result.skippedDuplicates);
                headers['X-Writeback-Attempted'] = String(result.attempted);
                if (result.errors.length > 0) {
                    headers['X-Writeback-Errors'] = String(result.errors.length);
                    console.error('writeback errors:', result.errors);
                }
            } catch (err) {
                // The workbook is still the deliverable — never fail the export over write-back.
                console.error('writeback failed:', err);
                headers['X-Writeback-Mode'] = 'error';
            }
        }
    }

    return new NextResponse(new Uint8Array(buf), { status: 200, headers });
}
