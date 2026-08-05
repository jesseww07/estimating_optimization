/**
 * Engine tuning tests — built from the Camino Del Rio live-use review
 * (Jesse's notes, 2026-07-20). Each case reproduces a real bid line that
 * misbehaved on first live use and pins the corrected behavior:
 *
 *  - site poles/heads get in-category Premier recommendations (never silence)
 *  - vanity/mirror marks classify from the MARK text and stay in-category
 *  - Lithonia building lights surface the EFS Surface Mount family
 *  - tape-in-channel systems and handrail strip runs are suppressed as tape,
 *    while architectural linear fixtures are NOT
 *  - TBD / RFI placeholder rows get an RFI message, never a fabricated match
 */

import { describe, expect, it } from 'vitest';
import type { EngineContext, HistoryRow, ParsedLineItem, PremierItemRow } from '@/lib/types';
import { analyzeLineItem } from '@/lib/engine/recommend';
import {
    calculateCatalogMatchScore,
    detectFixtureCategory,
    isAccessoryItem,
    isFamilySpecMatch,
    isLedTape,
    isRfiPlaceholder,
    seriesCategory,
} from '@/lib/engine/matcher';
import { compareRecommendations, shouldAutoSelect } from '@/lib/engine/ranking';

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

// Synthetic catalog using the REAL Fixture Category vocabulary from the live base.
const CTX: EngineContext = {
    history: [],
    thirdPartyItems: [],
    fans: [],
    premierItems: [
        premier({ id: 'p1', itemId: 'GC-PPH-D25-30K', fixtureCategory: 'Post/Pier Head', itemDescription: 'LED POLE HEAD DOUBLE 25FT MOUNT', timesUsed: 40 }),
        premier({ id: 'p2', itemId: 'GC-PB-BOL-36', fixtureCategory: 'Post & Bollard', itemDescription: '36" LED BOLLARD', timesUsed: 12 }),
        premier({ id: 'v22', itemId: 'GC-VAN-LED-22-30K', fixtureCategory: 'Vanity', itemDescription: '22" LED VANITY BAR BRUSHED NICKEL', timesUsed: 18 }),
        premier({ id: 'v34', itemId: 'GC-VAN-LED-34-30K', fixtureCategory: 'Vanity', itemDescription: '34" LED VANITY BAR BRUSHED NICKEL', timesUsed: 22 }),
        premier({ id: 'wm', itemId: 'GC-WM-100-30K', fixtureCategory: 'Wall Mount', itemDescription: 'LED WALL MOUNT UP/DOWN', timesUsed: 30 }),
        premier({ id: 'mir', itemId: 'GC-MIR-2436-BL', fixtureCategory: 'LED Mirror', itemDescription: '24"X36" BACKLIT LED MIRROR', timesUsed: 9 }),
        premier({ id: 'efs', itemId: 'EFS-001-LED40-30K-WH-MV-DIM', fixtureCategory: 'Surface Mount', itemDescription: 'LED SURFACE MOUNT 40W', timesUsed: 1 }),
        premier({ id: 'exit', itemId: 'GCEXITEM-G2', fixtureCategory: 'Exit Sign', itemDescription: 'LED EXIT SIGN EMERGENCY COMBO', timesUsed: 98 }),
    ],
};

const line = (mark: string, manufacturer: string, catalogNumber: string, rowIndex = 1): ParsedLineItem => ({
    rowIndex,
    section: 'Test',
    mark,
    quantity: '1',
    manufacturer,
    catalogNumber,
    rawRow: {},
});

const itemIds = (r: ReturnType<typeof analyzeLineItem>) => r.recommendations.map(x => x.premierItem);
const categories = (r: ReturnType<typeof analyzeLineItem>) => r.recommendations.map(x => x.productCategory);

describe('category detection from real Camino Del Rio rows', () => {
    it('classifies pole and head marks as Outdoor Pole', () => {
        expect(detectFixtureCategory("OP1A - 20' POLE", '693-1234-3X3-9004 POLE', 'WE-EF')).toBe('Outdoor Pole');
        expect(detectFixtureCategory('OP1A - SGL HEAD', '108-1680-9004-0-10V DIMMING FIXTURE, 430-0029 GLARE SHIELD', 'WE-EF')).toBe('Outdoor Pole');
        expect(detectFixtureCategory('OP3B - DBL HEAD', 'OLPL-F40-SB2-2G350-30-BL-HX', 'SELUX')).toBe('Outdoor Pole');
    });

    it('classifies vanity and mirror from the mark text', () => {
        expect(detectFixtureCategory('U-SS1B - 22" Vanity', 'RAC-120-23-29-NS', 'ACOLYTE')).toBe('Vanity');
        expect(detectFixtureCategory('U-WM1 - 24"X36" Backlit Mirror', 'SM020-36"X24"-L930K-NS-SD', 'SCOTT ARCHITECTURAL')).toBe('Mirror');
    });

    it('classifies Lithonia building lights as Linear', () => {
        expect(detectFixtureCategory('WL2E (Elevator Pit)', 'CSVT-L48-5000LM-MVOLT-40K-80CRI-SBOR10; ELEVATOR SHAFT / PIT', 'LITHONIA')).toBe('Linear');
        expect(detectFixtureCategory('WL1E (Stairs)', 'BLWP4 72HLE ADSMT GZ1 LP840 NESPDT7 DIM10; STAIRCASE', 'LITHONIA')).toBe('Linear');
    });
});

describe('in-category fallback recommendations', () => {
    it('site pole gets Post/Pier Head + Post & Bollard candidates, never wall mounts or silence', () => {
        const r = analyzeLineItem(line("OP1A - 20' POLE", 'WE-EF', '693-1234-3X3-9004 POLE'), CTX);
        expect(r.recommendations.length).toBeGreaterThan(0);
        for (const cat of categories(r)) {
            expect(['Post/Pier Head', 'Post & Bollard']).toContain(cat);
        }
        expect(itemIds(r)).toContain('GC-PPH-D25-30K');
    });

    it('22" vanity recommends the 22" vanity — dimension-gates the 34", excludes wall mounts', () => {
        const r = analyzeLineItem(line('U-SS1B - 22" Vanity', 'ACOLYTE', 'RAC-120-23-29-NS'), CTX);
        expect(itemIds(r)).toContain('GC-VAN-LED-22-30K');
        expect(itemIds(r)).not.toContain('GC-VAN-LED-34-30K');
        expect(itemIds(r)).not.toContain('GC-WM-100-30K');
    });

    it('backlit mirror recommends LED Mirror items, not vanities or wall mounts', () => {
        const r = analyzeLineItem(line('U-WM1 - 24"X36" Backlit Mirror', 'SCOTT ARCHITECTURAL', 'SM020-36"X24"-L930K-NS-SD'), CTX);
        expect(itemIds(r)).toContain('GC-MIR-2436-BL');
        for (const cat of categories(r)) expect(cat).toBe('LED Mirror');
    });

    it('Lithonia building light surfaces the EFS Surface Mount family', () => {
        const r = analyzeLineItem(line('WL2E (Elevator Pit)', 'LITHONIA', 'CSVT-L48-5000LM-MVOLT-40K-80CRI-SBOR10; ELEVATOR SHAFT / PIT'), CTX);
        expect(itemIds(r)).toContain('EFS-001-LED40-30K-WH-MV-DIM');
    });
});

