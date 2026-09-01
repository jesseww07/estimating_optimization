/**
 * Base-item extraction for catalog / ordering strings.
 *
 * A schedule prints the ORDERING string, not the product. "VISUAL COMFORT
 * 4430802-112" is one product — 4430802, a two-light bar vanity — configured in
 * finish 112. Handing the whole string to a web search is what made "Look up
 * spec" fail in live use (2026-09-01): searching `4430802-112` returns little to
 * nothing, while `4430802` returns the manufacturer page, the product type, and
 * the finish list. The suffix is a configuration code, and configuration is
 * what the estimator adjusts anyway — identity is what they need looked up.
 *
 * So identification searches the BASE item and treats the stripped codes as
 * configuration context. This module is the pure, testable half of that: it
 * splits a spec into base + option codes and never guesses beyond what the
 * option grammar plainly says.
 *
 * Deliberately separate from lib/engine/matcher.ts: the engine's series/family
 * logic is measured by the eval ratchet and must not move for an
 * identification-prompt change. Nothing here is imported by the engine.
 */

/** Colour-temperature codes: 30K, 3000K, 5CCT, CCT, 2700K. */
const CCT = /^(\d{2,4}K|\d?CCT|CCT\d?)$/;
/** Wattage: 15W, 9.5W, W15. */
const WATTAGE = /^(\d+(\.\d+)?W|W\d+(\.\d+)?)$/;
/** Lumens: 4000LM, 800L is ambiguous (L48 is a LENGTH code), so require LM. */
const LUMENS = /^\d{3,6}LM$/;
/** CRI: 80CRI, CRI90, 90+. */
const CRI = /^(\d{2}CRI|CRI\d{2}|\d{2}\+)$/;
/** Voltage: 120V, 277V, MVOLT, UNV. Bare "120" is left alone — see NUMERIC_OPTION. */
const VOLTAGE = /^(\d{3}V|MVOLT|MV|UNV|UNIV|UVOLT)$/;

/**
 * Option vocabulary that is configuration rather than identity. Finish words
 * and their common abbreviations, dimming/driver options, and mounting trims
 * that appear as trailing codes.
 */
const OPTION_WORDS = new Set([
    // Finishes, spelled out
    'WHITE', 'BLACK', 'BRONZE', 'NICKEL', 'BRASS', 'CHROME', 'GOLD', 'SILVER',
    'ALUMINUM', 'ALUMINIUM', 'COPPER', 'GRAPHITE', 'PEWTER', 'WALNUT', 'NATURAL',
    // Finishes, abbreviated
    'WH', 'WHT', 'BK', 'BLK', 'MB', 'MBK', 'BZ', 'BRZ', 'DBZ', 'DB', 'ORB',
    'NKL', 'BN', 'SN', 'PN', 'AN', 'AB', 'PB', 'SB', 'CH', 'PC', 'BC', 'SS',
    'AL', 'GLD', 'SLV', 'GR', 'GRY', 'TT', 'NAT', 'CLR', 'FR', 'OPL',
    // Dimming / driver
    'DIM', 'EDIM', 'NDIM', 'ELV', 'TRIAC', 'DALI', 'PHASE', '010V', '0-10V',
    'DIMMABLE', 'DRIVER',
    // Common trailing options
    'EM', 'EL', 'GLR', 'GMF', 'SPD', 'FUSE', 'SC', 'HO',
]);

/**
 * Delimiters a catalog string uses between tokens; the captured group keeps them
 * so the base rejoins verbatim. A dot is NOT a delimiter — it belongs to the
 * token ("9.5W" is one wattage code, "CG-404.B" one lamp designation).
 */
const TOKEN_SPLIT = /([\s\-_]+)/;

/**
 * A trailing run of 2-4 digits after a substantial core is a finish/option code
 * (`4430802-112`, `SL4-930`). Applied only when what remains is still a real
 * item number, so `WP-100` and `COM-DISK-7` keep their trailing figures.
 */
const NUMERIC_OPTION = /^\d{2,4}$/;

