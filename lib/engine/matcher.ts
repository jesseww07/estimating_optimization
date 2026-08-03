/**
 * Pure matching/scoring functions for the VE engine.
 * Ported from harvest/index.tsx (~788–1085). No React, no Airtable, no Next.
 */

// ── Text similarity (harvest ~788) ───────────────────────────────────────────

export function calculateMatchScore(searchTerm: string, target: string): number {
    if (!searchTerm || !target) return 0;

    const normalizedSearch = searchTerm.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedTarget = target.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (normalizedSearch === normalizedTarget) return 100;
    if (normalizedTarget.includes(normalizedSearch)) return 85;
    if (normalizedSearch.includes(normalizedTarget)) return 75;

    const searchParts = searchTerm.toLowerCase().split(/[\s\-_\/]+/).filter(p => p.length > 1);
    const targetParts = target.toLowerCase().split(/[\s\-_\/]+/).filter(p => p.length > 1);

    let matchedParts = 0;
    for (const part of searchParts) {
        if (targetParts.some(tp => tp.includes(part) || part.includes(tp))) {
            matchedParts++;
        }
    }

    if (searchParts.length > 0) {
        return Math.round((matchedParts / searchParts.length) * 60);
    }

    return 0;
}

export function normalizeProductId(id: string): string {
    if (!id) return '';
    return id.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The history-lookup key: normalized Original Spec / input catalog #.
 * Whitespace, case, and punctuation variance must not break the O(1) lookup —
 * this is the "normalized-history-match" must-survive behavior.
 */
export function normalizeSpecKey(spec: string): string {
    return normalizeProductId(spec);
}

// Tokens too generic to carry a text match on their own: "CANNELE PICTURE
// LIGHT" must not reach 43% against "MOUNTING CLIPS FOR TAPE LIGHT" because
// both contain "LIGHT" (Collective MedSpa L7). Category/attribute matching owns
// these words; the token matcher only gets distinctive ones.
// Color/finish words joined the list after the 3rd & Flower review (2026-07-30):
// "APLOMB GREY" must not reach 65% against "HEIR CUSTOM-JAIMA 43 -GREY" on the
// strength of GREY alone — finishes are attributes, not identity.
const GENERIC_MATCH_TOKENS = new Set([
    'LIGHT', 'LED', 'FIXTURE', 'MOUNT', 'KIT', 'WITH', 'THE', 'FOR', 'AND',
    'BLACK', 'WHITE', 'GREY', 'GRAY', 'BRONZE', 'COPPER', 'NICKEL', 'BRASS',
    'CHROME', 'GOLD', 'SATIN', 'MATTE', 'GLOSSY', 'BRUSHED', 'FINISH',
]);

export function calculateCatalogMatchScore(catalogNumber: string, originalSpec: string): number {
    if (!catalogNumber || !originalSpec) return 0;

    const normCatalog = catalogNumber.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normSpec = originalSpec.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (normCatalog === normSpec) return 100;
    if (normSpec.includes(normCatalog) && normCatalog.length >= 8) return 90;
    if (normCatalog.includes(normSpec) && normSpec.length >= 8) return 85;

    const catalogParts = catalogNumber.toUpperCase().split(/[-_\/\s]+/).filter(p => p.length >= 2);
    const specParts = originalSpec.toUpperCase().split(/[-_\/\s]+/).filter(p => p.length >= 2);

    if (catalogParts.length === 0 || specParts.length === 0) return 0;

    let exactMatches = 0;
    let partialMatches = 0;
    const significantParts = catalogParts.filter(
        p => p.length >= 3 && !/^\d+$/.test(p) && !GENERIC_MATCH_TOKENS.has(p),
    );

    for (const catalogPart of significantParts) {
        for (const specPart of specParts) {
            if (catalogPart === specPart) {
                exactMatches++;
                break;
            } else if (specPart.includes(catalogPart) || catalogPart.includes(specPart)) {
                partialMatches++;
                break;
            }
        }
    }

    if (significantParts.length === 0) return 0;

    const matchRatio = (exactMatches + partialMatches * 0.5) / significantParts.length;

    if (matchRatio >= 0.8 && exactMatches >= 2) return Math.round(75 + matchRatio * 20);
    if (matchRatio >= 0.5 && exactMatches >= 1) return Math.round(50 + matchRatio * 30);
    // The lowest tier needs real evidence too: a single significant token whose
    // only hit is a partial substring ("CS6964" ⊃ "CS", "HALO" ⊃ "AL") scored
    // 50 on the 3rd & Flower sheet and surfaced pure junk. One exact token, or
    // corroboration across two significant tokens, is the floor.
    if (matchRatio >= 0.3 && (exactMatches >= 1 || significantParts.length >= 2)) {
        return Math.round(30 + matchRatio * 40);
    }

    return 0;
}

// ── Fixture category detection (harvest ~944) ────────────────────────────────

/**
 * Infers the fixture category from the mark, catalog number, and manufacturer.
 * Returns a broad category string used to filter recommendations, or null if unknown.
 * Categories must match values used in Premier Items "Fixture Category" field.
 */
export function detectFixtureCategory(mark: string, catalogNumber: string, manufacturer: string, fixtureTypeHint?: string): string | null {
    // Normalize inputs — bid files are manually typed, capitalization is inconsistent.
    const m = mark.toUpperCase();
    const c = catalogNumber.toUpperCase();
    const mfr = manufacturer.toUpperCase();

    // ── Fixture Type Column Hint (highest priority) ──────────────────────────
    // When the bid tracker has a dedicated fixture-type column (e.g. "QTY LAMPS"
    // repurposed as a fixture category label), use it directly.
    if (fixtureTypeHint) {
        const h = fixtureTypeHint.toUpperCase().trim();
        if (/^(FAN|CEILING FAN)$/.test(h)) return 'Ceiling Fan';
        if (/^(VANITY|BATH BAR)$/.test(h)) return 'Vanity';
        if (/^PENDANT$/.test(h)) return 'Pendant';
        if (/^(SCONCE|WALL SCONCE)$/.test(h)) return 'Sconce';
        if (/^(CAN|RECESSED|DISC|DISK|DOWNLIGHT)$/.test(h)) return 'Recessed';
        if (/^(LINEAR|STRIP|TROFFER|UNDERCAB|STRIP LIGHT)$/.test(h)) return 'Linear';
        if (/^(CANOPY|SURFACE|FLUSH|SEMI|SEMI-FLUSH)$/.test(h)) return 'Ceiling';
        if (/^(OUTDOOR|POLE|POST TOP|POST|BOLLARD|AREA LIGHT|FLOOD|WALL PACK|SHOEBOX)$/.test(h)) return 'Outdoor';
        if (/^(EXIT|EMERGENCY|EGRESS|EXIT SIGN)$/.test(h)) return 'Exit/Emergency';
        if (/^(UP.?DOWN|UP\/DOWN)$/.test(h)) return 'Sconce';
        if (/^(CLOSET|SHELF|CABINET)$/.test(h)) return 'Linear';
    }

    // ── Prose Detection from Mark Field ──────────────────────────────────────
    // Mark fields often contain natural-language descriptions, e.g.:
    //   "D (bedroom ceiling fan)", "B (sgl vanity)", "CABINET LED - 3'0""
    // Handle non-catalog items first so they aren't misrouted.
    if (/EXHAUST\s*FAN/i.test(mark) || /EXHAUST\s*FAN/.test(c)) return null; // exhaust fans not in catalog
    if (/SMOKE|CARBON\s*MONO/i.test(mark) && !/LIGHT|FIXTURE/.test(m)) return null; // smoke/CO detectors
    if (/CEILING\s*FAN|BEDROOM.*FAN/i.test(mark)) return 'Ceiling Fan';
    if (/\b(SGL|DBL|DOUBLE|SINGLE|DUAL)\s*VANITY/i.test(mark)) return 'Vanity';
    if (/CABINET\s*LED|UNDER\s*CAB/i.test(mark)) return 'Undercabinet';

    // ── High-signal words — checked against BOTH mark and catalog ─────────────
    // Bid sheets carry the identifying word wherever the estimator typed it
    // ("U-WM1 - 24"X36" Backlit Mirror", "U-SS1B - 22" Vanity", "OP1A - 20' POLE").
    // The Camino Del Rio review showed these misrouted when only the catalog was
    // checked. Order matters: mirror before vanity ("vanity mirror" is a mirror),
    // both before the generic mark-code chains below.
    const t = `${m} ${c}`;
    // Electric Mirror is a mirror manufacturer — brand alone identifies the category
    // (Candlewood review 2026-07-28: their Front Lit-Mirror lines misrouted to Vanity).
    if (/BACK.?LIT|LED\s*MIRROR|\bMIRROR\b/.test(t) || mfr.includes('ELECTRIC MIRROR')) return 'Mirror';
    if (/\bVANITY\b|\bBATH\s*BAR\b/.test(t)) return 'Vanity';
    // Site poles & heads: an entire department builds these for every job — they
    // must always classify so the in-category fallback can offer Premier builds.
    if (/\bPOLE\b|\bPOST\s*TOP\b|\bBOLLARD\b|\b(SGL|DBL|SINGLE|DOUBLE|TWIN|QUAD)\s*HEAD\b/.test(t) || /^OP\d/.test(m)) {
        return 'Outdoor Pole';
    }
    // Undercabinet fixtures (U-UC marks, AFX ELNU series) — a real category in the
    // Premier vocabulary, distinct from tape.
    if (/\bU?-?UC\d/.test(m) || /^ELNU|UNDERCAB/.test(c)) return 'Undercabinet';
    // Unit surface disks (U-SD/SDE marks, LITON LCMPD series) — Premier Disk Light territory.
    if (/\bU-SDE?\d|\bSDE?\d+\s*\(/.test(m) || /^LCMPD/.test(c)) return 'Recessed';

    // ── Ceiling Fan ────────────────────────────────────────────────────────────
    // Must be tested FIRST — CLF, CF, and fan-brand mfrs are unambiguous.
    // Checking catalog for "CEILING FAN" also catches prose-description rows.
    const isFan =
        /\bCLF\b/.test(m) ||                     // U2-CLF-1, U1-CLF-1
        /\bCF\b/.test(m) ||                      // CF-1, CF-2
        /\bFAN\b/.test(m) ||
        /\bFAN\b/.test(c) ||                     // "FAN CABANA" (3rd & Flower LS4)
        // Fan described by attributes, never by the word: '50" (3) BLADES
        // LIGHT KIT ENERGY STAR' (3rd & Flower UF). Blade count + light kit /
        // a 2-digit-inch span is unambiguous fan vocabulary.
        (/\bBLADES?\b/.test(c) && (/LIGHT\s*KIT/.test(c) || /\b\d{2}\s*(?:"|”)/.test(c))) ||
        /^CF[-_\d]/.test(c) ||                   // CF-006-52-SN..., CF020...
        /CEILING.?FAN/.test(c) ||
        mfr.includes('MINKA') || mfr.includes('MONTE CARLO') ||
        mfr.includes('HUNTER') || mfr.includes('HAMPTON BAY') ||
        mfr.includes('FANIMATION') || mfr.includes('EMERSON') ||
        mfr.includes('MODERN FAN') || mfr.includes('ELLINGTON') ||
        mfr.includes('BIG ASS');
    if (isFan) return 'Ceiling Fan';

    // ── Outdoor / Pole / Area Light ────────────────────────────────────────────
    // P3HS, P4HS, P3, P5 = pole-mounted head fixtures (Signify EcoForm etc.)
    // BO, EX, EM = bollard, exterior, emergency (handled below for exit/em)
    // OL, SL = outdoor light, street light
    // Catalog patterns: SW3-, DSXB (Lithonia shoebox), ECF-S (Signify area), LPW (sconce but outdoor)
    const isOutdoor =
        /^P\d+(-|$|\s)/.test(m) ||               // P3, P4, P3HS, P4HS, P5 (pole marks)
        /\bBO\b/.test(m) ||                      // BO = bollard/outdoor
        /\bSL\b/.test(m) ||                      // SL = street light
        /\bOL\b/.test(m) ||                      // OL = outdoor light
        /\bPT\b/.test(m) ||                      // PT = pole top
        /^ECF/.test(c) ||                          // Signify EcoForm area/street
        /^DSXB|^DSX/.test(c) ||                   // Lithonia shoebox
        /^ALED/.test(c) ||                         // RAB area LED
        /^LNC[-\d]/.test(c) ||                    // Lithonia LNC wall pack (3rd & Flower S1/W1)
        /^SW\d/.test(c) ||                        // SW3-, SW4- (area lights)
        /SHOEBOX|COBRA|COBRAHEAD|AREA.?LIGHT|STREET.?LIGHT|PARKING/.test(c) ||
        /WALL.?PACK|FLOOD.?LIGHT/.test(c) ||
        mfr.includes('EELP') || (mfr.includes('SIGNIFY') && /^ECF|^LPW/.test(c)) ||
        mfr.includes('RAB') || mfr.includes('KIM LIGHTING') ||
        mfr.includes('GARDCO') || mfr.includes('LEOTEK');
    if (isOutdoor) return 'Outdoor';

    // ── Exit / Emergency ───────────────────────────────────────────────────────
    const isExitEmerg =
        /\bEX\d?\b|\bEM\d?\b|\bEMW\b/.test(m) ||
        /^LQM|^ELM|^AF0|^WL4|^LXEM/.test(c) ||   // LXEM = Lithonia LED exit (3rd & Flower mark C)
        // Bare EXIT wording covers "EXIT SINGLE" / "EXIT DOUBLE" placeholder
        // rows — 141 units on 3rd & Flower fell to null and total silence.
        /EXIT.?SIGN|EMERGENCY|EGRESS|\bEXIT\b/.test(c);
    if (isExitEmerg) return 'Exit/Emergency';

    // ── Vanity / Bath Bar ──────────────────────────────────────────────────────
    // V1, VL, U2-FX-1 (mirror/vanity context), bath bar prose descriptions
    const isVanity =
        /\bV\d+\b/.test(m) ||                   // V1, V2, V3
        /\bVL\b|\bVAN\b/.test(m) ||
        /\bBATH\b/.test(m) ||
        /\bVANITY\b|\bBATH.?BAR\b|\bBATH.?LIGHT\b/.test(c) ||
        /\bWIDE.{0,10}(BATH|VANITY)\b/.test(c) || // "36" WIDE BRONZE LED BATH"
        /\bMOD.?POD\b/.test(c) ||
        /\b\d+.?LIGHT.?BATH\b/.test(c) ||
        mfr.includes('TRANS GLOBE') || mfr.includes('TRANSGLOBE');
    if (isVanity) return 'Vanity';

    // ── Pendant / Hanging Light ────────────────────────────────────────────────
    // LT = luminaire/light (U2-LT-1 Kitchen Island), LF = light fixture/pendant
    // Catalog prose: MINI PENDANT, PENDANT, TRAPEZOID (Justice Design pendants)
    const isPendant =
        /\bLT-?\d/.test(m) ||                    // U2-LT-1, U1-LT-1 (kitchen pendants)
        /\bLF-?\d/.test(m) ||                    // LF-1, LF-2, LF-7 (light fixtures/pendants)
        /\bPD\b|\bPEN\b/.test(m) ||
        /PENDANT|MINI.?PENDANT|HANG/.test(c) ||
        // Chandeliers live in the Pendant vocabulary group (CATEGORY_GROUPS);
        // without this branch every "X CHANDELIER" prose spec fell to null and
        // text-matched the whole catalog (Collective MedSpa L2/L3/L8).
        /CHANDELIER/.test(c) ||
        /TRAPEZOID|TIER.?PENDANT|CONE.?PENDANT/.test(c) ||
        /GLOBE.?SUSP|SUSPENSION/.test(c);
    if (isPendant) return 'Pendant';

    // ── Mirror / Decorative ────────────────────────────────────────────────────
    // FX = fixture (often decorative/mirror in multifamily context)
    const isMirror =
        /\bFX-?\d/.test(m) ||                    // U2-FX-1, U1-FX-1
        /\bMIRROR\b/.test(c) ||
        /BACK.?LIT.{0,10}MIRROR|LED.{0,10}MIRROR/.test(c);
    if (isMirror) return 'Mirror';

    // ── Sconce / Wall Mount ────────────────────────────────────────────────────
    const isSconce =
        /\bWS\b|\bSC\b|\bWL\b|\bTR\b|\bW\d+\b/.test(m) ||
        /SCONCE|WALL.?LIGHT|WALL.?MOUNT/.test(c) ||
        /^WS-|^LPW/.test(c);
    if (isSconce) return 'Sconce';

    // ── Recessed Downlight ─────────────────────────────────────────────────────
    const isRecessed =
        /\bR\d+[A-Z]?\b/.test(m) ||             // R6H, R4, R6
        /\bRD\b|\bREC\b/.test(m) ||
        /RECESSED|DOWNLIGHT|CAN.?LIGHT|SLIM.?SURFACE|SLIM.?DISK/.test(c) ||
        /^SMD|^SLD/.test(c);                       // Halo/Cooper SMD series
    if (isRecessed) return 'Recessed';

    // ── Linear / Strip / Troffer ───────────────────────────────────────────────
    const isLinear =
        /\bF\d+\b|\bLIN\b|\bSTRIP\b|\bTROF\b/.test(m) || // F1E, F2, F4
        /LINEAR|STRIP|TROFFER|LED.?STRIP|UNDERCAB/.test(c) ||
        /^LBL|^WL4|^ZL2/.test(c) ||               // Lithonia linear products
        /^CSVT|^BLWP|^BLW\d/.test(c) ||           // Lithonia vapor-tight / wall-bracket linear (building lights → EFS/EFV family)
        /VAPOR.?TIGHT|STAIRWELL|STAIRCASE/.test(c);
    if (isLinear) return 'Linear';

    // ── Ceiling / Flush Mount ──────────────────────────────────────────────────
    const isCeiling =
        /\bCL\b|\bCM\b|\bSF\b|\bFM\b/.test(m) ||
        /FLUSH.?MOUNT|SEMI.?FLUSH|CLOSE.?TO.?CEIL|CEILING.?MOUNT/.test(c);
    if (isCeiling) return 'Ceiling';

    return null;
}

// ── Prose detection (harvest ~1812, hoisted) ─────────────────────────────────

/**
 * True when a spec string reads as an English description rather than a
 * structured part number (e.g. `CRETE 7 1/2" W LED LARGE CONCRETE TIER MINI
 * PENDANT`). Drives the prose-token fallback search.
 */
export function looksLikeProse(s: string): boolean {
    if (!s || s.length < 8) return false;
    const upper = s.toUpperCase();
    // Skip strings that look like backend logic / code fragments
    // e.g., "if it's a fan" should never become a recommendation
    if (/^if\s+(it|this|the)/i.test(s.trim())) return false;
    if (/function|return|const|let|var|=>|===|\?\s*:/i.test(s)) return false;
    // Prose indicators: contains common English words for fixture types, or
    // has a high ratio of spaces to total length (phrase vs. part number)
    const spaceRatio = (s.split(' ').length - 1) / s.length;
    const hasProseWords = /\b(PENDANT|SCONCE|VANITY|BATH|CEILING|FLUSH|SURFACE|MOUNT|LIGHT|FIXTURE|ROUND|WIDE|TALL|LED|SLIM|MINI|LARGE|SMALL|CONCRETE|BRONZE|NICKEL|BLACK|WHITE|BRUSHED|CHROME|GLASS|FROSTED|OPEN|CLOSED|TIER|GLOBE|CONE|DOME|DRUM|RING|LINEAR|STRIP|PANEL|BACKLIT|MIRROR|FAN|BLADE|REMOTE|POLE|BOLLARD|HANDRAIL|STAIR)\b/.test(upper);
    return hasProseWords && spaceRatio > 0.05;
}

// ── Category vocabulary mapping ───────────────────────────────────────────────
// The detector's labels are broad groupings; the Premier Items "Fixture Category"
// singleSelect carries 30+ specific choices ("Post/Pier Head", "LED Mirror",
// "Disk Light", …). Pulled from the live base 2026-07-20. The old substring
// overlap silently matched almost nothing ("Outdoor" vs "Post/Pier Head") —
// gate through this map instead.
export const CATEGORY_GROUPS: Record<string, string[]> = {
    'Ceiling Fan': ['Ceiling Fan', 'Ceiling Fans + Accessories'],
    'Vanity': ['Vanity'],
    'Mirror': ['LED Mirror'],
    'Pendant': ['Pendant', 'Chandelier', 'Linear / Island Chandeliers'],
    'Sconce': ['Sconce', 'Wall Sconce', 'Wall Mount', 'Outdoor Wall Sconce'],
    'Outdoor Pole': ['Post/Pier Head', 'Post & Bollard'],
    'Outdoor': ['Post/Pier Head', 'Post & Bollard', 'Flood Light', 'Outdoor Wall Sconce', 'Wall Mount'],
    'Exit/Emergency': ['Exit Sign', 'Exit Sign / EMG'],
    'Recessed': ['Disk Light', 'Downlight'],
    'Linear': ['Linear Surface Mount', 'Surface Mount'],
    'Undercabinet': ['Undercabinet / Tape Light + Connectors', 'Surface Mount'],
    'Ceiling': ['Ceiling Mount', 'Flush / Surface Mount', 'Surface Mount'],
};

/**
 * True when a catalog item's Fixture Category is acceptable for the inferred
 * label. Falls back to the legacy substring overlap for labels not in the map
 * (so unknown future labels degrade the old way instead of blocking everything).
 */
export function categoriesCompatible(inferredLabel: string, itemCategory: string): boolean {
    if (!inferredLabel || !itemCategory) return true; // no signal — don't gate
    const group = CATEGORY_GROUPS[inferredLabel];
    if (group) {
        const cat = itemCategory.trim().toLowerCase();
        return group.some(g => g.toLowerCase() === cat);
    }
    const catNorm = itemCategory.toLowerCase();
    const infNorm = inferredLabel.toLowerCase();
    return catNorm.includes(infNorm) || infNorm.includes(catNorm);
}

// ── Bulb / lamp lines (Candlewood review 2026-07-28) ─────────────────────────
// Hospitality bids pair every fixture with a companion bulb line ("CG-404.B",
// SATCO, "Bulb @ Pendent Light - 5W LED A15, 3000K"). These are LAMP lines:
// the engine must never offer fixtures for them, and the SATCO S-series
// exclusion (which protects FIXTURE specs from being swapped to bulbs) must
// not starve them either.

/** SATCO S-series lamp number, e.g. S9594 / S12407. (normalizeProductId lowercases.) */
export function isSatcoLampNumber(value: string): boolean {
    return /^s\d{4,5}$/.test(normalizeProductId(value));
}

// Lookbehind instead of \b on the left: SATCO writes "9.5A19/LED/3000K", where
// the digit touching the shape defeats a word boundary.
const LAMP_SHAPE_RE = /(?<![A-Z])(A15|A19|A21|B10|B11|CA10|CA11|BR20|BR30|BR40|PAR16|PAR20|PAR30|PAR38|MR11|MR16|G9|G16|G25|G30|G40|GU10|GU24|ST19|ST64|T[2-9]|T1[02])\b/;

export interface LampAttributes {
    shape?: string;     // A15, A19, BR30, G40, …
    kelvin?: number;    // 2700, 3000, … (normalizes "30K" → 3000)
    watts?: number;
    base?: string;      // E26, E12, MEDIUM, CANDELABRA
}

export function extractLampAttributes(text: string): LampAttributes {
    const t = (text || '').toUpperCase();
    const attrs: LampAttributes = {};
    const shape = t.match(LAMP_SHAPE_RE)?.[1];
    if (shape) attrs.shape = shape;
    const k4 = t.match(/\b([23][0-9]{3})\s*K\b/);
    const k2 = t.match(/\b([23][0-9])K\b/);
    if (k4) attrs.kelvin = Number(k4[1]);
    else if (k2) attrs.kelvin = Number(k2[1]) * 100;
    const w = t.match(/\b(\d{1,3}(?:\.\d{1,2})?)\s*(?:W\b|WATTS?\b)/);
    if (w) attrs.watts = Number(w[1]);
    const base = t.match(/\b(E26|E12|GU24|MED(?:IUM)?\s*BASE|CANDELABRA)\b/)?.[1];
    if (base) attrs.base = base.startsWith('MED') ? 'E26' : base === 'CANDELABRA' ? 'E12' : base;
    return attrs;
}

/**
 * True when a bid line IS a bulb/lamp (not a fixture): explicit "Bulb …"
 * wording, a bare SATCO S-number, or the ".B" companion-line convention /
 * lamp-shaped SATCO prose. Bulb lines take the dedicated lamp-matching path.
 */
export function isBulbLampLine(mark: string, catalogNumber: string, manufacturer: string): boolean {
    const m = (mark || '').toUpperCase().trim();
    const c = (catalogNumber || '').toUpperCase();
    if (/\bBULBS?\b/.test(c) || /\bBULBS?\b/.test(m)) return true;
    if (isSatcoLampNumber(catalogNumber)) return true;
    const satcoMfr = (manufacturer || '').toUpperCase().includes('SATCO');
    if (satcoMfr && /\.B\d*$/.test(m)) return true;                       // CG-404.B pairing convention
    if (satcoMfr && (LAMP_SHAPE_RE.test(c) || /\bLED\b/.test(c))) return true;
    return false;
}

/**
 * Category gate for 3rd Party Domestic Items, whose "Product Categories" field
 * is a display string of linked category names (possibly several, comma
 * joined) rather than a single select. Conservative: an item with no category
 * signal never qualifies for the in-category fallback.
 */
export function thirdPartyCategoriesCompatible(inferredLabel: string, productCategories: string): boolean {
    if (!inferredLabel || !productCategories) return false;
    const cats = productCategories.toLowerCase();
    const group = CATEGORY_GROUPS[inferredLabel];
    if (group) {
        return group.some(g => cats.includes(g.toLowerCase()));
    }
    return cats.includes(inferredLabel.toLowerCase());
}

// ── Accessory detection (Collective MedSpa review, 2026-07-28) ───────────────
// Mounting clips, drivers, brackets, and other accessory SKUs live inside
// fixture categories in the catalog ("MOUNTING CLIPS FOR TAPE LIGHT" under tape,
// "GC-REC-…-POWER" power supplies under Disk Light). They must never surface as
// substitution candidates for a FIXTURE spec — only when the spec itself asks
// for an accessory.

// Per Jesse (2026-07-28): GC-REC-*-POWER items ARE drivers for the
// wattage-selectable downlight system (alongside -EM battery and -TUNABLE
// fixture variants, and GC-REC-*-EMGDRIVER emergency drivers) — "POWER FOR"
// descriptions and EMGDRIVER ids are accessories. -TUNABLE/-EM stay matchable:
// those are fixtures.
const ACCESSORY_TEXT_RE = /\bMOUNTING\s+(CLIP|PLATE|BRACKET|KIT)|(^|\s)CLIPS?\b|\bBRACKET\b|\bCANOPY\s+KIT\b|\bDRIVER\b|EMG\s*DRIVER|\bXMFR\b|\bTRANSFORMER\b|\bPOWER\s+(SUPPLY|FOR)\b|\bCONNECTOR\b|\bSPLICE\b|\bEND\s+CAP\b|\bTRIM\s+RING\b|\bREMOTE\s+CONTROL\b|\bDOWN\s*RODS?\b|\bACCESSOR/i;

/** True when a catalog item reads as an accessory rather than a fixture. */
export function isAccessoryItem(itemId: string, description: string): boolean {
    return ACCESSORY_TEXT_RE.test(`${itemId} ${description}`);
}

/** True when the SPEC line itself is asking for an accessory (so accessories may match). */
export function specWantsAccessory(mark: string, catalogNumber: string): boolean {
    return ACCESSORY_TEXT_RE.test(`${mark} ${catalogNumber}`);
}

// ── RFI / TBD placeholder detection (domain rule: never fabricate a match) ────

const UNKNOWN_MFRS = new Set(['', 'TBD', 'RFI', 'N/A', 'NA', '-', '?', 'UNKNOWN', 'BY OTHERS']);

/**
 * True when a bid line has no identifiable spec — a TBD manufacturer with a
 * placeholder catalog value (the mark repeated, a ceiling-height note like
 * `(c.h. 10'0" aff 0'0")`, or an explicit RFI/NO SPEC marker). These lines get
 * an RFI message, never a fabricated recommendation.
 */
export function isRfiPlaceholder(mark: string, catalogNumber: string, manufacturer: string): boolean {
    const mfrUnknown = UNKNOWN_MFRS.has(manufacturer.trim().toUpperCase());
    const cat = catalogNumber.trim();
    const placeholderCatalog =
        cat === '' ||
        cat === mark.trim() ||
        /MISSING\s+SPEC|NO\s+SPEC/i.test(cat) ||
        (/^\s*\(/.test(cat) && /\bAFF\b|C\.?H\.?\s*\d/i.test(cat));
    if (!placeholderCatalog) return false;
    return mfrUnknown || /\bRFI\s*#?\s*\d/i.test(`${mark} ${cat}`);
}

// ── URL / junk protection (must-survive: invalid-rec-filter) ─────────────────

/** A URL pasted into a catalog column must never drive or become a recommendation. */
export function isUrlLike(value: string): boolean {
    if (!value) return false;
    const v = value.trim().toLowerCase();
    return /^https?:\/\//.test(v) || /^www\./.test(v) || /\.(com|net|org|io)\//.test(v);
}

// ── LED tape detection (must-survive: led-tape-suppress) ─────────────────────

const TAPE_BRANDS = ['DIODE LED', 'DIODELED', 'AMERICAN LIGHTING', 'ELEMENTAL LED', 'ENVIRONMENTAL LIGHTS', 'Q-TRAN', 'QTRAN', 'LUMINII', 'GM LIGHTING', 'TIVOLI', 'FEELUX'];

/**
 * LED tape / flexible strip is suppressed with an informational message — it is
 * bid as-spec (channel, driver, and footage are project-specific), never swapped.
 *
 * Detected forms (Camino Del Rio review, 2026-07-20):
 *  - explicit TAPE / flexible-strip wording
 *  - tape-in-channel component specs: the catalog cell lists CHANNEL: plus a
 *    DRIVER:/XMFR: breakdown (CORE LNE/LSM, TIVOLI, FEELUX systems)
 *  - handrail / footage-run LED strip lines ("HR-STRIP - 14'0"", "LED STRIP LIGHT; HANDRAILS")
 * Architectural linear fixtures (A-Light G3, Lithonia CSVT) carry none of these
 * signatures and must NOT be suppressed.
 */
export function isLedTape(mark: string, catalogNumber: string, manufacturer: string): boolean {
    const m = mark.toUpperCase();
    const c = catalogNumber.toUpperCase();
    const mfr = manufacturer.toUpperCase();

    if (/LED\s*TAPE|TAPE\s*LIGHT|TAPE\s*LED|\bTAPE\b/.test(m) || /LED\s*TAPE|TAPE\s*LIGHT|\bTAPE\b/.test(c)) return true;
    if (/FLEX(IBLE)?\s*(LED\s*)?STRIP|RIBBON\s*LIGHT/.test(c) || /FLEX(IBLE)?\s*(LED\s*)?STRIP/.test(m)) return true;

    // Tape-in-channel component spec: CHANNEL: always means a tape system; a
    // DRIVER:/XMFR: breakdown with a 12/24V token does too.
    const hasChannel = /(?:MOUNTING\s+)?CHANNEL\s*:/.test(c);
    const hasDriver = /\b(?:DRIVER|XMFR|TRANSFORMER|PSU)\s*:/.test(c);
    const lowVolt = /\b(?:12|24)\s*V\b|-(?:12|24)\b/.test(c);
    if (hasChannel) return true;
    if (hasDriver && lowVolt) return true;

    // Handrail / cove strip runs measured in feet ("HR-STRIP - 14'0"").
    if (/\bHR-?STRIP\b|HAND\s*RAIL/.test(`${m} ${c}`)) return true;
    if (/LED\s*STRIP\s*LIGHT/.test(c) && (/HANDRAIL|COVE/.test(c) || /\d+\s*'\s*\d*\s*"?/.test(m))) return true;

    // Known tape product families / low-voltage strip signatures from tape brands
    const fromTapeBrand = TAPE_BRANDS.some(b => mfr.includes(b));
    if (fromTapeBrand && (/\b(12|24)V\b|BLAZE|VALENT|FLUID.?VIEW|TRULUX|SPEC.?GRADE\s*TAPE/.test(c) || /\bSTRIP\b/.test(c) || hasDriver)) return true;
    return false;
}

// ── Dimension hard-gate (must-survive: dimension-hard-gate) ──────────────────

export interface DimensionSignature {
    /** Aperture/diameter-style inches (4", 6" downlight cans, fan blade spans). */
    inches: number[];
    /** Nominal panel/troffer sizes like 2X4, 1X4, 2X2. */
    panels: string[];
    /** Lengths expressed in feet (4FT strip, 8FT strip). */
    feet: number[];
}

/**
 * Extract the dimension tokens a lighting spec exposes. Conservative on purpose:
 * the hard-gate only fires when BOTH sides expose a comparable dimension class
 * and the values conflict — an item with no detectable dimensions is never gated.
 */
export function extractDimensions(text: string): DimensionSignature {
    const sig: DimensionSignature = { inches: [], panels: [], feet: [] };
    if (!text) return sig;
    const t = text.toUpperCase();

    // 2X4 / 2'X4' / 1X4 / 2X2 panel-style nominal sizes
    for (const m of t.matchAll(/\b([124])\s*'?\s*X\s*([1248])\s*'?\b/g)) {
        sig.panels.push(`${m[1]}X${m[2]}`);
    }

    // Foot lengths: 4FT, 4 FT, 4', 8FT strip
    for (const m of t.matchAll(/\b(\d{1,2})\s*(?:FT|FOOT|FEET|')(?![\w])/g)) {
        const v = parseInt(m[1] ?? '', 10);
        if (v >= 1 && v <= 12) sig.feet.push(v);
    }

    // Inch measurements: 6", 6 IN, 6-INCH, 6IN
    for (const m of t.matchAll(/\b(\d{1,2}(?:\.\d)?)\s*(?:"|”|-?IN(?:CH(?:ES)?)?\b)/g)) {
        const v = parseFloat(m[1] ?? '');
        if (v >= 1 && v <= 96) sig.inches.push(v);
    }

    // Series-embedded apertures on recessed/downlight-style part numbers:
    // DL4/DL6, R4/R6, RD6, SMD6, HL6, CAN6 — and separator-carrying Premier SKU
    // forms like REC-4 / REC-6 (GC-REC-6-DL-MX32W). One optional -_/space between
    // the series token and its single aperture digit.
    for (const m of t.matchAll(/\b(?:DL|RD|REC|SMD|SLD|HL|CAN|R)[-_ ]?(\d)(?=[A-Z\-_ "]|\b)/g)) {
        const v = parseInt(m[1] ?? '', 10);
        if (v >= 2 && v <= 9) sig.inches.push(v);
    }

    return sig;
}

/**
 * Fan-span gate: ceiling-fan SKUs embed the blade span as a bare 2-digit token
 * ("F896-84-WHF" = 84", "CF-006-52-SN" = 52") that the quote/FT-based
 * dimension extractor cannot see — on 3rd & Flower an 84" fan spec
 * auto-selected the 65" sibling. Only meaningful between two ceiling-fan
 * strings (elsewhere bare 2-digit tokens mean kelvin/wattage shorthand), so
 * callers must scope it to Ceiling Fan matching.
 */
export function fanSpansCompatible(specText: string, candidateText: string): boolean {
    const spans = (t: string) => t.toUpperCase().split(/[^A-Z0-9]+/)
        .filter(tok => /^\d{2}$/.test(tok))
        .map(Number)
        .filter(n => n >= 24 && n <= 96);
    const a = spans(specText);
    const b = spans(candidateText);
    if (a.length === 0 || b.length === 0) return true; // no signal — don't gate
    return a.some(x => b.includes(x));
}

/**
 * The dimension hard-gate: a candidate that matches on category/brand but is
 * dimensionally incompatible with the spec must be blocked, never just demoted.
 * Returns true when the candidate is COMPATIBLE (or when either side exposes no
 * comparable dimension — the gate refuses to guess).
 */
export function dimensionsCompatible(specText: string, candidateText: string): boolean {
    const a = extractDimensions(specText);
    const b = extractDimensions(candidateText);

    // Panel sizes are exact-match: a 2X4 spec never accepts a 2X2 candidate.
    if (a.panels.length > 0 && b.panels.length > 0) {
        if (!a.panels.some(p => b.panels.includes(p))) return false;
    }

    // Aperture/diameter inches: compatible when any pairing is within 0.5".
    if (a.inches.length > 0 && b.inches.length > 0) {
        const anyClose = a.inches.some(x => b.inches.some(y => Math.abs(x - y) <= 0.5));
        if (!anyClose) return false;
    }

    // Foot lengths: compatible when any pairing matches exactly (4FT vs 8FT conflicts).
    if (a.feet.length > 0 && b.feet.length > 0) {
        if (!a.feet.some(x => b.feet.includes(x))) return false;
    }

    return true;
}
