/**
 * Ranking, dedupe, and validity filtering for VE recommendations.
 * Ported from harvest/index.tsx (~815–895 and ~1941–1985). No React, no Airtable, no Next.
 */

import type { ItemAttributes, Recommendation } from '../types';
import { isUrlLike, normalizeProductId } from './matcher';

// --- VE Priority Hierarchy ---
// Premier Lighting's own brands should always rank above third-party alternatives.
// "Our Products" includes all of the following — they are operationally equivalent
// and should be treated identically for scoring purposes:
//
//   Global Concepts  — item IDs starting with GC (various punctuation / casing)
//   Lucius Lighting  — brand name used on documentation; items start with LUC or LUCIUS
//   PL-series items  — PL followed by numbers or hyphens
//   CUSTGC           — custom Global Concepts variants
//   MIR / GCL / MDL / PKL / FRIS / HW — additional Premier private-label series
//
// None of these are third-party alternatives. SATCO, Westgate, and similar are
// the actual third-party alternatives that do NOT receive this bonus.
//
// Note: all patterns are tested against the uppercased item ID to normalize
// inconsistent capitalization from manually-created bid sheets.
export function isPremierOwnBrand(rec: Pick<Recommendation, 'premierItem' | 'bidItem'>): boolean {
    const id = (rec.premierItem || rec.bidItem || '').toUpperCase().trim();
    return (
        // Global Concepts — GC followed by dash, digit, underscore, space, or nothing
        /^GC[-_\s]/.test(id) ||
        /^GC\d/.test(id) ||
        id === 'GC' ||
        // Custom GC variants
        id.startsWith('CUSTGC') ||
        // Lucius Lighting — LUC or LUCIUS prefix
        id.startsWith('LUC') ||
        // PL-series — PL followed by digit or hyphen
        /^PL[-\d]/.test(id) ||
        // Remaining Premier private-label series
        /^GCL[-_\d]/.test(id) ||
        /^MIR[-_\d]/.test(id) ||
        /^MDL[-_\d]/.test(id) ||
        /^PKL[-_\d]/.test(id) ||
        /^FRIS[-_\d]?/.test(id) ||
        /^HW[-_\d]/.test(id)
    );
}

/** Confidence bonus applied to own-brand recommendations before ranking. */
export const OWN_BRAND_BONUS = 15;

// ── Auto-select gate (Collective MedSpa review, 2026-07-28) ──────────────────
// The UI pre-checks the top recommendation. Pre-checking a 30% category guess
// makes it exportable — and export writes History, which feeds recency
// weighting and (after 3 exports) the authoritative tier: a self-reinforcing
// loop for a guess nobody endorsed. Only pre-check candidates with real
// evidence; everything else defaults to "Leave as specified" and stays one
// click away.

/** Minimum confidence for the UI to pre-check a recommendation. */
export const MIN_AUTOSELECT_CONFIDENCE = 50;

/**
 * True when a recommendation is strong enough to be the default selection:
 * confident AND better-than-'partial' evidence (category fallbacks are
 * hard-coded 'partial' — never a default, whatever their score).
 */
export function shouldAutoSelect(rec: { confidence: number; matchType: string; isPassthrough?: boolean } | undefined | null): boolean {
    if (!rec || rec.isPassthrough) return false;
    if (rec.matchType === 'partial') return false;
    return rec.confidence >= MIN_AUTOSELECT_CONFIDENCE;
}

/**
 * Ranking comparator: History always beats Premier Items / Fans; within the same
 * source tier, higher confidence first (own-brand bonus already baked in), with
 * the most recent matching swap date breaking History ties (recency weighting).
 */
export function compareRecommendations(a: Recommendation, b: Recommendation): number {
    if (a.source === 'History' && b.source !== 'History') return -1;
    if (a.source !== 'History' && b.source === 'History') return 1;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return mostRecentSwapTime(b) - mostRecentSwapTime(a);
}

function mostRecentSwapTime(rec: Recommendation): number {
    if (!rec.historyMatches || rec.historyMatches.length === 0) return 0;
    let latest = 0;
    for (const h of rec.historyMatches) {
        if (!h.bidDate) continue;
        const t = Date.parse(h.bidDate);
        if (!Number.isNaN(t) && t > latest) latest = t;
    }
    return latest;
}

