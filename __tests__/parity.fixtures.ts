/**
 * Parity fixtures for the VE engine port.
 *
 * PURPOSE: guard the recommendation rules that are easiest for a generic rewrite to
 * silently drop. Each case targets ONE rule.
 *
 * Cases marked `ready: true` carry REAL values frozen from the live Airtable base
 * (appWj912AEOvtxqJF) on 2026-07-19 — the matching rows live in parity.context.json.
 * Cases still holding `FILL(...)` placeholders are SKIPPED by the runner, so an
 * unfilled case reports "skipped", never a false "pass".
 *
 * Still unfilled (need data not yet frozen):
 *   - premier-own-brand-rank  (needs a spec matched by both an own-brand and a 3rd-party alt)
 *   - satco-bulb-exclude      (needs a SATCO S-series lamp row in the frozen context)
 *   - recency-weight          (the authoritative dataset has EMPTY Bid Dates — needs dated rows)
 *   - decorative-not-suppressed (needs a decorative spec with a Premier equivalent in context)
 */

import type { ParsedLineItem } from '@/lib/types';

/**
 * Documents an unfilled value and registers string placeholders so the runner can flag a
 * case that was marked `ready: true` while still holding an example value.
 */
export const PLACEHOLDERS = new Set<string>();
export const FILL = <T>(_hint: string, placeholder: T): T => {
    if (typeof placeholder === 'string') PLACEHOLDERS.add(placeholder);
    return placeholder;
};

export interface ExpectSpec {
    /** The premierItem the TOP recommendation should carry. */
    topPremierItem?: string;
    /** Minimum confidence the top recommendation must meet (e.g. 95 for authoritative tier). */
    minConfidence?: number;
    /** matchType the top recommendation must have. */
    topMatchType?: 'exact' | 'fuzzy' | 'partial' | 'manual';
    /** source the top recommendation must have. */
    topSource?: 'History' | 'Premier Items' | 'Fans' | 'Manual';
    /** These premierItem values MUST appear somewhere in recommendations. */
    mustInclude?: string[];
    /** These premierItem values MUST NOT appear (e.g. dimensionally incompatible, SATCO bulb). */
    mustNotInclude?: string[];
    /** premierItem `a` must rank strictly above premierItem `b`. */
    mustRankAbove?: [string, string];
    /** Recommendations array must be empty (e.g. LED tape suppressed). */
    expectNoRecommendations?: boolean;
    /** Top recommendation's matchReason (case-insensitive substring). */
    matchReasonContains?: string;
    /** Top recommendation's swapCount must be >= this. */
    swapCountAtLeast?: number;
    /** Top recommendation's exactMatchCount must be >= this (authoritative tier). */
    exactMatchCountAtLeast?: number;
}

export interface ParityCase {
    id: string;
    rule: string;              // the behavior this case guards
    sourceBid: string;         // where to pull the real values from
    ready: boolean;            // false => skipped by the runner
    input: ParsedLineItem;
    expect: ExpectSpec;
    bindNote?: string;         // extra guidance when the assertion field is port-dependent
}

const row = (o: Record<string, string>): Record<string, string> => o;

