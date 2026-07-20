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
