import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
    COL,
    buildCorporateWorkbook,
    inferSubManufacturer,
    workbookToBuffer,
    type ExportRow,
} from '../lib/export/corporate';
import type { ParsedLineItem } from '../lib/types';

function li(partial: Partial<ParsedLineItem>): ParsedLineItem {
    return {
        rowIndex: 0,
        section: '',
        mark: '',
        quantity: '',
        manufacturer: '',
        catalogNumber: '',
        rawRow: {},
        ...partial,
    };
}

const rows: ExportRow[] = [
    {
        lineItem: li({ rowIndex: 0, section: 'Building', mark: 'X-D', quantity: '30', manufacturer: 'BEGHELLI', catalogNumber: 'VA4-R-SA-AT' }),
        substitution: { item: 'GCEXITEM-G2', manufacturer: 'GLOBAL CONCEPTS', source: 'History', confidence: 95, matchReason: '✓ Bid 7 times' },
    },
    {
        lineItem: li({ rowIndex: 1, section: 'Amenity', mark: 'W2', quantity: '3', manufacturer: 'VISUAL COMFORT', catalogNumber: 'CHD 2586AB/NRT' }),
        substitution: null,
        note: 'Left as specified (high-end decorative)',
    },
    {
        lineItem: li({ rowIndex: 2, section: 'Amenity', mark: 'T1', quantity: '12', manufacturer: 'QTRAN', catalogNumber: 'LED TAPE 24V' }),
        substitution: null,
        note: 'LED tape — quote separately',
    },
];

function sheetToGrid(ws: XLSX.WorkSheet): (string | number | undefined)[][] {
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: undefined }) as (string | number | undefined)[][];
}

describe('buildCorporateWorkbook', () => {
    const wb = buildCorporateWorkbook({
        jobName: 'Luna Landing',
        jobLocation: 'New Port Richey, FL',
        customer: 'REKS',
        bidDate: '6/16/26',
        rows,
    });

    it('produces VE DRAFT and ORIGINAL SPEC sheets', () => {
        expect(wb.SheetNames).toEqual(['ORIGINAL SPEC', 'VE DRAFT']);
    });

    it('round-trips through the xlsx writer', () => {
        const buf = workbookToBuffer(wb);
        const re = XLSX.read(buf, { type: 'buffer' });
        expect(re.SheetNames).toEqual(['ORIGINAL SPEC', 'VE DRAFT']);
    });

    it('places the header block at the corporate grid positions', () => {
        const grid = sheetToGrid(wb.Sheets['VE DRAFT']);
        expect(grid[0][0]).toBe('BID SET');
        expect(grid[5][COL.MARK]).toBe('JOB NAME - LUNA LANDING');
        expect(grid[5][COL.MAN]).toBe('CUSTOMER - REKS');
        expect(grid[6][COL.MARK]).toBe('JOB LOCATION - NEW PORT RICHEY, FL');
        const headerRow = grid.findIndex(r => r?.[COL.MARK] === 'MARK');
        expect(headerRow).toBeGreaterThan(6);
        expect(grid[headerRow][COL.MAN]).toBe('MAN');
        expect(grid[headerRow][COL.CATALOG]).toBe('CATALOG #');
        expect(grid[headerRow][COL.COR_NOTES]).toBe('ESTIMATING NOTES FOR CORS');
    });

    it('writes substitutions on VE DRAFT with the original spec in COR notes', () => {
        const grid = sheetToGrid(wb.Sheets['VE DRAFT']);
        const headerRow = grid.findIndex(r => r?.[COL.MARK] === 'MARK');
        // Rows sort by section: Amenity (W2, T1) then Building (X-D).
        const dataRows = grid.slice(headerRow + 1, headerRow + 1 + rows.length);
        const veRow = dataRows.find(r => r[COL.MARK] === 'X-D')!;
        expect(veRow[COL.MAN]).toBe('GLOBAL CONCEPTS');
        expect(veRow[COL.CATALOG]).toBe('GCEXITEM-G2');
        expect(veRow[COL.COR_NOTES]).toBe('VE: was BEGHELLI VA4-R-SA-AT');
        expect(veRow[COL.QTY]).toBe(30);
        const asSpec = dataRows.find(r => r[COL.MARK] === 'W2')!;
        expect(asSpec[COL.MAN]).toBe('VISUAL COMFORT');
        expect(asSpec[COL.CATALOG]).toBe('CHD 2586AB/NRT');
        expect(asSpec[COL.NOTES]).toBe('Left as specified (high-end decorative)');
    });

    it('keeps ORIGINAL SPEC verbatim (no substitutions)', () => {
        const grid = sheetToGrid(wb.Sheets['ORIGINAL SPEC']);
        const headerRow = grid.findIndex(r => r?.[COL.MARK] === 'MARK');
        const dataRows = grid.slice(headerRow + 1, headerRow + 1 + rows.length);
        const orig = dataRows.find(r => r[COL.MARK] === 'X-D')!;
        expect(orig[COL.MAN]).toBe('BEGHELLI');
        expect(orig[COL.CATALOG]).toBe('VA4-R-SA-AT');
        expect(orig[COL.COR_NOTES]).toBeUndefined();
    });

    it('adds a Subtotal formula over the extended-cost column', () => {
        const ws = wb.Sheets['VE DRAFT'];
        const cellWithFormula = Object.keys(ws).find(
            k => !k.startsWith('!') && (ws[k] as XLSX.CellObject).f?.startsWith('SUM('),
        );
        expect(cellWithFormula).toBeDefined();
    });
});

describe('inferSubManufacturer', () => {
    it('maps Premier own-brand prefixes to GLOBAL CONCEPTS / LUCIUS', () => {
        expect(inferSubManufacturer('GCEXITEM-G2')).toBe('GLOBAL CONCEPTS');
        expect(inferSubManufacturer('GC-BUG-EM-A')).toBe('GLOBAL CONCEPTS');
        expect(inferSubManufacturer('LUC-1234')).toBe('LUCIUS');
        expect(inferSubManufacturer('S21359')).toBe('SATCO');
        expect(inferSubManufacturer('UNKNOWN-XYZ')).toBe('');
    });
});