describe('tape suppression refinement', () => {
    it('suppresses tape-in-channel component systems (CORE / TIVOLI / FEELUX)', () => {
        const rows: Array<[string, string, string]> = [
            ['RL1.1', 'CORE', 'LSM90HF-30K-16-24, CHANNEL: ALP2800TL-96-FR-WH, XMFR: PSVT-24V'],
            ['SL4.1', 'TIVOLI', 'TPLCBSE-SB-I-30-24, DRIVER: INF-J-96-1-4-24; LOBBY'],
            ['SL5.1', 'FEELUX', 'FIXTURE: FNN1-30K-C90-STD-STD-EXL-FLEX-HW-0-10V-120, DRIVER: PWM DIMMING'],
            ['OL1 (15\'0")', 'CORE', 'LNE-15-DB-2-30K-24-XX-IP67-BF-HW15, MOUNTING CHANNEL: LNE15-CH'],
        ];
        for (const [mark, mfr, cat] of rows) {
            expect(isLedTape(mark, cat, mfr), `${mark} should be tape`).toBe(true);
            const r = analyzeLineItem(line(mark, mfr, cat), CTX);
            expect(r.recommendations).toHaveLength(0);
            expect(r.infoMessage ?? '').toContain('LED tape');
        }
    });

    it('suppresses handrail LED strip runs', () => {
        const r = analyzeLineItem(line('HR-STRIP - 14\'0" (rfi #2)', 'TBD', 'LED STRIP LIGHT; HANDRAILS PER LC204'), CTX);
        expect(r.recommendations).toHaveLength(0);
        expect(r.infoMessage ?? '').toContain('LED tape');
    });

    it('does NOT suppress architectural linear fixtures', () => {
        expect(isLedTape('SL8E (Stairs)', 'G3-4FT-LVH-40-80-U-HE-F-B-D-OF; STAIRCASE', 'A LIGHT')).toBe(false);
        const r = analyzeLineItem(line('SL8E (Stairs)', 'A LIGHT', 'G3-4FT-LVH-40-80-U-HE-F-B-D-OF; STAIRCASE'), CTX);
        expect(r.infoMessage ?? '').not.toContain('LED tape');
    });
});

describe('RFI / TBD placeholder guard', () => {
    it('detects the Camino placeholder forms', () => {
        expect(isRfiPlaceholder('PDE1 (rfi #1)', '(c.h. 10\'0" aff 0\'0")', 'TBD')).toBe(true);
        expect(isRfiPlaceholder('WDE5 (rfi #1)', 'WDE5 (rfi #1)', 'TBD')).toBe(true);
        expect(isRfiPlaceholder('COVE LIGHT (rfi#3)', 'COVE LIGHT        RFI#4 - NO SPEC OR LOCATION', 'TBD')).toBe(true);
        expect(isRfiPlaceholder('RFI #1 - MISSING SPECS', 'RFI #1 - MISSING SPECS', '')).toBe(true);
        expect(isRfiPlaceholder('COVE - 24\'0"', 'COVE - 24\'0"', 'TBD')).toBe(true);
    });

    it('does not flag identifiable specs, even with an RFI annotation on the mark', () => {
        expect(isRfiPlaceholder('HR-STRIP - 14\'0" (rfi #2)', 'LED STRIP LIGHT; HANDRAILS PER LC204', 'TBD')).toBe(false);
        expect(isRfiPlaceholder('U-SS1B - 22" Vanity', 'RAC-120-23-29-NS', 'ACOLYTE')).toBe(false);
    });

    it('returns an RFI message and zero recommendations', () => {
        const r = analyzeLineItem(line('PDE1 (rfi #1)', 'TBD', '(c.h. 10\'0" aff 0\'0")'), CTX);
        expect(r.recommendations).toHaveLength(0);
        expect(r.infoMessage ?? '').toContain('RFI');

        const r2 = analyzeLineItem(line('RFI #2 - HAND RAIL LIGHTING', '', 'RFI #2 - HAND RAIL LIGHTING'), CTX);
        expect(r2.recommendations).toHaveLength(0);
        expect(r2.infoMessage ?? '').toContain('RFI');
    });
});

describe('3rd-party items in the in-category fallback (Phase 2 backlog)', () => {
    const third = (id: string, itemId: string, productCategories: string, itemDescription: string, manufacturer = 'SATCO') => ({
        id, itemId, itemDescription, manufacturer,
        finish: '', colorTemp: '', maxWattage: '', lightOutput: '',
        productCategories,
    });

    const ctx: EngineContext = {
        history: [],
        fans: [],
        premierItems: [
            premier({ id: 'pv', itemId: 'GC-VAN-LED-22-30K', fixtureCategory: 'Vanity', itemDescription: '22" LED VANITY BAR', timesUsed: 0 }),
        ],
        thirdPartyItems: [
            third('t1', 'SAT-VAN-22', 'Vanity', '22" VANITY BAR BUDGET LED'),
            third('t2', 'WG-POLE-25', 'Post/Pier Head', 'LED POLE HEAD', 'WESTGATE'),
        ],
    };

    it('offers 3rd-party alternatives inside the inferred category', () => {
        const r = analyzeLineItem(line('U-SS1B - 22" VANITY', 'NOBRAND', 'CUSTOM VANITY BAR 22 INCH'), ctx);
        const ids = r.recommendations.map(x => x.premierItem);
        expect(ids).toContain('SAT-VAN-22');
        // The pole-head item is category-incompatible with Vanity and must not appear.
        expect(ids).not.toContain('WG-POLE-25');
        const thirdRec = r.recommendations.find(x => x.premierItem === 'SAT-VAN-22')!;
        expect(thirdRec.source).toBe('3rd Party');
        expect(thirdRec.thirdPartyLinkId).toBe('t1');
    });

    it('never ranks a 3rd-party alternative above an own-brand item with equal signal', () => {
        const r = analyzeLineItem(line('U-SS1B - 22" VANITY', 'NOBRAND', 'CUSTOM VANITY BAR 22 INCH'), ctx);
        const ids = r.recommendations.map(x => x.premierItem);
        expect(ids.indexOf('GC-VAN-LED-22-30K')).toBeLessThan(ids.indexOf('SAT-VAN-22'));
    });
});

