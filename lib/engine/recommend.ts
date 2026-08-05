/**
 * VE recommendation orchestration — the function the /api/recommendations route
 * (and the parity runner) calls.
 *
 * Ported from harvest/index.tsx generateRecommendations (~1281–1986), rewritten to
 * operate on the plain EngineContext rows the Airtable adapter emits instead of live
 * SDK Records. Scoring, thresholds, and ordering are preserved 1:1 except where the
 * v3 handoff's must-survive list adds behavior the harvest snapshot lacked:
 *
 *   1. Authoritative tier — 3+ true matching swaps floor the confidence at 95%,
 *      matchType 'exact', matchReason "✓ Bid N times".
 *   2. Recency weighting — matching swaps are weighted by bid-date age (recent = 1.0
 *      decaying to 0.25), so a recent swap outranks stale ones; recency also breaks
 *      confidence ties in ranking.
 *   3. Dimension hard-gate — catalog-derived candidates (Premier direct, Fans, prose
 *      fallback) and sub-authoritative history matches are BLOCKED when dimensionally
 *      incompatible with the spec. Authoritative history evidence (3+ real estimator
 *      decisions) deliberately beats the dimension heuristic.
 *   4. LED-tape suppression — tape lines return no recommendations plus an
 *      informational message.
 *   5. Passthrough badge — recognized high-end decorative specs with no match are
 *      surfaced "↻ Left as-spec" instead of dropped.
 */

import type {
    EngineContext,
    HistoryMatch,
    HistoryRow,
    ItemAttributes,
    ParsedLineItem,
    Recommendation,
} from '../types';
import {
    CATEGORY_GROUPS,
    calculateCatalogMatchScore,
    calculateMatchScore,
    categoriesCompatible,
    detectFixtureCategory,
    dimensionsCompatible,
    extractLampAttributes,
    fanSpansCompatible,
    isAccessoryItem,
    isBulbLampLine,
    explainCatalogMatchScore,
    isFamilySpecMatch,
    isIdentifiableSpecKey,
    isLedTape,
    isRfiPlaceholder,
    isSatcoLampNumber,
    isUrlLike,
    looksLikeProse,
    normalizeProductId,
    normalizeSpecKey,
    specWantsAccessory,
    thirdPartyCategoriesCompatible,
} from './matcher';
import {
    MIN_AUTOSELECT_CONFIDENCE,
    OWN_BRAND_BONUS,
    compareRecommendations,
    deduplicateRecommendations,
    isPremierOwnBrand,
    recencyWeight,
} from './ranking';

export interface LineItemAnalysis {
    lineItem: ParsedLineItem;
    recommendations: Recommendation[];
    /**
     * Informational banner for the line (LED tape suppression, RFI notice).
     * May coexist with recommendations: an RFI line whose text names a fixture
     * category carries the notice plus category-level suggestions.
     */
    infoMessage?: string;
    /**
     * The fixture category the engine inferred for the SPEC line itself
     * (identify-flow category, learned series, or the text detector) — shown in
     * the UI header so the estimator can see what the engine thinks the item IS
     * and judge recommendations against it. null = category unknown.
     */
    specCategory?: string | null;
}

/** Number of true matching swaps at which a history match becomes authoritative. */
const AUTHORITATIVE_SWAP_COUNT = 3;
/** Confidence floor for authoritative matches. */
const AUTHORITATIVE_CONFIDENCE = 95;

// Exact-history confidence shape (2026-08-05 rework, from Jesse's Excel-listing
// review: a 2-swap exact precedent displayed 35% while a family card next to it
// showed 48% — the old weightedSwaps*20 curve punished exactly the evidence the
// system exists to learn from). Confidence now rides two honest factors:
//
//   agreement — of all history rows carrying this exact spec, what share chose
//               THIS item? (2 of 2 → 100%; 1 of 3 → competition/as-spec rows
//               pull it down)
//   recency   — weighted swap mass, saturating: w/(w+0.6), so one recent swap
//               ≈ 0.63, two ≈ 0.77, three ≈ 0.83
//
//   confidence = 45 + 50 × agreement × recency-saturation + usage prior
//                (min(20, timesUsed/2) of the linked catalog item), capped at 92
//
// Calibration (eval corpus under LOPO, 2026-08-05): exact-history top cards on
// identifiable specs are right 74% overall, 81% at full agreement — so 60–85%
// displayed is honest, 20–40% was not. Auto-select does NOT follow the display
// upward: autoSelectSafe mirrors the old evidence-mass bar (see below), so the
// pre-check set only narrows.
const EXACT_CONFIDENCE_BASE = 45;
const EXACT_CONFIDENCE_SPAN = 50;
const EXACT_RECENCY_SATURATION = 0.6;
const EXACT_CONFIDENCE_CAP = 92;
/** Confidence ceiling for exact-tier matches whose spec key is generic (not a real product identity). */
const GENERIC_SPEC_CONFIDENCE_CAP = 45;

// Family-tier confidence shape (Phase 4, backlog #2): graduated, sub-authoritative.
// base + 15 per recency-weighted family swap, capped at 75. One undated swap
// (weight 0.5) lands at 48 — a visible suggestion below the 50 auto-select bar;
// two undated swaps at 55 pre-check; three recent swaps saturate the cap.
const FAMILY_CONFIDENCE_BASE = 40;
const FAMILY_CONFIDENCE_PER_SWAP = 15;
const FAMILY_CONFIDENCE_CAP = 75;

// High-end decorative manufacturers that stay as-spec: surfaced with a passthrough
// badge rather than dropped or given a bogus swap. Deliberately conservative — a
// brand missing from this list just falls through to "no recommendations".
const PASSTHROUGH_DECORATIVE_BRANDS = [
    'HUBBARDTON FORGE',
    'VISUAL COMFORT',
    'CIRCA LIGHTING',
    'ARTERIORS',
    'CURREY',           // Currey & Company
    'FINE ART',         // Fine Art Lamps / Handcrafted
    'TECH LIGHTING',
    'KELLY WEARSTLER',
    // Consumer/designer retail brands from decorative fixture schedules
    // (Collective MedSpa 2026-07-28) — no wholesale VE path, quote as specified
    // unless the estimator identifies a substitutable equivalent.
    'LUMENS',
    'LULU AND GEORGIA',
    'ARTHAUS',
    'ETSY',
    'NAAYASTUDIO',
    'ETHNIKLIVING',
    'ETHINKLIVING',     // as typed on real bid sheets
    'LAS SOLAS',
    // European/designer decorative brands from the 3rd & Flower IS schedule
    // (2026-07-30) — same posture: quote as specified unless the estimator
    // identifies a substitutable equivalent via the identify flow.
    'TOOY',
    'FOSCARINI',
    'MARSET',
    'CVL',              // CVL Luminaires
    '&TRADITION',
    'CORBETT',
    'ALLIED MAKER',
    'LODES',
];

function isPassthroughDecorative(manufacturer: string, inferredCategory: string | null): boolean {
    const mfr = manufacturer.toUpperCase();
    if (!PASSTHROUGH_DECORATIVE_BRANDS.some(b => mfr.includes(b))) return false;
    // Only decorative categories (or unknown) stay as-spec; a commodity troffer from
    // a decorative brand would still be a legitimate VE target.
    return inferredCategory === null ||
        ['Pendant', 'Sconce', 'Vanity', 'Ceiling', 'Mirror'].includes(inferredCategory);
}

const CODE_FRAGMENT_RE = /function|return|const|let|var|=>|===|\?\s*:/i;
const CODE_PREFIX_RE = /^if\s+(it|this|the)/i;

/**
 * Human-readable explanation of WHY an item-ID text match scored, for the
 * match-details panel. "Item ID X matches input" told the estimator nothing;
 * this names the shared and missing spec tokens so a weak overlap is visibly
 * weak ("shares only 30K, MV") and a strong one visibly strong.
 */
function describeIdMatch(inputSpec: string, targetId: string): string[] {
    const ex = explainCatalogMatchScore(inputSpec, targetId);
    switch (ex.kind) {
        case 'exact':
            return ['Item ID is an exact match to the spec catalog #'];
        case 'containment':
            return ['Item ID and spec catalog # contain one another (same number, different formatting)'];
        case 'tokens': {
            const lines: string[] = [];
            const shared = [...ex.matched, ...ex.partial.map(t => `~${t}`)];
            if (shared.length > 0) {
                lines.push(`Shares spec tokens: ${shared.join(', ')}${ex.partial.length > 0 ? ' (~ = partial)' : ''}`);
            }
            if (ex.unmatched.length > 0) {
                lines.push(`Spec tokens NOT matched: ${ex.unmatched.join(', ')}`);
            }
            return lines;
        }
        default:
            return [];
    }
}

