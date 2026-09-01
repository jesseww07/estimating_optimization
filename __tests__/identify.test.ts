/**
 * Phase 2 identification foundation tests.
 *
 * No live API calls — these pin the pure plumbing around the Claude engine:
 * merging an IdentifiedSpec into a line, the engine's category-gate override,
 * URL detection in the parser, and request coercion round-trips.
 */

import { deflateRawSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { EngineContext, ParsedLineItem, PremierItemRow } from '@/lib/types';
import type { IdentifiedSpec } from '@/lib/identify/types';
import type { ScheduleChunkRequest, ScheduleRow } from '@/lib/identify/schedule';
import { applyIdentifiedSpec } from '@/lib/identify/apply';
import { analyzeLineItem } from '@/lib/engine/recommend';
import { coerceLineItem } from '@/lib/parse/coerce';
import { extractUrlsFromCells } from '@/lib/parse/workbook';
import { htmlToText, isFetchableSpecUrl } from '@/lib/identify/fetchUrl';
import { ACCEPTED_MEDIA_LABEL, PDF_MEDIA, detectSupportedMedia, mediaContentBlock } from '@/lib/identify/media';
import { countPdfPages } from '@/lib/identify/pdfPages';

const premier = (o: Partial<PremierItemRow> & Pick<PremierItemRow, 'id' | 'itemId' | 'fixtureCategory'>): PremierItemRow => ({
    itemDescription: '',
    style: '',
    finish: '',
    colorTemp: '',
    maxWattage: '',
    lightOutput: '',
    timesUsed: 0,
    ...o,
});

const CTX: EngineContext = {
    history: [],
    thirdPartyItems: [],
    fans: [],
    premierItems: [
        premier({ id: 'v22', itemId: 'GC-VAN-LED-22-30K', fixtureCategory: 'Vanity', itemDescription: '22" LED VANITY BAR', timesUsed: 18 }),
        premier({ id: 'pend', itemId: 'GC-PEND-DRUM-16', fixtureCategory: 'Pendant', itemDescription: '16" DRUM PENDANT BLACK', timesUsed: 7 }),
    ],
};

const line = (mark: string, manufacturer: string, catalogNumber: string): ParsedLineItem => ({
    rowIndex: 1,
    section: 'Test',
    mark,
    quantity: '1',
    manufacturer,
    catalogNumber,
    rawRow: {},
});

const spec = (o: Partial<IdentifiedSpec>): IdentifiedSpec => ({
    manufacturer: '',
    catalogNumber: '',
    productName: '',
    category: null,
    attributes: {},
    confidence: 'MEDIUM',
    source: 'url',
    evidence: '',
    ...o,
});

describe('applyIdentifiedSpec', () => {
    it('fills manufacturer and catalog number and records provenance', () => {
        const merged = applyIdentifiedSpec(line('P1', '', 'https://example.com/spec.pdf'), spec({
            manufacturer: 'JUSTICE DESIGN',
            catalogNumber: 'CER-6100-BIS',
            source: 'url',
        }));
        expect(merged.manufacturer).toBe('JUSTICE DESIGN');
        expect(merged.catalogNumber).toBe('CER-6100-BIS');
        expect(merged.identified?.source).toBe('url');
    });

    it('keeps original values when the identification came back empty', () => {
        const merged = applyIdentifiedSpec(line('P1', 'KICHLER', '52527BK'), spec({}));
        expect(merged.manufacturer).toBe('KICHLER');
        expect(merged.catalogNumber).toBe('52527BK');
    });
});

describe('engine category override from identification', () => {
    it('uses the identified category to drive the in-category fallback', () => {
        // "FIXTURE A / misc text" alone would never classify as Pendant.
        const merged = applyIdentifiedSpec(line('FA', 'UNKNOWNBRAND', 'ZZZ-UNMATCHABLE-123456'), spec({
            category: 'Pendant',
            confidence: 'HIGH',
        }));
        const result = analyzeLineItem(merged, CTX);
        expect(result.recommendations.length).toBeGreaterThan(0);
        expect(result.recommendations.every(r => r.productCategory === 'Pendant')).toBe(true);
    });

    it('ignores an identified category outside the engine vocabulary', () => {
        const merged = applyIdentifiedSpec(line('FA', 'UNKNOWNBRAND', 'ZZZ-UNMATCHABLE-123456'), spec({
            category: 'Chandelier-ish thing',
        }));
        const result = analyzeLineItem(merged, CTX);
        expect(result.recommendations).toHaveLength(0);
    });

    // The category is a HARD GATE on every tier, so the confidence the identifier
    // reported has to matter. LOW means "identification is a guess" (identify
    // system prompt) — it may FILL a null category, never REPLACE a real one.
    // The eval corpus never populates `identified`, so the ratchet cannot catch a
    // regression here; these three cases are the only guard.
    it('lets a LOW-confidence category fill a category the detector could not infer', () => {
        const merged = applyIdentifiedSpec(line('FA', 'UNKNOWNBRAND', 'ZZZ-UNMATCHABLE-123456'), spec({
            category: 'Pendant',
            confidence: 'LOW',
        }));
        const result = analyzeLineItem(merged, CTX);
        expect(result.specCategory).toBe('Pendant');
        expect(result.recommendations.length).toBeGreaterThan(0);
    });

    it('does not let a LOW-confidence category override a category the detector DID infer', () => {
        // Mark "V1" classifies as Vanity on the detector's own evidence; a guessed
        // "Pendant" must not gate the vanity candidates out of the line.
        const merged = applyIdentifiedSpec(line('V1', 'UNKNOWNBRAND', 'ZZZ-UNMATCHABLE-123456'), spec({
            category: 'Pendant',
            confidence: 'LOW',
        }));
        const result = analyzeLineItem(merged, CTX);
        expect(result.specCategory).toBe('Vanity');
        expect(result.recommendations.every(r => r.productCategory === 'Vanity')).toBe(true);
    });

    it('still lets a MEDIUM/HIGH category override the detector', () => {
        const merged = applyIdentifiedSpec(line('V1', 'UNKNOWNBRAND', 'ZZZ-UNMATCHABLE-123456'), spec({
            category: 'Pendant',
            confidence: 'MEDIUM',
        }));
        const result = analyzeLineItem(merged, CTX);
        expect(result.specCategory).toBe('Pendant');
        expect(result.recommendations.every(r => r.productCategory === 'Pendant')).toBe(true);
    });
});

describe('URL detection in raw rows', () => {
    it('finds URLs pasted in stray columns and normalizes www.', () => {
        const urls = extractUrlsFromCells([
            'P1', '4', 'see https://www.lithonia.com/products/csvt.pdf,',
            'www.rablighting.com/aled', 'plain text',
        ]);
        expect(urls).toEqual([
            'https://www.lithonia.com/products/csvt.pdf',
            'https://www.rablighting.com/aled',
        ]);
    });

    it('dedupes repeated links', () => {
        const urls = extractUrlsFromCells(['https://a.com/x', 'https://a.com/x']);
        expect(urls).toEqual(['https://a.com/x']);
    });
});

describe('spec URL fetch guards', () => {
    it('accepts public http(s) URLs only', () => {
        expect(isFetchableSpecUrl('https://www.lithonia.com/spec.pdf')).toBe(true);
        expect(isFetchableSpecUrl('http://example.com')).toBe(true);
        expect(isFetchableSpecUrl('ftp://example.com/f.pdf')).toBe(false);
        expect(isFetchableSpecUrl('https://localhost/admin')).toBe(false);
        expect(isFetchableSpecUrl('https://127.0.0.1/x')).toBe(false);
        expect(isFetchableSpecUrl('https://192.168.1.10/x')).toBe(false);
        expect(isFetchableSpecUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
        expect(isFetchableSpecUrl('not a url')).toBe(false);
    });

    it('strips HTML to readable text', () => {
        const text = htmlToText('<html><head><style>.x{}</style><script>evil()</script></head><body><h1>ALED26</h1><p>26W &amp; 5000K</p></body></html>');
        expect(text).toContain('ALED26');
        expect(text).toContain('26W & 5000K');
        expect(text).not.toContain('evil');
        expect(text).not.toContain('<');
    });
});

describe('coerceLineItem identified/specUrls passthrough', () => {
    it('round-trips identified spec and specUrls', () => {
        const item = coerceLineItem({
            rowIndex: 4,
            mark: 'P1',
            catalogNumber: 'ABC-123',
            specUrls: ['https://example.com/a.pdf'],
            identified: {
                manufacturer: 'RAB',
                catalogNumber: 'ALED26',
                productName: 'ALED Area Light',
                category: 'Outdoor',
                attributes: { wattage: '26W', colorTemp: '5000K' },
                confidence: 'HIGH',
                source: 'web',
                evidence: 'rab.com product page',
            },
        }, 0);
        expect(item?.specUrls).toEqual(['https://example.com/a.pdf']);
        expect(item?.identified?.category).toBe('Outdoor');
        expect(item?.identified?.attributes.wattage).toBe('26W');
        expect(item?.identified?.confidence).toBe('HIGH');
    });

    it('degrades a garbage identified payload instead of throwing', () => {
        const item = coerceLineItem({ mark: 'X', catalogNumber: 'Y-123456', identified: { confidence: 'BOGUS', attributes: null } }, 0);
        expect(item?.identified?.confidence).toBe('LOW');
        expect(item?.identified?.category).toBeNull();
    });
});

describe('schedule PDF row mapping', async () => {
    const { scheduleRowsToLineItems } = await import('@/lib/identify/schedule');

    it('maps extracted rows to line items with sections, urls, and raw columns', () => {
        const items = scheduleRowsToLineItems([
            { mark: 'CG-400', quantity: '98', manufacturer: 'Electric Mirror', catalogNumber: 'VAL1.1-48.00X36.00', section: 'Vanity', description: 'Front Lit-Mirror', specUrl: 'https://electricmirror.com/val' },
            { mark: 'CG-403.B', quantity: '309', manufacturer: 'SATCO', catalogNumber: 'S9594', section: 'Kitchen', description: '', specUrl: null },
        ]);
        expect(items).toHaveLength(2);
        expect(items[0]!.rowIndex).toBe(0);
        expect(items[0]!.section).toBe('Vanity');
        expect(items[0]!.specUrls).toEqual(['https://electricmirror.com/val']);
        expect(items[0]!.rawRow.DESCRIPTION).toBe('Front Lit-Mirror');
        expect(items[1]!.catalogNumber).toBe('S9594');
        expect(items[1]!.specUrls).toBeUndefined();
    });

    it('falls back to the description when a row has no catalog number, and drops empty rows', () => {
        const items = scheduleRowsToLineItems([
            { mark: 'P1', quantity: '4', manufacturer: '', catalogNumber: '', section: 'Site', description: '20FT POLE DOUBLE HEAD', specUrl: null },
            { mark: '', quantity: '', manufacturer: '', catalogNumber: '', section: '', description: '', specUrl: null },
        ]);
        expect(items).toHaveLength(1);
        expect(items[0]!.catalogNumber).toBe('20FT POLE DOUBLE HEAD');
    });
});

// ── Intake hardening (2026-08-31): images, and long schedules ────────────────

describe('upload media detection', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
    const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x01, 0x00, 0x01, 0x00])]);
    const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1')]);
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n', 'latin1');

    it('reads the media type from the bytes, not the filename', () => {
        // Every one of these arrives from the browser as some other extension or
        // an empty MIME at least some of the time.
        expect(detectSupportedMedia(pdf)).toEqual(PDF_MEDIA);
        expect(detectSupportedMedia(png)?.mediaType).toBe('image/png');
        expect(detectSupportedMedia(jpeg)?.mediaType).toBe('image/jpeg');
        expect(detectSupportedMedia(gif)?.mediaType).toBe('image/gif');
        expect(detectSupportedMedia(webp)?.mediaType).toBe('image/webp');
    });

    it('rejects sheets and junk so they fall through to the workbook parser', () => {
        expect(detectSupportedMedia(Buffer.from('MARK,QTY,MAN,CATALOG #\nP1,4,RAB,ALED26\n'))).toBeNull();
        expect(detectSupportedMedia(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBeNull(); // xlsx (zip)
        expect(detectSupportedMedia(Buffer.alloc(0))).toBeNull();
        expect(detectSupportedMedia(Buffer.from('RIFF____AVI ', 'latin1'))).toBeNull();
    });

    it('sends a PDF as a document block and an image as an image block', () => {
        const doc = mediaContentBlock(PDF_MEDIA, 'QkFTRTY0');
        expect(doc.type).toBe('document');
        if (doc.type === 'document' && doc.source.type === 'base64') {
            expect(doc.source.media_type).toBe('application/pdf');
            expect(doc.source.data).toBe('QkFTRTY0');
        }
        const media = detectSupportedMedia(jpeg)!;
        const img = mediaContentBlock(media, 'QkFTRTY0');
        expect(img.type).toBe('image');
        if (img.type === 'image' && img.source.type === 'base64') {
            expect(img.source.media_type).toBe('image/jpeg');
        }
    });

    it('names what is accepted so an error string can teach the fix', () => {
        expect(ACCEPTED_MEDIA_LABEL).toBe('PDF, PNG, JPEG, WebP, or GIF');
    });

    it('adds a cache breakpoint only when asked', () => {
        expect(mediaContentBlock(PDF_MEDIA, 'x')).not.toHaveProperty('cache_control');
        expect(mediaContentBlock(PDF_MEDIA, 'x', true)).toHaveProperty('cache_control', { type: 'ephemeral' });
    });
});