// ── Recency weighting (must-survive: recency-weight) ─────────────────────────

/**
 * Weight a matching swap by how recently it was bid, relative to a reference
 * date. Recent swaps carry full weight; stale ones decay, so a single recent
 * high-quality swap can outrank many older swaps to a different item.
 * Undated swaps get a middle weight rather than being thrown away.
 */
export function recencyWeight(bidDate: string | undefined, referenceDate?: string): number {
    if (!bidDate) return 0.5;
    const t = Date.parse(bidDate);
    if (Number.isNaN(t)) return 0.5;
    const ref = referenceDate ? Date.parse(referenceDate) : Date.now();
    const ageDays = (ref - t) / 86_400_000;
    if (ageDays <= 365) return 1.0;
    if (ageDays <= 730) return 0.7;
    if (ageDays <= 1095) return 0.45;
    return 0.25;
}

// ── Invalid-recommendation filtering (harvest ~846) ──────────────────────────

export function isInvalidRecommendation(itemValue: string): boolean {
    if (!itemValue || itemValue.trim().length < 3) return true;
    // A URL is never a product (invalid-rec-filter / URL-as-catalog protection)
    if (isUrlLike(itemValue)) return true;
    // Filter out code/logic fragments that should never appear as recommendations
    if (/^if\s+(it|this|the)/i.test(itemValue.trim())) return true;
    if (/function|return|const|let|var|=>|===|\?\s*:/i.test(itemValue)) return true;
    // Filter out obviously non-product strings
    if (/^(true|false|null|undefined|NaN)$/i.test(itemValue.trim())) return true;
    return false;
}

// ── Dedupe (harvest ~820–895) ─────────────────────────────────────────────────

export function areProductsSimilar(item1: string, item2: string, attrs1?: ItemAttributes, attrs2?: ItemAttributes): boolean {
    const norm1 = normalizeProductId(item1);
    const norm2 = normalizeProductId(item2);

    if (norm1 === norm2) return true;
    if (norm1.includes(norm2) && norm2.length >= 6) return true;
    if (norm2.includes(norm1) && norm1.length >= 6) return true;

    if (attrs1 && attrs2) {
        const categoryMatch = attrs1.category && attrs2.category &&
            attrs1.category.toLowerCase() === attrs2.category.toLowerCase();
        const finishMatch = attrs1.finish && attrs2.finish &&
            attrs1.finish.toLowerCase() === attrs2.finish.toLowerCase();
        const wattageMatch = attrs1.wattage && attrs2.wattage &&
            attrs1.wattage === attrs2.wattage;
        const colorTempMatch = attrs1.colorTemp && attrs2.colorTemp &&
            attrs1.colorTemp === attrs2.colorTemp;

        if (categoryMatch && finishMatch && wattageMatch && colorTempMatch) {
            return true;
        }
    }

    return false;
}

export function deduplicateRecommendations(recommendations: Recommendation[], originalCatalog: string): Recommendation[] {
    const result: Recommendation[] = [];
    const seenItems = new Set<string>();

    for (const rec of recommendations) {
        const itemId = rec.bidItem || rec.premierItem || rec.fanItem || '';

        // Passthrough cards intentionally carry the original spec — exempt from
        // the "don't recommend the input back" rules below.
        if (rec.isPassthrough) {
            result.push(rec);
            continue;
        }

        // Skip invalid recommendations (code fragments, URLs, garbage text, etc.)
        if (isInvalidRecommendation(itemId)) {
            continue;
        }

        const normalizedId = normalizeProductId(itemId);
        const normalizedOriginal = normalizeProductId(originalCatalog);

        if (normalizedId === normalizedOriginal && normalizedId.length >= 6) {
            continue;
        }

        if (normalizedOriginal && normalizedId.includes(normalizedOriginal) && normalizedOriginal.length >= 8) {
            continue;
        }

        let isDuplicate = false;
        for (const existing of result) {
            const existingId = existing.bidItem || existing.premierItem || existing.fanItem || '';
            if (areProductsSimilar(itemId, existingId, rec.itemAttributes, existing.itemAttributes)) {
                isDuplicate = true;
                break;
            }
        }

        if (!isDuplicate && !seenItems.has(normalizedId)) {
            seenItems.add(normalizedId);
            result.push(rec);
        }
    }

    return result;
}
