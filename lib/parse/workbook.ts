/**
 * Known-column CSV/XLSX → ParsedLineItem[].
 *
 * Ported 1:1 from harvest/index.tsx (~354–786): COLUMN_ALIASES,
 * normalizeColumnName, findColumnIndex, parseCSVContent, looksLikeCatalogNumber,
 * parseUploadedFileFromRows. The only rewrite is the Excel entry point: the
 * Interface used the browser File API; here parseWorkbook takes the raw bytes a
 * route handler receives. Phase 1 input contract: a pre-converted CSV or
 * single-sheet XLSX whose columns mirror the first sheet of the two-sheet
 * history-source workbooks. No OCR, no PDF/DOCX.
 */

import * as XLSX from 'xlsx';
import type { ParsedLineItem } from '../types';

export const COLUMN_ALIASES: Record<string, string[]> = {
    mark: ['mark', 'fixture mark', 'type', 'fixture type', 'item'],
    quantity: ['qty', 'quantity', 'count', 'amount'],
    manufacturer: ['man', 'manufacturer', 'mfg', 'mfr', 'vendor'],
    catalogNumber: ['catalog #', 'catalog', 'cat #', 'cat no', 'catalog number', 'part #', 'part number', 'model', 'sku', 'product code', 'description', 'spec', 'specification', 'lamp', 'luminaire', 'fixture'],
    section: ['section', 'area', 'location', 'zone', 'group', 'site', 'site lighting', 'building', 'unit', 'common', 'amenity', 'garage', 'clubhouse', 'landscape', 'pool'],
    project: ['project', 'project name', 'job', 'job name'],
};