/** "Mar 2026" style label for a history bid date, or null. */
function bidDateLabel(bidDate: string | undefined): string | null {
    if (!bidDate) return null;
    const t = Date.parse(bidDate);
    if (Number.isNaN(t)) return null;
    return new Date(t).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// ── Bulb / lamp lines (Candlewood tuning, 2026-07-28) ────────────────────────
// Hospitality bids pair every fixture with a companion bulb line. A bulb line
// gets lamps, never fixtures: candidates come from the 3rd-party Light Bulb
// catalog, scored by lamp attributes (shape / kelvin / wattage) extracted from
// the spec prose plus how often that lamp has actually been bid.

function isLampCatalogItem(item: { itemId: string; manufacturer: string; productCategories: string }): boolean {
    if (item.productCategories.toLowerCase().includes('light bulb')) return true;
    return isSatcoLampNumber(item.itemId) && item.manufacturer.toLowerCase().includes('satco');
}

/** How many times each lamp (by normalized item number) was bid across all history. */
function lampUsageCounts(ctx: EngineContext): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of ctx.history) {
        if (!isSatcoLampNumber(row.bidItem)) continue;
        const key = normalizeProductId(row.bidItem);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}

function analyzeBulbLine(lineItem: ParsedLineItem, ctx: EngineContext, catalogNumber: string): LineItemAnalysis {
    const usage = lampUsageCounts(ctx);
    const lamps = ctx.thirdPartyItems.filter(isLampCatalogItem);
    const normCat = normalizeProductId(catalogNumber);

    // The spec already IS a specific lamp number (e.g. "S9594") — confirm it,
    // never text-match it against fixture SKUs.
    if (isSatcoLampNumber(catalogNumber)) {
        const exact = lamps.find(l => normalizeProductId(l.itemId) === normCat);
        const timesBid = usage.get(normCat) ?? 0;
        return {
            lineItem,
            recommendations: [{
                id: exact?.id ?? `bulb-asspec-${lineItem.rowIndex}`,
                source: '3rd Party',
                matchType: 'exact',
                confidence: 99,
                bidItem: catalogNumber,
                recordId: exact?.id,
                matchReason: 'Already a specified SATCO lamp — carry as spec',
                matchDetails: [
                    ...(exact ? [`Catalog: ${exact.itemDescription}`.slice(0, 120)] : []),
                    ...(timesBid > 0 ? [`Bid ${timesBid} time${timesBid === 1 ? '' : 's'} across history`] : []),
                ],
                itemAttributes: exact ? {
                    category: 'Light Bulb',
                    colorTemp: exact.colorTemp || undefined,
                    wattage: exact.maxWattage || undefined,
                    manufacturer: exact.manufacturer || undefined,
                } : { category: 'Light Bulb' },
                ...(exact ? { thirdPartyLinkId: exact.id } : {}),
                isPassthrough: true,
            }],
            specCategory: 'Light Bulb',
        };
    }

    // Prose bulb description ("Bulb @ Pendent Light - 5W LED A15, 3000K"):
    // attribute-match against the lamp catalog. History swaps for the same
    // normalized spec (as write-back accumulates them) add direct evidence.
    const specAttrs = extractLampAttributes(`${lineItem.mark} ${catalogNumber}`);
    const hasAttrSignal = !!(specAttrs.shape || specAttrs.kelvin || specAttrs.watts);
    const normalizedSpecKey = normalizeSpecKey(catalogNumber);
    const swapCounts = new Map<string, number>();
    for (const row of ctx.history) {
        if (!isSatcoLampNumber(row.bidItem)) continue;
        if (normalizedSpecKey.length >= 6 && normalizeSpecKey(row.originalSpec) === normalizedSpecKey) {
            const key = normalizeProductId(row.bidItem);
            swapCounts.set(key, (swapCounts.get(key) ?? 0) + 1);
        }
    }

    const scored: Array<{ score: number; reasons: string[]; details: string[]; item: (typeof lamps)[number] }> = [];
    for (const item of lamps) {
        const candText = `${item.itemId} ${item.itemDescription}`;
        const candAttrs = extractLampAttributes(candText);
        if (!candAttrs.kelvin && item.colorTemp) {
            const k = Number(String(item.colorTemp).replace(/[^0-9]/g, ''));
            if (k >= 1800 && k <= 6500) candAttrs.kelvin = k;
        }
        if (candAttrs.watts === undefined && item.maxWattage) {
            const w = Number(String(item.maxWattage).replace(/[^0-9.]/g, ''));
            if (Number.isFinite(w) && w > 0) candAttrs.watts = w;
        }

        // Hard gates: a declared shape or kelvin must not contradict.
        if (specAttrs.shape && candAttrs.shape && specAttrs.shape !== candAttrs.shape) continue;
        if (specAttrs.kelvin && candAttrs.kelvin && specAttrs.kelvin !== candAttrs.kelvin) continue;

        const key = normalizeProductId(item.itemId);
        const timesBid = usage.get(key) ?? 0;
        const swaps = swapCounts.get(key) ?? 0;
        const reasons: string[] = [];
        const details: string[] = [`Catalog: ${item.itemDescription}`.slice(0, 120)];
        let score = 20; // it is a lamp, and this is a lamp line

        if (specAttrs.shape && candAttrs.shape === specAttrs.shape) {
            score += 30;
            reasons.push(specAttrs.shape);
        }
        if (specAttrs.kelvin && candAttrs.kelvin === specAttrs.kelvin) {
            score += 20;
            reasons.push(`${specAttrs.kelvin}K`);
        }
        if (specAttrs.watts !== undefined && candAttrs.watts !== undefined) {
            const diff = Math.abs(specAttrs.watts - candAttrs.watts);
            if (diff <= 1) { score += 15; reasons.push(`${candAttrs.watts}W`); }
            else if (diff <= 3) { score += 8; }
        }
        score += Math.min(20, timesBid * 2);
        if (timesBid > 0) details.push(`Bid ${timesBid} time${timesBid === 1 ? '' : 's'} across history`);
        if (swaps > 0) {
            score += Math.min(25, swaps * 8);
            details.push(`${swaps} matching swap${swaps === 1 ? '' : 's'}: same bulb spec → this lamp`);
        }

        // With no attribute signal at all, only usage ranks — keep confidence honest.
        if (!hasAttrSignal && swaps === 0) {
            if (timesBid === 0) continue;
            score = Math.min(55, 20 + timesBid * 2);
        }

        scored.push({
            score,
            reasons,
            details,
            item,
        });
    }

    scored.sort((a, b) => b.score - a.score);
    const recommendations: Recommendation[] = scored.slice(0, 3).map(cand => ({
        id: cand.item.id,
        source: '3rd Party' as const,
        matchType: cand.score >= 70 ? 'exact' as const : cand.score >= 45 ? 'fuzzy' as const : 'partial' as const,
        confidence: Math.min(96, Math.round(cand.score)),
        premierItem: cand.item.itemId,
        recordId: cand.item.id,
        matchReason: cand.reasons.length > 0
            ? `Lamp match: ${cand.reasons.join(' · ')}`
            : 'Most-used lamp in bid history (bulb spec carries no attributes)',
        itemAttributes: {
            category: 'Light Bulb',
            colorTemp: cand.item.colorTemp || undefined,
            wattage: cand.item.maxWattage || undefined,
            manufacturer: cand.item.manufacturer || undefined,
        },
        matchDetails: cand.details,
        productCategory: 'Light Bulb',
        thirdPartyLinkId: cand.item.id,
    }));

    return {
        lineItem,
        recommendations,
        ...(recommendations.length === 0
            ? { infoMessage: 'Bulb/lamp line — no matching lamp found in the catalog; bid as specified.' }
            : {}),
        specCategory: 'Light Bulb',
    };
}

/**
 * Parity-runner entry point (BIND 1): one parsed line item + the data context,
 * returns Recommendation[] ranked best-first.
 */
export function recommendForLineItem(lineItem: ParsedLineItem, ctx: EngineContext): Recommendation[] {
    return analyzeLineItem(lineItem, ctx).recommendations;
}

/**
 * In-category fallback: token overlap from the mark/catalog text ranks first,
 * then Times Used. This is the "spec item not identified" mitigation from the
 * Camino Del Rio review — site poles, building lights, vanities, and mirrors
 * always get in-category candidates instead of silence or cross-category
 * text-match junk. Extracted so the RFI branch and the post-dedupe retry can
 * reuse it (Collective MedSpa review: line A ended silent though its category
 * was known).
 */