describe('PDF page counting (no PDF library)', () => {
    /** Minimal, synthetic PDF bodies — no customer document is involved. */
    function classicPdf(pages: number, extra = ''): Buffer {
        const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ');
        const pageObjects = Array.from({ length: pages }, (_, i) =>
            `${i + 3} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj`).join('\n');
        return Buffer.from(
            '%PDF-1.4\n'
            + '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n'
            + `2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pages} >> endobj\n`
            + `${extra}\n${pageObjects}\n%%EOF\n`,
            'latin1',
        );
    }

    it('counts pages from the page tree', () => {
        expect(countPdfPages(classicPdf(1))).toBe(1);
        expect(countPdfPages(classicPdf(37))).toBe(37);
    });

    it('ignores /Count on a neighbouring outline tree', () => {
        // The outline's /Count is a bookmark count and is routinely larger than
        // the page count — reading it would over-chunk every bookmarked schedule.
        const pdf = classicPdf(4, '9 0 obj << /Type /Outlines /First 10 0 R /Count 99 >> endobj');
        expect(countPdfPages(pdf)).toBe(4);
    });

    it('reads a page tree hidden inside a compressed object stream', () => {
        const inner = Buffer.from('<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 12 >>', 'latin1');
        const pdf = Buffer.concat([
            Buffer.from('%PDF-1.5\n6 0 obj << /Type /ObjStm /N 2 /First 12 /Filter /FlateDecode >>\nstream\n', 'latin1'),
            deflateSync(inner),
            Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
        ]);
        expect(countPdfPages(pdf)).toBe(12);
    });

    it('returns null when the bytes say nothing usable', () => {
        expect(countPdfPages(Buffer.alloc(0))).toBeNull();
        expect(countPdfPages(Buffer.from('%PDF-1.4\nnot really a pdf\n%%EOF', 'latin1'))).toBeNull();
    });
});

