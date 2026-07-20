/**
 * Corporate-template export — builds a Premier Lighting bid-workbook draft from
 * the estimator's reviewed selections.
 *
 * Layout is mirrored from the live corporate bid workbooks (e.g. LUNA LANDING,
 * Box file 2296392839387): header block (JOB NAME / JOB LOCATION / CUSTOMER /
 * SALES / ESTIMATOR, BID DATE), the standard exclusions block, then the line
 * grid with MARK at column D and the pricing columns left for the estimator:
 *
 *   D MARK · E Location · G QTY · H Product Code · I MAN · J CATALOG # ·
 *   K QTY LAMPS · L ESTIMATING NOTES FOR CORS · M NOTES · N LAMP $ ·
 *   O EACH $ · P MULTIPLIER · Q UNIT COST · R EXTENDED COST · S COST EXTENDED
 *
 * Two sheets, same grid: "VE DRAFT" carries the selected substitutions (with
 * the original spec recorded in ESTIMATING NOTES FOR CORS); "ORIGINAL SPEC"
 * carries the parsed upload verbatim. Pricing columns are intentionally blank —
 * pricing stays with the estimator; this is a takeoff draft, not a quote.
 */

import * as XLSX from 'xlsx';
import type { ParsedLineItem } from '../types';

export interface ExportSubstitution {
    item: string;
    manufacturer: string;
    source: string;
    confidence: number;
    matchReason: string;
    /** Catalog record ids backing the selection — used by the History write-back link, not the workbook. */
    premierLinkId?: string;
    thirdPartyLinkId?: string;
}

export interface ExportRow {
    lineItem: ParsedLineItem;
    /** null = leave as specified */
    substitution: ExportSubstitution | null;
    note?: string;
}

export interface ExportRequest {
    jobName: string;
    jobLocation: string;
    customer: string;
    sourceFileName?: string;
    /** Bid date shown in the header; defaults to today (US format). */
    bidDate?: string;
    rows: ExportRow[];
}

// Column indexes (0-based) matching the corporate workbook grid.
export const COL = {
    MARK: 3,        // D
    LOCATION: 4,    // E
    QTY: 6,         // G
    PRODUCT_CODE: 7,// H
    MAN: 8,         // I
    CATALOG: 9,     // J
    QTY_LAMPS: 10,  // K
    COR_NOTES: 11,  // L
    NOTES: 12,      // M
    LAMP: 13,       // N
    EACH: 14,       // O
    MULTIPLIER: 15, // P
    UNIT_COST: 16,  // Q
    EXTENDED: 17,   // R
    COST_EXT: 18,   // S
} as const;

const STANDARD_NOTES = [
    'VE Package. Must be approved by owner and engineer.',
    'Bid as a complete package any changes to quantities voids all pricing',
    'Subject to Premier Lightings Standard Terms and Conditions',
    'All one-hour fire barriers excluded unless noted',
    'Integral Emergency backup excluded unless otherwise noted (EMG)',
    'Emergency Invertors and Generators Excluded',
    'Lighting Controls Excluded',
    'Lighting Programing and startup excluded',
];

/** Best-effort manufacturer label when history didn't carry one. */
export function inferSubManufacturer(item: string): string {
    const u = item.toUpperCase();
    if (/^(GC|GCL|GCEXIT|GCCOMBO|GCMOD|MIR|MDL|PKL|FRIS|HW)/.test(u) || u.startsWith('R-') || u.startsWith('REC-') || u.startsWith('COM-') || u.startsWith('PL-') || u.startsWith('TJ')) {
        return 'GLOBAL CONCEPTS';
    }
    if (u.startsWith('LUC')) return 'LUCIUS';
    if (u.startsWith('S') && /^S\d/.test(u)) return 'SATCO';
    if (u.startsWith('WG') || u.startsWith('WEST')) return 'WESTGATE';
    return '';
}

function headerRows(req: ExportRequest, gridLabel: string): (string | number | null)[][] {
    const bidDate = req.bidDate ?? new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
    const rows: (string | number | null)[][] = [];
    rows.push(['BID SET']);                                                            // 1
    const r2: (string | null)[] = [];
    r2[1] = 'QUOTES LINKED';
    r2[2] = 'REASON FOR CHANGE';
    r2[9] = 'BID DATE';
    r2[10] = bidDate;
    rows.push(r2);                                                                     // 2
    rows.push([], [], []);                                                             // 3-5
    const r6: (string | null)[] = [];
    r6[COL.MARK] = `JOB NAME - ${req.jobName.toUpperCase()}`;
    r6[COL.MAN] = `CUSTOMER - ${req.customer.toUpperCase()}`;
    rows.push(r6);                                                                     // 6
    const r7: (string | null)[] = [];
    r7[COL.MARK] = `JOB LOCATION - ${req.jobLocation.toUpperCase()}`;
    r7[COL.MAN] = 'SALES - ';
    rows.push(r7);                                                                     // 7
    const r8: (string | null)[] = [];
    r8[COL.MAN] = 'ESTIMATOR - ';
    rows.push(r8);                                                                     // 8
    rows.push([], []);                                                                 // 9-10
    for (const note of STANDARD_NOTES) {
        const r: (string | null)[] = [];
        r[COL.MARK] = note;
        rows.push(r);
    }
    rows.push([]);
    const src: (string | null)[] = [];
    src[COL.MARK] = `Plan information - ${gridLabel}${req.sourceFileName ? ` (from ${req.sourceFileName})` : ''}`;
    rows.push(src);
    // Super-header over the pricing columns.
    const superH: (string | null)[] = [];
    superH[COL.EACH] = 'COST';
    superH[COL.MULTIPLIER] = 'COST';
    superH[COL.UNIT_COST] = 'COST';
    superH[COL.EXTENDED] = 'UNIT';
    superH[COL.COST_EXT] = 'EXTENDED';
    rows.push(superH);
    const h: (string | null)[] = [];
    h[COL.MARK] = 'MARK';
    h[COL.LOCATION] = 'Location';
    h[COL.QTY] = 'QTY';
    h[COL.PRODUCT_CODE] = 'Product Code';
    h[COL.MAN] = 'MAN';
    h[COL.CATALOG] = 'CATALOG #';
    h[COL.QTY_LAMPS] = 'QTY LAMPS';
    h[COL.COR_NOTES] = 'ESTIMATING NOTES FOR CORS';
    h[COL.NOTES] = 'NOTES';
    h[COL.LAMP] = 'LAMP $';
    h[COL.EACH] = 'EACH $';
    h[COL.MULTIPLIER] = 'MULTIPLIER';
    h[COL.UNIT_COST] = 'COST';
    h[COL.EXTENDED] = 'COST';
    h[COL.COST_EXT] = 'EXTENDED';
    rows.push(h);
    return rows;
}

