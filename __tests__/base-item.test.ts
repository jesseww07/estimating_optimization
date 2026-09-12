/**
 * Base-item identification (ownership review of 3rd & Flower, 2026-09-11).
 *
 * The finding: the engine scored the WHOLE catalog string — configuration
 * codes, product names, typed notes included — so `OXYGEN 3-515-25- HALO` and
 * `ALLIED MAKER WAL-031 MQUAN HALF-CIRCLE` were "not identified" even though the
 * category header said SCONCE and a Google search of the base number (`OXYGEN
 * 3-515`) finds the product at once. Estimators search the base item; the
 * engine now reads it too, and says so.
 */

import { describe, expect, it } from 'vitest';
import type { EngineContext, HistoryRow, ParsedLineItem, PremierItemRow } from '@/lib/types';
import { sameBaseItem, simplifiedBaseItem, splitBaseItem } from '@/lib/engine/baseItem';
import { categoriesCompatible, detectFixtureCategory } from '@/lib/engine/matcher';
import { analyzeLineItem } from '@/lib/engine/recommend';
import { shouldAutoSelect } from '@/lib/engine/ranking';
import { planCatalogSearch } from '@/lib/identify/catalogNumber';
import { isFileShareUrl, preferredSpecUrls, specUrlHost } from '@/lib/identify/specUrls';

const base = (spec: string, manufacturer?: string) => splitBaseItem(spec, manufacturer).base;

describe('splitBaseItem — the part of a catalog string that identifies the product', () => {
    it('reads the 3rd & Flower decorative lines the way the estimator searched them', () => {
        expect(splitBaseItem('3-515-25- HALO', 'OXYGEN')).toEqual({ base: '3-515', kind: 'code', variant: ['25'], name: 'HALO' });
        expect(splitBaseItem('3-515-25 - HALO', 'OXYGEN').base).toBe('3-515');
        expect(splitBaseItem('WAC-042-MQUAN CIRCLE', 'ALLIED MAKER')).toEqual({ base: 'WAC-042', kind: 'code', variant: [], name: 'MQUAN CIRCLE' });
        expect(splitBaseItem('WAC-042- MQUAN CIRCLE', 'ALLIED MAKER').base).toBe('WAC-042');
        expect(splitBaseItem('WAL-031 MQUAN HALF-CIRCLE', 'ALLIED MAKER').base).toBe('WAL-031');
    });

    it('reads a product NAME when the line is prose, and stops at fixture vocabulary and finishes', () => {
        const formation = splitBaseItem('FORMATION WALL SCONCE BRUSHED SATIN GOLD - NERO MARQUINA MARBLE', 'B-TD');
        expect(formation.kind).toBe('name');
        expect(formation.base).toBe('FORMATION');
        expect(formation.variant).toEqual(['BRUSHED', 'SATIN', 'GOLD']);
        expect(formation.name).toBe('WALL SCONCE NERO MARQUINA MARBLE');
        expect(base('APLOMB GREY', 'FOSCARINI')).toBe('APLOMB');
        expect(base('BUGIA TRIPLE GLOSSY BRONZE', 'LODES')).toBe('BUGIA');
        expect(base('BLOC WALL SCONCE', 'B-TD')).toBe('BLOC');
        // A model number right after the name belongs to it.
        expect(base('NACHO 1300 SATIN COPPER', 'CVL')).toBe('NACHO 1300');
        expect(base('DSXB LED P1 40K', 'LITHONIA')).toBe('DSXB');
    });

    it('stops a part number at the first configuration code and keeps design numbers', () => {
        expect(splitBaseItem('4430802-112', 'VISUAL COMFORT')).toEqual({ base: '4430802', kind: 'code', variant: ['112'], name: '' });
        expect(base('F896-84-WHF', 'MINKA AIRE')).toBe('F896');
        expect(base('LXEM4-40HL-RFA-EDU')).toBe('LXEM4');
        expect(base('R-SLIM-DISK-12W-5CCT-WH')).toBe('R-SLIM-DISK');
        // A six-digit run after a short prefix is a design number, not a finish.
        expect(base('GC-06-011123-1-16W-30K-BN', 'GLOBAL CONCEPTS')).toBe('GC-06-011123');
        // The whole code segment stands when it is short but carries a digit.
        expect(base('VP3- FLOWERPOT', '&TRADITION')).toBe('VP3');
    });

    it('drops the manufacturer when it was typed into the catalog cell too', () => {
        expect(base('ALLIED MAKER WAL-004 BLK', 'ALLIED MAKER')).toBe('WAL-004');
        expect(base('LUMIERE 1003', 'LUMIERE')).toBe('1003');
    });

    it('reads nothing out of vocabulary, placeholders, dimensions and links', () => {
        for (const junk of ['EXIT SINGLE', '9" UNDER CABINET', '50" (3) BLADES LIGHT KIT ENERGY STAR', 'LED',
            'STAIR WELLS / ELECTRICAL ROOMS - NO SPEC', 'PIC ONLY NO SPEC. NEED CLEARER PIC', 'https://www.b-td.com/formation', '']) {
            expect(splitBaseItem(junk).kind, junk).toBe('none');
        }
    });

    it('simplifiedBaseItem is null when the string already IS the base', () => {
        expect(simplifiedBaseItem('4430802', 'VISUAL COMFORT')).toBeNull();
        expect(simplifiedBaseItem('WAL-004', 'ALLIED MAKER')).toBeNull();
        expect(simplifiedBaseItem('3-515-25- HALO', 'OXYGEN')?.base).toBe('3-515');
    });
});