describe('schedule page-range planning', async () => {
    const { planPageRanges, buildSchedulePrompt, WHOLE_DOCUMENT } = await import('@/lib/identify/schedule');

    it('reads a short schedule in a single whole-document pass', () => {
        expect(planPageRanges(1, 8, 12)).toEqual([WHOLE_DOCUMENT]);
        expect(planPageRanges(8, 8, 12)).toEqual([WHOLE_DOCUMENT]);
        // Unknown page count (an image, or a PDF we could not read) — one pass.
        expect(planPageRanges(null, 8, 12)).toEqual([WHOLE_DOCUMENT]);
    });

    it('splits a long schedule into contiguous ranges with an open-ended tail', () => {
        expect(planPageRanges(20, 8, 12)).toEqual([
            { start: 1, end: 8 },
            { start: 9, end: 16 },
            // Open-ended so a page count that reads low cannot drop the tail.
            { start: 17, end: null },
        ]);
    });

    it('refuses a document past the pass ceiling with a message that says what to do', () => {
        expect(() => planPageRanges(500, 8, 12)).toThrow(/96-page limit/);
        expect(() => planPageRanges(500, 8, 12)).toThrow(/Split it into smaller files/);
    });

    it('scopes the prompt only when the document is actually chunked', () => {
        expect(buildSchedulePrompt(WHOLE_DOCUMENT, '')).not.toContain('PAGE SCOPE');
        const scoped = buildSchedulePrompt({ start: 9, end: 16 }, '');
        expect(scoped).toContain('pages 9-16');
        expect(scoped).toContain('PAGE SCOPE');
        expect(buildSchedulePrompt({ start: 17, end: null }, '')).toContain('pages 17 to the end of the document');
    });
});