// ── Candlewood live-use review (2026-07-28) ──────────────────────────────────
// A hospitality bid: Electric Mirror mirrors misrouted to Vanity because the
// LOCATION column said "Vanity", and the SATCO bulb companion lines (".B")
// got fixture junk instead of lamp recommendations.
describe('Candlewood tuning', () => {
    const lamp = (id: string, itemId: string, itemDescription: string, colorTemp = '3000', maxWattage = '') => ({
        id, itemId, itemDescription,
        manufacturer: 'Satco',
        finish: '', lightOutput: '',
        colorTemp, maxWattage,
        productCategories: 'Light Bulb',
    });

    const hist = (bidItem: string, originalSpec = 'SOME-FIXTURE-SPEC') => ({
        id: `h-${bidItem}-${Math.random().toString(36).slice(2, 6)}`,
        mark: 'X', bidItem, originalSpec, project: 'Old Hotel', bidDate: '',
        specManufacturer: '', bidManufacturer: '', specMfrBackup: '', bidMfrBackup: 'SATCO',
        matchType: 'EXACT', productCategory: '', specDescription: '', specVendor: '',
        specEnrichConfidence: '', premierLinkIds: [], thirdPartyLinkIds: [],
    });

    const ctx: EngineContext = {
        history: [hist('S9594'), hist('S9594'), hist('S9594'), hist('S12407'), hist('S11400')],
        fans: [],
        premierItems: [
            premier({ id: 'v22', itemId: 'GC-VAN-LED-22-30K', fixtureCategory: 'Vanity', itemDescription: '22" LED VANITY BAR', timesUsed: 18 }),
            premier({ id: 'mir', itemId: 'GC-MIR-4836-BL', fixtureCategory: 'LED Mirror', itemDescription: '48"X36" BACKLIT LED FRONT LIT MIRROR', timesUsed: 9 }),
            premier({ id: 'sc', itemId: 'GC-WB337-BK', fixtureCategory: 'Sconce', itemDescription: 'WALL SCONCE BLACK', timesUsed: 22 }),
            premier({ id: 'bol', itemId: '4" RD-120-94', fixtureCategory: 'Post & Bollard', itemDescription: '4 INCH BOLLARD', timesUsed: 3 }),
        ],
        thirdPartyItems: [
            lamp('t-a15', 'S12407', '8.2W A15 MED BASE LED 30K DIM 90CRI', '3000', '8.20'),
            lamp('t-a19', 'S9594', '- Energy-efficient LED bulb. 9.5A19/LED/3000K/ND/120V', '3000', '9.50'),
            lamp('t-27k', 'S11400', '6W A19 LED 2700K Medium base', '2700', '6.00'),
        ],
    };

    const cwLine = (mark: string, section: string, manufacturer: string, catalogNumber: string): ParsedLineItem => ({
        rowIndex: 1,
        section,
        mark,
        quantity: '10',
        manufacturer,
        catalogNumber,
        rawRow: { MARK: mark, Location: section, MAN: manufacturer, 'CATALOG #': catalogNumber },
    });

    it('classifies Electric Mirror front-lit mirrors as Mirror even when the LOCATION column says Vanity', () => {
        const r = analyzeLineItem(
            cwLine('CG-400', 'Vanity', 'Electric Mirror', 'VAL1.1-48.00X36.00-LHO-OS-30K : Front Lit-Mirror 48"W x 36"H x 1 7/8"D'),
            ctx,
        );
        expect(r.recommendations.length).toBeGreaterThan(0);
        expect(r.recommendations.every(x => x.productCategory === 'LED Mirror')).toBe(true);
        expect(r.recommendations.map(x => x.premierItem)).not.toContain('GC-VAN-LED-22-30K');
    });

    it('matches a prose bulb line to the right lamp by shape + kelvin', () => {
        const r = analyzeLineItem(
            cwLine('CG-404.B', 'One Bedroom Kitchen', 'SATCO', 'Bulb @ Pendent Light - 5W LED A15, 3000K'),
            ctx,
        );
        expect(r.recommendations[0]?.premierItem).toBe('S12407');       // the A15 30K lamp
        expect(r.recommendations[0]?.source).toBe('3rd Party');
        expect(r.recommendations[0]?.confidence).toBeGreaterThanOrEqual(70);
        // The 2700K lamp contradicts the declared 3000K and must be gated out.
        expect(r.recommendations.map(x => x.premierItem)).not.toContain('S11400');
    });

    it('never offers fixtures for a bulb line', () => {
        const r = analyzeLineItem(
            cwLine('CG-409.B', 'Desk, Studio', 'SATCO', 'Bulb @ Wall sconce (1 per lamp)'),
            ctx,
        );
        const ids = r.recommendations.map(x => x.premierItem ?? x.bidItem);
        expect(ids).not.toContain('GC-WB337-BK');                        // no sconces for a bulb
        expect(r.recommendations.every(x => x.productCategory === 'Light Bulb')).toBe(true);
        // Attribute-less spec: usage-ranked, honest moderate confidence.
        expect(r.recommendations[0]?.premierItem).toBe('S9594');
        expect(r.recommendations[0]?.confidence).toBeLessThanOrEqual(60);
    });

    it('confirms a bare SATCO S-number as-spec instead of text-matching it to fixture SKUs', () => {
        const r = analyzeLineItem(cwLine('CG-403.B', 'Kitchen', 'SATCO', 'S9594'), ctx);
        expect(r.recommendations).toHaveLength(1);
        const rec = r.recommendations[0]!;
        expect(rec.isPassthrough).toBe(true);
        expect(rec.confidence).toBe(99);
        expect(rec.bidItem).toBe('S9594');
        expect(rec.matchReason).toContain('SATCO lamp');
        // The old failure: S9594 text-matched to the 4" bollard.
        expect(r.recommendations.map(x => x.premierItem)).not.toContain('4" RD-120-94');
    });

    it('uses written-back bulb swaps as direct evidence once they exist', () => {
        const ctxWithSwaps: EngineContext = {
            ...ctx,
            history: [
                ...ctx.history,
                hist('S12407', 'Bulb @ Pendent Light - 5W LED A15, 3000K'),
                hist('S12407', 'Bulb @ Pendent Light - 5W LED A15, 3000K'),
            ],
        };
        const r = analyzeLineItem(
            cwLine('CG-404.B', 'One Bedroom Kitchen', 'SATCO', 'Bulb @ Pendent Light - 5W LED A15, 3000K'),
            ctxWithSwaps,
        );
        expect(r.recommendations[0]?.premierItem).toBe('S12407');
        expect(r.recommendations[0]?.confidence).toBeGreaterThanOrEqual(85);
        expect(r.recommendations[0]?.matchDetails?.join(' ')).toContain('matching swap');
    });
});

// ── Collective MedSpa tuning (2026-07-29) ─────────────────────────────────────
// Real fixture-schedule run: decorative consumer brands, no catalog numbers.
// Pins: chandelier category detection, accessory exclusion, generic-token
// stop list, RFI lines with a detectable category, post-dedupe fallback
// retry, and the auto-select gate.

