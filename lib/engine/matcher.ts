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
    const significantParts = catalogParts.filter(p => p.length >= 3 && !/^\d+$/.test(p));

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
    if (matchRatio >= 0.3) return Math.round(30 + matchRatio * 40);

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
    if (/EXHAUST\s*FAN/i.test(mark)) return null;              // exhaust fans not in catalog
    if (/SMOKE|CARBON\s*MONO/i.test(mark) && !/LIGHT|FIXTURE/.test(m)) return null; // smoke/CO detectors
    if (/CEILING\s*FAN|BEDROOM.*FAN/i.test(mark)) return 'Ceiling Fan';
    if (/\b(SGL|DBL|DOUBLE|SINGLE|DUAL)\s*VANITY/i.test(mark)) return 'Vanity';
    if (/CABINET\s*LED|UNDER\s*CAB/i.test(mark)) return 'Linear';

    // ── Ceiling Fan ────────────────────────────────────────────────────────────
    // Must be tested FIRST — CLF, CF, and fan-brand mfrs are unambiguous.
    // Checking catalog for "CEILING FAN" also catches prose-description rows.
    const isFan =
        /\bCLF\b/.test(m) ||                     // U2-CLF-1, U1-CLF-1
        /\bCF\b/.test(m) ||                      // CF-1, CF-2
        /\bFAN\b/.test(m) ||
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
        /^LQM|^ELM|^AF0|^WL4/.test(c) ||
        /EXIT.?SIGN|EMERGENCY|EGRESS/.test(c);
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
        /^LBL|^WL4|^ZL2/.test(c);                 // Lithonia linear products
    if (isLinear) return 'Linear';

    // ── Ceiling / Flush Mount ──────────────────────────────────────────────────
    const isCeiling =
        /\bCL\b|\bCM\b|\bSF\b|\bFM\b/.test(m) ||
        /FLUSH.?MOUNT|SEMI.?FLUSH|CLOSE.?TO.?CEIL/.test(c);
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
    const hasProseWords = /\b(PENDANT|SCONCE|VANITY|BATH|CEILING|FLUSH|SURFACE|MOUNT|LIGHT|FIXTURE|ROUND|WIDE|TALL|LED|SLIM|MINI|LARGE|SMALL|CONCRETE|BRONZE|NICKEL|BLACK|WHITE|BRUSHED|CHROME|GLASS|FROSTED|OPEN|CLOSED|TIER|GLOBE|CONE|DOME|DRUM|RING|LINEAR|STRIP|PANEL|BACKLIT|MIRROR|FAN|BLADE|REMOTE)\b/.test(upper);
    return hasProseWords && spaceRatio > 0.05;
}

// ── URL / junk protection (must-survive: invalid-rec-filter) ─────────────────

/** A URL pasted into a catalog column must never drive or become a recommendation. */
export function isUrlLike(value: string): boolean {
    if (!value) return false;
    const v = value.trim().toLowerCase();
    return /^https?:\/\//.test(v) || /^www\./.test(v) || /\.(com|net|org|io)\//.test(v);
}

// ── LED tape detection (must-survive: led-tape-suppress) ─────────────────────

const TAPE_BRANDS = ['DIODE LED', 'DIODELED', 'AMERICAN LIGHTING', 'ELEMENTAL LED', 'ENVIRONMENTAL LIGHTS', 'Q-TRAN', 'QTRAN', 'LUMINII', 'GM LIGHTING'];

/**
 * LED tape / flexible strip is suppressed with an informational message — it is
 * bid as-spec (channel, driver, and footage are project-specific), never swapped.
 */
export function isLedTape(mark: string, catalogNumber: string, manufacturer: string): boolean {
    const m = mark.toUpperCase();
    const c = catalogNumber.toUpperCase();
    const mfr = manufacturer.toUpperCase();

    if (/LED\s*TAPE|TAPE\s*LIGHT|TAPE\s*LED|\bTAPE\b/.test(m) || /LED\s*TAPE|TAPE\s*LIGHT|\bTAPE\b/.test(c)) return true;
    if (/FLEX(IBLE)?\s*(LED\s*)?STRIP|RIBBON\s*LIGHT/.test(c) || /FLEX(IBLE)?\s*(LED\s*)?STRIP/.test(m)) return true;
    // Known tape product families / low-voltage strip signatures from tape brands
    const fromTapeBrand = TAPE_BRANDS.some(b => mfr.includes(b));
    if (fromTapeBrand && (/\b(12|24)V\b|BLAZE|VALENT|FLUID.?VIEW|TRULUX|SPEC.?GRADE\s*TAPE/.test(c) || /\bSTRIP\b/.test(c))) return true;
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
    // DL4/DL6, R4/R6, RD6, SMD6, HL6, CAN6 — a letter run ending in a small digit.
    for (const m of t.matchAll(/\b(?:DL|RD|R|SMD|SLD|HL|CAN)(\d)(?=[A-Z-]|\b)/g)) {
        const v = parseInt(m[1] ?? '', 10);
        if (v >= 2 && v <= 9) sig.inches.push(v);
    }

    return sig;
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