describe('schedule chunked extraction', async () => {
    const { extractScheduleRows, scheduleRowsToLineItems } = await import('@/lib/identify/schedule');

    const row = (mark: string, section = ''): ScheduleRow => ({
        mark,
        quantity: '2',
        manufacturer: 'ACME',
        catalogNumber: `CAT-${mark}`,
        section,
        description: '',
        specUrl: null,
    });

    /** Records every pass and answers with rows named after the range. */
    function recorder(rowsFor: (req: ScheduleChunkRequest) => ScheduleRow[]) {
        const calls: ScheduleChunkRequest[] = [];
        return {
            calls,
            extract: async (req: ScheduleChunkRequest) => {
                calls.push(req);
                return { rows: rowsFor(req), truncated: false };
            },
        };
    }

    it('costs exactly one call on a short schedule', async () => {
        const { calls, extract } = recorder(() => [row('A'), row('B')]);
        const rows = await extractScheduleRows(extract, { pageCount: 3 });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.range).toEqual({ start: 1, end: null });
        expect(calls[0]!.prompt).not.toContain('PAGE SCOPE');
        expect(rows.map(r => r.mark)).toEqual(['A', 'B']);
    });

    it('keeps document order and renumbers rowIndex continuously across chunks', async () => {
        const { calls, extract } = recorder(({ range }) => [
            row(`${range.start}A`),
            // A row with nothing identifying is dropped by the mapper — the
            // numbering must stay gapless anyway.
            { mark: '', quantity: '', manufacturer: '', catalogNumber: '', section: '', description: '', specUrl: null },
            row(`${range.start}B`),
        ]);
        const rows = await extractScheduleRows(extract, { pageCount: 20, pagesPerChunk: 8 });
        expect(calls.map(c => c.range)).toEqual([
            { start: 1, end: 8 },
            { start: 9, end: 16 },
            { start: 17, end: null },
        ]);
        const items = scheduleRowsToLineItems(rows);
        expect(items.map(i => i.mark)).toEqual(['1A', '1B', '9A', '9B', '17A', '17B']);
        expect(items.map(i => i.rowIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('carries the last section heading into the next chunk prompt', async () => {
        const { calls, extract } = recorder(({ range }) => (range.start === 1
            ? [row('A', 'LEVEL 1 - LOBBY'), row('B', 'LEVEL 2 - CORRIDOR')]
            : [row(`${range.start}A`)]));
        await extractScheduleRows(extract, { pageCount: 20, pagesPerChunk: 8 });
        expect(calls[1]!.prompt).toContain('CARRIED CONTEXT');
        expect(calls[1]!.prompt).toContain('LEVEL 2 - CORRIDOR');
        expect(calls[1]!.prompt).toContain('before page 9');
        // Nothing to carry into the first pass.
        expect(calls[0]!.prompt).not.toContain('CARRIED CONTEXT');
    });

    it('drops a row repeated at a chunk boundary but keeps a real repeat elsewhere', async () => {
        const { extract } = recorder(({ range }) => (range.start === 1
            ? [row('A'), row('B')]
            // "B" straddles the page break and comes back from both passes; the
            // second "A" is the same fixture genuinely scheduled again later.
            : [row('B'), row('C'), row('A')]));
        const rows = await extractScheduleRows(extract, { pageCount: 16, pagesPerChunk: 8 });
        expect(rows.map(r => r.mark)).toEqual(['A', 'B', 'C', 'A']);
    });

    it('subdivides a truncated pass instead of failing the upload', async () => {
        const calls: ScheduleChunkRequest[] = [];
        const rows = await extractScheduleRows(async req => {
            calls.push(req);
            // The whole-document pass overflows; the halves fit.
            if (req.range.end === null && req.range.start === 1) {
                return { rows: [row('JUNK-PARTIAL')], truncated: true };
            }
            return { rows: [row(`p${req.range.start}`)], truncated: false };
        }, { pageCount: 4 });
        expect(calls.map(c => c.range)).toEqual([
            { start: 1, end: null },
            { start: 1, end: 2 },
            { start: 3, end: null },
        ]);
        // Rows from the truncated pass are discarded, not half-kept.
        expect(rows.map(r => r.mark)).toEqual(['p1', 'p3']);
    });

    it('fails clearly when a single page cannot fit in one pass', async () => {
        await expect(extractScheduleRows(
            async () => ({ rows: [], truncated: true }),
            { pageCount: 1 },
        )).rejects.toThrow(/Page 1 alone holds more rows/);
    });

    it('fails clearly when truncation happens with no page count to split on', async () => {
        await expect(extractScheduleRows(
            async () => ({ rows: [], truncated: true }),
            { pageCount: null },
        )).rejects.toThrow(/page count could not be read/);
    });

    it('bounds the work: repeated truncation stops at the pass ceiling', async () => {
        let passes = 0;
        await expect(extractScheduleRows(
            async () => { passes++; return { rows: [], truncated: true }; },
            { pageCount: 24, pagesPerChunk: 8, maxChunks: 3 },
        )).rejects.toThrow(/more than 3 extraction passes/);
        expect(passes).toBe(3);
    });
});

describe('base-item catalog parsing (what "Look up spec" actually searches)', async () => {
    const { planCatalogSearch, splitCatalogAlternates, splitCatalogParts } = await import('@/lib/identify/catalogNumber');

    it('strips a trailing finish code off an item number', () => {
        // The live failure, 2026-09-01: searching "4430802-112" returns nothing;
        // searching "4430802" returns the product, its type, and its finishes.
        expect(splitCatalogParts('4430802-112')).toEqual({ base: '4430802', options: ['112'] });
    });

    it('strips a run of trailing option codes and stops at the item number', () => {
        expect(splitCatalogParts('COM-DISK-7-15W-5CCT-WH'))
            .toEqual({ base: 'COM-DISK-7', options: ['15W', '5CCT', 'WH'] });
        expect(splitCatalogParts('GC-03-092017-1-16W-30K-WH'))
            .toEqual({ base: 'GC-03-092017-1', options: ['16W', '30K', 'WH'] });
        expect(splitCatalogParts('CSVT L48 4000LM MVOLT 40K 80CRI'))
            .toEqual({ base: 'CSVT L48', options: ['4000LM', 'MVOLT', '40K', '80CRI'] });
    });

    it('leaves identity alone: a trailing figure that is part of the item stays', () => {
        // Over-stripping is the dangerous direction — a base that names no real
        // product searches worse than the full string.
        expect(splitCatalogParts('WP-100').options).toEqual([]);
        expect(splitCatalogParts('LUMIERE 1003').options).toEqual([]);
        expect(splitCatalogParts('FMVCSL 14 20830 M4').options).toEqual([]);
        expect(splitCatalogParts('LED').base).toBe('LED');
        expect(splitCatalogParts('').base).toBe('');
    });

    it('splits a cell that lists alternates, but never splits one part number', () => {
        expect(splitCatalogAlternates('4430802-112 / 4430804-112'))
            .toEqual(['4430802-112', '4430804-112']);
        expect(splitCatalogAlternates('120/277V')).toEqual(['120/277V']);
        expect(splitCatalogAlternates('MVOLT/UNV')).toEqual(['MVOLT/UNV']);
    });

    it('plans the lookup: every base to search, every code set aside', () => {
        const plan = planCatalogSearch('4430802-112 / 4430804-112');
        expect(plan.baseNumbers).toEqual(['4430802', '4430804']);
        expect(plan.optionCodes).toEqual(['112']);
        expect(plan.hasBase).toBe(true);
    });

    it('reports nothing to strip when the cell is already a base item number', () => {
        const plan = planCatalogSearch('4430802');
        expect(plan.baseNumbers).toEqual(['4430802']);
        expect(plan.optionCodes).toEqual([]);
        expect(plan.hasBase).toBe(false);
    });
});

// ── Word documents ───────────────────────────────────────────────────────────
// Built here rather than committed as a fixture: the real samples are customer
// bid schedules, and this repo is public.

/** Minimal PNG (1x1 would be filtered as an icon, so declare a page-sized one). */
function fakePng(width: number, height: number): Uint8Array {
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4);
    ihdr.writeUInt32BE(width, 8);
    ihdr.writeUInt32BE(height, 12);
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return new Uint8Array(Buffer.concat([signature, ihdr, Buffer.alloc(16)]));
}

/** Write a ZIP the way Word does — deflated entries, central directory, EOCD. */
function makeZip(files: Array<{ name: string; bytes: Uint8Array }>): Uint8Array {
    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const file of files) {
        const name = Buffer.from(file.name, 'utf-8');
        const deflated = deflateRawSync(Buffer.from(file.bytes));
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(8, 8);            // deflated
        local.writeUInt32LE(deflated.length, 18);
        local.writeUInt32LE(file.bytes.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, deflated);

        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(8, 10);
        entry.writeUInt32LE(deflated.length, 20);
        entry.writeUInt32LE(file.bytes.length, 24);
        entry.writeUInt16LE(name.length, 28);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, name);
        offset += 30 + name.length + deflated.length;
    }
    const body = Buffer.concat(locals);
    const directory = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(directory.length, 12);
    eocd.writeUInt32LE(body.length, 16);
    return new Uint8Array(Buffer.concat([body, directory, eocd]));
}