describe('sameBaseItem — one product, options differed', () => {
    it('matches variants of one base under one brand', () => {
        expect(sameBaseItem({ spec: '3-515-25- HALO', manufacturer: 'OXYGEN' }, { spec: '3-515-15 HALO', manufacturer: 'OXYGEN' })).toBe(true);
        expect(sameBaseItem({ spec: 'BLOC WALL SCONCE', manufacturer: 'B-TD' }, { spec: 'BLOC WALL SCONCE AGED BRASS', manufacturer: 'B-TD' })).toBe(true);
        // Brand aliases: "LUMENS/TOOY" carries TOOY.
        expect(sameBaseItem({ spec: '557.24 - LEGIER', manufacturer: 'TOOY' }, { spec: '557.22 - LEGIER', manufacturer: 'LUMENS/TOOY' })).toBe(false);
        expect(sameBaseItem({ spec: '557.24 - LEGIER', manufacturer: 'TOOY' }, { spec: '557.24 LEGIER BLACK', manufacturer: 'LUMENS/TOOY' })).toBe(true);
    });

    it('needs the brand for a short number or a product name', () => {
        expect(sameBaseItem({ spec: '3-515-25', manufacturer: 'OXYGEN' }, { spec: '3-515-9', manufacturer: 'CORBETT' })).toBe(false);
        expect(sameBaseItem({ spec: '3-515-25', manufacturer: '' }, { spec: '3-515-9', manufacturer: 'OXYGEN' })).toBe(false);
        expect(sameBaseItem({ spec: 'BLOC WALL SCONCE', manufacturer: '' }, { spec: 'BLOC WALL SCONCE AGED BRASS', manufacturer: 'B-TD' })).toBe(false);
        // A long part number stands on its own.
        expect(sameBaseItem({ spec: '4430802-112', manufacturer: '' }, { spec: '4430802-BZ', manufacturer: 'VISUAL COMFORT' })).toBe(true);
    });

    it('never calls identical strings family', () => {
        expect(sameBaseItem({ spec: '3-515-25- HALO', manufacturer: 'OXYGEN' }, { spec: '3-515-25- HALO', manufacturer: 'OXYGEN' })).toBe(false);
    });
});

