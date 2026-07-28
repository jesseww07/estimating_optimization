/**
 * Known-column CSV/XLSX → ParsedLineItem[].
 *
 * Ported 1:1 from harvest/index.tsx (~354–786): COLUMN_ALIASES,
 * normalizeColumnName, findColumnIndex, parseCSVContent, looksLikeCatalogNumber,
 * parseUploadedFileFromRows. The only rewrite is the Excel entry point: the
 * Interface used the browser File API; here parseWorkbook takes the raw bytes a
 * route handler receives. Input contract: a CSV, or an XLSX whose bid sheet
 * mirrors the first sheet of the two-sheet history-source workbooks —
 * multi-sheet workbooks are handled by parsing every sheet and keeping the one
 * that yields the most line items. No OCR here; fixture-schedule PDFs go
 * through lib/identify/schedule.ts instead.
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

interface CatalogCandidate {
    colIdx: number;
    /** Index into COLUMN_ALIASES.catalogNumber — lower = more catalog-like. */
    aliasRank: number;
}

/**
 * Every column in a header row matching a catalogNumber alias, tagged with the
 * best (lowest) alias index it matched. Alias order encodes priority: a column
 * labeled "CATALOG #" must beat one labeled "Product Code" even when it sits
 * further right. (Collective MedSpa regression: an empty Product Code column
 * hijacked the mapping left-to-right and every L-series line was dropped.)
 */
export function findCatalogCandidates(row: string[]): CatalogCandidate[] {
    const aliases = COLUMN_ALIASES.catalogNumber ?? [];
    const candidates: CatalogCandidate[] = [];
    for (let colIdx = 0; colIdx < row.length; colIdx++) {
        const normalized = normalizeColumnName(String(row[colIdx] ?? ''));
        if (!normalized) continue;
        for (let a = 0; a < aliases.length; a++) {
            const alias = aliases[a];
            if (normalized === alias || normalized.includes(alias) || alias.includes(normalized)) {
                candidates.push({ colIdx, aliasRank: a });
                break;
            }
        }
    }
    return candidates;
}

