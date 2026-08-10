/**
 * Firecrest Ridge live-use review (Jesse's notes, 2026-08-10). Four defects,
 * each pinned here:
 *
 *  1. Spec categories and card categories spoke different vocabularies, so a
 *     card that had PASSED the category gate still read as a mismatch.
 *  2. The gate itself was partly dead: three Premier choices in the old map
 *     don't exist in the live base, and the 3rd-party gate compared the resold
 *     catalog's own vocabulary against Premier's.
 *  3. Digit-free but perfectly real catalog numbers (LUMENPAD, FMVCSL, AXCENT)
 *     were treated as generic description and capped at 45%.
 *  4. Identifying a line replaced the typed catalog # — the key its own history
 *     is filed under — so the recommendations didn't improve.
 */

import { describe, expect, it } from 'vitest';
import type { EngineContext, ParsedLineItem, PremierItemRow } from '@/lib/types';
import { analyzeLineItem } from '@/lib/engine/recommend';
import { CATEGORY_TAXONOMY, groupOfCatalogCategory } from '@/lib/engine/categories';
import {
    CATEGORY_GROUPS,
    categoriesCompatible,
    isIdentifiableSpecKey,
    thirdPartyCategoriesCompatible,
} from '@/lib/engine/matcher';
import { defaultSelection, shouldAutoSelect } from '@/lib/engine/ranking';
import { applyIdentifiedSpec } from '@/lib/identify/apply';
import type { IdentifiedSpec } from '@/lib/identify/types';

const premier = (o: Partial<PremierItemRow> & Pick<PremierItemRow, 'id' | 'itemId' | 'fixtureCategory'>): PremierItemRow => ({
    itemDescription: '', style: '', finish: '', colorTemp: '', maxWattage: '', lightOutput: '', timesUsed: 0, ...o,
});

const line = (mark: string, manufacturer: string, catalogNumber: string): ParsedLineItem => ({
    rowIndex: 1, section: 'Site', mark, quantity: '1', manufacturer, catalogNumber, rawRow: {},
});

// ── 1 + 2: one vocabulary, and a gate that actually admits things ────────────

describe('category vocabulary', () => {
    it('every group name the taxonomy declares is reachable from both catalogs', () => {
        // The regression this guards: the old map listed "Post/Pier Head",
        // "Post & Bollard" and "Ceiling Fans + Accessories", none of which exist
        // in the live base — so "Outdoor Pole" matched literally nothing.
        for (const [group, def] of Object.entries(CATEGORY_TAXONOMY)) {
            expect(def.premier.length + def.thirdParty.length, `${group} has no vocabulary`).toBeGreaterThan(0);
            for (const cat of def.premier) {
                expect(categoriesCompatible(group, cat), `${group} should admit Premier "${cat}"`).toBe(true);
            }
            for (const cat of def.thirdParty) {
                expect(thirdPartyCategoriesCompatible(group, cat), `${group} should admit 3rd-party "${cat}"`).toBe(true);
            }
        }
    });

    it('the live Pole Heads / Bollards choices gate an outdoor-pole spec', () => {
        expect(categoriesCompatible('Outdoor Pole', 'Pole Heads')).toBe(true);
        expect(categoriesCompatible('Outdoor Pole', 'Bollards')).toBe(true);
        expect(categoriesCompatible('Outdoor Pole', 'Vanity')).toBe(false);
    });

    it('3rd-party categories are matched against the 3rd-party vocabulary, not Premier\'s', () => {
        // "Recessed Light" / "Exit / Emergency" only exist on the 3rd-party side;
        // matching them against Premier's "Disk Light" / "Exit Sign" rejected the
        // entire resold catalog whenever a spec's category was known.
        expect(thirdPartyCategoriesCompatible('Recessed', 'Recessed Light')).toBe(true);
        expect(thirdPartyCategoriesCompatible('Exit/Emergency', 'Exit / Emergency')).toBe(true);
        expect(thirdPartyCategoriesCompatible('Outdoor', 'Area Light')).toBe(true);
        expect(thirdPartyCategoriesCompatible('Pendant', 'Chandelier')).toBe(true);
        expect(thirdPartyCategoriesCompatible('Vanity', 'Pendant')).toBe(false);
    });

    it('a multi-category cell matches on any of its entries, not on a substring', () => {
        expect(thirdPartyCategoriesCompatible('Pendant', 'Wall Sconce, Chandelier')).toBe(true);
        // "Wall Sconce — Outdoor" must not satisfy a plain indoor Sconce lookup
        // by substring the way the old `cats.includes(...)` check did.
        expect(thirdPartyCategoriesCompatible('Ceiling', 'Wall Sconce — Outdoor')).toBe(false);
    });

    it('CATEGORY_GROUPS stays the Premier view of the taxonomy (identify enum + gates)', () => {
        for (const [group, def] of Object.entries(CATEGORY_TAXONOMY)) {
            expect(CATEGORY_GROUPS[group]).toEqual(def.premier);
        }
    });
});