function normalized(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when `token` reads as a configuration code rather than product identity. */
export function isOptionToken(token: string): boolean {
    const t = token.trim().toUpperCase();
    if (!t) return false;
    if (OPTION_WORDS.has(t)) return true;
    return CCT.test(t) || WATTAGE.test(t) || LUMENS.test(t) || CRI.test(t) || VOLTAGE.test(t);
}

/**
 * What survives as a searchable item number. Deliberately strict: a base with
 * no digits and under 5 characters ("LED", "SL") is vocabulary, not an item, and
 * searching it is worse than searching the full string.
 */
function isUsableBase(base: string): boolean {
    const norm = normalized(base);
    if (norm.length < 4) return false;
    if (!/\d/.test(norm) && norm.length < 6) return false;
    return true;
}

export interface CatalogParts {
    /** The item number to look up — the input itself when nothing could be stripped. */
    base: string;
    /** The configuration codes stripped off the end, in the order they appeared. */
    options: string[];
}

/**
 * Split one catalog string into its base item number and its trailing
 * configuration codes.
 *
 * Only TRAILING tokens are stripped, and only while the remainder still reads
 * as an item number. Option codes embedded mid-string (`GC-03-092017-1-16W-30K-WH`
 * strips WH, 30K and 16W; `4430802-112` strips 112) come off from the right in
 * one pass, which is where the option grammar actually lives — a token in the
 * middle that merely looks like an option is far more likely to be identity.
 */
export function splitCatalogParts(spec: string): CatalogParts {
    const raw = (spec ?? '').trim();
    if (!raw) return { base: '', options: [] };
    // Keep the delimiters so the base rejoins exactly as the manufacturer prints it.
    const parts = raw.split(TOKEN_SPLIT);
    const options: string[] = [];

    // parts alternates [token, delim, token, delim, ...]; tokens sit at even indices.
    let end = parts.length;
    while (end > 1) {
        const tokenIndex = end - 1;
        const token = parts[tokenIndex] ?? '';
        if (tokenIndex % 2 !== 0 || !token) break; // not a token slot / empty tail
        const remainder = parts.slice(0, tokenIndex).join('').replace(/[\s\-_]+$/, '');
        if (!isUsableBase(remainder)) break;
        const isOption = isOptionToken(token)
            || (NUMERIC_OPTION.test(token) && /\d/.test(normalized(remainder)) && normalized(remainder).length >= 5);
        if (!isOption) break;
        options.unshift(token);
        end = tokenIndex - 1; // drop the token and the delimiter before it
    }

    if (options.length === 0) return { base: raw, options: [] };
    const base = parts.slice(0, end).join('').replace(/[\s\-_]+$/, '');
    return { base: base || raw, options };
}

/** Shorthand for the base item number alone. */
export function baseCatalogNumber(spec: string): string {
    return splitCatalogParts(spec).base;
}

/**
 * Split a cell that carries SEVERAL catalog numbers into the individual ones.
 *
 * Schedules routinely print alternates on one line ("4430802-112 / 4430804-112"
 * — the two- and three-light versions of the same vanity). Both are worth
 * looking up; the whole string is worth looking up as nothing.
 *
 * Conservative on purpose: a slash inside one part number ("120/277V",
 * "MVOLT/UNV") must not split it, so each side has to stand alone as a
 * candidate item number.
 */
export function splitCatalogAlternates(spec: string): string[] {
    const raw = (spec ?? '').trim();
    if (!raw) return [];
    const pieces = raw.split(/\s*\/\s*/).map(p => p.trim()).filter(Boolean);
    if (pieces.length < 2) return [raw];
    const standalone = pieces.every(p => normalized(p).length >= 5 && /\d/.test(p) && !isOptionToken(p));
    return standalone ? pieces : [raw];
}

export interface CatalogSearchPlan {
    /** Every catalog number on the line, in printed order. */
    alternates: string[];
    /** Base item numbers to search, deduped, in printed order. */
    baseNumbers: string[];
    /** Configuration codes stripped off, deduped — context, never search terms. */
    optionCodes: string[];
    /** True when stripping actually changed something worth telling the model. */
    hasBase: boolean;
}

/**
 * The lookup plan for one catalog cell: what to search, and what was set aside
 * as configuration. Pure so the prompt builder and its tests share one source.
 */
export function planCatalogSearch(spec: string): CatalogSearchPlan {
    const alternates = splitCatalogAlternates(spec);
    const baseNumbers: string[] = [];
    const optionCodes: string[] = [];
    for (const alternate of alternates) {
        const { base, options } = splitCatalogParts(alternate);
        if (base && !baseNumbers.includes(base)) baseNumbers.push(base);
        for (const option of options) {
            if (!optionCodes.includes(option)) optionCodes.push(option);
        }
    }
    const hasBase = baseNumbers.length > 0
        && (optionCodes.length > 0 || baseNumbers.length !== 1 || baseNumbers[0] !== (spec ?? '').trim());
    return { alternates, baseNumbers, optionCodes, hasBase };
}