const RELS = `<?xml version="1.0"?><Relationships>
<Relationship Id="rId1" Target="media/image1.png"/>
<Relationship Id="rId2" Target="media/image2.png"/>
</Relationships>`;

/** The shape Jesse's samples take: captions with pasted schedule screenshots. */
const SCREENSHOT_DOC = `<?xml version="1.0"?><w:document><w:body>
<w:p><w:r><w:t>ALEXAN GATEWAY</w:t></w:r></w:p>
<w:p><w:r><w:t>FIXTURE SCHEDULE &#8211; SITE &#8211; E0.4</w:t></w:r></w:p>
<w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>
<w:p><w:r><w:t>FIXTURE SCHEDULE &#8211; UNIT &#8211; E0.4</w:t></w:r></w:p>
<w:p><w:r><w:drawing><a:blip r:embed="rId2"/></w:drawing></w:r></w:p>
</w:body></w:document>`;

/** The other shape: the schedule is a real Word table. */
const TABLE_DOC = `<?xml version="1.0"?><w:document><w:body>
<w:p><w:r><w:t>LEVEL 2 &#8211; CORRIDOR</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>MARK</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>QTY</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>CATALOG #</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>R3</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>428</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>4430802-112</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body></w:document>`;

describe('Word (.docx) reading', async () => {
    const { isDocxContainer, imageCaptions, readDocx } = await import('@/lib/parse/docx');

    const screenshotDocx = (): Uint8Array => makeZip([
        { name: 'word/document.xml', bytes: new TextEncoder().encode(SCREENSHOT_DOC) },
        { name: 'word/_rels/document.xml.rels', bytes: new TextEncoder().encode(RELS) },
        { name: 'word/media/image1.png', bytes: fakePng(1499, 664) },
        { name: 'word/media/image2.png', bytes: fakePng(1495, 189) },
        // Bulk that must never be inflated to read the document.
        { name: 'word/settings.xml', bytes: new TextEncoder().encode('<settings/>') },
    ]);

    it('recognizes a Word file from the ZIP directory, not the extension', () => {
        expect(isDocxContainer(screenshotDocx())).toBe(true);
        // An .xlsx is also a ZIP, and must not be routed to the Word reader.
        const xlsxLike = makeZip([{ name: 'xl/workbook.xml', bytes: new TextEncoder().encode('<workbook/>') }]);
        expect(isDocxContainer(xlsxLike)).toBe(false);
        expect(isDocxContainer(new Uint8Array([1, 2, 3, 4, 5]))).toBe(false);
    });

    it('returns text and images interleaved in document order', async () => {
        const doc = await readDocx(screenshotDocx());
        expect(doc.blocks.map(b => b.kind)).toEqual(['text', 'image', 'text', 'image']);
        expect(doc.images).toHaveLength(2);
        expect(doc.images[0]!.mediaType).toBe('image/png');
        expect(doc.images[0]!.width).toBe(1499);
    });

    it('captions each page image from the text above it', async () => {
        // This is where the section on every extracted row comes from.
        const captions = imageCaptions(await readDocx(screenshotDocx()));
        expect(captions).toEqual([
            'FIXTURE SCHEDULE – SITE – E0.4',
            'FIXTURE SCHEDULE – UNIT – E0.4',
        ]);
    });

    it('drops art too small to hold schedule content, and keeps thin strips', async () => {
        const doc = await readDocx(makeZip([
            { name: 'word/document.xml', bytes: new TextEncoder().encode(SCREENSHOT_DOC) },
            { name: 'word/_rels/document.xml.rels', bytes: new TextEncoder().encode(RELS) },
            { name: 'word/media/image1.png', bytes: fakePng(24, 24) },      // bullet
            { name: 'word/media/image2.png', bytes: fakePng(438, 99) },     // one-row strip
        ]));
        expect(doc.images.map(i => i.width)).toEqual([438]);
    });

    it('reads a Word-table schedule as rows of text', async () => {
        const doc = await readDocx(makeZip([
            { name: 'word/document.xml', bytes: new TextEncoder().encode(TABLE_DOC) },
        ]));
        expect(doc.images).toHaveLength(0);
        expect(doc.text).toContain('LEVEL 2 – CORRIDOR');
        expect(doc.text).toContain('R3 | 428 | 4430802-112');
    });

    it('says what to do when the ZIP is not a Word document', async () => {
        const notWord = makeZip([{ name: 'xl/workbook.xml', bytes: new TextEncoder().encode('<workbook/>') }]);
        await expect(readDocx(notWord)).rejects.toThrow(/not a Word document/);
    });
});