describe('shared display group', () => {
    it('a catalog category renders under the spec\'s own group when it belongs to it', () => {
        // Wall Mount is legitimately both Sconce and Outdoor; on an outdoor
        // spec the card must read "Outdoor", matching the header.
        expect(groupOfCatalogCategory('Wall Mount', 'Outdoor')).toBe('Outdoor');
        expect(groupOfCatalogCategory('Wall Mount', 'Sconce')).toBe('Sconce');
    });

    it('the Firecrest mismatches now resolve to the spec\'s own label', () => {
        expect(groupOfCatalogCategory('Linear Surface Mount', 'Linear')).toBe('Linear');
        expect(groupOfCatalogCategory('Exit Sign', 'Exit/Emergency')).toBe('Exit/Emergency');
        expect(groupOfCatalogCategory('Disk Light', 'Recessed')).toBe('Recessed');
        expect(groupOfCatalogCategory('Wall Sconce', 'Sconce')).toBe('Sconce');
    });

    it('a category outside the spec\'s group still resolves, so the UI can flag it', () => {
        expect(groupOfCatalogCategory('Vanity', 'Recessed')).toBe('Vanity');
    });

    it('categories outside the taxonomy return null rather than a made-up group', () => {
        expect(groupOfCatalogCategory('Other / Uncategorized', 'Pendant')).toBeNull();
        expect(groupOfCatalogCategory('', 'Pendant')).toBeNull();
    });

    it('resolves multi-category cells entry by entry, preferring the spec group', () => {
        // 3rd-party items link several categories; the gate splits them, so the
        // display must too, or those cards fall back to raw joined text.
        expect(groupOfCatalogCategory('Wall Sconce, Chandelier', 'Pendant')).toBe('Pendant');
        expect(groupOfCatalogCategory('Wall Sconce, Chandelier', 'Sconce')).toBe('Sconce');
        expect(groupOfCatalogCategory('Other / Uncategorized, Recessed Light', 'Recessed')).toBe('Recessed');
        expect(groupOfCatalogCategory('Other / Uncategorized, Specialty Item', 'Recessed')).toBeNull();
    });

    it('recommendations carry the group alongside the specific catalog category', () => {
        const ctx: EngineContext = {
            history: [], fans: [], thirdPartyItems: [],
            premierItems: [
                premier({ id: 'ph', itemId: 'GC-PPH-D25-30K', fixtureCategory: 'Pole Heads', itemDescription: 'LED POLE HEAD', timesUsed: 40 }),
            ],
        };
        const r = analyzeLineItem(line("OP1A - 20' POLE", 'WE-EF', '693-1234-3X3-9004 POLE'), ctx);
        const top = r.recommendations[0];
        expect(top?.productCategory).toBe('Pole Heads');
        expect(top?.categoryGroup).toBe(r.specCategory);
    });
});

// ── 3: digit-free catalog numbers are identities, category words are not ─────

