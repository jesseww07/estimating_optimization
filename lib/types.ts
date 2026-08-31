/**
 * Core domain types for the VE estimating engine.
 *
 * Lifted from the validated Airtable Interface engine (harvest/index.tsx ~138–216),
 * with one structural change for the serverless port: the engine no longer holds live
 * Airtable SDK Record objects. The Airtable adapter (lib/airtable/fetch.ts) emits the
 * plain row shapes below, and everything in lib/** operates on those. No React, no
 * Next.js, no Airtable SDK imports anywhere in this file.
 */

import type { IdentifiedSpec } from './identify/types';

export interface ParsedLineItem {
    rowIndex: number;
    section: string;
    mark: string;
    quantity: string;
    manufacturer: string;
    catalogNumber: string;
    /**
     * The sheet's own prose description of the fixture, when it ships one in a
     * column of its own ("4' LED WRAPAROUND, 4000K", "RECESSED DOWNLIGHT, 6IN").
     *
     * Set only when the description is a SEPARATE column from the catalog number
     * — when a sheet has no catalog column, the description already IS
     * `catalogNumber` and duplicating it here would double-count the same text.
     *
     * Deliberately its own field rather than appended to `catalogNumber`: it is
     * weaker, prose-shaped evidence, and the engine treats it that way (a
     * null-category-only fallback in detectFixtureCategory, never an override).
     * Fixture schedules almost always carry the words that name the fixture
     * type; before this field the parser captured them and the engine dropped
     * them on the floor.
     */
    description?: string;
    rawRow: Record<string, string>;
    /** Spec-sheet URLs found anywhere in the raw row (estimators paste links in stray columns). */
    specUrls?: string[];
    /** Set when the line was identified via URL / web lookup / PDF — provenance for the UI. */
    identified?: IdentifiedSpec;
}

export interface HistoryMatch {
    project: string;
    mark: string;
    originalSpec: string;
    bidItem: string;
    approvalStatus: string;
    bidDate?: string;
    specManufacturer?: string;
    bidManufacturer?: string;
    recordId?: string;
    specDescription?: string;   // from Spec Description field (NS purchaseDescription)
    specVendor?: string;        // from Spec Vendor field
    specEnrichConfidence?: string; // HIGH | MEDIUM | LOW from NS matching
}

export interface ItemAttributes {
    category?: string;
    productCategory?: string;
    finish?: string;
    colorTemp?: string;
    wattage?: string;
    lightOutput?: string;
    manufacturer?: string;
    fanSize?: string;
    bladeCount?: number;
    hasLight?: boolean;
}