function categoryFallbackRecommendations(
    lineItem: ParsedLineItem,
    ctx: EngineContext,
    inferredCategory: string,
    specDimensionText: string,
    catalogNumber: string,
): Recommendation[] {
    const { mark } = lineItem;
    const recommendations: Recommendation[] = [];
    const catalogIsProse = looksLikeProse(catalogNumber);
    const markIsProse = looksLikeProse(mark);
    // Accessory SKUs (clips, drivers, power supplies) never substitute for a
    // fixture spec — only for a spec that is itself an accessory.
    const allowAccessories = specWantsAccessory(mark, catalogNumber);

    const stopWords = new Set(['AND', 'OR', 'THE', 'FOR', 'WITH', 'NOT', 'LED', 'A', 'AN', 'IN', 'OF', 'W', 'X', 'FAN', 'LIGHT', 'FIXTURE']);
    const tokenSource = catalogIsProse ? catalogNumber : markIsProse ? mark : `${mark} ${catalogNumber}`;
    const proseTokens = tokenSource.toUpperCase()
        .split(/[\s\-\/,()'"]+/)
        .filter(t => t.length >= 3 && !stopWords.has(t) && !/^\d+(\.\d+)?["']?$/.test(t));

    interface FallbackCandidate {
        tokenScore: number;
        matchedTokens: string[];
        usageBonus: number;
        score: number;
        tier: 'premier' | 'third_party';   // own-brand catalog first, 3rd-party budget tier second
        id: string;
        itemId: string;
        category: string;
        timesUsed: number;
        itemAttributes: ItemAttributes;
    }
    const candidates: FallbackCandidate[] = [];

    const tokensMatching = (itemId: string, description: string): string[] => {
        const searchTarget = (itemId + ' ' + description).toUpperCase();
        return proseTokens.filter(token => searchTarget.includes(token));
    };

    for (const item of ctx.premierItems) {
        const category = item.fixtureCategory;

        // Must belong to the inferred category's vocabulary group.
        if (!category || !categoriesCompatible(inferredCategory, category)) continue;

        // Dimension hard-gate applies to fallback candidates too.
        if (!dimensionsCompatible(specDimensionText, `${item.itemId} ${item.itemDescription}`)) continue;

        if (!allowAccessories && isAccessoryItem(item.itemId, item.itemDescription)) continue;

        // Score by token overlap with item ID + description, then usage.
        const matchedTokens = tokensMatching(item.itemId, item.itemDescription);
        const tokenScore = matchedTokens.length;
        const usageBonus = Math.min(10, Math.floor(item.timesUsed / 2));

        candidates.push({
            tokenScore,
            matchedTokens,
            usageBonus,
            score: tokenScore * 8 + usageBonus,
            tier: 'premier',
            id: item.id,
            itemId: item.itemId,
            category,
            timesUsed: item.timesUsed,
            itemAttributes: {
                category: category || undefined,
                finish: item.finish || undefined,
                colorTemp: item.colorTemp || undefined,
                wattage: item.maxWattage || undefined,
            },
        });
    }

    // 3rd-party items join the fallback as the budget-alternative tier
    // (SATCO/Westgate). No Times Used on that table, so their signal is
    // token overlap only — and the tier ordering below guarantees they never
    // rank above an own-brand candidate with equal signal.
    for (const item of ctx.thirdPartyItems) {
        if (!thirdPartyCategoriesCompatible(inferredCategory, item.productCategories)) continue;
        if (!dimensionsCompatible(specDimensionText, `${item.itemId} ${item.itemDescription}`)) continue;
        if (!allowAccessories && isAccessoryItem(item.itemId, item.itemDescription)) continue;

        const matchedTokens = tokensMatching(item.itemId, item.itemDescription);
        candidates.push({
            tokenScore: matchedTokens.length,
            matchedTokens,
            usageBonus: 0,
            score: matchedTokens.length * 8,
            tier: 'third_party',
            id: item.id,
            itemId: item.itemId,
            category: item.productCategories,
            timesUsed: 0,
            itemAttributes: {
                category: item.productCategories || undefined,
                finish: item.finish || undefined,
                colorTemp: item.colorTemp || undefined,
                wattage: item.maxWattage || undefined,
                manufacturer: item.manufacturer || undefined,
            },
        });
    }

    candidates.sort((a, b) =>
        b.score - a.score ||
        // Equal signal: own-brand always outranks the 3rd-party tier.
        (a.tier === b.tier ? 0 : a.tier === 'premier' ? -1 : 1) ||
        b.timesUsed - a.timesUsed);
    // Prefer candidates with a real signal (token match or usage history);
    // fall back to the top in-category items so the estimator still sees the
    // right family instead of "No recommendations".
    const withSignal = candidates.filter(cand => cand.tokenScore > 0 || cand.timesUsed > 0);
    const chosen = (withSignal.length > 0 ? withSignal : candidates).slice(0, 3);
    for (const cand of chosen) {
        const descriptionBased = cand.tokenScore > 0;
        const isThirdParty = cand.tier === 'third_party';
        recommendations.push({
            id: cand.id,
            source: isThirdParty ? '3rd Party' : 'Premier Items',
            matchType: 'partial',
            confidence: descriptionBased
                ? Math.min(60, Math.max(15, cand.score)) // cap at 60 — prose matching is imprecise
                : Math.min(45, 15 + Math.min(30, cand.timesUsed)),
            premierItem: cand.itemId || undefined,
            recordId: cand.id,
            matchReason: descriptionBased
                ? `Category match: ${inferredCategory} (description-based${isThirdParty ? ', 3rd-party alternative' : ''})`
                : `Category match: ${inferredCategory} — most-used catalog items (spec not identified at item level)`,
            itemAttributes: cand.itemAttributes,
            matchDetails: [
                `Category: ${cand.category} — matches the spec's (${inferredCategory})`,
                descriptionBased
                    ? `Spec words found in this item: ${cand.matchedTokens.join(', ')}`
                    : `No text overlap with the spec — offered as an in-category most-used item`,
                ...(cand.timesUsed > 0 ? [`Used ${cand.timesUsed} time${cand.timesUsed === 1 ? '' : 's'} before`] : []),
                ...(isThirdParty ? ['3rd-party budget alternative'] : []),
                'Exact item not identified from the spec — these are category-level suggestions, never pre-checked',
            ],
            productCategory: cand.category || undefined,
            ...(isThirdParty ? { thirdPartyLinkId: cand.id } : { premierLinkId: cand.id }),
        });
    }
    return recommendations;
}

export function analyzeLineItem(lineItem: ParsedLineItem, ctx: EngineContext): LineItemAnalysis {
    const recommendations: Recommendation[] = [];
    const { mark, manufacturer } = lineItem;

    // URL-as-catalog protection: a pasted spec-sheet link must never drive matching.
    const catalogNumber = isUrlLike(lineItem.catalogNumber) ? '' : lineItem.catalogNumber;

    // TBD / missing-spec lines become an RFI, never a fabricated match (domain
    // rule). Checked before tape: "RFI #2 - HAND RAIL LIGHTING" is an RFI, not tape.
    // When the RFI text still names a fixture CATEGORY ("MISSING SPEC — RECESSED
    // DOWNLIGHT"), offer the in-category most-used candidates alongside the RFI
    // notice instead of silence — they are suggestions, never auto-selected
    // (matchType 'partial' is excluded from auto-select), and RFI lines are
    // excluded from History write-back regardless of selection.
    if (isRfiPlaceholder(mark, lineItem.catalogNumber, manufacturer)) {
        const rfiCategory = detectFixtureCategory(mark, catalogNumber, manufacturer);
        const rfiRecs = rfiCategory
            ? categoryFallbackRecommendations(lineItem, ctx, rfiCategory, `${mark} ${catalogNumber}`, catalogNumber)
            : [];
        for (const rec of rfiRecs) {
            if (!rec.isPassthrough && isPremierOwnBrand(rec)) {
                rec.confidence = Math.min(100, rec.confidence + OWN_BRAND_BONUS);
            }
        }
        rfiRecs.sort(compareRecommendations);
        return {
            lineItem,
            recommendations: rfiRecs.slice(0, 3),
            infoMessage: 'RFI — spec not identified (TBD / missing spec). Request the specification; the engine never fabricates a match for an unidentified item.',
            specCategory: rfiCategory,
        };
    }

    // LED tape is suppressed with an informational message, not given swap recs.
    if (isLedTape(mark, lineItem.catalogNumber, manufacturer)) {
        return {
            lineItem,
            recommendations: [],
            infoMessage: 'LED tape — bid as specified. Tape runs are project-specific (channel, driver, footage); no VE substitution is offered.',
            specCategory: 'LED Tape',
        };
    }

    // A bulb/lamp companion line ("CG-404.B", SATCO, "Bulb @ ...") takes the
    // dedicated lamp path: lamps in, fixtures never (Candlewood tuning).
    if (isBulbLampLine(mark, lineItem.catalogNumber, manufacturer)) {
        return analyzeBulbLine(lineItem, ctx, catalogNumber);
    }

    // Extract fixture type hint from any raw column that holds a short fixture-type label.
    // Many bid trackers repurpose columns (e.g. "QTY LAMPS") to hold values like
    // "VANITY", "FAN", "POST TOP", "DISC" — use these to sharpen category detection.
    // The LOCATION column is excluded: a room name like "Vanity" is where the fixture
    // hangs, not what it is (Candlewood: Electric Mirror lines misrouted to Vanity).
    const FIXTURE_HINT_RE = /^(fan|ceiling fan|vanity|bath bar|pendant|sconce|can|recessed|disc|disk|downlight|linear|strip|strip light|canopy|troffer|surface|flush|semi|semi-flush|post top|post|outdoor|bollard|pole|exit|exit sign|emergency|egress|up.?down|wall pack|flood|area light|closet|shelf|cabinet)$/i;
    const sectionNorm = (lineItem.section || '').trim().toUpperCase();
    const fixtureTypeHint = Object.values(lineItem.rawRow).find(v => {
        const t = (v || '').trim();
        return t.length >= 3 && t.length <= 20 && t.toUpperCase() !== sectionNorm && FIXTURE_HINT_RE.test(t);
    }) || '';

    // Infer fixture category once — used to gate Fans and Premier Items matching.
    // A category from a per-line identification (URL/web/PDF, Phase 2) is authoritative
    // over the text heuristic: it was extracted from the actual spec sheet / product page
    // and is already expressed in the detector's vocabulary.
    const identifiedCategory =
        lineItem.identified?.category && CATEGORY_GROUPS[lineItem.identified.category]
            ? lineItem.identified.category
            : null;
    const inferredCategory = identifiedCategory ?? detectFixtureCategory(mark, catalogNumber, manufacturer, fixtureTypeHint);

    // The dimension signature the spec exposes — candidates are gated against this.
    const specDimensionText = `${mark} ${catalogNumber}`;

    // ── History matching ──────────────────────────────────────────────────────
    interface BidItemMatchData {
        score: number;
        rows: HistoryRow[];
        historyMatches: HistoryMatch[];
        reasons: string[];
        hasCatalogMatch: boolean;
        /** Any collected row matches the input at family level (isFamilySpecMatch). */
        hasFamilyMatch: boolean;
        productCategory?: string;
    }
    const bidItemMatchMap = new Map<string, BidItemMatchData>();

    // History lookup key, hoisted: the NORMALIZED input catalog (whitespace/
    // case/punctuation variance must not break matching).
    const normalizedInputCatalog = normalizeSpecKey(catalogNumber);

    for (const row of ctx.history) {
        let score = 0;
        const reasons: string[] = [];
        let hasCatalogMatch = false;

        const historyMark = row.mark;
        const bidItemValue = row.bidItem;

        // Skip bid items that look like code/logic fragments or garbage text
        if (bidItemValue && CODE_PREFIX_RE.test(bidItemValue.trim())) continue;
        if (bidItemValue && CODE_FRAGMENT_RE.test(bidItemValue)) continue;
        // Skip very short or empty bid items
        if (!bidItemValue || bidItemValue.trim().length < 3) continue;

        if (row.matchType === 'NON-ITEM') continue;

        // SATCO bulb/lamp exclusion (must-survive): SATCO S-series lamps are never
        // offered as swap recommendations.
        const isSatcoBulb = row.bidMfrBackup === 'SATCO' && /^S\d{4,5}$/.test(bidItemValue);
        if (isSatcoBulb) continue;

        // A row that "swapped" the spec to ITSELF is an as-spec record, not
        // substitution evidence. Dedupe would delete the resulting rec as an
        // input-echo anyway — but by then it has already suppressed the
        // direct-match tiers via hasHistoryMatches (3rd & Flower D16: the
        // as-spec Minka fan rows starved the line down to fallback junk).
        if (normalizedInputCatalog.length >= 6 &&
            normalizeProductId(bidItemValue) === normalizedInputCatalog) continue;

        const specMfr = row.specManufacturer || row.specMfrBackup || '';
        const bidMfr = row.bidManufacturer || row.bidMfrBackup || '';

        const specScore = calculateCatalogMatchScore(catalogNumber, row.originalSpec);

        // Family-level spec match (same series, different options) — collected
        // even when the token score alone wouldn't qualify: PR #6's junk gates
        // rightly zero accidental substring overlaps, so family evidence must
        // ride its own purpose-built signal (Largo BA: S7R835K10AL scored 0
        // against every S7R history row and 4+ prior decisions were invisible).
        const familySpecMatch = isFamilySpecMatch(catalogNumber, row.originalSpec, specScore);

        // Boost score when NS has confirmed this spec's identity (HIGH = +10, MEDIUM = +5)
        const enrichBonus = row.specEnrichConfidence === 'HIGH' ? 10 : row.specEnrichConfidence === 'MEDIUM' ? 5 : 0;
        if (specScore >= 70) {
            score += specScore * 0.8;
            score += enrichBonus;
            reasons.push(`Catalog # match: ${specScore}%`);
            hasCatalogMatch = true;
        } else if (specScore >= 40) {
            score += specScore * 0.5;
            score += enrichBonus;
            reasons.push(`Partial catalog match: ${specScore}%`);
            hasCatalogMatch = true;
        }

        if (!hasCatalogMatch && mark && mark.replace(/[^a-zA-Z0-9]/g, '').length >= 4) {
            const markScore = calculateMatchScore(mark, historyMark);
            if (markScore >= 80) {
                score += markScore * 0.15;
                reasons.push(`Mark match: ${markScore}%`);
            }
        } else if (hasCatalogMatch && mark) {
            const markScore = calculateMatchScore(mark, historyMark);
            if (markScore >= 50) {
                score += 5;
                reasons.push('Mark also matches');
            }
        }

        const minScoreThreshold = hasCatalogMatch ? 20 : 40;
        if (score >= minScoreThreshold || familySpecMatch) {
            const historyMatch: HistoryMatch = {
                project: row.project,
                mark: historyMark,
                originalSpec: row.originalSpec,
                bidItem: bidItemValue,
                approvalStatus: '',
                bidDate: row.bidDate || undefined,
                specManufacturer: specMfr,
                bidManufacturer: bidMfr,
                recordId: row.id,
                specDescription: row.specDescription || undefined,
                specVendor: row.specVendor || undefined,
                specEnrichConfidence: row.specEnrichConfidence || undefined,
            };

            const existing = bidItemMatchMap.get(bidItemValue);
            if (existing) {
                existing.score = Math.max(existing.score, score);
                existing.rows.push(row);
                existing.historyMatches.push(historyMatch);
                existing.hasCatalogMatch = existing.hasCatalogMatch || hasCatalogMatch;
                existing.hasFamilyMatch = existing.hasFamilyMatch || familySpecMatch;
                if (reasons.length > existing.reasons.length) {
                    existing.reasons = reasons;
                }
                if (!existing.productCategory && row.productCategory) {
                    existing.productCategory = row.productCategory;
                }
            } else {
                bidItemMatchMap.set(bidItemValue, {
                    score,
                    rows: [row],
                    historyMatches: [historyMatch],
                    reasons,
                    hasCatalogMatch,
                    hasFamilyMatch: familySpecMatch,
                    productCategory: row.productCategory || undefined,
                });
            }
        }
    }

    let totalSpecAppearances = 0;
    for (const row of ctx.history) {
        if (row.matchType === 'NON-ITEM') continue;
        if (normalizeSpecKey(row.originalSpec) === normalizedInputCatalog && normalizedInputCatalog.length >= 6) {
            totalSpecAppearances++;
        }
    }

    const premierById = new Map(ctx.premierItems.map(p => [p.id, p]));
    const thirdPartyById = new Map(ctx.thirdPartyItems.map(t => [t.id, t]));

    for (const [bidItemValue, data] of bidItemMatchMap.entries()) {
        if (!data.hasCatalogMatch && !data.hasFamilyMatch) continue;

        const trueMatchingSwaps = data.historyMatches.filter(h => {
            const normalizedSpec = normalizeSpecKey(h.originalSpec);
            const normalizedBid = normalizeProductId(h.bidItem);
            const recommendedBid = normalizeProductId(bidItemValue);
            return normalizedSpec === normalizedInputCatalog &&
                normalizedBid === recommendedBid &&
                normalizedInputCatalog.length >= 6;
        });

        // ── Family tier (Phase 4, backlog #2) ────────────────────────────────
        // No exact-spec precedent, but history rows whose ORIGINAL SPEC is the
        // same product series (different options) agree on this bid item →
        // a real sub-authoritative recommendation, not silence. Graduated
        // confidence (capped below the authoritative floor), matchType 'fuzzy'
        // so auto-select applies only when the evidence honestly clears 50.
        const familySwaps = trueMatchingSwaps.length > 0 ? [] :
            data.historyMatches.filter(h => isFamilySpecMatch(catalogNumber, h.originalSpec));
        const isFamily = trueMatchingSwaps.length === 0 && familySwaps.length > 0;

        if (trueMatchingSwaps.length === 0 && !isFamily) continue;

        const evidenceSwaps = isFamily ? familySwaps : trueMatchingSwaps;
        const bidProductCategory = data.productCategory || '';
        const uniqueProjects = [...new Set(evidenceSwaps.map(h => h.project).filter(Boolean))];
        const matchingSwapCount = evidenceSwaps.length;

        // Recency-weighted swap mass: recent swaps carry full weight, stale ones decay.
        const weightedSwaps = evidenceSwaps.reduce(
            (sum, h) => sum + recencyWeight(h.bidDate, ctx.referenceDate), 0);

        // Agreement: of every history row carrying this exact spec, what share
        // chose THIS item? Competing swaps to other items and as-spec rows both
        // dilute it — 2 of 2 is settled precedent, 1 of 5 is a minority report.
        const specAppearances = Math.max(totalSpecAppearances, matchingSwapCount);
        const agreementShare = specAppearances > 0 ? matchingSwapCount / specAppearances : 1;
        // Whether the spec text is a real product identity — generic keys
        // ("DOWNLIGHT", "NO SPEC") equality-match on vocabulary, not identity.
        const identifiableSpec = isIdentifiableSpecKey(catalogNumber);

        const matchDetails: string[] = [];
        if (isFamily) {
            matchDetails.push(`${matchingSwapCount} family swap${matchingSwapCount > 1 ? 's' : ''}: same product series, different options → same bid item`);
            matchDetails.push(`e.g. "${evidenceSwaps[0]?.originalSpec}" → ${bidItemValue}`);
        } else {
            const agreementPct = Math.round(agreementShare * 100);
            matchDetails.push(
                `Estimators bid this exact spec ${specAppearances} time${specAppearances === 1 ? '' : 's'}; ` +
                `${matchingSwapCount} chose this item (${agreementPct}% agreement)`);
        }
        if (uniqueProjects.length > 0) {
            // Name the projects WITH their swap dates — the estimator can judge
            // staleness at a glance instead of trusting a bare percentage.
            const dated = evidenceSwaps.slice(0, 3).map(h => {
                const d = bidDateLabel(h.bidDate);
                return h.project ? (d ? `${h.project} (${d})` : h.project) : null;
            }).filter(Boolean);
            matchDetails.push(`Projects: ${dated.length > 0 ? dated.join(', ') : uniqueProjects.join(', ')}${evidenceSwaps.length > 3 ? ` +${evidenceSwaps.length - 3} more` : ''}`);
        }

        const firstMatch = evidenceSwaps[0];

        // Resolve the linked catalog record from History. A History row links to
        // exactly one of {Premier, 3rd Party} or neither — mutually exclusive per
        // the design contract. Premier wins if any row in this match set has a
        // Premier link; otherwise fall back to 3rd Party. catalogSource tells the
        // UI which catalog the displayed attributes came from.
        let resolvedPremier: (typeof ctx.premierItems)[number] | undefined;
        let resolvedThirdParty: (typeof ctx.thirdPartyItems)[number] | undefined;
        let catalogSource: 'premier' | 'third_party' | undefined;

        for (const histRow of data.rows) {
            const premierLinkId = histRow.premierLinkIds[0];
            if (premierLinkId) {
                const found = premierById.get(premierLinkId);
                if (found) {
                    resolvedPremier = found;
                    catalogSource = 'premier';
                    break;
                }
            }
            const thirdPartyLinkId = histRow.thirdPartyLinkIds[0];
            if (thirdPartyLinkId) {
                const found = thirdPartyById.get(thirdPartyLinkId);
                if (found) {
                    resolvedThirdParty = found;
                    catalogSource = 'third_party';
                    // don't break — keep looking in case a later row has a Premier link
                }
            }
        }

        // Unlinked history rows (no Airtable link set) still name a bid item that
        // usually IS a catalog item — resolve it by normalized Item ID so the card
        // carries its category and attributes instead of a bare item number
        // (Jesse's Excel-listing review: the GC-WP-R8 precedent rendered with no
        // category badge and no attributes because its Diamond View rows were
        // unlinked). Display/linking only: the auto-select mirror below ignores
        // this resolution so unlinked evidence pre-checks no wider than before.
        let resolvedByText = false;
        if (!resolvedPremier && !resolvedThirdParty) {
            const normBid = normalizeProductId(bidItemValue);
            if (normBid.length >= 4) {
                resolvedPremier = ctx.premierItems.find(p => normalizeProductId(p.itemId) === normBid);
                if (resolvedPremier) {
                    catalogSource = 'premier';
                    resolvedByText = true;
                } else {
                    resolvedThirdParty = ctx.thirdPartyItems.find(t => normalizeProductId(t.itemId) === normBid);
                    if (resolvedThirdParty) {
                        catalogSource = 'third_party';
                        resolvedByText = true;
                    }
                }
            }
        }

        let itemAttributes: ItemAttributes | undefined;
        let resolvedItemId: string | undefined;
        let resolvedItemText = '';
        let timesUsedBonus = 0;

        if (resolvedPremier) {
            resolvedItemId = resolvedPremier.itemId || undefined;
            resolvedItemText = `${resolvedPremier.itemId} ${resolvedPremier.itemDescription}`;
            // Catalog popularity is a real prior: an item Premier bids constantly
            // is likelier to be the one estimators reach for again than a
            // same-evidence sibling nobody uses (Joyfield: the linked 7" disk at
            // 22 uses vs an unlinked variant string). Display-only — the
            // auto-select mirror below deliberately excludes it.
            timesUsedBonus = Math.min(20, Math.floor(resolvedPremier.timesUsed / 2));
            itemAttributes = {
                category: resolvedPremier.fixtureCategory || undefined,
                finish: resolvedPremier.finish || undefined,
                colorTemp: resolvedPremier.colorTemp || undefined,
                wattage: resolvedPremier.maxWattage || undefined,
                lightOutput: resolvedPremier.lightOutput || undefined,
            };
        } else if (resolvedThirdParty) {
            // 3rd Party item — same display contract as Premier, different fields.
            // Note: no Times Used on this table (timesUsedBonus stays 0).
            resolvedItemId = resolvedThirdParty.itemId || undefined;
            resolvedItemText = `${resolvedThirdParty.itemId} ${resolvedThirdParty.itemDescription}`;
            itemAttributes = {
                category: resolvedThirdParty.productCategories || undefined,
                finish: resolvedThirdParty.finish || undefined,
                colorTemp: resolvedThirdParty.colorTemp || undefined,
                wattage: resolvedThirdParty.maxWattage || undefined,
                lightOutput: resolvedThirdParty.lightOutput || undefined,
                manufacturer: resolvedThirdParty.manufacturer || undefined,
            };
        }

        // Family evidence is sub-authoritative BY DEFINITION: options differed,
        // so however many family swaps agree, it never reaches the 95% floor.
        // The authoritative tier also demands a real product identity and
        // majority agreement: three "NO SPEC" rows agreeing is vocabulary, not
        // precedent (both generic authoritative cards in the eval corpus were
        // wrong at 100% displayed confidence), and 3 swaps out of 8 appearances
        // is a minority report however you count it.
        const isAuthoritative = !isFamily && matchingSwapCount >= AUTHORITATIVE_SWAP_COUNT &&
            identifiableSpec && agreementShare >= 0.5;

        // Dimension hard-gate for sub-authoritative history matches: block a linked
        // catalog item that is dimensionally incompatible with the spec. 3+ real
        // estimator decisions (authoritative) outrank the heuristic and pass through.
        if (!isAuthoritative && resolvedItemText &&
            !dimensionsCompatible(specDimensionText, resolvedItemText)) {
            continue;
        }

        // Accessory gate, same posture as the dimension gate: a single stale
        // swap to a downrod/driver must not surface for a FIXTURE spec (3rd &
        // Flower D16: fan spec F896-65-CL → DR524-CL downrod at confidence 10,
        // which then suppressed direct matching entirely). Authoritative
        // history — 3+ real decisions — still passes.
        if (!isAuthoritative && resolvedItemText &&
            !specWantsAccessory(mark, catalogNumber) &&
            isAccessoryItem(resolvedItemId ?? bidItemValue, resolvedItemText)) {
            continue;
        }

        // Category gate for family matches only: family inference must stay
        // inside the spec's category when both sides declare one. (Exact-spec
        // history deliberately has no category gate — a real estimator decision
        // on the same spec outranks the detector.)
        if (isFamily && inferredCategory) {
            if (resolvedPremier?.fixtureCategory &&
                !categoriesCompatible(inferredCategory, resolvedPremier.fixtureCategory)) continue;
            if (!resolvedPremier && resolvedThirdParty?.productCategories &&
                !thirdPartyCategoriesCompatible(inferredCategory, resolvedThirdParty.productCategories)) continue;
        }

        // Exact-tier confidence: agreement × recency saturation + catalog-usage
        // prior (see the constants block for the calibration numbers behind
        // this shape). Deliberately NOT rounded here: near-ties between
        // competing candidates must keep their real ordering — the UI rounds
        // for display.
        const recencySaturation = weightedSwaps / (weightedSwaps + EXACT_RECENCY_SATURATION);
        let adjustedConfidence = Math.min(EXACT_CONFIDENCE_CAP,
            EXACT_CONFIDENCE_BASE + EXACT_CONFIDENCE_SPAN * agreementShare * recencySaturation + timesUsedBonus);
        let matchReason = `Bid ${matchingSwapCount} of ${specAppearances} time${specAppearances === 1 ? '' : 's'} — same spec → this item`;
        let autoSelectSafe: boolean | undefined;

        if (isFamily) {
            // Graduated family confidence: 40 base + 15 per recency-weighted
            // swap, capped at 75 — well below the 95 authoritative floor. Two
            // undated family swaps (weight 0.5 each) clear the 50 auto-select
            // bar honestly; a single stale one stays a suggestion.
            adjustedConfidence = Math.min(FAMILY_CONFIDENCE_CAP,
                Math.round(FAMILY_CONFIDENCE_BASE + weightedSwaps * FAMILY_CONFIDENCE_PER_SWAP));
            matchReason = `Family match: same product series bid ${matchingSwapCount} time${matchingSwapCount > 1 ? 's' : ''} → this item`;
            matchDetails.push(`Confidence ${Math.round(adjustedConfidence)}%: family evidence — right series, options differed, so the exact variant is unverified`);
        } else {
            if (!identifiableSpec) {
                // Generic spec text ("DOWNLIGHT", "NO SPEC"): the "exact" key
                // equality is vocabulary, not product identity. Keep the card
                // as a pointer but never let it look or act confident.
                adjustedConfidence = Math.min(adjustedConfidence, GENERIC_SPEC_CONFIDENCE_CAP);
                autoSelectSafe = false;
                matchDetails.push(`"${catalogNumber.trim()}" is a generic description, not a unique catalog # — confidence capped, never pre-checked`);
            } else if (isAuthoritative) {
                // Authoritative tier: the same spec→item swap made 3+ times is settled
                // precedent — floor at 95% and label it.
                adjustedConfidence = Math.max(AUTHORITATIVE_CONFIDENCE, adjustedConfidence);
                matchReason = `✓ Bid ${matchingSwapCount} times — same spec → same item`;
                autoSelectSafe = true;
                matchDetails.push(`Confidence ${Math.round(adjustedConfidence)}%: settled precedent — ${matchingSwapCount} estimator decisions agree on this exact spec`);
            } else {
                // Sub-authoritative exact evidence. The DISPLAYED confidence is
                // calibrated to measured precision (60–85 honest range), but the
                // PRE-CHECK eligibility deliberately mirrors the old evidence-mass
                // bar (recency-weighted swaps × 20, + own-brand preference ≥ 50)
                // so honest display never widens auto-select — the eval ratchet's
                // autoWrong quadrant is the learning loop's pollution guard.
                const legacyMass = Math.min(100, Math.round(weightedSwaps * 20)) +
                    (isPremierOwnBrand({ premierItem: resolvedItemId, bidItem: bidItemValue }) ? OWN_BRAND_BONUS : 0);
                autoSelectSafe = legacyMass >= MIN_AUTOSELECT_CONFIDENCE;
                const recencyDesc = weightedSwaps >= matchingSwapCount * 0.85 ? 'recent'
                    : weightedSwaps >= matchingSwapCount * 0.45 ? 'aging' : 'stale';
                const agreementDesc = agreementShare >= 0.999 ? 'full agreement'
                    : agreementShare >= 0.5 ? 'majority pick' : `minority pick (${matchingSwapCount} of ${specAppearances})`;
                matchDetails.push(`Confidence ${Math.round(adjustedConfidence)}%: ${agreementDesc}, ${recencyDesc} swap${matchingSwapCount === 1 ? '' : 's'}${timesUsedBonus > 0 ? ` (+${timesUsedBonus} usage prior)` : ''}`);
                if (resolvedPremier && resolvedPremier.timesUsed > 0) {
                    matchDetails.push(`Catalog item bid ${resolvedPremier.timesUsed} time${resolvedPremier.timesUsed === 1 ? '' : 's'} across all projects`);
                }
            }
            // Category cross-check is transparency, not a gate: a real estimator
            // decision on this exact spec outranks the category detector, but a
            // mismatch is worth the estimator's glance.
            const recCategoryLabel = resolvedPremier?.fixtureCategory || resolvedThirdParty?.productCategories || bidProductCategory;
            if (inferredCategory && recCategoryLabel) {
                const compatible = resolvedPremier
                    ? categoriesCompatible(inferredCategory, resolvedPremier.fixtureCategory)
                    : thirdPartyCategoriesCompatible(inferredCategory, recCategoryLabel);
                if (!compatible) {
                    matchDetails.push(`⚠ Category differs from the spec's (${recCategoryLabel} vs ${inferredCategory}) — kept because it's a past estimator decision`);
                }
            }
        }
        if (resolvedByText) {
            // Airtable hygiene surfaced where it's felt: these History rows carry
            // no catalog link, so the card was matched to the catalog by item #.
            matchDetails.push('History rows for this swap aren\'t linked in Airtable — catalog record matched by item #');
        } else if (!resolvedPremier && !resolvedThirdParty && !bidProductCategory) {
            matchDetails.push('Bid item not found in the Premier / 3rd-party catalogs — no category or attributes available (Airtable link missing?)');
        }

        recommendations.push({
            id: data.rows[0]?.id ?? `history-${bidItemValue}`,
            source: 'History',
            matchType: isAuthoritative ? 'exact' : 'fuzzy',
            confidence: adjustedConfidence,
            bidItem: bidItemValue,
            premierItem: resolvedItemId,
            recordId: data.rows[0]?.id,
            matchReason,
            historyMatches: evidenceSwaps,
            swapCount: matchingSwapCount,
            exactMatchCount: isFamily ? 0 : matchingSwapCount,
            ...(isFamily ? { familyMatch: true } : {}),
            ...(autoSelectSafe !== undefined ? { autoSelectSafe } : {}),
            matchDetails,
            itemAttributes,
            specManufacturer: firstMatch?.specManufacturer,
            bidManufacturer: firstMatch?.bidManufacturer,
            totalSpecAppearances,
            projectsUsed: uniqueProjects,
            productCategory: bidProductCategory || itemAttributes?.category,
            specDescription: firstMatch?.specDescription,
            specVendor: firstMatch?.specVendor,
            specEnrichConfidence: firstMatch?.specEnrichConfidence,
            matchedOriginalSpec: firstMatch?.originalSpec,
            catalogSource,
            premierLinkId: resolvedPremier?.id,
            thirdPartyLinkId: resolvedThirdParty?.id,
        });
    }

    // ── Premier Items direct matching ─────────────────────────────────────────
    // Only fall back to direct Premier SKU text-matching when History produced no
    // results and the catalog number already looks like a Premier item number
    // (estimator re-uploaded a Premier bid). Family matches don't count: their
    // evidence is weaker, so the direct tiers still run and compete on confidence.
    const hasHistoryMatches = recommendations.some(r =>
        r.source === 'History' && !r.familyMatch && r.bidItem && r.bidItem.length > 3);

    if (!hasHistoryMatches) {
        const normalizedCatalog = normalizeProductId(catalogNumber);
        const allowAccessories = specWantsAccessory(mark, catalogNumber);
        // Marks shorter than 3 normalized characters ("C", "W1") substring-hit
        // most of the catalog (3rd & Flower: mark "C" scored 85% against
        // GC-BLChannel for an exit-sign spec) — they carry no identity.
        const markUsable = normalizeProductId(mark).length >= 3;

        for (const item of ctx.premierItems) {
            let score = 0;
            const reasons: string[] = [];
            const matchDetails: string[] = [];
            const scoreParts: string[] = [];

            const itemId = item.itemId;
            const category = item.fixtureCategory;

            // If we have a confident fixture category inference, skip Premier Items
            // whose Fixture Category is outside the inferred label's vocabulary group.
            if (inferredCategory && category && !categoriesCompatible(inferredCategory, category)) continue;

            // Dimension hard-gate: a candidate matching on category but dimensionally
            // incompatible must be blocked, not just demoted.
            if (!dimensionsCompatible(specDimensionText, `${itemId} ${item.itemDescription}`)) continue;

            // Accessory SKUs never substitute for a fixture spec (MedSpa L7:
            // tape-light mounting clips offered for a picture light).
            if (!allowAccessories && isAccessoryItem(itemId, item.itemDescription)) continue;

            if (itemId) {
                const normalizedItemId = normalizeProductId(itemId);
                if (normalizedItemId === normalizedCatalog && normalizedCatalog.length >= 6) {
                    continue;
                }

                const idScore = calculateCatalogMatchScore(catalogNumber, itemId);
                // Null-category junk gate (Phase 4, backlog #5): with no
                // category to gate on, a 40s-grade token overlap surfaces
                // cross-category junk (Largo BH: "-100-" tokens offered pole
                // heads for a vapor-tight at 43%). An unknown category demands
                // stronger identity evidence; the identify flow absorbs the
                // silence this trades junk for.
                const idScoreFloor = inferredCategory ? 40 : 55;
                if (idScore >= idScoreFloor) {
                    score += idScore * 0.7;
                    reasons.push(`Item ID match: ${idScore}%`);
                    matchDetails.push(...describeIdMatch(catalogNumber, itemId));
                    scoreParts.push(`item-# similarity ${idScore}% → ${Math.round(idScore * 0.7)} pts`);
                }

                if (score === 0 && markUsable) {
                    const markScore = calculateMatchScore(mark, itemId);
                    if (markScore >= 70) {
                        score += markScore * 0.2;
                        reasons.push(`Mark match: ${markScore}%`);
                        scoreParts.push(`mark similarity ${markScore}% → ${Math.round(markScore * 0.2)} pts`);
                    }
                }
            }

            if (category) {
                // The reverse containment needs a real mark: category "Sconce"
                // .includes("c") handed +10 to everything for 1-char marks.
                if (mark.toLowerCase().includes(category.toLowerCase()) ||
                    (markUsable && category.toLowerCase().includes(mark.toLowerCase()))) {
                    score += 10;
                    reasons.push('Category match');
                    scoreParts.push('category named in mark → 10 pts');
                }
                // Category is always stated on the card, with the spec-side
                // verdict: candidates here have already passed the category
                // gate whenever the spec's category is known.
                matchDetails.push(inferredCategory
                    ? `Category: ${category} — compatible with the spec's (${inferredCategory})`
                    : `Category: ${category} (spec's category unknown — no category check possible)`);
            }

            if (item.timesUsed > 0) {
                score += Math.min(10, item.timesUsed);
                matchDetails.push(`Used ${item.timesUsed} time${item.timesUsed > 1 ? 's' : ''} before`);
                scoreParts.push(`prior usage → ${Math.min(10, item.timesUsed)} pts`);
            }

            if (score >= 20) {
                matchDetails.push(`Score ${Math.round(score)}: ${scoreParts.join(' + ')}`);
                const itemAttributes: ItemAttributes = {
                    category: category || undefined,
                    productCategory: category || undefined,
                    finish: item.finish || undefined,
                    colorTemp: item.colorTemp || undefined,
                    wattage: item.maxWattage || undefined,
                    lightOutput: item.lightOutput || undefined,
                };

                recommendations.push({
                    id: item.id,
                    source: 'Premier Items',
                    matchType: score >= 70 ? 'exact' : score >= 40 ? 'fuzzy' : 'partial',
                    confidence: Math.min(100, Math.round(score)),
                    premierItem: itemId || undefined,
                    recordId: item.id,
                    matchReason: reasons.join('; '),
                    itemAttributes,
                    matchDetails,
                    productCategory: category || undefined,
                    premierLinkId: item.id,
                });
            }
        }

        // ── 3rd Party direct matching (3rd & Flower review, 2026-07-30) ──────
        // Premier resells these items, but they previously had NO direct
        // text-match tier — only history links and the token fallback (capped
        // 60). A Minka fan spec F896-65-CL sat one finish code away from
        // catalog item F896-65-WHF and scored 15 while a fan DOWNROD from
        // history outranked it. Mirror the Premier block: catalog-number
        // evidence only (no mark rescue — the weaker tier earns no leniency),
        // same category/dimension/accessory gates, no own-brand bonus.
        //
        // When the spec IS a resold item (exact normalized id match), the
        // right card is "carry as spec", not a sibling variant: siblings of an
        // item we already stock are noise, and a variant pre-checked at fuzzy
        // confidence would write a phantom swap to History on export. Premier
        // own-brand upsell is unaffected — the Premier block above already ran.
        const resoldAsSpec = normalizedCatalog.length >= 6
            ? ctx.thirdPartyItems.find(t => !isLampCatalogItem(t) && normalizeProductId(t.itemId) === normalizedCatalog)
            : undefined;
        if (resoldAsSpec) {
            recommendations.push({
                id: resoldAsSpec.id,
                source: '3rd Party',
                matchType: 'exact',
                confidence: 99,
                premierItem: catalogNumber,
                recordId: resoldAsSpec.id,
                matchReason: 'Already a resold 3rd-party item — no substitution needed',
                itemAttributes: {
                    category: resoldAsSpec.productCategories || undefined,
                    finish: resoldAsSpec.finish || undefined,
                    colorTemp: resoldAsSpec.colorTemp || undefined,
                    wattage: resoldAsSpec.maxWattage || undefined,
                    manufacturer: resoldAsSpec.manufacturer || undefined,
                },
                matchDetails: [
                    'Catalog # is an exact match to a resold 3rd-party Item ID',
                    'Premier already carries this product — quote as specified',
                ],
                productCategory: resoldAsSpec.productCategories || undefined,
                thirdPartyLinkId: resoldAsSpec.id,
                isPassthrough: true,
            });
        }
        for (const item of resoldAsSpec ? [] : ctx.thirdPartyItems) {
            const itemId = item.itemId;
            if (!itemId) continue;
            // Lamps are never fixture substitutions (SATCO rule).
            if (isLampCatalogItem(item)) continue;
            if (inferredCategory && item.productCategories &&
                !thirdPartyCategoriesCompatible(inferredCategory, item.productCategories)) continue;
            if (!dimensionsCompatible(specDimensionText, `${itemId} ${item.itemDescription}`)) continue;
            // Fan SKUs carry their blade span as a bare 2-digit token the
            // generic extractor can't see (F896-84 vs F896-65).
            if (inferredCategory === 'Ceiling Fan' &&
                !fanSpansCompatible(catalogNumber, itemId)) continue;
            if (!allowAccessories && isAccessoryItem(itemId, item.itemDescription)) continue;

            const normalizedItemId = normalizeProductId(itemId);
            if (normalizedItemId === normalizedCatalog && normalizedCatalog.length >= 6) continue;

            const idScore = calculateCatalogMatchScore(catalogNumber, itemId);
            const score = idScore * 0.7;
            // Floor at 50 (idScore ≈ 72): this tier exists for near-exact
            // family matches only. Anything weaker both reads as junk AND —
            // by existing at all — preempts the in-category most-used
            // fallback, which the eval showed was often the better answer
            // (ASCENT SMD6 cases lost their correct top-1 to 35-point cards).
            if (score < 50) continue;

            recommendations.push({
                id: item.id,
                source: '3rd Party',
                matchType: score >= 70 ? 'exact' : 'fuzzy',
                confidence: Math.min(100, Math.round(score)),
                premierItem: itemId,
                recordId: item.id,
                matchReason: `Item ID match: ${idScore}% (3rd-party catalog)`,
                itemAttributes: {
                    category: item.productCategories || undefined,
                    finish: item.finish || undefined,
                    colorTemp: item.colorTemp || undefined,
                    wattage: item.maxWattage || undefined,
                    lightOutput: item.lightOutput || undefined,
                    manufacturer: item.manufacturer || undefined,
                },
                matchDetails: [
                    ...describeIdMatch(catalogNumber, itemId),
                    ...(item.productCategories ? [inferredCategory
                        ? `Category: ${item.productCategories} — compatible with the spec's (${inferredCategory})`
                        : `Category: ${item.productCategories} (spec's category unknown — no category check possible)`] : []),
                    ...(item.manufacturer ? [`3rd-party: ${item.manufacturer}`] : []),
                    `Score ${Math.round(score)}: item-# similarity ${idScore}% → ${Math.round(idScore * 0.7)} pts`,
                ],
                productCategory: item.productCategories || undefined,
                thirdPartyLinkId: item.id,
            });
        }
    }

    // ── Fans matching ─────────────────────────────────────────────────────────
    // Only search the fans table if this item actually looks like a ceiling fan.
    // This prevents fan recommendations from appearing on vanity bars, streetlights, etc.
    const itemLooksLikeFan = inferredCategory === 'Ceiling Fan';

    // Skip fan searches entirely if we already have good history matches
    const skipFanSearch = hasHistoryMatches &&
        recommendations.filter(r => r.source === 'History' && !r.familyMatch).length >= 2;

    if (ctx.fans.length > 0 && itemLooksLikeFan && !skipFanSearch) {
        const normalizedCatalog = normalizeProductId(catalogNumber);

        for (const fan of ctx.fans) {
            let score = 0;
            const reasons: string[] = [];
            const matchDetails: string[] = [];

            const itemNumber = fan.itemNumber;

            if (!dimensionsCompatible(specDimensionText, `${itemNumber} ${fan.fanSize}`)) continue;

            if (itemNumber) {
                const normalizedItemNum = normalizeProductId(itemNumber);
                if (normalizedItemNum === normalizedCatalog && normalizedCatalog.length >= 6) {
                    continue;
                }

                const itemScore = calculateCatalogMatchScore(catalogNumber, itemNumber);
                if (itemScore >= 40) {
                    score += itemScore * 0.8;
                    reasons.push(`Item number match: ${itemScore}%`);
                    matchDetails.push(...describeIdMatch(catalogNumber, itemNumber));
                }

                if (score === 0 && normalizeProductId(mark).length >= 3) {
                    const markScore = calculateMatchScore(mark, itemNumber);
                    if (markScore >= 70) {
                        score += markScore * 0.2;
                        reasons.push(`Mark match: ${markScore}%`);
                    }
                }
            }

            if (score >= 35) {
                const itemAttributes: ItemAttributes = {
                    category: fan.fanSize ? `${fan.fanSize} Fan` : 'Ceiling Fan',
                    productCategory: 'Ceiling Fan',
                    finish: fan.housingFinish || fan.bladeFinish || undefined,
                    fanSize: fan.fanSize || undefined,
                    bladeCount: fan.bladeCount ?? undefined,
                    hasLight: fan.light === 'Yes',
                };

                if (fan.bladeCount) {
                    matchDetails.push(`${fan.bladeCount} blade${fan.bladeCount !== 1 ? 's' : ''}`);
                }
                if (fan.light === 'Yes') {
                    matchDetails.push('Includes light kit');
                }
                if (fan.fanSize) {
                    matchDetails.push(`Size: ${fan.fanSize}`);
                }

                recommendations.push({
                    id: fan.id,
                    source: 'Fans',
                    matchType: score >= 70 ? 'exact' : score >= 40 ? 'fuzzy' : 'partial',
                    confidence: Math.min(100, Math.round(score)),
                    fanItem: itemNumber || undefined,
                    recordId: fan.id,
                    matchReason: reasons.join('; '),
                    itemAttributes,
                    matchDetails,
                    productCategory: 'Ceiling Fan',
                });
            }
        }
    }

    let hasAnyRecommendations = recommendations.length > 0;

    // ── Already a Premier / Global Concepts Item ──────────────────────────────
    // When the spec IS already one of our items, there is no substitution to
    // recommend. Show an informational card instead of "No recommendations found".
    if (!hasAnyRecommendations && catalogNumber) {
        const normCat = normalizeProductId(catalogNumber);
        if (normCat.length >= 3) {
            const alreadyPremier = ctx.premierItems.find(p => normalizeProductId(p.itemId) === normCat);
            if (alreadyPremier) {
                recommendations.push({
                    id: alreadyPremier.id,
                    source: 'Premier Items',
                    matchType: 'exact',
                    confidence: 99,
                    premierItem: catalogNumber,
                    recordId: alreadyPremier.id,
                    matchReason: 'Already a Premier / Global Concepts item — no substitution needed',
                    itemAttributes: { category: alreadyPremier.fixtureCategory || undefined },
                    matchDetails: [
                        'Catalog # is an exact match to a Premier Item ID',
                        'This is already our product — no VE substitution required',
                    ],
                    productCategory: alreadyPremier.fixtureCategory || undefined,
                    isPassthrough: true,
                });
                hasAnyRecommendations = true;
            }
        }
    }

    // ── Category Fallback (generalized prose fallback) ───────────────────────
    // When nothing matched but the fixture CATEGORY is known, recommend from the
    // Premier catalog inside that category (categoryFallbackRecommendations).
    if (!hasAnyRecommendations && inferredCategory) {
        recommendations.push(...categoryFallbackRecommendations(lineItem, ctx, inferredCategory, specDimensionText, catalogNumber));
        hasAnyRecommendations = recommendations.length > 0;
    }

    // ── Passthrough badge ─────────────────────────────────────────────────────
    // High-end decorative / must-stay-as-spec items are surfaced with a passthrough
    // badge, not dropped and not given a bogus swap.
    if (!hasAnyRecommendations && isPassthroughDecorative(manufacturer, inferredCategory)) {
        recommendations.push({
            id: `passthrough-${lineItem.rowIndex}`,
            source: 'Manual',
            matchType: 'manual',
            confidence: 100,
            bidItem: lineItem.catalogNumber,
            matchReason: '↻ Left as-spec — high-end decorative fixture; carry the specified product',
            matchDetails: [
                `Recognized decorative manufacturer: ${manufacturer}`,
                'No VE substitution offered — quote as specified',
            ],
            isPassthrough: true,
        });
    }

    // Own-brand-first ranking: Premier's own brands get a confidence bonus so they
    // rank above equivalent third-party alternatives. Family matches stay capped:
    // the bonus is a ranking preference, not extra evidence, and family evidence
    // has a sub-authoritative ceiling by design — as does sub-authoritative exact
    // history (the bonus must not push an honest 84% into looking authoritative).
    for (const rec of recommendations) {
        if (!rec.isPassthrough && isPremierOwnBrand(rec)) {
            const cap = rec.familyMatch ? FAMILY_CONFIDENCE_CAP
                : rec.source === 'History' && rec.matchType !== 'exact' ? EXACT_CONFIDENCE_CAP
                    : 100;
            const bumped = Math.min(cap, rec.confidence + OWN_BRAND_BONUS);
            if (bumped !== rec.confidence) {
                rec.confidence = bumped;
                rec.matchDetails = [...(rec.matchDetails ?? []), `Premier own-brand: +${OWN_BRAND_BONUS} ranking preference included`];
            }
        }
    }
    recommendations.sort(compareRecommendations);

    let dedupedRecommendations = deduplicateRecommendations(recommendations, catalogNumber);

    // Dedupe can delete every candidate (the "don't recommend the input back"
    // rule) AFTER the fallback decision was made on the pre-dedupe list — the
    // line would end silent even though its category is known (MedSpa line A:
    // "RECESSED DOWNLIGHT" admitted a same-name item, dedupe removed it). Retry
    // with the in-category fallback so a known category never ends empty.
    if (dedupedRecommendations.length === 0 && recommendations.length > 0 && inferredCategory) {
        const retry = categoryFallbackRecommendations(lineItem, ctx, inferredCategory, specDimensionText, catalogNumber);
        for (const rec of retry) {
            if (!rec.isPassthrough && isPremierOwnBrand(rec)) {
                rec.confidence = Math.min(100, rec.confidence + OWN_BRAND_BONUS);
            }
        }
        retry.sort(compareRecommendations);
        dedupedRecommendations = deduplicateRecommendations(retry, catalogNumber);
    }

    return { lineItem, recommendations: dedupedRecommendations.slice(0, 3), specCategory: inferredCategory };
}

/** Batch orchestration for the /api/recommendations route. */
export function analyzeLineItems(lineItems: ParsedLineItem[], ctx: EngineContext): LineItemAnalysis[] {
    return lineItems.map(item => analyzeLineItem(item, ctx));
}