describe('identifiable spec keys', () => {
    it('accepts digit-free manufacturer model names', () => {
        // Every one of these is a real spec off the Firecrest sheet whose exact
        // history precedent displayed the 45% generic cap.
        for (const spec of ['LUMENPAD', 'FMVCSL', 'AXCENT', 'LUMIERE 1003', 'FARO MUD IN']) {
            expect(isIdentifiableSpecKey(spec), `${spec} should read as product identity`).toBe(true);
        }
    });

    it('keeps the 6-character identity floor', () => {
        // Below 6 normalized characters nothing can form an exact-history match
        // anyway (the lookup keys enforce the same floor), so short specs like
        // "SWLED" / "GRAD" stay non-identifiable rather than minting precedents.
        expect(isIdentifiableSpecKey('SWLED')).toBe(false);
        expect(isIdentifiableSpecKey('GRAD')).toBe(false);
    });

    it('still rejects category vocabulary and placeholders', () => {
        for (const spec of ['NO SPEC', 'DOWNLIGHT', 'WALL PACK', 'EXIT SIGN', 'LED FIXTURE', 'CEILING FAN', 'TBD']) {
            expect(isIdentifiableSpecKey(spec), `${spec} is vocabulary, not identity`).toBe(false);
        }
    });

    it('still rejects descriptive prose', () => {
        expect(isIdentifiableSpecKey('ROUND CONCRETE TIER MINI PENDANT WIDE')).toBe(false);
    });

    it('an exact-history precedent on a digit-free spec is no longer capped at 45%', () => {
        const ctx: EngineContext = {
            history: [
                {
                    id: 'h1', mark: 'R1', bidItem: 'R-SLIM-DISK-12W-5CCT-MULTIDIM-WH', originalSpec: 'LUMENPAD',
                    project: 'Firecrest Ridge', bidDate: '2026-06-01', specManufacturer: '', bidManufacturer: '',
                    specMfrBackup: 'LITON', bidMfrBackup: 'GLOBAL CONCEPTS', matchType: 'EXACT',
                    productCategory: 'Disk Light', specDescription: '', specVendor: '', specEnrichConfidence: '',
                    premierLinkIds: ['p-disk'], thirdPartyLinkIds: [],
                },
            ],
            fans: [], thirdPartyItems: [],
            premierItems: [
                premier({ id: 'p-disk', itemId: 'R-SLIM-DISK-12W-5CCT-MULTIDIM-WH', fixtureCategory: 'Disk Light', itemDescription: '7" SLIM DISK 12W', timesUsed: 30 }),
            ],
        };
        const r = analyzeLineItem(line('R1', 'LITON', 'LUMENPAD'), { ...ctx, referenceDate: '2026-08-10' });
        const top = r.recommendations[0];
        expect(top?.bidItem).toBe('R-SLIM-DISK-12W-5CCT-MULTIDIM-WH');
        expect(top?.confidence).toBeGreaterThan(45);
        expect((top?.matchDetails ?? []).join(' ')).not.toContain('generic description');
    });
});

// ── Pre-check discipline: evidence, not string resemblance ───────────────────

describe('auto-select discipline on the direct catalog tiers', () => {
    const ctx: EngineContext = {
        history: [], fans: [], thirdPartyItems: [],
        premierItems: [
            premier({ id: 'emg', itemId: 'R-SLIM-DISK-7"-EMG', fixtureCategory: 'Disk Light', itemDescription: '7" SLIM DISK EMERGENCY', timesUsed: 12 }),
        ],
    };

    it('a partial item-# resemblance is offered but never pre-checked', () => {
        // Firecrest W2E: a 71% text resemblance arrived pre-selected while a 92%
        // exact-history card and a 99% carry-as-spec card sat unchecked.
        const r = analyzeLineItem(line('W2E', 'LITHONIA', 'WPX1 EMG'), ctx);
        const top = r.recommendations[0];
        expect(top).toBeDefined();
        expect(top!.autoSelectSafe).toBe(false);
        expect(shouldAutoSelect(top)).toBe(false);
        expect(top!.autoSelectReason).toContain('Not pre-checked');
    });

    it('a near-exact item # still pre-checks', () => {
        const r = analyzeLineItem(line('R7', 'ACME', 'R-SLIM-DISK-7-EMG-XYZ'), ctx);
        const top = r.recommendations[0];
        expect(top?.premierItem).toBe('R-SLIM-DISK-7"-EMG');
        expect(top!.autoSelectSafe).toBe(true);
        expect(shouldAutoSelect(top)).toBe(true);
    });
});

describe('default selection', () => {
    const passthrough = { id: 'p', confidence: 99, matchType: 'exact', isPassthrough: true };

    it('selects a passthrough card instead of leaving 99% unchecked next to it', () => {
        // Commercially identical to "Leave as specified" — the export still
        // records no substitution — but it no longer reads as self-contradiction.
        expect(defaultSelection([passthrough])?.id).toBe('p');
        expect(shouldAutoSelect(passthrough)).toBe(false);  // still not a substitution
    });

    it('leaves a weak top card unselected', () => {
        expect(defaultSelection([{ id: 'x', confidence: 33, matchType: 'partial' }])).toBeNull();
        expect(defaultSelection([])).toBeNull();
        expect(defaultSelection(undefined)).toBeNull();
    });
});

// ── 4: identification adds a key, it never swaps one out ─────────────────────

