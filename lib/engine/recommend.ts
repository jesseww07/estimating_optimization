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
    calculateCatalogMatchScore,
    calculateMatchScore,
    detectFixtureCategory,
    dimensionsCompatible,
    isLedTape,
    isUrlLike,
    looksLikeProse,
    normalizeProductId,
    normalizeSpecKey,
} from './matcher';
import {
    OWN_BRAND_BONUS,
    compareRecommendations,
    deduplicateRecommendations,
    isPremierOwnBrand,
    recencyWeight,
} from './ranking';

export interface LineItemAnalysis {
    lineItem: ParsedLineItem;
    recommendations: Recommendation[];
    /** Set when recommendations are intentionally empty (e.g. LED tape suppression). */
    infoMessage?: string;
}

/** Number of true matching swaps at which a history match becomes authoritative. */
const AUTHORITATIVE_SWAP_COUNT = 3;
/** Confidence floor for authoritative matches. */
const AUTHORITATIVE_CONFIDENCE = 95;

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
 * Parity-runner entry point (BIND 1): one parsed line item + the data context,
 * returns Recommendation[] ranked best-first.
 */
export function recommendForLineItem(lineItem: ParsedLineItem, ctx: EngineContext): Recommendation[] {
    return analyzeLineItem(lineItem, ctx).recommendations;
}

