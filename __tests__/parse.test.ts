/**
 * Workbook parser regressions.
 *
 * The Collective MedSpa fixtures replicate the real bid workbook (2026-07-28)
 * that exposed three bugs: an empty "Product Code" column hijacking the
 * catalog mapping (dropping every L-series line), "RFI #1 - MISSING SPECS"
 * surviving the junk filter because of the space before "#", and summary rows
 * (Subtotal/Tax/Total/tariff boilerplate) becoming line items once the catalog
 * column actually held data.
 */

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
    chooseCatalogColumn,
    findCatalogCandidates,
    parseUploadedFileFromRows,
    parseWorkbook,
} from '../lib/parse/workbook';

/** Column layout of the real MedSpa bid sheet (19 columns, data starts at C). */
const MEDSPA_HEADER = ['', '', 'MARK', 'Location', '', 'QTY', 'Product Code', 'MAN', 'CATALOG #', 'QTY LAMPS', 'ESTIMATING NOTES FOR CORS', 'NOTES', 'LAMP $', 'EACH $', 'MULTIPLIER', 'COST', 'COST', 'EXTENDED', ''];

function medspaRow(mark: string, location: string, qty: string, man: string, catalog: string): string[] {
    return ['', '', mark, location, '', qty, '', man, catalog, '', '', '', '', '', '', '0', '0', '0', ''];
}