describe('Collective MedSpa: category + matching fixes', () => {
    const MEDSPA_CTX: EngineContext = {
        history: [],
        fans: [],
        premierItems: [
            ...CTX.premierItems,
            premier({ id: 'disk12', itemId: 'R-SLIM-DISK-12W-5CCT-WH', fixtureCategory: 'Disk Light', itemDescription: '12W SLIM DISK 5CCT WHITE', timesUsed: 35 }),
            premier({ id: 'disk8', itemId: 'R-SLIM-DISK-8W-5CCT-WH', fixtureCategory: 'Disk Light', itemDescription: '8W SLIM DISK 5CCT WHITE', timesUsed: 31 }),
            premier({ id: 'rdkit', itemId: 'RECESSED DOWNLIGHT RETRO', fixtureCategory: 'Downlight', itemDescription: 'LED RECESSED DOWNLIGHT RETROFIT', timesUsed: 2 }),
            premier({ id: 'flaire', itemId: 'FLAIRE 5 LIGHT SEMI-FLUSH MOUNT', fixtureCategory: 'Flush / Surface Mount', itemDescription: 'FIVE LIGHT SEMI FLUSH', timesUsed: 4 }),
            premier({ id: 'clips', itemId: 'MOUNTING CLIPS FOR TAPE LIGHT', fixtureCategory: 'Undercabinet / Tape Light + Connectors', itemDescription: 'MOUNTING CLIPS', timesUsed: 6 }),
            premier({ id: 'dawn', itemId: 'GC-DAWN 44 CHANDELIER', fixtureCategory: 'Chandelier', itemDescription: '44" CHANDELIER BRONZE', timesUsed: 8 }),
        ],
        thirdPartyItems: [],
    };

    it('classifies chandelier prose specs as Pendant', () => {
        expect(detectFixtureCategory('L2', 'DAITH CHANDELIER', 'LUMENS')).toBe('Pendant');
        expect(detectFixtureCategory('L8', 'PALOMA CHANDELIER', 'ARTHAUS')).toBe('Pendant');
    });

    it('generic tokens alone cannot manufacture a text match', () => {
        expect(calculateCatalogMatchScore('CANNELE PICTURE LIGHT', 'MOUNTING CLIPS FOR TAPE LIGHT')).toBe(0);
        expect(calculateCatalogMatchScore('CANNELE PICTURE LIGHT', 'FLAIRE 5 LIGHT SEMI-FLUSH MOUNT')).toBe(0);
        // Distinctive tokens still match.
        expect(calculateCatalogMatchScore('DAITH CHANDELIER', 'GC-DAWN 44 CHANDELIER')).toBeGreaterThan(0);
    });

    it('flags accessory SKUs and keeps them out of fixture candidates', () => {
        expect(isAccessoryItem('MOUNTING CLIPS FOR TAPE LIGHT', 'MOUNTING CLIPS')).toBe(true);
        expect(isAccessoryItem('R-SLIM-DISK-12W-5CCT-WH', '12W SLIM DISK')).toBe(false);
        // GC wattage-selectable downlight system (per Jesse 2026-07-28):
        // -POWER and EMGDRIVER are drivers; -TUNABLE and -EM are fixtures.
        expect(isAccessoryItem('GC-REC-6-DL-MX32W-POWER', 'POWER FOR "6"" LED Split Deep Regress Mini Downlight')).toBe(true);
        expect(isAccessoryItem('GC-REC-4-EMGDRIVER', 'EMERGENCY DRIVER')).toBe(true);
        expect(isAccessoryItem('GC-REC-4-DL-MX32W-TUNABLE', '4" LED DOWNLIGHT TUNABLE WHITE')).toBe(false);
        expect(isAccessoryItem('GC-REC-4-DL-MX22W-EM', '4" LED DOWNLIGHT EMERGENCY BATTERY')).toBe(false);
        const r = analyzeLineItem(line('L7', 'LUMENS', 'CANNELE PICTURE LIGHT'), MEDSPA_CTX);
        expect(r.recommendations.map(x => x.premierItem)).not.toContain('MOUNTING CLIPS FOR TAPE LIGHT');
        expect(r.recommendations.map(x => x.premierItem)).not.toContain('FLAIRE 5 LIGHT SEMI-FLUSH MOUNT');
    });

    it('unmatched decorative-retail brands get the passthrough badge, not junk', () => {
        const r = analyzeLineItem(line('L7', 'LUMENS', 'CANNELE PICTURE LIGHT'), MEDSPA_CTX);
        expect(r.recommendations).toHaveLength(1);
        expect(r.recommendations[0]?.isPassthrough).toBe(true);
    });

    it('RFI lines with a detectable category get in-category suggestions plus the RFI notice', () => {
        const r = analyzeLineItem(line('A (rfi #1)', 'TBD', 'MISSING SPEC - RECESSED DOWNLIGHT'), MEDSPA_CTX);
        expect(r.infoMessage ?? '').toContain('RFI');
        expect(r.recommendations.length).toBeGreaterThan(0);
        expect(r.recommendations[0]?.matchReason).toContain('Category match');
        // Suggestions on an RFI line are never strong enough to auto-select.
        expect(shouldAutoSelect(r.recommendations[0])).toBe(false);
    });

    it('RFI lines with no category signal still return zero recommendations', () => {
        const r = analyzeLineItem(line('PDE1 (rfi #1)', 'TBD', '(c.h. 10\'0" aff 0\'0")'), MEDSPA_CTX);
        expect(r.recommendations).toHaveLength(0);
        expect(r.infoMessage ?? '').toContain('RFI');
    });

    it('falls back in-category when dedupe deletes every direct candidate (line A)', () => {
        // "RECESSED DOWNLIGHT" text-matches the RECESSED DOWNLIGHT RETRO item
        // (substring rule), which dedupe then removes as "the input echoed
        // back" — the line must end with disk-light fallbacks, not silence.
        const r = analyzeLineItem(line('A', 'TBD', 'RECESSED DOWNLIGHT'), MEDSPA_CTX);
        expect(r.recommendations.length).toBeGreaterThan(0);
        expect(r.recommendations.map(x => x.premierItem)).toContain('R-SLIM-DISK-12W-5CCT-WH');
    });

    it('auto-select gate: strong evidence only', () => {
        expect(shouldAutoSelect({ confidence: 61, matchType: 'fuzzy' })).toBe(true);
        expect(shouldAutoSelect({ confidence: 95, matchType: 'exact' })).toBe(true);
        expect(shouldAutoSelect({ confidence: 45, matchType: 'fuzzy' })).toBe(false);   // below bar
        expect(shouldAutoSelect({ confidence: 60, matchType: 'partial' })).toBe(false); // category guess
        expect(shouldAutoSelect({ confidence: 100, matchType: 'manual', isPassthrough: true })).toBe(false);
        expect(shouldAutoSelect(undefined)).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3rd & Flower identification fixes (Jesse's ownership-meeting review,
// 2026-07-30). Each case reproduces a real line from the test bid sheet /
// IS schedule where the source item wasn't identified: near-misses that
// should have been easy dunks, and junk born from 1-char marks and
// single-token substring overlaps.
// ─────────────────────────────────────────────────────────────────────────────

describe('3rd & Flower: category detection gaps', () => {
    it('detects a ceiling fan described only by attributes (blades + light kit)', () => {
        expect(detectFixtureCategory('UF', '50" (3) BLADES LIGHT KIT ENERGY STAR', '')).toBe('Ceiling Fan');
    });

    it('detects a fan named in the catalog text, not the mark', () => {
        expect(detectFixtureCategory('LS4', 'FAN CABANA', '')).toBe('Ceiling Fan');
    });

    it('still routes exhaust fans nowhere, even from catalog text', () => {
        expect(detectFixtureCategory('EF1', 'EXHAUST FAN 110CFM', '')).toBeNull();
    });

    it('classifies EXIT SINGLE / EXIT DOUBLE placeholder rows as Exit/Emergency', () => {
        expect(detectFixtureCategory('EXIT SINGLE', 'EXIT SINGLE', '')).toBe('Exit/Emergency');
        expect(detectFixtureCategory('EXIT DOUBLE', 'EXIT DOUBLE', '')).toBe('Exit/Emergency');
    });

    it('classifies Lithonia LXEM exit units and LNC wall packs', () => {
        expect(detectFixtureCategory('C', 'LXEM4-40HL-RFA-EDU', '')).toBe('Exit/Emergency');
        expect(detectFixtureCategory('S1', 'LNC-7LU-4K-3', '')).toBe('Outdoor');
    });

    it('EXIT placeholder rows surface in-category exit items with the RFI notice instead of silence', () => {
        // Real rows: 100x "EXIT SINGLE" + 41x "EXIT DOUBLE" with no spec —
        // mark === catalog makes them RFI placeholders; the category must
        // still route them to the exit-sign family.
        const r = analyzeLineItem(line('EXIT SINGLE', '', 'EXIT SINGLE'), CTX);
        expect(r.infoMessage ?? '').toContain('RFI');
        expect(r.recommendations.map(x => x.premierItem)).toContain('GCEXITEM-G2');
        expect(shouldAutoSelect(r.recommendations[0])).toBe(false);
    });
});

describe('3rd & Flower: short-mark and single-token junk gates', () => {
    it('a 1-char mark cannot manufacture matches (exit spec got GC-BLChannel via mark "C")', () => {
        const r = analyzeLineItem(line('C', '', 'LXEM4-40HL-RFA-EDU'), CTX);
        // With LXEM now detected, the line lands in the exit family — and the
        // old mark-substring junk (85% on the letter C) must be gone.
        for (const rec of r.recommendations) {
            expect(rec.matchReason).not.toContain('Mark match');
            expect(rec.productCategory).toBe('Exit Sign');
        }
    });

    it('a single significant token matching only as a substring scores zero', () => {
        expect(calculateCatalogMatchScore('CS6964', 'GC-01-083123-1-2XE26-CS')).toBe(0);
        expect(calculateCatalogMatchScore('3-515-25- HALO', 'GC-01-061118-2-12W-30K-AL')).toBe(0);
    });

    it('color/finish words are attributes, not identity', () => {
        expect(calculateCatalogMatchScore('APLOMB GREY', 'HEIR CUSTOM-JAIMA 43 -GREY')).toBe(0);
        expect(calculateCatalogMatchScore('DJEMBÉ GREY - RAL 7022', 'HEIR CUSTOM-JAIMA 43 -GREY')).toBe(0);
    });

    it('real shared tokens still match (family match survives the gates)', () => {
        expect(calculateCatalogMatchScore('F896-65-CL', 'F896-65-WHF')).toBeGreaterThanOrEqual(70);
    });
});

describe('3rd & Flower: 3rd-party direct matching tier', () => {
    const FAN_CTX: EngineContext = {
        history: [],
        premierItems: [],
        fans: [],
        thirdPartyItems: [
            {
                id: 't-f896', itemId: 'F896-65-WHF', itemDescription: 'MINKA AIRE 65" XTREME H2O FLAT WHITE',
                manufacturer: 'MINKA AIRE', finish: 'FLAT WHITE', colorTemp: '', maxWattage: '', lightOutput: '',
                productCategories: 'Ceiling Fans + Accessories',
            },
            {
                id: 't-rod', itemId: 'DR524-CL', itemDescription: 'MOUNTING DOWNROD 24" FOR CEILING FAN',
                manufacturer: 'MINKA AIRE', finish: '', colorTemp: '', maxWattage: '', lightOutput: '',
                productCategories: 'Ceiling Fan Accessory',
            },
        ],
    };

    it('a resold 3rd-party family match surfaces directly (Minka F896-65-CL → F896-65-WHF)', () => {
        const r = analyzeLineItem(line('D16', 'MINKA AIRE', 'F896-65-CL'), FAN_CTX);
        const top = r.recommendations[0];
        expect(top?.premierItem).toBe('F896-65-WHF');
        expect(top?.source).toBe('3rd Party');
        expect(top?.thirdPartyLinkId).toBe('t-f896');
        expect(top?.confidence).toBeGreaterThanOrEqual(50);
    });

    it('accessories never ride the 3rd-party direct tier (downrod stays out)', () => {
        const r = analyzeLineItem(line('D16', 'MINKA AIRE', 'F896-65-CL'), FAN_CTX);
        expect(r.recommendations.map(x => x.premierItem)).not.toContain('DR524-CL');
    });
});

describe('3rd & Flower: decorative brand passthrough additions', () => {
    it('TOOY / FOSCARINI / CVL specs get the as-spec badge, not silence or junk', () => {
        for (const [mfr, spec] of [['TOOY', '557.24 - LEGIER'], ['FOSCARINI', 'APLOMB GREY'], ['CVL', 'CERCLE & TRAIT XL SATIN COPPER']] as const) {
            const r = analyzeLineItem(line('D1', mfr, spec), CTX);
            expect(r.recommendations).toHaveLength(1);
            expect(r.recommendations[0]?.isPassthrough).toBe(true);
            expect(r.recommendations[0]?.matchReason).toContain('as-spec');
        }
    });
});

describe('3rd & Flower: fan-span and accessory-history gates', () => {
    const FAN_CTX2: EngineContext = {
        history: [
            // One stale swap: fan spec → a DOWNROD (accessory). Must never
            // surface for a fixture spec, and must not suppress direct matching.
            {
                id: 'h-rod', mark: 'D16', bidItem: 'DR524-CL', originalSpec: 'F896-65-CL',
                project: 'Old Job', bidDate: '', specManufacturer: '', bidManufacturer: '',
                specMfrBackup: 'MINKA AIRE', bidMfrBackup: 'MINKA AIRE', matchType: 'EXACT',
                productCategory: '', specDescription: '', specVendor: '', specEnrichConfidence: '',
                premierLinkIds: [], thirdPartyLinkIds: ['t-rod'],
            },
        ],
        premierItems: [],
        fans: [],
        thirdPartyItems: [
            {
                id: 't-f896', itemId: 'F896-65-WHF', itemDescription: 'MINKA AIRE 65" XTREME H2O FLAT WHITE',
                manufacturer: 'MINKA AIRE', finish: 'FLAT WHITE', colorTemp: '', maxWattage: '', lightOutput: '',
                productCategories: 'Ceiling Fans + Accessories',
            },
            {
                id: 't-rod', itemId: 'DR524-CL', itemDescription: 'MOUNTING DOWNROD 24" FOR CEILING FAN',
                manufacturer: 'MINKA AIRE', finish: '', colorTemp: '', maxWattage: '', lightOutput: '',
                productCategories: 'Ceiling Fan Accessory',
            },
        ],
    };

    it('a stale accessory swap is gated out of history and stops blocking direct matches', () => {
        const r = analyzeLineItem(line('D16', 'MINKA AIRE', 'F896-65-CL'), FAN_CTX2);
        const ids = r.recommendations.map(x => x.premierItem ?? x.bidItem);
        expect(ids).not.toContain('DR524-CL');
        expect(ids).toContain('F896-65-WHF');
    });

    it('a wrong blade span never rides the 3rd-party direct tier (84" spec vs 65" catalog)', () => {
        // Before the gate this line auto-selected the 65" sibling at fuzzy@67.
        // The 65" fan may still appear as a category-level 'partial' fallback
        // card (family pointer, one click away) — but never as a confident,
        // auto-selectable direct match.
        const r = analyzeLineItem(line('D15', 'MINKA AIRE', 'F896-84-WHF'), FAN_CTX2);
        const wrongSpan = r.recommendations.filter(x => x.premierItem === 'F896-65-WHF');
        for (const rec of wrongSpan) {
            expect(rec.matchType).toBe('partial');
            expect(shouldAutoSelect(rec)).toBe(false);
        }
    });
});

describe('3rd & Flower: resold-as-spec and as-spec history echoes', () => {
    const RESOLD_CTX: EngineContext = {
        history: [
            // Real Flats at Ballpark rows: the spec was bid AS ITSELF (resold
            // item) plus its downrod — neither is substitution evidence.
            {
                id: 'h-self', mark: 'LT-1', bidItem: 'F896-65-CL', originalSpec: 'F896-65-CL',
                project: 'Old Job', bidDate: '', specManufacturer: '', bidManufacturer: '',
                specMfrBackup: 'MINKA AIRE', bidMfrBackup: 'MINKA AIRE', matchType: 'EXACT',
                productCategory: '', specDescription: '', specVendor: '', specEnrichConfidence: '',
                premierLinkIds: [], thirdPartyLinkIds: ['t-cl'],
            },
        ],
        premierItems: [],
        fans: [],
        thirdPartyItems: [
            {
                id: 't-cl', itemId: 'F896-65-CL', itemDescription: 'MINKA AIRE 65" XTREME H2O COAL',
                manufacturer: 'MINKA AIRE', finish: 'COAL', colorTemp: '', maxWattage: '', lightOutput: '',
                productCategories: 'Ceiling Fans + Accessories',
            },
            {
                id: 't-whf', itemId: 'F896-65-WHF', itemDescription: 'MINKA AIRE 65" XTREME H2O FLAT WHITE',
                manufacturer: 'MINKA AIRE', finish: 'FLAT WHITE', colorTemp: '', maxWattage: '', lightOutput: '',
                productCategories: 'Ceiling Fans + Accessories',
            },
        ],
    };

    it('a spec that IS a resold item gets the as-spec card, never an auto-checked sibling variant', () => {
        const r = analyzeLineItem(line('D16', 'MINKA AIRE', 'F896-65-CL'), RESOLD_CTX);
        const top = r.recommendations[0];
        expect(top?.isPassthrough).toBe(true);
        expect(top?.matchReason).toContain('resold');
        expect(top?.thirdPartyLinkId).toBe('t-cl');
        expect(shouldAutoSelect(top)).toBe(false);
        // The finish sibling must not ride along as a confident direct match.
        const sibling = r.recommendations.find(x => x.premierItem === 'F896-65-WHF');
        expect(sibling?.matchType ?? 'partial').toBe('partial');
    });

    it('as-spec history rows (spec swapped to itself) are not substitution evidence', () => {
        // With the echo skipped, history contributes nothing here and the
        // pipeline reaches the resold-as-spec card instead of fallback junk.
        const r = analyzeLineItem(line('LT-16', 'MINKA AIRE', 'BCI3541446 / F896-65-CL'), RESOLD_CTX);
        expect(r.recommendations.some(x => x.source === 'History')).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Largo Station exemplars (Phase 4 freeze, test of 2026-07-30). Ground truth:
// what Premier's estimators ACTUALLY bid for each spec (the "07-31-26 AP"
// sheet), with the synthetic history mirroring the real snapshot rows that
// already held the answers. These are the acceptance tests for the Phase 4
// identification work: family/series history matching, learned series →
// category knowledge, and the null-category junk gate.
// ─────────────────────────────────────────────────────────────────────────────

describe('Largo Station: learned series → category (backlog #4)', () => {
    it('categorizes S7R (Philips SlimSurface) as Recessed from History knowledge', () => {
        // detectFixtureCategory returned null for this spec on the live test —
        // the S7R series was learned from 4 linked Diamond View/COTTONWOOD rows.
        expect(seriesCategory('S7R835K10AL')).toBe('Recessed');
        expect(detectFixtureCategory('BA', 'S7R835K10AL', 'PHILIPS')).toBe('Recessed');
    });

    it('categorizes BS100LED (Beghelli vapor-tight) as Linear from History knowledge', () => {
        expect(seriesCategory('BS100LED-4-HT-VLO-WT35-120-277')).toBe('Linear');
        expect(detectFixtureCategory('BH', 'BS100LED-4-HT-VLO-WT35-120-277', 'BEGHELLI')).toBe('Linear');
    });

    it('resolves separator-free option grammar to the learned series (S7R835… → s7r)', () => {
        // The Largo bid sheet ran the options together; the learned rows carry
        // dashes. Both forms must resolve to the same series.
        expect(seriesCategory('S7R-8-35K-10-Z10U')).toBe(seriesCategory('S7R835K10AL'));
    });
});

describe('Largo Station: family/series history matching (backlog #2)', () => {
    it('spec pairs from the live test read as family', () => {
        // BA: 9-char shared prefix with Cupertino's row.
        expect(isFamilySpecMatch('S7R835K10AL', 'S7R-8-35K-10-Z10U')).toBe(true);
        // BA: only 4 shared chars with Diamond View's row — the learned S7R
        // series key carries it.
        expect(isFamilySpecMatch('S7R835K10AL', 'S7R-8-27K-10-ZI0U')).toBe(true);
        // BH: same Beghelli series, different options.
        expect(isFamilySpecMatch('BS100LED-4-HT-VLO-WT35-120-277', 'BS100LED-4-SA-HO-WT40-120-277-SM-EMG')).toBe(true);
        // BF: dashed vs run-together Philips wrap — series-token kinship + score.
        expect(isFamilySpecMatch('FSW-4-30L-835-UNV-DIM', 'FSW440L840-UNV-SDIM-LSXR10')).toBe(true);
    });

    it('family matching is series-aware, never substring-accidental', () => {
        // Different FC Lighting wall products: no family claim.
        expect(isFamilySpecMatch('FCW3052', 'FCW1084')).toBe(false);
        // Near-universal OPTION tokens (UNV/DIM/30K) must not manufacture kinship:
        // a Beta downlight scored 65 against a Philips wrap on UNV+DIM alone.
        expect(isFamilySpecMatch('FSW-4-30L-835-UNV-DIM', 'BETA-3R-SW-15LM-40K-90-40HET-BK-BK-P-UNV-DIM10')).toBe(false);
        // Prose describes, it doesn't identify.
        expect(isFamilySpecMatch('LED STRIP LIGHTING', 'LED STRIP LIGHT; HANDRAILS PER LC204')).toBe(false);
        // Exact same spec is the authoritative tier's business, not family's.
        expect(isFamilySpecMatch('S7R835K10AL', 's7r 835 K10 AL')).toBe(false);
    });

    it('a dimension conflict vetoes family, whatever the shared prefix', () => {
        expect(isFamilySpecMatch(
            'EFS-001-LED40-PATU-MV-WH-O-DIM-4FT',
            'EFS-001-LED40-PATU-MV-WH-O-DIM-8FT',
        )).toBe(false);
        expect(isFamilySpecMatch('RECESSED DOWNLIGHT 6 INCH', 'RECESSED DOWNLIGHT 4 INCH')).toBe(false);
    });
});

describe('Largo Station: end-to-end exemplars', () => {
    const largoHist = (
        id: string, project: string, originalSpec: string, bidItem: string,
        premierLinkIds: string[] = [], bidDate = '',
    ): HistoryRow => ({
        id, mark: 'X', bidItem, originalSpec, project, bidDate,
        specManufacturer: '', bidManufacturer: '', specMfrBackup: '', bidMfrBackup: '',
        matchType: 'EXACT', productCategory: '', specDescription: '', specVendor: '',
        specEnrichConfidence: '', premierLinkIds, thirdPartyLinkIds: [],
    });

    // Mirrors the real snapshot rows (verified 2026-08-03) + the pole-head
    // items that surfaced as junk for BH on the live test.
    const LARGO_CTX: EngineContext = {
        fans: [],
        thirdPartyItems: [],
        premierItems: [
            premier({ id: 'disk12', itemId: 'R-SLIM-DISK-12W-5CCT-WH', fixtureCategory: 'Disk Light', itemDescription: '12W SLIM DISK 5CCT WHITE', timesUsed: 35 }),
            premier({ id: 'efv40', itemId: 'EFV-002-LED40-PATU-MV-WH-O-DIM-4FT', fixtureCategory: 'Surface Mount', itemDescription: 'LED VAPOR TIGHT 40W 4FT', timesUsed: 58 }),
            premier({ id: 'efv75', itemId: 'EFV-002-LED75-PATU-MV-WH-O-DIM-4FT', fixtureCategory: 'Surface Mount', itemDescription: 'LED VAPOR TIGHT 75W 4FT', timesUsed: 12 }),
            premier({ id: 'efs40', itemId: 'EFS-001-LED40-PATU-MV-WH-O-DIM-4FT', fixtureCategory: 'Surface Mount', itemDescription: 'LED WRAP 40W 4FT', timesUsed: 44 }),
            premier({ id: 'sat100', itemId: 'GC-SAT-LED-100W-30k-T3-MV-BZ', fixtureCategory: 'Post/Pier Head', itemDescription: 'LED AREA LIGHT 100W TYPE 3', timesUsed: 20 }),
            premier({ id: 'cont100', itemId: 'CONT-S-100-30K-MV-SM-T3-D-BZ', fixtureCategory: 'Post/Pier Head', itemDescription: 'LED POLE HEAD 100W', timesUsed: 15 }),
        ],
        history: [
            // BH's answer, thrown away by the engine @ PR #6: Flourney bid the
            // same Beghelli series (different options) to EFV-002-LED40 3×.
            largoHist('h-fl1', 'Flourney Research Park', 'BS100LED-4-SA-HO-WT40-120-277-SM-EMG', 'EFV-002-LED40-PATU-MV-WH-O-DIM-4FT', ['efv40']),
            largoHist('h-fl2', 'Flourney Research Park', 'BS100LED-4-SA-HO-WT40-120-277-SM-EMG', 'EFV-002-LED40-PATU-MV-WH-O-DIM-4FT', ['efv40']),
            largoHist('h-fl3', 'Flourney Research Park', 'BS100LED-4-SA-HO-WT40-120-277-SM-EMG', 'EFV-002-LED40-PATU-MV-WH-O-DIM-4FT', ['efv40']),
            largoHist('h-sat', 'Saturday', 'BS100LED-PG-4HT-HO-WT30-120-227V-SM-IOS', 'EFV-002-LED75-PATU-MV-WH-O-DIM-4FT-STEPSENS', ['efv75']),
            // BA's answer: S7R SlimSurface swaps across four projects.
            largoHist('h-dv1', 'Diamond View', 'S7R-8-27K-10-ZI0U', 'R-SLIM-DISK-12W-5CCT-WH', ['disk12']),
            largoHist('h-dv2', 'Diamond View', 'S7R-8-27K-10-ZI0U', 'R-SLIM-DISK-12W-5CCT-WH', ['disk12']),
            largoHist('h-ywca', 'YWCA', 'S7R-8-30K-10', 'R-SLIM-DISK-12W-5CCT-MULTIDIM-WH'),
            largoHist('h-cup', 'Cupertino Senior Living', 'S7R-8-35K-10-Z10U', 'R-SLIM-DISK-12W-5CCT-MULTIDIM-WH'),
            // BF's answer: Aquino bid the Philips FSW wrap family to EFS-001.
            largoHist('h-aq1', 'Aquino', 'FSW440L840-UNV-SDIM-LSXR10', 'EFS-001-LED40-PATU-MV-WH-O-DIM-4FT-STEPDIMSENS', ['efs40']),
            largoHist('h-aq2', 'Aquino', 'FSW440L840-UNV-SDIM-LSXR10-EMLED', 'EFS-001-LED40-PATU-MV-WH-O-DIM-4FT-STEPDIMSENS', ['efs40']),
        ],
    };

    it('BA: the R-SLIM disk family surfaces on top with real confidence (was: silence/45-cap)', () => {
        const r = analyzeLineItem(line('BA', 'PHILIPS', 'S7R835K10AL'), LARGO_CTX);
        const top = r.recommendations[0]!;
        expect(top.premierItem ?? top.bidItem).toContain('R-SLIM-DISK');
        expect(top.source).toBe('History');
        expect(top.familyMatch).toBe(true);
        expect(top.confidence).toBeGreaterThanOrEqual(45);
        expect(top.confidence).toBeLessThan(95);                  // never authoritative
        // Actually bid: R-SLIM-DISK-12W-5CCT-WH — it must be among the cards.
        expect(r.recommendations.map(x => x.premierItem ?? x.bidItem)).toContain('R-SLIM-DISK-12W-5CCT-WH');
    });

    it('BH: the EFV vapor-tight family surfaces — never pole/pier heads (was: 3 pole heads @ 30-45%)', () => {
        const r = analyzeLineItem(line('BH', 'BEGHELLI', 'BS100LED-4-HT-VLO-WT35-120-277'), LARGO_CTX);
        expect(r.recommendations.length).toBeGreaterThan(0);
        const top = r.recommendations[0]!;
        // Actually bid: EFV-002-LED40… — the 3× Flourney family evidence.
        expect(top.premierItem).toBe('EFV-002-LED40-PATU-MV-WH-O-DIM-4FT');
        expect(top.familyMatch).toBe(true);
        expect(top.matchType).toBe('fuzzy');
        expect(top.confidence).toBeLessThanOrEqual(75);           // family cap
        for (const rec of r.recommendations) {
            expect(rec.productCategory).not.toBe('Post/Pier Head');
            expect(rec.premierItem ?? '').not.toMatch(/GC-SAT|CONT-S/);
        }
    });

    it('BF: the EFS wrap family surfaces from Aquino family evidence (was: EFS-003 2FT junk @ 31%)', () => {
        const r = analyzeLineItem(line('BF', 'PHILIPS', 'FSW-4-30L-835-UNV-DIM'), LARGO_CTX);
        const top = r.recommendations[0]!;
        expect(top.premierItem).toBe('EFS-001-LED40-PATU-MV-WH-O-DIM-4FT');
        expect(top.familyMatch).toBe(true);
    });

    it('family suggestions never pre-check (variant precision is unearned until attribute agreement)', () => {
        // Family evidence names the right FAMILY, but the exact variant (LED40
        // vs LED75, 8W vs 12W) measured ~36% precision across the eval corpus.
        // A wrong default writes History on export — so family cards stay one
        // click away. Backlog #3 (attributes) is what earns the pre-check.
        for (const [mark, mfr, cat] of [
            ['BA', 'PHILIPS', 'S7R835K10AL'],
            ['BH', 'BEGHELLI', 'BS100LED-4-HT-VLO-WT35-120-277'],
            ['BF', 'PHILIPS', 'FSW-4-30L-835-UNV-DIM'],
        ] as const) {
            const r = analyzeLineItem(line(mark, mfr, cat), LARGO_CTX);
            for (const rec of r.recommendations.filter(x => x.familyMatch)) {
                expect(shouldAutoSelect(rec), `${mark} family card must not pre-check`).toBe(false);
            }
        }
        expect(shouldAutoSelect({ confidence: 75, matchType: 'fuzzy', familyMatch: true })).toBe(false);
        expect(shouldAutoSelect({ confidence: 75, matchType: 'fuzzy' })).toBe(true);
    });

    it('family matches do not take the History ranking trump — they compete on confidence', () => {
        const familyRec = { source: 'History', familyMatch: true, confidence: 48 } as Parameters<typeof compareRecommendations>[0];
        const directRec = { source: 'Premier Items', confidence: 60 } as Parameters<typeof compareRecommendations>[0];
        const exactRec = { source: 'History', confidence: 40 } as Parameters<typeof compareRecommendations>[0];
        expect(compareRecommendations(directRec, familyRec)).toBeLessThan(0);   // direct@60 above family@48
        expect(compareRecommendations(exactRec, familyRec)).toBeLessThan(0);    // exact history still trumps
        expect(compareRecommendations(exactRec, directRec)).toBeLessThan(0);
    });

    it('BD: off-catalog spec with a schedule type hint gets the wrap/strip family, no junk', () => {
        // The item actually bid (LIN-UD-2INCH-4FT-…) is NOT in the catalog —
        // no engine change can surface it (Airtable hygiene, backlog #6). The
        // honest in-catalog answer is the EFS/EFV Surface Mount family.
        const bd: ParsedLineItem = {
            rowIndex: 1, section: 'Test', mark: 'BD', quantity: '14',
            manufacturer: 'HE WILLIAMS', catalogNumber: '75L-4-L50/835-AF12125-EM/10WLP-DIM-UNV',
            rawRow: { TYPE: 'STRIP' },
        };
        const r = analyzeLineItem(bd, LARGO_CTX);
        expect(r.recommendations.length).toBeGreaterThan(0);
        for (const rec of r.recommendations) {
            expect(rec.productCategory).toBe('Surface Mount');
            expect(shouldAutoSelect(rec)).toBe(false);            // category guess stays a guess
        }
        expect(r.recommendations.map(x => x.premierItem ?? '').join(' ')).toMatch(/EFS|EFV/);
    });

    it('BD without any type hint: silence over cross-category junk', () => {
        const r = analyzeLineItem(line('BD', 'HE WILLIAMS', '75L-4-L50/835-AF12125-EM/10WLP-DIM-UNV'), LARGO_CTX);
        for (const rec of r.recommendations) {
            expect(rec.productCategory).not.toBe('Post/Pier Head');
        }
    });

    it('BS: unknown FC Lighting spec stays silent (its bid item is off-catalog too)', () => {
        const r = analyzeLineItem(line('BS', 'FC LIGHTING', 'FCW3052'), LARGO_CTX);
        expect(r.recommendations).toHaveLength(0);
    });
});

describe('null-category junk gate (backlog #5)', () => {
    const POLE_CTX: EngineContext = {
        history: [], thirdPartyItems: [], fans: [],
        premierItems: [
            premier({ id: 'cont100', itemId: 'CONT-S-100-30K-MV-SM-T3-D-BZ', fixtureCategory: 'Post/Pier Head', itemDescription: 'LED POLE HEAD 100W', timesUsed: 15 }),
        ],
    };

    it('an unknown-category spec cannot surface cross-category cards on a weak token overlap', () => {
        // idScore ≈ 43 (one exact token of three) — under a null category that
        // used to become a 30-45% card (Largo BH: pole heads for a vapor-tight).
        expect(calculateCatalogMatchScore('XQZ-30K-ABC9', 'CONT-S-100-30K-MV-SM-T3-D-BZ')).toBeGreaterThanOrEqual(40);
        expect(calculateCatalogMatchScore('XQZ-30K-ABC9', 'CONT-S-100-30K-MV-SM-T3-D-BZ')).toBeLessThan(55);
        const r = analyzeLineItem(line('BX', '', 'XQZ-30K-ABC9'), POLE_CTX);
        expect(r.recommendations).toHaveLength(0);
    });

    it('the same weak overlap is still allowed INSIDE a detected category', () => {
        // Mark OP1 → Outdoor Pole: an in-category 43%-grade match is a
        // legitimate low-confidence candidate, not cross-category junk.
        const r = analyzeLineItem(line('OP1 - POLE', '', 'XQZ-30K-ABC9'), POLE_CTX);
        expect(r.recommendations.map(x => x.premierItem)).toContain('CONT-S-100-30K-MV-SM-T3-D-BZ');
        expect(shouldAutoSelect(r.recommendations[0])).toBe(false);
    });
});

// ── Exact-history confidence rework (Excel-listing review, 2026-08-05) ────────
// Jesse's Diamond View re-run: a 2-swap exact precedent displayed 35% while the
// family card next to it showed 48%. Confidence now rides agreement × recency
// (+ catalog-usage prior); pre-check eligibility stays pinned to raw evidence
// mass so the honest display never widens auto-select.
describe('exact-history confidence rework', () => {
    const REF = '2026-08-01T00:00:00.000Z';
    const xhist = (id: string, project: string, originalSpec: string, bidItem: string, o: Partial<HistoryRow> = {}): HistoryRow => ({
        id, mark: 'SC', bidItem, originalSpec, project,
        bidDate: '2026-03-01', specManufacturer: '', bidManufacturer: '',
        specMfrBackup: 'LITHONIA', bidMfrBackup: '', matchType: 'EXACT',
        productCategory: '', specDescription: '', specVendor: '', specEnrichConfidence: '',
        premierLinkIds: [], thirdPartyLinkIds: [],
        ...o,
    });
    const WDGE = 'WDGE2-LED-P3-30K-80CRI-T4M-MVOLT-SRM';
    const XCTX: EngineContext = {
        referenceDate: REF,
        fans: [], thirdPartyItems: [],
        premierItems: [
            premier({ id: 'wp', itemId: 'GC-WP-R8-40/30/20/15W-3CCT-BZ-STEPDIM', fixtureCategory: 'Wall Mount', itemDescription: 'LED WALL PACK 3CCT BRONZE', timesUsed: 10 }),
            premier({ id: 'disk', itemId: 'R-SLIM-DISK-12W-5CCT-WH', fixtureCategory: 'Disk Light', itemDescription: '12W SLIM DISK 5CCT WHITE', timesUsed: 91 }),
        ],
        // Two Diamond View rows, same spec → same item, UNLINKED (as in the live base).
        history: [
            xhist('h1', 'Diamond View', WDGE, 'GC-WP-R8-40/30/20/15W-3CCT-BZ-STEPDIM'),
            xhist('h2', 'Diamond View', WDGE, 'GC-WP-R8-40/30/20/15W-3CCT-BZ-STEPDIM'),
        ],
    };

    it('a 2-swap full-agreement recent precedent scores high and pre-checks (was 35%, unchecked)', () => {
        const r = analyzeLineItem(line('SC', 'LITHONIA', WDGE), XCTX);
        const top = r.recommendations[0]!;
        expect(top.source).toBe('History');
        expect(top.bidItem).toBe('GC-WP-R8-40/30/20/15W-3CCT-BZ-STEPDIM');
        expect(top.confidence).toBeGreaterThanOrEqual(75);
        expect(top.confidence).toBeLessThan(95);                  // sub-authoritative: 2 swaps, not 3
        expect(shouldAutoSelect(top)).toBe(true);
        const details = (top.matchDetails ?? []).join(' | ');
        expect(details).toContain('100% agreement');
        expect(details).toContain('Confidence');
    });

    it('unlinked history rows resolve category + attributes from the catalog by item #', () => {
        const r = analyzeLineItem(line('SC', 'LITHONIA', WDGE), XCTX);
        const top = r.recommendations[0]!;
        expect(top.productCategory).toBe('Wall Mount');
        expect(top.premierLinkId).toBe('wp');
        expect((top.matchDetails ?? []).join(' ')).toContain("aren't linked in Airtable");
    });

    it('generic spec words never become confident or authoritative exact matches', () => {
        // Three rows agreeing that "DOWNLIGHT" → this disk used to mint an
        // authoritative 95-100% card. "DOWNLIGHT" matching "DOWNLIGHT" is
        // vocabulary, not a product identity (measured 29% precision).
        const ctx: EngineContext = {
            ...XCTX,
            history: [
                xhist('g1', 'Job A', 'DOWNLIGHT', 'R-SLIM-DISK-12W-5CCT-WH', { premierLinkIds: ['disk'] }),
                xhist('g2', 'Job B', 'DOWNLIGHT', 'R-SLIM-DISK-12W-5CCT-WH', { premierLinkIds: ['disk'] }),
                xhist('g3', 'Job C', 'DOWNLIGHT', 'R-SLIM-DISK-12W-5CCT-WH', { premierLinkIds: ['disk'] }),
            ],
        };
        const r = analyzeLineItem(line('R1', '', 'DOWNLIGHT'), ctx);
        const rec = r.recommendations.find(x => (x.premierItem ?? x.bidItem) === 'R-SLIM-DISK-12W-5CCT-WH');
        expect(rec).toBeDefined();
        expect(rec!.matchType).toBe('fuzzy');                     // not authoritative 'exact'
        expect(rec!.confidence).toBeLessThanOrEqual(45);          // cap holds through the own-brand bonus
        expect(shouldAutoSelect(rec)).toBe(false);
        expect((rec!.matchDetails ?? []).join(' ')).toContain('generic');
    });

    it('a 3-vs-3 split never mints two authoritative precedents', () => {
        const ctx: EngineContext = {
            ...XCTX,
            history: [
                xhist('s1', 'Job A', WDGE, 'GC-WP-R8-40/30/20/15W-3CCT-BZ-STEPDIM'),
                xhist('s2', 'Job B', WDGE, 'GC-WP-R8-40/30/20/15W-3CCT-BZ-STEPDIM'),
                xhist('s3', 'Job C', WDGE, 'GC-WP-R8-40/30/20/15W-3CCT-BZ-STEPDIM'),
                xhist('s4', 'Job D', WDGE, 'GC-WPX-OTHER-ITEM-40W-30K'),
                xhist('s5', 'Job E', WDGE, 'GC-WPX-OTHER-ITEM-40W-30K'),
                xhist('s6', 'Job F', WDGE, 'GC-WPX-OTHER-ITEM-40W-30K'),
            ],
        };
        const r = analyzeLineItem(line('SC', 'LITHONIA', WDGE), ctx);
        for (const rec of r.recommendations.filter(x => x.source === 'History')) {
            expect(rec.matchType, `${rec.bidItem} must stay sub-authoritative on an even split`).toBe('fuzzy');
            expect(rec.confidence).toBeLessThan(95);
        }
    });

    it('space-separated part numbers still count as identifiable spec keys', () => {
        // "DSXB LED P1 40K" reads as prose to looksLikeProse (LED + spaces),
        // but its option-grammar tokens (P1, 40K) are part-number DNA — three
        // agreeing swaps on it deserve the authoritative tier.
        const ctx: EngineContext = {
            ...XCTX,
            history: [
                xhist('d1', 'Job A', 'DSXB LED P1 40K', 'GC-WP-R8-40/30/20/15W-3CCT-BZ-STEPDIM'),
                xhist('d2', 'Job B', 'DSXB LED P1 40K', 'GC-WP-R8-40/30/20/15W-3CCT-BZ-STEPDIM'),
                xhist('d3', 'Job C', 'DSXB LED P1 40K', 'GC-WP-R8-40/30/20/15W-3CCT-BZ-STEPDIM'),
            ],
        };
        const r = analyzeLineItem(line('SL', 'LITHONIA', 'DSXB LED P1 40K'), ctx);
        const top = r.recommendations[0]!;
        expect(top.matchType).toBe('exact');
        expect(top.confidence).toBeGreaterThanOrEqual(95);
    });

    it('a minority pick (1 of 3 appearances) stays below the pre-check bar whatever it displays', () => {
        const ctx: EngineContext = {
            ...XCTX,
            history: [
                xhist('m1', 'Job A', WDGE, 'GC-WP-R8-40/30/20/15W-3CCT-BZ-STEPDIM'),
                xhist('m2', 'Job B', WDGE, 'GC-WPX-OTHER-ITEM-40W-30K'),
                xhist('m3', 'Job C', WDGE, 'GC-WPX-OTHER-ITEM-40W-30K'),
            ],
        };
        const r = analyzeLineItem(line('SC', 'LITHONIA', WDGE), ctx);
        const minority = r.recommendations.find(x => x.bidItem === 'GC-WP-R8-40/30/20/15W-3CCT-BZ-STEPDIM');
        expect(minority).toBeDefined();
        expect(minority!.autoSelectSafe).toBe(false);             // 1 recent swap: evidence mass 20+15 < 50
        expect(shouldAutoSelect(minority)).toBe(false);
        expect((minority!.matchDetails ?? []).join(' ')).toContain('3 times; 1 chose this item');
    });

    it('shouldAutoSelect honors the autoSelectSafe veto regardless of confidence', () => {
        expect(shouldAutoSelect({ confidence: 88, matchType: 'fuzzy', autoSelectSafe: false })).toBe(false);
        expect(shouldAutoSelect({ confidence: 88, matchType: 'fuzzy', autoSelectSafe: true })).toBe(true);
        expect(shouldAutoSelect({ confidence: 88, matchType: 'fuzzy' })).toBe(true);
    });

    it('the spec category rides the analysis for the UI header', () => {
        const r = analyzeLineItem(line('SC', 'LITHONIA', WDGE), XCTX);
        expect(r.specCategory).toBe('Sconce');
        const unknown = analyzeLineItem(line('ZZ', 'ACME', 'TOTALLY-UNKNOWN-99Q'), XCTX);
        expect(unknown.specCategory).toBeNull();
    });
});