export interface Recommendation {
    id: string;
    source: 'History' | 'Premier Items' | '3rd Party' | 'Fans' | 'Manual';
    matchType: 'exact' | 'fuzzy' | 'partial' | 'manual';
    confidence: number;
    bidItem?: string;
    premierItem?: string;
    fanItem?: string;
    /** Airtable record id of the row backing this recommendation (replaces the live SDK Record). */
    recordId?: string;
    matchReason: string;
    isManualEntry?: boolean;
    manualItemName?: string;
    manualItemId?: string;
    manualItemNotes?: string;
    historyMatches?: HistoryMatch[];
    swapCount?: number;
    itemAttributes?: ItemAttributes;
    matchDetails?: string[];
    specManufacturer?: string;
    bidManufacturer?: string;
    exactMatchCount?: number;
    totalSpecAppearances?: number;
    projectsUsed?: string[];
    productCategory?: string;
    /**
     * The shared display GROUP the card's catalog category belongs to
     * ("Outdoor" for a Wall Mount on an outdoor spec). The spec header and every
     * card render this same vocabulary so a passing category gate reads as a
     * match instead of a mismatch; productCategory keeps the specific catalog
     * name for the detail line. null = outside the taxonomy.
     */
    categoryGroup?: string | null;
    specProductCategory?: string;
    specDescription?: string;      // enriched NS product description for the original spec
    specVendor?: string;           // enriched NS vendor for the original spec
    specEnrichConfidence?: string; // HIGH | MEDIUM | LOW
    matchedOriginalSpec?: string;  // the actual Original Spec value from history that triggered this match
    catalogSource?: 'premier' | 'third_party'; // which catalog the linked item came from (undefined for non-history-sourced recs)
    /** Premier Items record id backing this rec — carried through export for the History write-back link. */
    premierLinkId?: string;
    /** 3rd Party Domestic Items record id backing this rec — same role as premierLinkId. */
    thirdPartyLinkId?: string;
    /** True when this is a "leave as spec" passthrough card, not a substitution. */
    isPassthrough?: boolean;
    /**
     * True when this History recommendation rides FAMILY evidence (same product
     * series, different options) rather than exact-spec swaps. Family matches
     * are sub-authoritative: they never take the History-first ranking trump,
     * never reach the 95% authoritative floor, and don't suppress the direct
     * matching tiers.
     */
    familyMatch?: boolean;
    /**
     * Explicit auto-select eligibility, set by tiers whose DISPLAYED confidence
     * is calibrated to real-world precision rather than to the pre-check bar.
     * `false` blocks the UI pre-check regardless of confidence (the card stays
     * one click away); undefined defers to the confidence/matchType gate.
     * Exact-history recs set this from raw evidence mass so that honest
     * confidence display (60–90%) doesn't silently widen auto-select.
     */
    autoSelectSafe?: boolean;
    /**
     * Plain-language reason this card was NOT pre-checked, shown in the UI when
     * the top card sits unselected. "A 99% card left unchecked while a 71% one
     * is selected" is only confusing while the rule is invisible.
     */
    autoSelectReason?: string;
    /**
     * Hard ceiling the confidence must never exceed, ranking bonuses included
     * (e.g. the generic-spec 45% cap). Undefined = the tier's default ceiling.
     */
    confidenceCap?: number;
}

export interface LineItemWithRecommendations {
    lineItem: ParsedLineItem;
    recommendations: Recommendation[];
    selectedRecommendation: Recommendation | null;
    /** Informational message when recommendations are intentionally empty (e.g. LED tape suppression). */
    infoMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plain row shapes emitted by the Airtable adapter — the engine's data context.
// Field-by-field these mirror what the Interface engine read live via
// getCellValueAsString; keeping them as plain strings preserves scoring parity.
// ─────────────────────────────────────────────────────────────────────────────

export interface HistoryRow {
    id: string;
    mark: string;
    bidItem: string;
    originalSpec: string;
    project: string;
    bidDate: string;              // ISO date string or '' — feeds recency weighting
    specManufacturer: string;     // linked-record display value
    bidManufacturer: string;      // linked-record display value
    specMfrBackup: string;        // "Spec Manufacturer (text)" fallback
    bidMfrBackup: string;         // "Bid Manufacturer (text)" fallback
    matchType: string;            // EXACT / NON-ITEM / UNMAPPED
    productCategory: string;
    specDescription: string;
    specVendor: string;
    specEnrichConfidence: string; // HIGH | MEDIUM | LOW | ''
    premierLinkIds: string[];     // linked Premier Items record ids (NetSuite ID link)
    thirdPartyLinkIds: string[];  // linked 3rd Party Domestic Items record ids
}

export interface PremierItemRow {
    id: string;
    itemId: string;
    fixtureCategory: string;
    itemDescription: string;
    style: string;
    finish: string;
    colorTemp: string;
    maxWattage: string;
    lightOutput: string;
    timesUsed: number;
}

export interface ThirdPartyItemRow {
    id: string;
    itemId: string;
    itemDescription: string;
    manufacturer: string;
    finish: string;
    colorTemp: string;
    maxWattage: string;
    lightOutput: string;
    productCategories: string;    // display string of the linked Product Categories
}

export interface FanRow {
    id: string;
    itemNumber: string;
    fanSize: string;
    bladeCount: number | null;
    light: string;                // 'Yes' | 'No' | ''
    housingFinish: string;
    bladeFinish: string;
}

/** The data context the engine scores against — History + the three catalogs. */
export interface EngineContext {
    history: HistoryRow[];
    premierItems: PremierItemRow[];
    thirdPartyItems: ThirdPartyItemRow[];
    fans: FanRow[];
    /** Reference date for recency weighting; defaults to "now". Injectable for tests. */
    referenceDate?: string;
}