describe('planCatalogSearch — what "Look up spec" searches', () => {
    it('searches the base item and hands the printed name over as a lead', () => {
        const plan = planCatalogSearch('3-515-25- HALO', 'OXYGEN');
        expect(plan.baseNumbers).toEqual(['3-515']);
        expect(plan.optionCodes).toEqual(['25']);
        expect(plan.productName).toBe('HALO');
        expect(plan.hasBase).toBe(true);
        expect(planCatalogSearch('WAL-031 MQUAN HALF-CIRCLE', 'ALLIED MAKER').baseNumbers).toEqual(['WAL-031']);
        const formation = planCatalogSearch('FORMATION WALL SCONCE BRUSHED SATIN GOLD - NERO MARQUINA MARBLE', 'B-TD');
        expect(formation.baseNumbers).toEqual(['FORMATION']);
        expect(formation.productName?.startsWith('WALL SCONCE')).toBe(true);
    });

    it('still reads trailing option codes by grammar first', () => {
        const plan = planCatalogSearch('4430802-112 / 4430804-112');
        expect(plan.baseNumbers).toEqual(['4430802', '4430804']);
        expect(plan.optionCodes).toEqual(['112']);
    });
});

// ── Engine: base-item family evidence and the fallback wording ───────────────

const premier = (o: Partial<PremierItemRow> & Pick<PremierItemRow, 'id' | 'itemId' | 'fixtureCategory'>): PremierItemRow => ({
    itemDescription: '', finish: '', colorTemp: '', maxWattage: '', lightOutput: '', timesUsed: 0, ...o,
});

const history = (o: Partial<HistoryRow> & Pick<HistoryRow, 'id' | 'originalSpec' | 'bidItem'>): HistoryRow => ({
    mark: 'D3', project: 'Old Job', bidDate: '2026-06-01', specManufacturer: '', bidManufacturer: 'GLOBAL CONCEPTS',
    specMfrBackup: '', bidMfrBackup: '', matchType: 'EXACT', productCategory: '', specDescription: '',
    specEnrichConfidence: '', premierLinkIds: [], thirdPartyLinkIds: [], ...o,
});

const line = (mark: string, manufacturer: string, catalogNumber: string, rawRow: Record<string, string> = {}): ParsedLineItem => ({
    rowIndex: 1, section: 'Amenity', mark, quantity: '1', manufacturer, catalogNumber, rawRow,
});

const SCONCE_ITEM = premier({ id: 'p-sconce', itemId: 'GC-06-011123-1-16W-30K-BN', fixtureCategory: 'Wall Sconce', itemDescription: 'LED WALL SCONCE 16W', timesUsed: 6 });

describe('engine: a History row for the same base item is family evidence', () => {
    const ctx: EngineContext = {
        premierItems: [SCONCE_ITEM],
        thirdPartyItems: [],
        fans: [],
        history: [history({ id: 'h1', originalSpec: '3-515-15 HALO', specManufacturer: 'OXYGEN', bidItem: SCONCE_ITEM.itemId, premierLinkIds: ['p-sconce'] })],
        referenceDate: '2026-09-11',
    };

    it('surfaces the prior swap for a different size of the same Oxygen sconce, never pre-checked', () => {
        const r = analyzeLineItem(line('D3', 'OXYGEN', '3-515-25- HALO'), ctx);
        const fam = r.recommendations.find(rec => rec.source === 'History');
        expect(fam, 'family card').toBeDefined();
        expect(fam!.familyMatch).toBe(true);
        expect(fam!.premierItem).toBe(SCONCE_ITEM.itemId);
        expect(shouldAutoSelect(fam)).toBe(false);
        expect(r.specBaseItem?.base).toBe('3-515');
    });

    it('does not borrow the evidence for another brand\'s 3-515', () => {
        const r = analyzeLineItem(line('D3', 'CORBETT', '3-515-25- HALO'), ctx);
        expect(r.recommendations.some(rec => rec.source === 'History')).toBe(false);
    });
});

