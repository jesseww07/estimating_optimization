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
import type { EngineContext, ParsedLineItem, PremierItemRow } from '@/lib/types';
import { analyzeLineItem } from '@/lib/engine/recommend';
import { detectFixtureCategory, isLedTape, isRfiPlaceholder } from '@/lib/engine/matcher';

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