describe('Word schedule page planning', async () => {
    const { planDocxPages, splitTextPages } = await import('@/lib/identify/docxPages');
    const { readDocx } = await import('@/lib/parse/docx');

    it('makes one page per screenshot, labelled, with the doc text as context', async () => {
        const doc = await readDocx(makeZip([
            { name: 'word/document.xml', bytes: new TextEncoder().encode(SCREENSHOT_DOC) },
            { name: 'word/_rels/document.xml.rels', bytes: new TextEncoder().encode(RELS) },
            { name: 'word/media/image1.png', bytes: fakePng(1499, 664) },
            { name: 'word/media/image2.png', bytes: fakePng(1495, 189) },
        ]));
        const plan = planDocxPages(doc);
        expect(plan.shape).toBe('images');
        expect(plan.pages).toHaveLength(2);
        expect(plan.pages[0]).toMatchObject({ kind: 'media', label: 'FIXTURE SCHEDULE – SITE – E0.4' });
        expect(plan.context).toContain('ALEXAN GATEWAY');
    });

    it('makes text pages for a Word-table schedule, with no context duplicate', async () => {
        const doc = await readDocx(makeZip([
            { name: 'word/document.xml', bytes: new TextEncoder().encode(TABLE_DOC) },
        ]));
        const plan = planDocxPages(doc);
        expect(plan.shape).toBe('text');
        expect(plan.pages).toHaveLength(1);
        // The rows must not also arrive as "context, not line items".
        expect(plan.context).toBe('');
    });

    it('reports an empty document instead of calling the API on nothing', async () => {
        const doc = await readDocx(makeZip([
            { name: 'word/document.xml', bytes: new TextEncoder().encode('<w:document><w:body/></w:document>') },
        ]));
        expect(planDocxPages(doc)).toEqual({ pages: [], context: '', shape: 'empty' });
    });

    it('splits text on line boundaries so a schedule row is never cut in half', () => {
        const text = ['R1 | 4 | AAA-1', 'R2 | 5 | BBB-2', 'R3 | 6 | CCC-3'].join('\n');
        const pages = splitTextPages(text, 20);
        expect(pages).toEqual(['R1 | 4 | AAA-1', 'R2 | 5 | BBB-2', 'R3 | 6 | CCC-3']);
        expect(splitTextPages(text, 10_000)).toEqual([text]);
    });
});

describe('page-list extraction prompts', async () => {
    const { buildPagesPrompt, MAX_PAGES } = await import('@/lib/identify/schedule');

    it('tells the truth about what is attached: pages, not instructions', () => {
        // The PDF path can only SAY which pages to read; the pages path attaches
        // exactly those pages, so the prompt must not claim the rest is present.
        const scoped = buildPagesPrompt({ start: 9, end: 16 }, '', 27);
        expect(scoped).toContain('pages 9-16 of 27');
        expect(scoped).toContain('Only these pages are attached');

        expect(buildPagesPrompt({ start: 1, end: null }, '', 5)).toContain('all 5 pages');
        expect(buildPagesPrompt({ start: 1, end: null }, '', 1)).toContain('whole document');
    });

    it('carries the section heading across a page boundary', () => {
        const carried = buildPagesPrompt({ start: 9, end: 16 }, 'LEVEL 2 – CORRIDOR', 27);
        expect(carried).toContain('CARRIED CONTEXT');
        expect(carried).toContain('LEVEL 2 – CORRIDOR');
    });

    it('bounds one upload at the same ceiling as the PDF path', () => {
        expect(MAX_PAGES).toBe(96);
    });
});