export function analyzeLineItem(lineItem: ParsedLineItem, ctx: EngineContext): LineItemAnalysis {
    const recommendations: Recommendation[] = [];
    const { mark, manufacturer } = lineItem;

    // URL-as-catalog protection: a pasted spec-sheet link must never drive matching.
    const catalogNumber = isUrlLike(lineItem.catalogNumber) ? '' : lineItem.catalogNumber;

    // LED tape is suppressed with an informational message, not given swap recs.
    if (isLedTape(mark, lineItem.catalogNumber, manufacturer)) {
        return {
            lineItem,
            recommendations: [],
            infoMessage: 'LED tape — bid as specified. Tape runs are project-specific (channel, driver, footage); no VE substitution is offered.',
        };
    }

    // Extract fixture type hint from any raw column that holds a short fixture-type label.
    // Many bid trackers repurpose columns (e.g. "QTY LAMPS") to hold values like
    // "VANITY", "FAN", "POST TOP", "DISC" — use these to sharpen category detection.
    const FIXTURE_HINT_RE = /^(fan|ceiling fan|vanity|bath bar|pendant|sconce|can|recessed|disc|disk|downlight|linear|strip|strip light|canopy|troffer|surface|flush|semi|semi-flush|post top|post|outdoor|bollard|pole|exit|exit sign|emergency|egress|up.?down|wall pack|flood|area light|closet|shelf|cabinet)$/i;
    const fixtureTypeHint = Object.values(lineItem.rawRow).find(v => {
        const t = (v || '').trim();
        return t.length >= 3 && t.length <= 20 && FIXTURE_HINT_RE.test(t);
    }) || '';

    // Infer fixture category once — used to gate Fans and Premier Items matching
    const inferredCategory = detectFixtureCategory(mark, catalogNumber, manufacturer, fixtureTypeHint);

    // The dimension signature the spec exposes — candidates are gated against this.
    const specDimensionText = `${mark} ${catalogNumber}`;

    // ── History matching ──────────────────────────────────────────────────────
    interface BidItemMatchData {
        score: number;
        rows: HistoryRow[];
        historyMatches: HistoryMatch[];
        reasons: string[];
        hasCatalogMatch: boolean;
        productCategory?: string;
    }
    const bidItemMatchMap = new Map<string, BidItemMatchData>();

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

        const specMfr = row.specManufacturer || row.specMfrBackup || '';
        const bidMfr = row.bidManufacturer || row.bidMfrBackup || '';

        const specScore = calculateCatalogMatchScore(catalogNumber, row.originalSpec);

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
        if (score >= minScoreThreshold) {
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
                    productCategory: row.productCategory || undefined,
                });
            }
        }
    }

    // History lookup key: the NORMALIZED input catalog — whitespace/case/punctuation
    // variance must not break the match (normalized-history-match).
    const normalizedInputCatalog = normalizeSpecKey(catalogNumber);
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
        if (!data.hasCatalogMatch) continue;

        const trueMatchingSwaps = data.historyMatches.filter(h => {
            const normalizedSpec = normalizeSpecKey(h.originalSpec);
            const normalizedBid = normalizeProductId(h.bidItem);
            const recommendedBid = normalizeProductId(bidItemValue);
            return normalizedSpec === normalizedInputCatalog &&
                normalizedBid === recommendedBid &&
                normalizedInputCatalog.length >= 6;
        });

        if (trueMatchingSwaps.length === 0) continue;

        const bidProductCategory = data.productCategory || '';
        const uniqueProjects = [...new Set(trueMatchingSwaps.map(h => h.project).filter(Boolean))];
        const matchingSwapCount = trueMatchingSwaps.length;

        // Recency-weighted swap mass: recent swaps carry full weight, stale ones decay.
        const weightedSwaps = trueMatchingSwaps.reduce(
            (sum, h) => sum + recencyWeight(h.bidDate, ctx.referenceDate), 0);
        const confidenceScore = Math.min(100, Math.round(weightedSwaps * 20));

        const matchDetails: string[] = [];
        matchDetails.push(`${matchingSwapCount} matching swap${matchingSwapCount > 1 ? 's' : ''}: same spec → same bid item`);
        if (uniqueProjects.length > 0) {
            matchDetails.push(`Projects: ${uniqueProjects.join(', ')}`);
        }

        const firstMatch = trueMatchingSwaps[0];

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

        let itemAttributes: ItemAttributes | undefined;
        let resolvedItemId: string | undefined;
        let resolvedItemText = '';
        let timesUsedBonus = 0;

        if (resolvedPremier) {
            resolvedItemId = resolvedPremier.itemId || undefined;
            resolvedItemText = `${resolvedPremier.itemId} ${resolvedPremier.itemDescription}`;
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

        const isAuthoritative = matchingSwapCount >= AUTHORITATIVE_SWAP_COUNT;

        // Dimension hard-gate for sub-authoritative history matches: block a linked
        // catalog item that is dimensionally incompatible with the spec. 3+ real
        // estimator decisions (authoritative) outrank the heuristic and pass through.
        if (!isAuthoritative && resolvedItemText &&
            !dimensionsCompatible(specDimensionText, resolvedItemText)) {
            continue;
        }

        let adjustedConfidence = Math.min(100, confidenceScore + timesUsedBonus);
        let matchReason = `${matchingSwapCount} matching swap${matchingSwapCount > 1 ? 's' : ''} in history`;
        if (isAuthoritative) {
            // Authoritative tier: the same spec→item swap made 3+ times is settled
            // precedent — floor at 95% and label it.
            adjustedConfidence = Math.max(AUTHORITATIVE_CONFIDENCE, adjustedConfidence);
            matchReason = `✓ Bid ${matchingSwapCount} times — same spec → same item`;
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
            historyMatches: trueMatchingSwaps,
            swapCount: matchingSwapCount,
            exactMatchCount: matchingSwapCount,
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
        });
    }

    // ── Premier Items direct matching ─────────────────────────────────────────
    // Only fall back to direct Premier SKU text-matching when History produced no
    // results and the catalog number already looks like a Premier item number
    // (estimator re-uploaded a Premier bid).
    const hasHistoryMatches = recommendations.some(r => r.source === 'History' && r.bidItem && r.bidItem.length > 3);

    if (!hasHistoryMatches) {
        const normalizedCatalog = normalizeProductId(catalogNumber);

        for (const item of ctx.premierItems) {
            let score = 0;
            const reasons: string[] = [];
            const matchDetails: string[] = [];

            const itemId = item.itemId;
            const category = item.fixtureCategory;

            // If we have a confident fixture category inference, skip Premier Items
            // that are clearly in a different category.
            if (inferredCategory && category) {
                const catNorm = category.toLowerCase();
                const infNorm = inferredCategory.toLowerCase();
                const categoryMismatch = !catNorm.includes(infNorm) && !infNorm.includes(catNorm);
                if (categoryMismatch) continue;
            }

            // Dimension hard-gate: a candidate matching on category but dimensionally
            // incompatible must be blocked, not just demoted.
            if (!dimensionsCompatible(specDimensionText, `${itemId} ${item.itemDescription}`)) continue;

            if (itemId) {
                const normalizedItemId = normalizeProductId(itemId);
                if (normalizedItemId === normalizedCatalog && normalizedCatalog.length >= 6) {
                    continue;
                }

                const idScore = calculateCatalogMatchScore(catalogNumber, itemId);
                if (idScore >= 40) {
                    score += idScore * 0.7;
                    reasons.push(`Item ID match: ${idScore}%`);
                    if (idScore >= 50) {
                        matchDetails.push(`Item ID "${itemId}" matches input`);
                    }
                }

                if (score === 0 && mark) {
                    const markScore = calculateMatchScore(mark, itemId);
                    if (markScore >= 70) {
                        score += markScore * 0.2;
                        reasons.push(`Mark match: ${markScore}%`);
                    }
                }
            }

            if (category) {
                if (mark.toLowerCase().includes(category.toLowerCase()) ||
                    category.toLowerCase().includes(mark.toLowerCase())) {
                    score += 10;
                    reasons.push('Category match');
                    matchDetails.push(`Category: ${category}`);
                }
            }

            if (item.timesUsed > 0) {
                score += Math.min(10, item.timesUsed);
                matchDetails.push(`Used ${item.timesUsed} time${item.timesUsed > 1 ? 's' : ''} before`);
            }

            if (score >= 20) {
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
                });
            }
        }
    }

    // ── Fans matching ─────────────────────────────────────────────────────────
    // Only search the fans table if this item actually looks like a ceiling fan.
    // This prevents fan recommendations from appearing on vanity bars, streetlights, etc.
    const itemLooksLikeFan = inferredCategory === 'Ceiling Fan';

    // Skip fan searches entirely if we already have good history matches
    const skipFanSearch = hasHistoryMatches && recommendations.filter(r => r.source === 'History').length >= 2;

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
                    if (itemScore >= 50) {
                        matchDetails.push(`Item "${itemNumber}" matches input`);
                    }
                }

                if (score === 0 && mark) {
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
    const catalogIsProse = looksLikeProse(catalogNumber);

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

    // ── Prose Description Fallback ────────────────────────────────────────────
    // When the catalog number is plain English (e.g. "CRETE 7 1/2" W LED LARGE
    // CONCRETE TIER MINI PENDANT") rather than a structured part number,
    // text-matching against Premier Item IDs always returns 0. In this case, if we
    // have an inferred category, search Premier Items by category match + keyword
    // overlap from the description.
    const markIsProse = looksLikeProse(mark);
    if (!hasAnyRecommendations && (catalogIsProse || markIsProse) && inferredCategory) {
        const stopWords = new Set(['AND', 'OR', 'THE', 'FOR', 'WITH', 'NOT', 'LED', 'A', 'AN', 'IN', 'OF', 'W', 'X', 'FAN', 'LIGHT', 'FIXTURE']);
        const tokenSource = catalogIsProse ? catalogNumber : mark;
        const proseTokens = tokenSource.toUpperCase()
            .split(/[\s\-\/,()'"]+/)
            .filter(t => t.length >= 3 && !stopWords.has(t) && !/^\d+(\.\d+)?["']?$/.test(t));

        const proseCandidates: Array<{ score: number; item: (typeof ctx.premierItems)[number]; itemAttributes: ItemAttributes }> = [];

        for (const item of ctx.premierItems) {
            const category = item.fixtureCategory;

            // Must match inferred category
            if (!category) continue;
            const catNorm = category.toLowerCase();
            const infNorm = inferredCategory.toLowerCase();
            if (!catNorm.includes(infNorm) && !infNorm.includes(catNorm)) continue;

            // Dimension hard-gate applies to prose-matched candidates too.
            if (!dimensionsCompatible(specDimensionText, `${item.itemId} ${item.itemDescription}`)) continue;

            // Score by token overlap with item ID + description
            const searchTarget = (item.itemId + ' ' + item.itemDescription).toUpperCase();
            let tokenScore = 0;
            for (const token of proseTokens) {
                if (searchTarget.includes(token)) tokenScore++;
            }

            const usageBonus = Math.min(10, Math.floor(item.timesUsed / 2));

            const totalScore = tokenScore * 8 + usageBonus;
            if (totalScore >= 8) { // at least 1 token match
                proseCandidates.push({
                    score: totalScore,
                    item,
                    itemAttributes: {
                        category: category || undefined,
                        finish: item.finish || undefined,
                        colorTemp: item.colorTemp || undefined,
                        wattage: item.maxWattage || undefined,
                    },
                });
            }
        }

        proseCandidates.sort((a, b) => b.score - a.score);
        for (const cand of proseCandidates.slice(0, 3)) {
            recommendations.push({
                id: cand.item.id,
                source: 'Premier Items',
                matchType: 'partial',
                confidence: Math.min(60, cand.score), // cap at 60 — prose matching is imprecise
                premierItem: cand.item.itemId || undefined,
                recordId: cand.item.id,
                matchReason: `Category match: ${inferredCategory} (description-based)`,
                itemAttributes: cand.itemAttributes,
                matchDetails: [`Category: ${cand.item.fixtureCategory}`, 'Matched from prose description'],
                productCategory: cand.item.fixtureCategory || undefined,
            });
        }
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
    // rank above equivalent third-party alternatives.
    for (const rec of recommendations) {
        if (!rec.isPassthrough && isPremierOwnBrand(rec)) {
            rec.confidence = Math.min(100, rec.confidence + OWN_BRAND_BONUS);
        }
    }
    recommendations.sort(compareRecommendations);

    const dedupedRecommendations = deduplicateRecommendations(recommendations, catalogNumber);
    return { lineItem, recommendations: dedupedRecommendations.slice(0, 3) };
}

/** Batch orchestration for the /api/recommendations route. */
export function analyzeLineItems(lineItems: ParsedLineItem[], ctx: EngineContext): LineItemAnalysis[] {
    return lineItems.map(item => analyzeLineItem(item, ctx));
}