function sortRows(rows: ExportRow[]): ExportRow[] {
    return [...rows].sort((a, b) => {
        const s = (a.lineItem.section || '').localeCompare(b.lineItem.section || '');
        if (s !== 0) return s;
        return a.lineItem.rowIndex - b.lineItem.rowIndex;
    });
}

function buildSheet(req: ExportRequest, mode: 'VE' | 'ORIGINAL'): XLSX.WorkSheet {
    const aoa = headerRows(req, mode === 'VE' ? 'VE DRAFT' : 'ORIGINAL SPEC');
    const headerRowIndex = aoa.length - 1; // 0-based index of the MARK header row
    for (const row of sortRows(req.rows)) {
        const li = row.lineItem;
        const r: (string | number | null)[] = [];
        r[COL.MARK] = li.mark;
        r[COL.LOCATION] = li.section;
        r[COL.QTY] = li.quantity !== '' && !isNaN(Number(li.quantity)) ? Number(li.quantity) : li.quantity;
        if (mode === 'VE' && row.substitution) {
            const sub = row.substitution;
            r[COL.MAN] = sub.manufacturer || inferSubManufacturer(sub.item);
            r[COL.CATALOG] = sub.item;
            r[COL.COR_NOTES] = `VE: was ${[li.manufacturer, li.catalogNumber].filter(Boolean).join(' ')}`.trim();
            r[COL.NOTES] = [`${sub.matchReason}`, row.note].filter(Boolean).join(' — ');
        } else {
            r[COL.MAN] = li.manufacturer;
            r[COL.CATALOG] = li.catalogNumber;
            if (mode === 'VE') {
                r[COL.NOTES] = row.note || 'As specified';
            }
        }
        aoa.push(r);
    }
    const firstDataRow = headerRowIndex + 2;           // 1-based Excel row of first line item
    const lastDataRow = headerRowIndex + 1 + req.rows.length;
    aoa.push([]);
    const sub: (string | number | null)[] = [];
    sub[COL.UNIT_COST] = 'Subtotal';
    aoa.push(sub);
    const tax: (string | null)[] = [];
    tax[COL.UNIT_COST] = 'Tax';
    tax[COL.EXTENDED] = 'Excluded';
    aoa.push(tax);
    const tot: (string | null)[] = [];
    tot[COL.UNIT_COST] = 'Total';
    aoa.push(tot);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Subtotal formula over the EXTENDED COST column (left blank for pricing).
    if (req.rows.length > 0) {
        const colLetter = XLSX.utils.encode_col(COL.EXTENDED);
        const subCell = XLSX.utils.encode_cell({ r: aoa.length - 3, c: COL.EXTENDED });
        ws[subCell] = { t: 'n', f: `SUM(${colLetter}${firstDataRow}:${colLetter}${lastDataRow})` };
    }
    ws['!cols'] = Array.from({ length: 20 }, (_, i) => {
        if (i === COL.MARK) return { wch: 22 };
        if (i === COL.LOCATION) return { wch: 14 };
        if (i === COL.MAN) return { wch: 20 };
        if (i === COL.CATALOG) return { wch: 46 };
        if (i === COL.COR_NOTES || i === COL.NOTES) return { wch: 36 };
        if (i < COL.MARK) return { wch: 4 };
        return { wch: 10 };
    });
    return ws;
}

export function buildCorporateWorkbook(req: ExportRequest): XLSX.WorkBook {
    const wb = XLSX.utils.book_new();
    // ORIGINAL SPEC first, VE DRAFT second — estimators read the as-spec sheet
    // before the selections sheet (requested 2026-07-20).
    XLSX.utils.book_append_sheet(wb, buildSheet(req, 'ORIGINAL'), 'ORIGINAL SPEC');
    XLSX.utils.book_append_sheet(wb, buildSheet(req, 'VE'), 'VE DRAFT');
    return wb;
}

export function workbookToBuffer(wb: XLSX.WorkBook): Buffer {
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
