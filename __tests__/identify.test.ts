/**
 * Phase 2 identification foundation tests.
 *
 * No live API calls — these pin the pure plumbing around the Claude engine:
 * merging an IdentifiedSpec into a line, the engine's category-gate override,
 * URL detection in the parser, and request coercion round-trips.
 */

import { describe, expect, it } from 'vitest';
import type { EngineContext, ParsedLineItem, PremierItemRow } from '@/lib/types';
import type { IdentifiedSpec } from '@/lib/identify/types';
import { applyIdentifiedSpec } from '@/lib/identify/apply';
import { analyzeLineItem } from '@/lib/engine/recommend';
import { coerceLineItem } from '@/lib/parse/coerce';
import { extractUrlsFromCells } from '@/lib/parse/workbook';
import { htmlToText, isFetchableSpecUrl } from '@/lib/identify/fetchUrl';

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