const MEDSPA_ROWS: string[][] = [
    ['QUOTES LINKED', 'REASON FOR CHANGE', '', '', '', '', '', '', 'BID DATE', '5/18/26', '', '', '', '', '', 'BID DATE', '5/18/26', '', ''],
    ['', '', 'JOB NAME - COLLECTIVE MEDSPA', '', '', '', '', '', 'CUSTOMER - DBM', '', '', '', '', '', '', '', '', '', ''],
    ['', '', 'JOB LOCATION - Litchfield Park, AZ', '', '', '', '', '', 'SALES - CK', '', '', '', '', '', '', '', '', '', ''],
    ['', '', 'VE Package. Must be approved by owner', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', '', 'COST', 'COST', 'COST', 'UNIT', 'EXTENDED', 'COST', ''],
    MEDSPA_HEADER,
    medspaRow('A (rfi #1)', 'Amenity', '54', 'TBD', 'RECESSED DOWNLIGHT'),
    medspaRow('A1 (rfi #1)', 'Amenity', '6', 'TBD', 'RECESSED EM DOWNLIGHT'),
    medspaRow('EXIT-SF (rfi #1)', 'Amenity', '3', 'TBD', 'SINGLE FACED EXIT SIGN'),
    medspaRow('L1', 'Amenity', '2', 'ETHINKLIVING', 'PRUDENCE WALL SCONCE'),
    medspaRow('L2', 'Amenity', '1', 'LUMENS', 'DAITH CHANDELIER'),
    medspaRow('L3', 'Amenity', '1', 'VISUAL COMFORT', "MOLLINO 40' CHANDELIER"),
    medspaRow('L4', 'Amenity', '4', 'ETSY/NAAYASTUDIO', 'WABI SABI WALL SCONCE'),
    medspaRow('L5', 'Amenity', '4', 'LULU AND GEORGIA', 'SHADO SCONCE'),
    medspaRow('L6', 'Amenity', '6', 'LULU AND GEORGIA', 'TAMAR SCONCE'),
    medspaRow('L7', 'Amenity', '2', 'LUMENS', 'CANNELE PICTURE LIGHT'),
    medspaRow('L8', 'Amenity', '1', 'ARTHAUS', 'PALOMA CHANDELIER'),
    medspaRow('L9', 'Amenity', '2', 'LUMENS', 'CLEO WALL SCONCE'),
    medspaRow('L10', 'Amenity', '6', 'LAS SOLAS', 'ELIF MODERN RECESSED METAL PLASTER LED WALL LAMP-OPTION C'),
    ['', '', 'RFI #1 - MISSING SPECS', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', 'Subtotal', '0', '', '', '', '', '', 'Subtotal', '0', '0', ''],
    ['', '', '', '', '', '', '', '', 'Tax', 'Excluded', '', '', '', '', '', 'Tax', 'Excluded', '', ''],
    ['', '', '', '', '', '', '', '', 'Total', '0', '', '', '', '', '', 'Total', '0', '#DIV/0!', ''],
    ['', '', '', '', '', '', '', '', '*Pricing includes all Tariffs as of', '4/1/25', '', '', '', '', '', '*Pricing includes all Tariffs as of', '4/1/25', '', ''],
    ['', '', '', '', '', '', '', '', '*Any future Tariffs will result in a price increase', '', '', '', '', '', '', '', '', '', ''],
];

describe('catalog column mapping (alias priority)', () => {
    it('prefers CATALOG # over an earlier Product Code column', () => {
        const candidates = findCatalogCandidates(MEDSPA_HEADER);
        expect(candidates.map(c => c.colIdx)).toContain(6);
        expect(candidates.map(c => c.colIdx)).toContain(8);
        expect(chooseCatalogColumn(candidates)).toBe(8);
    });

    it('falls back to a populated candidate when the best-ranked column is empty', () => {
        const rows: string[][] = [
            ['MARK', 'QTY', 'CATALOG #', 'MAN', 'DESCRIPTION'],
            ['F1', '10', '', 'LITHONIA', 'WF6-LED-30K-MW'],
            ['F2', '4', '', 'LITHONIA', 'CPX-2X4-40L'],
        ];
        const items = parseUploadedFileFromRows(rows);
        expect(items).toHaveLength(2);
        expect(items[0]?.catalogNumber).toBe('WF6-LED-30K-MW');
    });
});

describe('Collective MedSpa bid sheet regression', () => {
    const items = parseUploadedFileFromRows(MEDSPA_ROWS);

    it('parses all 13 fixture lines (TBD rows and decorative L-series)', () => {
        expect(items.map(i => i.mark)).toEqual([
            'A (rfi #1)', 'A1 (rfi #1)', 'EXIT-SF (rfi #1)',
            'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10',
        ]);
    });

    it('reads specs from the CATALOG # column, not the mark or Product Code', () => {
        const byMark = new Map(items.map(i => [i.mark, i]));
        expect(byMark.get('A (rfi #1)')?.catalogNumber).toBe('RECESSED DOWNLIGHT');
        expect(byMark.get('L2')?.catalogNumber).toBe('DAITH CHANDELIER');
        expect(byMark.get('L2')?.manufacturer).toBe('LUMENS');
        expect(byMark.get('L10')?.catalogNumber).toBe('ELIF MODERN RECESSED METAL PLASTER LED WALL LAMP-OPTION C');
    });

    it('keeps quantities from the QTY column (not QTY LAMPS)', () => {
        const byMark = new Map(items.map(i => [i.mark, i]));
        expect(byMark.get('A (rfi #1)')?.quantity).toBe('54');
        expect(byMark.get('L6')?.quantity).toBe('6');
    });

    it('drops the RFI note row and the summary/boilerplate rows', () => {
        const marks = items.map(i => i.mark);
        expect(marks).not.toContain('RFI #1 - MISSING SPECS');
        for (const item of items) {
            expect(item.catalogNumber).not.toMatch(/^(subtotal|total|tax|\*?\s*pricing|\*?\s*any future)/i);
        }
    });
});

describe('3rd & Flower parser regressions (2026-07-30)', () => {
    it('the short-catalog rescue never replaces a real catalog number with a pasted URL', () => {
        // Real UA line: CATALOG # held "8113" (4 chars → rescue fires) and a
        // stray column carried the Amazon spec link. The rescue must skip the
        // URL; the link still lands in specUrls for the identify flow.
        const rows = [
            ['MARK', 'Location', 'QTY', 'MAN', 'CATALOG #', 'NOTES', ''],
            ['UA', 'Unit', '4022', 'HOME SELECTIONS INTERNATIONAL', '8113', '', 'https://us.amazon.com/HomeSelects-8113-Surface/dp/B01DEB8E2M'],
        ];
        const items = parseUploadedFileFromRows(rows);
        expect(items).toHaveLength(1);
        expect(items[0]!.catalogNumber).toBe('8113');
        expect(items[0]!.specUrls).toEqual(['https://us.amazon.com/HomeSelects-8113-Surface/dp/B01DEB8E2M']);
    });

    it('a 1-2 character data cell never becomes a catalog-column candidate', () => {
        // Mark cell "C" is a substring of the alias "catalog #" — without the
        // length guard it ranked 0 and could hijack the mapping during the
        // header scan.
        expect(findCatalogCandidates(['C', 'Bldg', '34', 'LXEM4-40HL-RFA-EDU'])).toHaveLength(0);
        // Real headers still match, including short-but-exact aliases.
        expect(chooseCatalogColumn(findCatalogCandidates(['MARK', 'CATALOG #']))).toBe(1);
    });
});

describe('multi-sheet workbooks', () => {
    it('picks the bid sheet over a cover sheet and a degenerate Airtable-import tab', () => {
        // Import staging tabs parse into MORE rows than the bid sheet, but the
        // rows are junk (catalog cell = Airtable rec ID or the manufacturer
        // repeated). The healthy-item score must send us to the bid sheet.
        const importHeader = ['Item', 'Manufacturer', 'Project'];
        const importRows: string[][] = [importHeader];
        for (let n = 0; n < 30; n++) {
            importRows.push([`Amenity L${n}`, 'recyM5OtDzebTS2aY', 'Collective Medspa']);
        }

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['QUOTES LINKED'], ['Notes only — see bid sheet']]), 'Cover');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(MEDSPA_ROWS), '2-Cleaned Bid');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(importRows), '3- Airtable Import');
        const buffer = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));

        const items = parseWorkbook(buffer, 'Collective Medspa Combined.xlsx');
        expect(items).toHaveLength(13);
        expect(items.map(i => i.mark)).toContain('L10');
        expect(items.every(i => !i.catalogNumber.startsWith('rec'))).toBe(true);
    });
});