describe('identify keeps the typed spec as the history key', () => {
    const identified = (catalogNumber: string, category: string | null = null): IdentifiedSpec => ({
        manufacturer: 'Lumiere (Cooper Lighting Solutions)',
        catalogNumber,
        productName: 'Lanterra 1003 Sign Light',
        category,
        attributes: {},
        confidence: 'HIGH',
        source: 'url',
        evidence: 'manufacturer page',
    });

    it('a usable typed catalog # survives identification', () => {
        const merged = applyIdentifiedSpec(line('R13', 'LUMIERE 1003', 'LUMIERE 1003'), identified('1003-WH'));
        expect(merged.catalogNumber).toBe('LUMIERE 1003');
        expect(merged.identified?.catalogNumber).toBe('1003-WH');
    });

    it('an empty or URL catalog cell is replaced by the identified number', () => {
        expect(applyIdentifiedSpec(line('R13', 'LUMIERE', ''), identified('1003-WH')).catalogNumber).toBe('1003-WH');
        expect(applyIdentifiedSpec(line('R13', 'LUMIERE', 'https://example.com/x.pdf'), identified('1003-WH')).catalogNumber).toBe('1003-WH');
    });

    it('history filed under the typed spec still matches after identification', () => {
        const ctx: EngineContext = {
            history: [
                {
                    id: 'h1', mark: 'R13', bidItem: 'WS-W230301-30-XX', originalSpec: 'LUMIERE 1003',
                    project: 'Firecrest Ridge', bidDate: '2026-06-01', specManufacturer: '', bidManufacturer: '',
                    specMfrBackup: 'LUMIERE', bidMfrBackup: 'WAC', matchType: 'EXACT',
                    productCategory: '', specDescription: '', specVendor: '', specEnrichConfidence: '',
                    premierLinkIds: [], thirdPartyLinkIds: [],
                },
            ],
            fans: [], thirdPartyItems: [], premierItems: [],
        };
        const merged = applyIdentifiedSpec(line('R13', 'LUMIERE 1003', 'LUMIERE 1003'), identified('1003-WH', 'Outdoor'));
        const r = analyzeLineItem(merged, { ...ctx, referenceDate: '2026-08-10' });
        expect(r.recommendations.map(x => x.bidItem)).toContain('WS-W230301-30-XX');
        expect(r.specCategory).toBe('Outdoor');
    });

    it('an identified spec that IS a Premier item gets the 99% carry-as-spec card', () => {
        // Exact-match on the identified key is skipped as a substitution
        // candidate (rightly — it's the spec); it has to land on the passthrough
        // path instead of falling through to category-level guesses.
        const ctx: EngineContext = {
            history: [], fans: [], thirdPartyItems: [],
            premierItems: [
                premier({ id: 'gc', itemId: 'GC-WM-1003-30K-BZ', fixtureCategory: 'Wall Mount', itemDescription: 'LED WALL MOUNT SIGN LIGHT', timesUsed: 5 }),
            ],
        };
        const r = analyzeLineItem(
            applyIdentifiedSpec(line('R13', 'LUMIERE', 'SIGNLIGHT'), identified('GC-WM-1003-30K-BZ', 'Outdoor')),
            ctx,
        );
        const top = r.recommendations[0];
        expect(top?.isPassthrough).toBe(true);
        expect(top?.confidence).toBe(99);
        expect(top?.matchReason).toContain('Already a Premier');
    });

    it('the identified catalog # adds catalog matches the typed one could not reach', () => {
        const ctx: EngineContext = {
            history: [], fans: [], thirdPartyItems: [],
            premierItems: [
                premier({ id: 'wm', itemId: 'GC-WM-1003-30K-BZ', fixtureCategory: 'Wall Mount', itemDescription: 'LED WALL MOUNT SIGN LIGHT', timesUsed: 5 }),
            ],
        };
        const typedOnly = analyzeLineItem(line('R13', 'LUMIERE', 'SIGNLIGHT'), ctx);
        const withIdent = analyzeLineItem(
            applyIdentifiedSpec(line('R13', 'LUMIERE', 'SIGNLIGHT'), identified('GC-WM-1003-30K-BZ-ALT', 'Outdoor')),
            ctx,
        );
        expect(typedOnly.recommendations.map(x => x.premierItem)).not.toContain('GC-WM-1003-30K-BZ');
        expect(withIdent.recommendations.map(x => x.premierItem)).toContain('GC-WM-1003-30K-BZ');
    });
});