describe('engine: category-level suggestions say what is missing, not that nothing was identified', () => {
    const ctx: EngineContext = { premierItems: [SCONCE_ITEM], thirdPartyItems: [], fans: [], history: [] };

    it('names the base item the catalog has no match for', () => {
        // The sheet's fixture-type column says SCONCE; the engine did identify
        // the category. The old copy — "the exact item wasn't identified" — read
        // as a contradiction under a SCONCE header (3rd & Flower D3/D10/D11).
        const r = analyzeLineItem(line('D10', 'ALLIED MAKER', 'WAC-042-MQUAN CIRCLE', { 'QTY LAMPS': 'SCONCE' }), ctx);
        expect(r.specCategory).toBe('Sconce');
        expect(r.specBaseItem?.base).toBe('WAC-042');
        const top = r.recommendations[0];
        expect(top).toBeDefined();
        expect(top!.autoSelectReason).toContain('recognized as Sconce');
        expect(top!.autoSelectReason).toContain('ALLIED MAKER WAC-042');
        expect(top!.autoSelectReason).not.toContain("wasn't identified");
        expect(top!.matchDetails?.join(' ')).not.toContain('not identified');
    });
});

// ── Outdoor sub-types ────────────────────────────────────────────────────────

describe('outdoor sub-categories: wall pack, flood, step/path', () => {
    it('gates a wall-pack spec to wall products and a flood spec to floods', () => {
        expect(detectFixtureCategory('S1', 'LNC-7LU-4K-3', 'LITHONIA')).toBe('Outdoor Wall');
        expect(detectFixtureCategory('WP1', 'AKT30401-III WALL PACK', 'ABOVE ALL')).toBe('Outdoor Wall');
        expect(detectFixtureCategory('F1', 'LED FLOOD LIGHT 100W', 'RAB')).toBe('Outdoor Flood');
        expect(detectFixtureCategory('SL1', 'LED STEP LIGHT BRONZE', '')).toBe('Outdoor Step');
        // An area light that only says "outdoor" keeps the umbrella.
        expect(detectFixtureCategory('P3', 'DSXB LED P1 40K', 'LITHONIA')).toBe('Outdoor');
    });

    it('the sub-type admits its own products and the umbrella still admits everything outdoor', () => {
        expect(categoriesCompatible('Outdoor Wall', 'Wall Mount')).toBe(true);
        expect(categoriesCompatible('Outdoor Wall', 'Outdoor Wall Sconce')).toBe(true);
        expect(categoriesCompatible('Outdoor Wall', 'Pole Heads')).toBe(false);
        expect(categoriesCompatible('Outdoor Wall', 'Flood Light')).toBe(false);
        expect(categoriesCompatible('Outdoor Flood', 'Flood Light')).toBe(true);
        expect(categoriesCompatible('Outdoor Step', 'Step Light')).toBe(true);
        expect(categoriesCompatible('Outdoor', 'Flood Light')).toBe(true);
        expect(categoriesCompatible('Outdoor', 'Wall Mount')).toBe(true);
    });
});

// ── Which pasted link to read ────────────────────────────────────────────────

describe('preferredSpecUrls — product pages before search links, file shares never', () => {
    it('drops the Box link that sat in column A and keeps the manufacturer page (3rd & Flower D17)', () => {
        const urls = preferredSpecUrls([
            'https://shoppremier.app.box.com/file/1989051167530',
            'https://www.b-td.com/formation-wall-sconce?rq=FORMATION%20WALL%20SCONCE',
        ]);
        expect(urls).toEqual(['https://www.b-td.com/formation-wall-sconce?rq=FORMATION%20WALL%20SCONCE']);
        expect(isFileShareUrl('https://shoppremier.app.box.com/file/1989051167530')).toBe(true);
        expect(specUrlHost('https://www.b-td.com/x')).toBe('b-td.com');
    });

    it('ranks a Google search link after a product page and drops junk', () => {
        expect(preferredSpecUrls([
            'https://www.google.com/search?q=LXEM4-40HL-RFA-EDU',
            'not a url',
            'https://www.currentlighting.com/outdoor-lighting/lnc-litepak/248676',
            'https://www.currentlighting.com/outdoor-lighting/lnc-litepak/248676',
        ])).toEqual([
            'https://www.currentlighting.com/outdoor-lighting/lnc-litepak/248676',
            'https://www.google.com/search?q=LXEM4-40HL-RFA-EDU',
        ]);
    });
});
