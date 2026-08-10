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
//   R- / REC- / COM- / TJ — Premier recessed & disk-light systems (R-SLIM-DISK,
//                           REC-TJ, TJRECFRAME; per the Phase 3 primer's catalog
//                           domain facts — previously missing here, which let a
//                           GC disk light outrank the R-SLIM family Largo
//                           actually bid for the S7R spec)
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
        /^HW[-_\d]/.test(id) ||
        // Premier recessed / disk-light systems (R-SLIM-DISK, REC-TJ, COM-,
        // TJRECFRAME). Dash-anchored so RAB-style third-party ids (R4…, RD6…)
        // never collect the bonus.
        /^R-/.test(id) ||
        /^REC-/.test(id) ||
        /^COM-/.test(id) ||
        /^TJ[A-Z\d-]/.test(id)
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
 *
 * FAMILY history matches never auto-select (Phase 4): they identify the right
 * product FAMILY reliably, but pick the exact VARIANT at only ~36% precision
 * (measured 2026-08-03 across the eval corpus — single-project family evidence
 * lands at 17%, cross-project at 68%). A default selection writes History on
 * export, so a family card stays one click away until attribute agreement
 * (Phase 4 backlog #3) can disambiguate variants and earn the pre-check.
 */
export function shouldAutoSelect(rec: { confidence: number; matchType: string; isPassthrough?: boolean; familyMatch?: boolean; autoSelectSafe?: boolean } | undefined | null): boolean {
    if (!rec || rec.isPassthrough) return false;
    if (rec.matchType === 'partial') return false;
    if (rec.familyMatch) return false;
    // A tier can veto the pre-check outright (autoSelectSafe: false) when its
    // displayed confidence is calibrated to precision, not to this bar —
    // raising a card's honest percentage must never widen auto-select.
    if (rec.autoSelectSafe === false) return false;
    return rec.confidence >= MIN_AUTOSELECT_CONFIDENCE;
}

/**
 * The card the UI should have selected when results first render, or null for
 * "Leave as specified".
 *
 * Distinct from shouldAutoSelect on purpose: a PASSTHROUGH card ("already a
 * resold 3rd-party item", "high-end decorative — quote as specified") *is* the
 * leave-as-specified answer, so selecting it changes nothing commercially — the
 * export still records no substitution and History still gets no row. Leaving
 * it unselected, however, put a 99% card next to an unchecked radio and a
 * checked "Leave as specified" underneath, which read as the engine disagreeing
 * with itself (Firecrest review, 2026-08-10). shouldAutoSelect keeps its
 * narrower meaning — "pre-check this SUBSTITUTION" — because the eval's
 * autoWrong quadrant is calibrated against it.
 */
export function defaultSelection<T extends { id: string; confidence: number; matchType: string; isPassthrough?: boolean; familyMatch?: boolean; autoSelectSafe?: boolean }>(
    recommendations: T[] | undefined | null,
): T | null {
    const top = recommendations?.[0];
    if (!top) return null;
    if (top.isPassthrough) return top;
    return shouldAutoSelect(top) ? top : null;
}

/**
 * Ranking comparator: exact-spec History always beats Premier Items / Fans;
 * within the same tier, higher confidence first (own-brand bonus already baked
 * in), with the most recent matching swap date breaking History ties (recency
 * weighting). FAMILY history matches (same series, different options — Phase 4)
 * deliberately do NOT take the History trump: their evidence is sub-
 * authoritative, so they compete with the direct tiers on confidence alone.
 */
export function compareRecommendations(a: Recommendation, b: Recommendation): number {
    const aExactHistory = a.source === 'History' && !a.familyMatch;
    const bExactHistory = b.source === 'History' && !b.familyMatch;
    if (aExactHistory && !bExactHistory) return -1;
    if (!aExactHistory && bExactHistory) return 1;
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
