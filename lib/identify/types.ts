/**
 * Identification domain types — Phase 2.
 *
 * An IdentifiedSpec is what the Claude identification engine returns for a bid
 * line the sheet alone couldn't identify (URL fetch, web lookup, or spec-sheet
 * PDF). It is deliberately plain data: no SDK imports, no server imports, so
 * both the engine (lib/**) and the client UI can type against it.
 */

export type IdentifyConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type IdentifySource = 'url' | 'web' | 'pdf';

export interface IdentifiedSpecAttributes {
    finish?: string;
    colorTemp?: string;
    wattage?: string;
    lumens?: string;
    dimensions?: string;
    voltage?: string;
    mounting?: string;
}

export interface IdentifiedSpec {
    manufacturer: string;
    catalogNumber: string;
    productName: string;
    /**
     * Fixture category mapped onto the engine's detector labels (the keys of
     * CATEGORY_GROUPS in lib/engine/matcher.ts), or null when the model could
     * not place the product in that vocabulary. A valid label plugs straight
     * into the existing category gates and the in-category fallback.
     */
    category: string | null;
    attributes: IdentifiedSpecAttributes;
    confidence: IdentifyConfidence;
    source: IdentifySource;
    /** What the identification is based on — for 'web', must cite the page used. */
    evidence: string;
}