export const PARITY_CASES: ParityCase[] = [
    {
        id: 'authoritative-tier',
        rule: 'A spec swapped 3+ times historically returns that Premier item at 95% with an exact/authoritative label',
        sourceBid: 'Crescent Render Norterra / Flourney Research Park — Beghelli exit sign swapped 7x to GCEXITEM-G2',
        ready: true,
        input: {
            rowIndex: 12,
            section: 'Building',
            mark: 'X-D',
            quantity: '10',
            manufacturer: 'Beghelli',
            catalogNumber: 'VA4-R-SA-AT',
            rawRow: row({}),
        },
        expect: {
            topPremierItem: 'GCEXITEM-G2',
            minConfidence: 95,
            topMatchType: 'exact',
            exactMatchCountAtLeast: 3,
            matchReasonContains: 'Bid',
        },
    },
    {
        id: 'dimension-hard-gate',
        rule: 'A candidate matching on category/brand but dimensionally incompatible must be blocked',
        sourceBid: 'Premier catalog family GC-REC-{4|6}-DL-MX32W-POWER (both "Disk Light") — 6" spec must gate out the 4" sibling',
        ready: true,
        input: {
            rowIndex: 20,
            section: 'Units',
            mark: 'A6',
            quantity: '30',
            manufacturer: 'Global Concepts',
            catalogNumber: 'GC-REC-6-DL-MX32W-30K',
            rawRow: row({}),
        },
        expect: {
            mustNotInclude: ['GC-REC-4-DL-MX32W-POWER'],
            mustInclude: ['GC-REC-6-DL-MX32W-POWER'],
        },
        bindNote: 'The gate drops the wrong-size item entirely (pre-scoring), so mustNotInclude is the right assertion.',
    },
    {
        id: 'premier-own-brand-rank',
        rule: 'When a Premier own-brand (GC/LUC/PL/MIR/GCL/MDL/PKL/FRIS/HW) and an equivalent third-party both qualify, own-brand ranks first',
        sourceBid: 'firecrest — a spec where both an own-brand and a SATCO/Westgate alt match',
        ready: false,
        input: {
            rowIndex: FILL('#', 33),
            section: FILL('section', '26 51 00'),
            mark: FILL('mark', 'W1'),
            quantity: FILL('qty', '15'),
            manufacturer: FILL('mfr', 'Lithonia'),
            catalogNumber: FILL('wrap/strip spec', 'FMLWL-48-840'),
            rawRow: row({}),
        },
        expect: {
            mustRankAbove: [
                FILL('own-brand SKU (should win)', 'GC-WRAP48-40K'),
                FILL('third-party alt SKU', 'WG-WRAP-48'),
            ],
        },
    },
    {
        id: 'led-tape-suppress',
        rule: 'LED tape is suppressed with an informational message, NOT given swap recommendations',
        sourceBid: 'constructed from a representative Diode LED tape SKU — detection is input-only',
        ready: true,
        input: {
            rowIndex: 41,
            section: 'Units',
            mark: 'TAPE1',
            quantity: '200',
            manufacturer: 'Diode LED',
            catalogNumber: 'DI-24V-BLBSC1-30-100',
            rawRow: row({}),
        },
        expect: {
            expectNoRecommendations: true,
        },
        bindNote: 'The port signals "suppressed but informational" as empty recommendations plus LineItemAnalysis.infoMessage (asserted separately in the runner).',
    },
    {
        id: 'passthrough-badge',
        rule: 'High-end decorative / must-stay-as-spec items are surfaced with a passthrough badge, not dropped and not given a bogus swap',
        sourceBid: 'constructed from a representative Hubbardton Forge SKU — passthrough keys on the recognized decorative manufacturer',
        ready: true,
        input: {
            rowIndex: 7,
            section: 'Lobby',
            mark: 'C1',
            quantity: '2',
            manufacturer: 'Hubbardton Forge',
            catalogNumber: '139570-SKT-20-GG0048',
            rawRow: row({}),
        },
        expect: {
            matchReasonContains: 'as-spec',
        },
        bindNote: 'The "↻ Left as-spec" badge rides matchReason; the rec also carries isPassthrough: true.',
    },
    {
        id: 'satco-bulb-exclude',
        rule: 'SATCO is excluded as a bulb/lamp recommendation per rule',
        sourceBid: 'any bid — a lamp/bulb line where SATCO would otherwise match',
        ready: false,
        input: {
            rowIndex: FILL('#', 55),
            section: FILL('section', '26 51 00'),
            mark: FILL('mark', 'LAMP1'),
            quantity: FILL('qty', '100'),
            manufacturer: FILL('mfr', 'Philips'),
            catalogNumber: FILL('A19 lamp spec', '9A19-LED-2700K'),
            rawRow: row({}),
        },
        expect: {
            mustNotInclude: [FILL('the SATCO SKU that must be excluded', 'SATCO-S11-A19')],
        },
    },
    {
        id: 'recency-weight',
        rule: 'A single recent high-quality swap outranks many older swaps to a different item',
        sourceBid: 'needs a spec with DATED history rows — the frozen authoritative dataset has empty Bid Dates',
        ready: false,
        input: {
            rowIndex: FILL('#', 61),
            section: FILL('section', '26 51 00'),
            mark: FILL('mark', 'V1'),
            quantity: FILL('qty', '8'),
            manufacturer: FILL('mfr', 'Kichler'),
            catalogNumber: FILL('vanity spec', '37502-24'),
            rawRow: row({}),
        },
        expect: {
            topPremierItem: FILL('the RECENT swap target (should win)', 'GC-VAN24-30K'),
            mustRankAbove: [
                FILL('recent target', 'GC-VAN24-30K'),
                FILL('older, more-frequent target', 'GC-VAN24-OLD'),
            ],
        },
        bindNote: 'Port behavior to calibrate when filled: swaps are recency-weighted (1.0/0.7/0.45/0.25 by age year) before the ×20 confidence step, and ties break on most-recent swap date. NOTE: a 3+ swap older target still hits the authoritative floor — pick an older target with exactly 2 swaps.',
    },
    {
        id: 'normalized-history-match',
        rule: 'History lookup keyed by NORMALIZED Original Spec still matches despite whitespace/case/punct variance',
        sourceBid: 'same Beghelli spec as authoritative-tier, formatting mangled',
        ready: true,
        input: {
            rowIndex: 12,
            section: 'Building',
            mark: 'X-D',
            quantity: '10',
            manufacturer: 'beghelli',
            catalogNumber: '  va4-R-sa-aT ',
            rawRow: row({}),
        },
        expect: {
            topPremierItem: 'GCEXITEM-G2',
            minConfidence: 95,
        },
    },
    {
        id: 'decorative-not-suppressed',
        rule: 'Decorative fixtures (vanity/sconce/pendant) still receive recommendations — not tier-suppressed',
        sourceBid: 'diamond view — a mid-range sconce that HAS a valid Premier equivalent',
        ready: false,
        input: {
            rowIndex: FILL('#', 15),
            section: FILL('section', '26 51 00'),
            mark: FILL('mark', 'S1'),
            quantity: FILL('qty', '12'),
            manufacturer: FILL('mfr', 'Progress'),
            catalogNumber: FILL('sconce spec', 'P710012-030'),
            rawRow: row({}),
        },
        expect: {
            mustInclude: [FILL('expected Premier sconce SKU', 'GC-SCONCE-30K')],
        },
        bindNote: 'The point is a NON-empty recommendations list for a decorative item — proves fixture-category detection did not suppress it.',
    },
    {
        id: 'invalid-rec-filter',
        rule: 'A URL / junk value in the catalog field never becomes a recommendation (URL-as-catalog protection)',
        sourceBid: 'constructed directly — catalogNumber set to a URL',
        ready: true,
        input: {
            rowIndex: 99,
            section: 'Units',
            mark: 'X1',
            quantity: '1',
            manufacturer: '',
            catalogNumber: 'https://www.example.com/product/spec-sheet.pdf',
            rawRow: row({}),
        },
        expect: {
            // Must not fabricate a rec from the URL. Either no recs, or no rec whose id/text is the URL.
            expectNoRecommendations: true,
        },
        bindNote: 'The engine blanks a URL catalog before matching; with no other signal the result is empty.',
    },
];