export function normalizeColumnName(col: string): string {
    return col.toLowerCase().trim().replace(/[^a-z0-9\s#]/g, '');
}

export function findColumnIndex(headers: string[], aliases: string[]): number {
    for (let i = 0; i < headers.length; i++) {
        const normalized = normalizeColumnName(headers[i] ?? '');
        for (const alias of aliases) {
            if (normalized === alias || normalized.includes(alias)) {
                return i;
            }
        }
    }
    return -1;
}

export function parseCSVContent(content: string): string[][] {
    const lines = content.split(/\r?\n/);
    return lines.map(line => {
        const cells: string[] = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if ((char === ',' || char === '\t') && !inQuotes) {
                cells.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        cells.push(current.trim());
        return cells;
    });
}

export function looksLikeCatalogNumber(value: string): boolean {
    if (!value || value.length < 5) return false;
    const hasNumbers = /\d/.test(value);
    const hasLetters = /[a-zA-Z]/.test(value);
    const hasDashes = /-/.test(value);
    const hasMultipleParts = value.split(/[-_\/]/).length >= 2;
    const isLongEnough = value.length >= 8;
    const hasTypicalPatterns = /\d{2,}[A-Z]|[A-Z]{2,}\d|\d{3,}/.test(value.toUpperCase());

    return (hasNumbers && hasLetters && (hasDashes || hasMultipleParts)) ||
           (hasNumbers && hasLetters && isLongEnough) ||
           hasTypicalPatterns;
}

// Estimators paste spec-sheet links into stray columns — surface every URL in
// the row so the UI can offer "Identify from link" (Phase 2).
const URL_IN_CELL_RE = /(?:https?:\/\/|www\.)[^\s"'<>()]+/gi;

export function extractUrlsFromCells(cells: string[]): string[] {
    const urls: string[] = [];
    for (const cell of cells) {
        if (!cell) continue;
        for (const match of cell.match(URL_IN_CELL_RE) ?? []) {
            const cleaned = match.replace(/[.,;]+$/, '');
            const normalized = cleaned.startsWith('www.') ? `https://${cleaned}` : cleaned;
            if (!urls.includes(normalized)) urls.push(normalized);
        }
    }
    return urls;
}

/** Parse XLSX/XLS bytes (first sheet only) into a string grid. */
export function parseExcelBuffer(buffer: ArrayBuffer | Buffer): string[][] {
    const workbook = XLSX.read(buffer, { type: buffer instanceof ArrayBuffer ? 'array' : 'buffer' });

    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return [];

    const worksheet = workbook.Sheets[firstSheetName];
    if (!worksheet) return [];

    const jsonData = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
        header: 1,
        defval: '',
        blankrows: false,
        raw: false,
    });

    const result: string[][] = [];
    for (const row of jsonData) {
        if (Array.isArray(row)) {
            const stringRow: string[] = [];
            for (let i = 0; i < row.length; i++) {
                const cell = row[i];
                stringRow.push(cell !== null && cell !== undefined ? String(cell).trim() : '');
            }
            result.push(stringRow);
        }
    }

    return result;
}

export function isExcelFileName(fileName: string, contentType?: string): boolean {
    const excelExtensions = ['.xlsx', '.xls', '.xlsm', '.xlsb'];
    const lower = fileName.toLowerCase();
    return excelExtensions.some(ext => lower.endsWith(ext)) ||
           contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
           contentType === 'application/vnd.ms-excel';
}

/** Route-handler entry point: file bytes + name → ParsedLineItem[]. */
export function parseWorkbook(buffer: Buffer, fileName: string, contentType?: string): ParsedLineItem[] {
    const rows = isExcelFileName(fileName, contentType)
        ? parseExcelBuffer(buffer)
        : parseCSVContent(buffer.toString('utf-8'));
    return parseUploadedFileFromRows(rows);
}

export function parseUploadedFileFromRows(rows: string[][]): ParsedLineItem[] {
    if (rows.length === 0) return [];

    let headerRowIndex = -1;
    let columnIndices: Record<string, number> = {};
    let bestScore = 0;

    const SECTION_HEADER_PATTERNS = [
        /^site\s*lighting$/i,
        /^clubhouse$/i,
        /^units?$/i,
        /^common$/i,
        /^amenity$/i,
        /^amenities$/i,
        /^garage$/i,
        /^landscape$/i,
        /^pool$/i,
        /^building\s*\d*$/i,
        /^bldg\s*\d*$/i,
        /^hotel\s*common/i,
        /^hotel\s*units?$/i,
        /^street\s*lighting$/i,
        /^patio$/i,
        /^outdoor$/i,
        /^exterior$/i,
        /^interior$/i,
        /^lobby$/i,
        /^parking$/i,
        /^fitness$/i,
        /^courtyard$/i,
        /^cabana$/i,
        /^maint/i,
        /^maintenance$/i,
        /^offsite$/i,
    ];

    const isSectionHeaderText = (text: string): boolean => {
        if (!text || text.length < 3) return false;
        const trimmed = text.trim();
        return SECTION_HEADER_PATTERNS.some(pattern => pattern.test(trimmed));
    };

    for (let i = 0; i < Math.min(rows.length, 30); i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;

        let currentScore = 0;
        const currentIndices: Record<string, number> = {};

        for (let colIdx = 0; colIdx < row.length; colIdx++) {
            const cellValue = row[colIdx];
            if (!cellValue || typeof cellValue !== 'string') continue;

            const normalizedCell = normalizeColumnName(cellValue);
            if (!normalizedCell) continue;

            const catalogAliases = COLUMN_ALIASES.catalogNumber ?? [];
            for (const alias of catalogAliases) {
                if (normalizedCell === alias || normalizedCell.includes(alias) || alias.includes(normalizedCell)) {
                    if (currentIndices.catalogNumber === undefined) {
                        currentIndices.catalogNumber = colIdx;
                        currentScore += 15;
                    }
                    break;
                }
            }

            const markAliases = COLUMN_ALIASES.mark ?? [];
            for (const alias of markAliases) {
                if (normalizedCell === alias || normalizedCell.includes(alias) || alias.includes(normalizedCell)) {
                    if (currentIndices.mark === undefined) {
                        currentIndices.mark = colIdx;
                        currentScore += 10;
                    }
                    break;
                }
            }

            const qtyAliases = COLUMN_ALIASES.quantity ?? [];
            for (const alias of qtyAliases) {
                if (normalizedCell === alias || normalizedCell.includes(alias)) {
                    if (currentIndices.quantity === undefined) {
                        currentIndices.quantity = colIdx;
                        currentScore += 5;
                    }
                    break;
                }
            }

            const mfgAliases = COLUMN_ALIASES.manufacturer ?? [];
            for (const alias of mfgAliases) {
                if (normalizedCell === alias || normalizedCell.includes(alias)) {
                    if (currentIndices.manufacturer === undefined) {
                        currentIndices.manufacturer = colIdx;
                        currentScore += 5;
                    }
                    break;
                }
            }

            const sectionAliases = COLUMN_ALIASES.section ?? [];
            for (const alias of sectionAliases) {
                if (normalizedCell === alias || normalizedCell.includes(alias)) {
                    if (currentIndices.section === undefined) {
                        currentIndices.section = colIdx;
                        currentScore += 8;
                    }
                    break;
                }
            }

            const projectAliases = COLUMN_ALIASES.project ?? [];
            for (const alias of projectAliases) {
                if (normalizedCell === alias || normalizedCell.includes(alias)) {
                    if (currentIndices.project === undefined) {
                        currentIndices.project = colIdx;
                        currentScore += 2;
                    }
                    break;
                }
            }

            const locationAliases = ['location', 'section', 'area', 'zone', 'group', 'site', 'site lighting', 'building', 'unit', 'units', 'common', 'amenity', 'garage', 'clubhouse', 'landscape', 'pool', 'street lighting', 'blgd', 'bldg', 'id', 'club/amenity', 'common area & garage', 'hotel common area & deco', 'hotel units', 'hotel', 'amenities', 'patio'];
            for (const alias of locationAliases) {
                if (normalizedCell === alias || normalizedCell.includes(alias)) {
                    if (currentIndices.location === undefined) {
                        currentIndices.location = colIdx;
                        currentScore += 8;
                    }
                    break;
                }
            }
        }

        const hasCatalog = currentIndices.catalogNumber !== undefined;
        const hasMark = currentIndices.mark !== undefined;
        const hasRequiredColumns = hasCatalog || hasMark;

        if (hasRequiredColumns && currentScore > bestScore) {
            bestScore = currentScore;
            headerRowIndex = i;
            columnIndices = {
                mark: currentIndices.mark ?? -1,
                quantity: currentIndices.quantity ?? -1,
                manufacturer: currentIndices.manufacturer ?? -1,
                catalogNumber: currentIndices.catalogNumber ?? -1,
                section: currentIndices.section !== undefined ? currentIndices.section : (currentIndices.location ?? -1),
                project: currentIndices.project ?? -1,
                location: currentIndices.location ?? -1,
            };

            if (hasCatalog && hasMark && currentScore >= 25) {
                break;
            }
        }
    }

    if (headerRowIndex === -1) return [];

    if (columnIndices.section === -1 && columnIndices.location !== undefined && columnIndices.location !== -1) {
        columnIndices.section = columnIndices.location;
    }

    const items: ParsedLineItem[] = [];
    let currentSection = '';
    const headers = rows[headerRowIndex] ?? [];

    for (let rowNum = 0; rowNum < headerRowIndex; rowNum++) {
        const row = rows[rowNum];
        if (!row) continue;
        const firstCell = row[0]?.trim() || '';
        if (isSectionHeaderText(firstCell)) {
            currentSection = firstCell;
        }
    }

    for (let i = headerRowIndex + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.every(cell => !cell || String(cell).trim() === '')) continue;

        const markIdx = columnIndices.mark;
        const catalogIdx = columnIndices.catalogNumber;
        const qtyIdx = columnIndices.quantity;
        const mfgIdx = columnIndices.manufacturer;
        const sectionIdx = columnIndices.section;
        const locationIdx = columnIndices.location;

        const markValue = (markIdx !== undefined && markIdx !== -1 && row[markIdx] !== undefined) ? String(row[markIdx]).trim() : '';
        const catalogValue = (catalogIdx !== undefined && catalogIdx !== -1 && row[catalogIdx] !== undefined) ? String(row[catalogIdx]).trim() : '';
        const qtyValue = (qtyIdx !== undefined && qtyIdx !== -1 && row[qtyIdx] !== undefined) ? String(row[qtyIdx]).trim() : '';
        const mfgValue = (mfgIdx !== undefined && mfgIdx !== -1 && row[mfgIdx] !== undefined) ? String(row[mfgIdx]).trim() : '';
        let sectionValue = (sectionIdx !== undefined && sectionIdx !== -1 && row[sectionIdx] !== undefined) ? String(row[sectionIdx]).trim() : '';
        const locationValue = (locationIdx !== undefined && locationIdx !== -1 && row[locationIdx] !== undefined) ? String(row[locationIdx]).trim() : '';

        if (!sectionValue && locationValue) {
            sectionValue = locationValue;
        }

        if (!sectionValue && currentSection) {
            sectionValue = currentSection;
        }

        const normalizedMarkCheck = normalizeColumnName(markValue);
        const normalizedFirstCell = row[0] ? normalizeColumnName(String(row[0])) : '';

        if (isSectionHeaderText(markValue)) {
            currentSection = markValue;
            continue;
        }

        const isHeaderRow = (normalizedMarkCheck && (normalizedMarkCheck.includes('mark') || normalizedMarkCheck.includes('type'))) ||
                           (normalizedFirstCell && (normalizedFirstCell.includes('mark') || normalizedFirstCell.includes('type')) && row.filter(c => c && String(c).trim() !== '').length > 3) ||
                           (normalizedMarkCheck === 'catalog' || normalizedMarkCheck.includes('catalog #') || normalizedMarkCheck.includes('catalog number'));

        if (isHeaderRow) {
            const newMarkIdx = findColumnIndex(row, COLUMN_ALIASES.mark ?? []);
            const newCatalogIdx = findColumnIndex(row, COLUMN_ALIASES.catalogNumber ?? []);
            if (newMarkIdx !== -1 || newCatalogIdx !== -1) {
                const newSectionIdx = findColumnIndex(row, COLUMN_ALIASES.section ?? []);
                const newLocationIdx = findColumnIndex(row, ['location', 'area', 'zone', 'group', 'site lighting', 'building', 'unit', 'common', 'amenity', 'garage', 'clubhouse', 'landscape', 'pool']);
                columnIndices = {
                    mark: newMarkIdx !== -1 ? newMarkIdx : columnIndices.mark ?? -1,
                    quantity: findColumnIndex(row, COLUMN_ALIASES.quantity ?? []),
                    manufacturer: findColumnIndex(row, COLUMN_ALIASES.manufacturer ?? []),
                    catalogNumber: newCatalogIdx !== -1 ? newCatalogIdx : columnIndices.catalogNumber ?? -1,
                    section: newSectionIdx !== -1 ? newSectionIdx : (newLocationIdx !== -1 ? newLocationIdx : columnIndices.section ?? -1),
                    project: findColumnIndex(row, COLUMN_ALIASES.project ?? []),
                    location: newLocationIdx !== -1 ? newLocationIdx : columnIndices.location ?? -1,
                };
            }
            continue;
        }

        const nonEmptyCells = row.filter(c => c && String(c).trim() !== '');

        const firstCellText = row[0]?.trim() || '';
        if (isSectionHeaderText(firstCellText)) {
            currentSection = firstCellText;
            continue;
        }

        const isSectionHeader = (!markValue || markValue.length <= 6) && !looksLikeCatalogNumber(markValue) && !looksLikeCatalogNumber(catalogValue) &&
                               catalogValue === '' &&
                               nonEmptyCells.length <= 3 &&
                               nonEmptyCells.length > 0 &&
                               nonEmptyCells.some(c => c.length > 2 && !c.match(/^\d+$/));

        if (isSectionHeader) {
            const sectionText = nonEmptyCells.find(c => c.length > 2 && !c.match(/^\d+$/)) ?? '';
            if (sectionText) {
                currentSection = sectionText.trim();
            }
            continue;
        }

        // Skip rows that are ONLY a section header (e.g., "UNITS" with no other data)
        // These should not become line items — they are location/section labels
        const firstCellOnly = row[0] && String(row[0]).trim();
        const restEmpty = row.slice(1).every(c => !c || String(c).trim() === '');
        if (firstCellOnly && restEmpty && firstCellOnly.length >= 2 && !looksLikeCatalogNumber(firstCellOnly)) {
            currentSection = firstCellOnly;
            continue;
        }
        if (!sectionValue && firstCellOnly && isSectionHeaderText(firstCellOnly)) {
            sectionValue = firstCellOnly;
            currentSection = firstCellOnly;
        }

        // A valid data row must have BOTH a mark AND a catalog number (or at least one that looks like a catalog)
        // Rows with only a mark but no catalog-like value are likely section headers
        const markLooksCatalog = markValue && looksLikeCatalogNumber(markValue);
        // Must have either a real catalog number OR a mark that looks like a catalog number
        // Single-word section labels (e.g., "UNITS") should not become line items
        const isValidDataRow = ((catalogValue && catalogValue.length > 0) || markLooksCatalog) && !(nonEmptyCells.length <= 2 && (!markValue || markValue.length <= 6));

        if (isValidDataRow) {
            const rawRow: Record<string, string> = {};
            headers.forEach((h, idx) => {
                rawRow[String(h ?? `col${idx}`)] = String(row[idx] ?? '');
            });

            let finalCatalog = catalogValue || '';
            const finalMark = markValue || '';

            if (!finalCatalog || finalCatalog.length < 5) {
                for (let colIdx = 0; colIdx < row.length; colIdx++) {
                    if (colIdx === columnIndices.mark || colIdx === columnIndices.quantity ||
                        colIdx === columnIndices.manufacturer || colIdx === columnIndices.section ||
                        colIdx === columnIndices.catalogNumber) continue;

                    const cellValue = row[colIdx];
                    if (cellValue && typeof cellValue === 'string' && looksLikeCatalogNumber(cellValue)) {
                        finalCatalog = cellValue.trim();
                        break;
                    }
                }
            }

            if (!finalCatalog && finalMark && looksLikeCatalogNumber(finalMark)) {
                finalCatalog = finalMark;
            }

            // Skip rows that are clearly not fixture line items:
            // RFI notes, totals, legal/tariff boilerplate, and over-long text cells.
            const isJunkRow =
                /^rfi#?\s*\d/i.test(finalMark) ||
                /^(rfi#|subtotal|total\b|tax\b|tariff|freight|payment\s|terms\s|conditions\s|notes\s+only|building\s*&\s*unit)/i.test(finalMark) ||
                finalCatalog.length > 150 ||   // paragraph / legal text in catalog column
                finalMark.length > 120;         // paragraph text in mark column
            if (isJunkRow) continue;

            const specUrls = extractUrlsFromCells(row.map(c => String(c ?? '')));

            items.push({
                rowIndex: i,
                section: sectionValue || currentSection,
                mark: finalMark,
                quantity: qtyValue,
                manufacturer: mfgValue,
                catalogNumber: finalCatalog,
                rawRow,
                ...(specUrls.length > 0 ? { specUrls } : {}),
            });
        }
    }

    return items;
}