export function chooseCatalogColumn(candidates: CatalogCandidate[]): number {
    let chosen: CatalogCandidate | undefined;
    for (const c of candidates) {
        if (!chosen || c.aliasRank < chosen.aliasRank) chosen = c;
    }
    return chosen ? chosen.colIdx : -1;
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

function sheetToGrid(worksheet: XLSX.WorkSheet): string[][] {
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

/** Parse XLSX/XLS bytes into one string grid per sheet, in workbook order. */
export function parseExcelBufferSheets(buffer: ArrayBuffer | Buffer): Array<{ name: string; rows: string[][] }> {
    const workbook = XLSX.read(buffer, { type: buffer instanceof ArrayBuffer ? 'array' : 'buffer' });
    const sheets: Array<{ name: string; rows: string[][] }> = [];
    for (const name of workbook.SheetNames) {
        const worksheet = workbook.Sheets[name];
        if (!worksheet) continue;
        sheets.push({ name, rows: sheetToGrid(worksheet) });
    }
    return sheets;
}

/** Parse XLSX/XLS bytes (first sheet only) into a string grid. */
export function parseExcelBuffer(buffer: ArrayBuffer | Buffer): string[][] {
    return parseExcelBufferSheets(buffer)[0]?.rows ?? [];
}

export function isExcelFileName(fileName: string, contentType?: string): boolean {
    const excelExtensions = ['.xlsx', '.xls', '.xlsm', '.xlsb'];
    const lower = fileName.toLowerCase();
    return excelExtensions.some(ext => lower.endsWith(ext)) ||
           contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
           contentType === 'application/vnd.ms-excel';
}

const AIRTABLE_RECORD_ID_RE = /^rec[a-zA-Z0-9]{14}$/;

/**
 * How many parsed items look like genuine fixture lines. Degenerate sheets
 * (Airtable-import staging tabs, pivot exports) parse into many rows whose
 * "catalog" is an Airtable record ID, the manufacturer repeated, or just the
 * mark echoed back — those score zero here so a clean 13-line bid sheet beats
 * a junk 27-row tab. Relative scoring only: a sheet full of weak lines still
 * wins when it is the only sheet that parses at all.
 */
function healthyItemCount(items: ParsedLineItem[]): number {
    let count = 0;
    for (const item of items) {
        const catalog = item.catalogNumber.trim().toLowerCase();
        if (!catalog) continue;
        if (AIRTABLE_RECORD_ID_RE.test(item.catalogNumber.trim())) continue;
        if (catalog === item.manufacturer.trim().toLowerCase()) continue;
        if (catalog === item.mark.trim().toLowerCase()) continue;
        count++;
    }
    return count;
}

/**
 * Route-handler entry point: file bytes + name → ParsedLineItem[].
 *
 * Multi-sheet workbooks: every sheet is parsed and the one yielding the most
 * healthy-looking line items wins (ties → earliest sheet). Estimators upload
 * combined workbooks (bid + cleaned + import sheets) — the old
 * first-sheet-only contract silently parsed whichever sheet happened to be
 * first.
 */
export function parseWorkbook(buffer: Buffer, fileName: string, contentType?: string): ParsedLineItem[] {
    if (!isExcelFileName(fileName, contentType)) {
        return parseUploadedFileFromRows(parseCSVContent(buffer.toString('utf-8')));
    }

    let best: ParsedLineItem[] = [];
    let bestScore = -1;
    for (const sheet of parseExcelBufferSheets(buffer)) {
        const items = parseUploadedFileFromRows(sheet.rows);
        const score = healthyItemCount(items);
        if (score > bestScore) {
            bestScore = score;
            best = items;
        }
    }
    return best;
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

    let bestCatalogCandidates: CatalogCandidate[] = [];

    for (let i = 0; i < Math.min(rows.length, 30); i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;

        let currentScore = 0;
        const currentIndices: Record<string, number> = {};
        let quantityExact = false;

        const rowCatalogCandidates = findCatalogCandidates(row.map(c => String(c ?? '')));
        const catalogChoice = chooseCatalogColumn(rowCatalogCandidates);
        if (catalogChoice !== -1) {
            currentIndices.catalogNumber = catalogChoice;
            currentScore += 15;
        }

        for (let colIdx = 0; colIdx < row.length; colIdx++) {
            const cellValue = row[colIdx];
            if (!cellValue || typeof cellValue !== 'string') continue;

            const normalizedCell = normalizeColumnName(cellValue);
            if (!normalizedCell) continue;

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
                        quantityExact = normalizedCell === alias;
                    } else if (!quantityExact && normalizedCell === alias) {
                        // "QTY" must beat a substring hit like "QTY LAMPS"
                        // regardless of column order.
                        currentIndices.quantity = colIdx;
                        quantityExact = true;
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
            bestCatalogCandidates = rowCatalogCandidates;
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

    // The best-ranked catalog label can still be an empty column (some layouts
    // carry both a blank "CATALOG #" and a populated "Description"). If the
    // chosen column has no data at all below the header while another catalog
    // candidate does, remap to the best-ranked candidate that holds values.
    if (bestCatalogCandidates.length > 1 && columnIndices.catalogNumber !== -1) {
        const density = new Map<number, number>();
        const scanEnd = Math.min(rows.length, headerRowIndex + 1 + 500);
        for (let r = headerRowIndex + 1; r < scanEnd; r++) {
            const row = rows[r];
            if (!row) continue;
            for (const c of bestCatalogCandidates) {
                if (String(row[c.colIdx] ?? '').trim() !== '') {
                    density.set(c.colIdx, (density.get(c.colIdx) ?? 0) + 1);
                }
            }
        }
        if ((density.get(columnIndices.catalogNumber) ?? 0) === 0) {
            const withData = bestCatalogCandidates.filter(c => (density.get(c.colIdx) ?? 0) > 0);
            const fallback = chooseCatalogColumn(withData);
            if (fallback !== -1) columnIndices.catalogNumber = fallback;
        }
    }

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
            const newCatalogIdx = chooseCatalogColumn(findCatalogCandidates(row.map(c => String(c ?? ''))));
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
                /^rfi\s*#?\s*\d/i.test(finalMark) ||
                /^(rfi\s*#|rfi\b|subtotal|total\b|tax\b|tariff|freight|payment\s|terms\s|conditions\s|notes\s+only|building\s*&\s*unit)/i.test(finalMark) ||
                // Summary/boilerplate rows have no mark and a label like
                // "Subtotal" / "Tax" / "*Pricing includes..." in the catalog column.
                (!finalMark && /^(subtotal|total\b|tax\b|\*?\s*pricing|\*?\s*any\s+future|excluded)/i.test(finalCatalog)) ||
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
