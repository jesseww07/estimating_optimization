/**
 * Base-item extraction: what a catalog string IDENTIFIES, apart from how it is
 * configured and what the estimator wrote next to it.
 *
 * A bid line prints an ORDERING string, and the ordering string is mostly
 * noise for identification. `OXYGEN 3-515-25- HALO` is one product — Oxygen's
 * 3-515 "Halo" sconce — in size/finish 25. `ALLIED MAKER WAL-031 MQUAN
 * HALF-CIRCLE` is product WAL-031; the rest is its name. `B-TD FORMATION WALL
 * SCONCE BRUSHED SATIN GOLD - NERO MARQUINA MARBLE` is the Formation sconce in
 * two finishes. The estimators' own instinct (ownership review, 2026-09-11) is
 * to search the most BASE version of the number they can find — the first one
 * or two groups of characters — and the engine had been doing the opposite:
 * scoring the whole string, so configuration codes, product names and typed
 * notes diluted every token match and hid the item behind them.
 *
 * Part numbers are never random, but there is no single grammar either, so
 * this module reads STRUCTURE rather than a vocabulary:
 *
 *   1. Split the string into segments at the separators manufacturers and
 *      estimators use between a code and its name (` - `, `- `, `;`, `|`,
 *      `•`, `: `, `, `). The first segment is the code; later ones are the
 *      product name / description.
 *   2. Inside the code segment, the base is the shortest run of leading tokens
 *      that carries identity: for a part NUMBER, the first run that contains a
 *      digit and is at least four characters (`3` → `3-515`; `WAC` → `WAC-042`;
 *      `4430802` stands alone), stopping at the first configuration code
 *      (finish, CCT, wattage, voltage, a dimension). For a product NAME — a
 *      digit-free first word of four or more letters that is not fixture
 *      vocabulary (`FORMATION`, `BUGIA`, `DSXB`, `APLOMB`) — the base is the
 *      name plus any model number that immediately follows it (`LUMIERE 1003`,
 *      `NACHO 1300`).
 *   3. Everything after the base inside the code segment is the VARIANT: the
 *      configuration the estimator adjusts, never the identity.
 *
 * Two lines are the SAME BASE ITEM when their bases agree AND the manufacturer
 * agrees — a base like `3-515` or `291` only means something within its brand,
 * so a manufacturer is required unless the base is long enough (six or more
 * characters) to be an identity on its own. A product NAME always needs its
 * brand: `FORMATION` is B-TD's sconce only because B-TD says so.
 *
 * Pure TypeScript, no I/O, no Airtable — the engine (family matching against
 * History), the identify flow (what "Look up spec" searches) and the UI (what
 * the header shows as the base item) all read one definition. Because the
 * engine consumes it, every rule here is measured by the eval ratchet.
 */

import { GENERIC_SPEC_WORDS, normalizeProductId } from './matcher';

export type BaseItemKind = 'code' | 'name' | 'none';

export interface BaseItem {
    /** The base item number or product name, as printed. '' when kind is 'none'. */
    base: string;
    kind: BaseItemKind;
    /** Configuration tokens that followed the base inside the code segment (finish, size, lamping). */
    variant: string[];
    /** Product name / description that followed the code segment ("HALO", "MQUAN CIRCLE"). */
    name: string;
}

const NONE: BaseItem = { base: '', kind: 'none', variant: [], name: '' };

// ── Configuration vocabulary ─────────────────────────────────────────────────
// These end a base: what follows a finish or a colour temperature is never
// identity. Shared with lib/identify/catalogNumber.ts, which re-exports
// isOptionToken so the web-lookup planner and the engine agree on what a
// configuration code is.

/** Colour-temperature codes: 30K, 3000K, 5CCT, CCT, 2700K. */
const CCT = /^(\d{2,4}K|\d?CCT|CCT\d?)$/;
/** Wattage: 15W, 9.5W, W15. */
const WATTAGE = /^(\d+(\.\d+)?W|W\d+(\.\d+)?)$/;
/** Lumens: 4000LM (800L is ambiguous — L48 is a LENGTH code — so LM is required). */
const LUMENS = /^\d{3,6}LM$/;
/** CRI: 80CRI, CRI90, 90+. */
const CRI = /^(\d{2}CRI|CRI\d{2}|\d{2}\+)$/;
/** Voltage: 120V, 277V, MVOLT, UNV. Bare "120" is left alone. */
const VOLTAGE = /^(\d{3}V|MVOLT|MV|UNV|UNIV|UVOLT)$/;
/** A dimension: 9", 13.5", 20', 4FT, 48IN, 600MM. Never the start of a part number. */
const DIMENSION = /^\d+(\.\d+)?(["'”′’]|FT|IN|MM|CM)$/;

/**
 * Option vocabulary that is configuration rather than identity: finish words
 * and their abbreviations, dimming/driver options, trailing mounting trims.
 */
export const OPTION_WORDS: ReadonlySet<string> = new Set([
    // Finishes, spelled out
    'WHITE', 'BLACK', 'BRONZE', 'NICKEL', 'BRASS', 'CHROME', 'GOLD', 'SILVER',
    'ALUMINUM', 'ALUMINIUM', 'COPPER', 'GRAPHITE', 'PEWTER', 'WALNUT', 'NATURAL',
    'GREY', 'GRAY', 'SATIN', 'MATTE', 'GLOSSY', 'BRUSHED', 'POLISHED', 'PATINA', 'ANTIQUE', 'AGED',
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

/** True when one indivisible token reads as a configuration code. */
function isSimpleOptionToken(t: string): boolean {
    if (OPTION_WORDS.has(t)) return true;
    return CCT.test(t) || WATTAGE.test(t) || LUMENS.test(t) || CRI.test(t) || VOLTAGE.test(t) || DIMENSION.test(t);
}

/**
 * True when `token` reads as a configuration code rather than product identity.
 *
 * Slash-delimited GROUPS count: manufacturers print a choice of options as one
 * token (`120/277V`, `MVOLT/UNV`, `30K/40K`). A group qualifies only when every
 * piece is either an option code or a bare figure the group's other pieces give
 * a unit to (`120` in `120/277V`), and at least one piece is a recognized code —
 * so an alternate item-number pair is never mistaken for one.
 */
export function isOptionToken(token: string): boolean {
    const t = token.trim().toUpperCase();
    if (!t) return false;
    if (isSimpleOptionToken(t)) return true;
    if (!t.includes('/')) return false;
    const pieces = t.split('/').map(p => p.trim()).filter(Boolean);
    if (pieces.length < 2) return false;
    let recognized = 0;
    for (const piece of pieces) {
        if (isSimpleOptionToken(piece)) { recognized++; continue; }
        if (!/^\d{2,4}$/.test(piece)) return false;
    }
    return recognized > 0;
}

// ── Name vocabulary ──────────────────────────────────────────────────────────

/**
 * Words that describe a product without naming one. A product NAME base is
 * never one of these, and a name stops at the first of them: `FORMATION WALL
 * SCONCE` is the Formation; `WALL` and `SCONCE` say what it is.
 */
const DESCRIPTIVE_WORDS: ReadonlySet<string> = new Set([
    'SLIM', 'MINI', 'MICRO', 'MAXI', 'LARGE', 'SMALL', 'MEDIUM', 'ROUND', 'SQUARE', 'RECT', 'RECTANGULAR',
    'OVAL', 'CUSTOM', 'DECORATIVE', 'ARCHITECTURAL', 'INDOOR', 'OUTDOOR', 'INTERIOR', 'EXTERIOR',
    'COMMERCIAL', 'RESIDENTIAL', 'HIGH', 'LOW', 'BAY', 'WATT', 'WATTS', 'VOLT', 'VOLTS', 'INCH', 'FOOT', 'FEET',
    'STANDARD', 'SERIES', 'MODEL', 'STYLE', 'COLOR', 'COLOUR', 'SIZE', 'QTY', 'EACH', 'PER', 'WIDE', 'TALL',
    'LONG', 'SHORT', 'NARROW', 'DEEP', 'HANGING', 'SUSPENDED', 'SUSPENSION', 'GLASS', 'METAL', 'ACRYLIC',
    'FROSTED', 'CLEAR', 'OPAL', 'DIFFUSER', 'SHADE', 'SHIPPING', 'FREIGHT', 'QUOTE', 'QUOTED', 'REQUESTED',
    'PENDING', 'ONLY', 'INFO', 'NEED', 'NEEDS', 'CONFIRM', 'DISCONTINUED', 'ALTERNATE', 'EQUAL', 'APPROVED',
    'LAMPS', 'BULBS', 'LUMINAIRE', 'LUMINAIRES', 'HEAD', 'HEADS', 'ARM', 'ARMS', 'WAY', 'TWO', 'THREE', 'FOUR',
    'LENGTH', 'WIDTH', 'HEIGHT', 'DEPTH', 'TOTAL', 'NOTED', 'QUANTITY', 'RUNS', 'RUN', 'VERIFY', 'MATCH',
    // Where a fixture hangs is not what it is.
    'STAIR', 'STAIRS', 'STAIRWELL', 'STAIRWELLS', 'WELLS', 'ELECTRICAL', 'ROOM', 'ROOMS', 'GARAGE', 'LOBBY',
    'CORRIDOR', 'HALLWAY', 'HALL', 'BUILDING', 'UNITS', 'AMENITY', 'CLUBHOUSE', 'POOL', 'KITCHEN', 'BATHROOM',
    'BEDROOM', 'ENTRY', 'ENTRANCE', 'ELEVATOR', 'MECHANICAL', 'STORAGE', 'OFFICE', 'RESTROOM', 'LAUNDRY',
]);

/**
 * Words that pick a VARIANT within a named family: `BUGIA TRIPLE` and `BUGIA
 * SINGLE` are the same product line. A name stops before one of these.
 */
const VARIANT_WORDS: ReadonlySet<string> = new Set([
    'SINGLE', 'DOUBLE', 'TRIPLE', 'QUAD', 'TWIN', 'DUAL', 'XS', 'XL', 'XXL', 'SM', 'MD', 'LG',
]);

/** Manufacturer cells that name no manufacturer. */
const UNKNOWN_MANUFACTURER = /^(TBD|TBA|RFI|N\/?A|NONE|NO SPEC|UNKNOWN|BY OTHERS|OR EQUAL|\?+|-+)$/i;

/**
 * Identity key for a base or a manufacturer: case-, punctuation- and
 * accent-insensitive (`DJEMBÉ` and `DJEMBE` are one word).
 */
export function baseItemKey(value: string): string {
    return normalizeProductId(value.normalize('NFD').replace(/[̀-ͯ]/g, ''));
}

/** The manufacturer's identity key, or '' when the cell names none. */
export function manufacturerKey(manufacturer: string | undefined): string {
    const trimmed = (manufacturer ?? '').trim();
    if (!trimmed || UNKNOWN_MANUFACTURER.test(trimmed)) return '';
    return baseItemKey(trimmed);
}

function isGenericWord(upper: string): boolean {
    return GENERIC_SPEC_WORDS.has(upper) || OPTION_WORDS.has(upper) || DESCRIPTIVE_WORDS.has(upper);
}

function letterCount(token: string): number {
    return (token.match(/\p{L}/gu) ?? []).length;
}

function hasDigit(s: string): boolean {
    return /\d/.test(s);
}

/**
 * True when a token can CONTINUE a product name: digit-free, three or more
 * letters, and neither fixture vocabulary nor a variant word.
 */
function isNameWord(token: string): boolean {
    const upper = token.toUpperCase();
    return !hasDigit(token) && letterCount(token) >= 3 && !isGenericWord(upper) && !VARIANT_WORDS.has(upper);
}

/** True when a token can START a product name (one letter stricter than continuing one). */
function isNameStart(token: string): boolean {
    return isNameWord(token) && letterCount(token) >= 4;
}

/** Separators between a code and its name, or between clauses of a description. */
const SEGMENT_SPLIT = /\s+[-–—]+\s*|\s*[-–—]+\s+|\s*[;|•\n]\s*|\s+\/\s+|:\s+|,\s+/;
/** Token delimiters inside one segment. A dot is not one ("557.24", "9.5W"). */
const TOKEN_SPLIT = /[\s\-_/]+/;

function tokenize(segment: string): string[] {
    return segment
        .split(TOKEN_SPLIT)
        .map(t => t.replace(/^[^\p{L}\p{N}$]+|[.,;:]+$/gu, ''))
        .filter(t => /[\p{L}\p{N}]/u.test(t));
}

/** Drop the manufacturer when the estimator typed it into the catalog cell too. */
function withoutManufacturer(tokens: string[], manufacturer: string | undefined): string[] {
    const mfr = manufacturerKey(manufacturer);
    if (!mfr) return tokens;
    let acc = '';
    for (let i = 0; i < tokens.length && i < 3; i++) {
        acc += baseItemKey(tokens[i]!);
        if (acc === mfr) return tokens.slice(i + 1);
        if (!mfr.startsWith(acc)) break;
    }
    return tokens;
}

const cache = new Map<string, BaseItem>();
const CACHE_LIMIT = 50_000;

/**
 * Split one catalog string into base item, variant codes, and product name.
 *
 * `manufacturer` is optional context: when the estimator typed the brand into
 * the catalog cell as well, it is not part of the item number.
 */
export function splitBaseItem(spec: string, manufacturer?: string): BaseItem {
    const cacheKey = `${manufacturer ?? ''} ${spec ?? ''}`;
    const hit = cache.get(cacheKey);
    if (hit) return hit;
    const result = computeBaseItem(spec ?? '', manufacturer);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(cacheKey, result);
    return result;
}

function computeBaseItem(spec: string, manufacturer: string | undefined): BaseItem {
    let raw = spec.trim();
    if (!raw) return NONE;
    // A pasted link is never a catalog number.
    if (/^(https?:\/\/|www\.)/i.test(raw)) return NONE;
    // Notes in brackets or stars ("(E )", "*Discontinued*") are commentary.
    raw = raw.replace(/\([^)]*\)|\[[^\]]*\]|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!raw) return NONE;

    const segments = raw.split(SEGMENT_SPLIT).map(s => s.trim()).filter(Boolean);
    if (segments.length === 0) return NONE;
    const codeSegment = segments[0]!;
    const nameSegments = segments.slice(1);

    const tokens = withoutManufacturer(tokenize(codeSegment), manufacturer);
    if (tokens.length === 0) return NONE;

    const base: string[] = [];
    let i = 0;
    let kind: BaseItemKind = 'none';

    if (isNameStart(tokens[0]!)) {
        // ── Product name ─────────────────────────────────────────────────
        kind = 'name';
        base.push(tokens[i++]!);
        while (i < tokens.length && base.length < 3 && isNameWord(tokens[i]!)) base.push(tokens[i++]!);
        // A model number right after the name belongs to it: LUMIERE 1003, NACHO 1300.
        if (i < tokens.length && /^\d{3,}$/.test(tokens[i]!)) base.push(tokens[i++]!);
    } else {
        // ── Part number ──────────────────────────────────────────────────
        let endedAtOption = false;
        while (i < tokens.length) {
            const token = tokens[i]!;
            const upper = token.toUpperCase();
            if (isOptionToken(upper)) {
                // A configuration code ends the base; one that LEADS the string
                // (a dimension, a finish) is skipped — nothing identifying yet.
                if (base.length > 0) { endedAtOption = true; break; }
                i++;
                continue;
            }
            base.push(token);
            i++;
            const key = baseItemKey(base.join(''));
            if (!hasDigit(key) || key.length < 4) continue;
            // A run of six or more digits right after a short prefix is a
            // design/serial number (GC-06-011123), not a finish code (4430802-112).
            if (i < tokens.length && /^\d{6,}$/.test(tokens[i]!)) base.push(tokens[i++]!);
            break;
        }
        if (base.length > 0) {
            const key = baseItemKey(base.join(''));
            if (hasDigit(key)) {
                // A run carrying a digit is identity at four characters, or at
                // three when it is the whole code segment ("VP3" of "VP3- FLOWERPOT").
                if (key.length >= 4 || (i >= tokens.length && key.length >= 3)) kind = 'code';
            } else {
                // Letters-only runs are identity only when a configuration code
                // follows them ("R-SLIM-DISK" of "R-SLIM-DISK-12W") and they are
                // more than vocabulary — "EXIT SINGLE" and "LED" never are.
                const allGeneric = base.every(t => isGenericWord(t.toUpperCase()) || VARIANT_WORDS.has(t.toUpperCase()));
                if (endedAtOption && key.length >= 4 && !allGeneric) kind = 'code';
            }
        }
    }

    if (kind === 'none') return NONE;

    // What follows the base in the code segment: words become part of the
    // product name ("WALL SCONCE", "MQUAN CIRCLE"); codes — finishes, short
    // abbreviations, anything with a digit — are configuration.
    const rest = tokens.slice(i);
    const restName: string[] = [];
    const variant: string[] = [];
    for (const token of rest) {
        if (!hasDigit(token) && letterCount(token) >= 4 && !isOptionToken(token.toUpperCase())) restName.push(token);
        else variant.push(token);
    }
    const name = [...restName, ...nameSegments].join(' ').trim();

    return { base: printedBase(codeSegment, base), kind, variant, name };
}

/** The base as the manufacturer prints it — original delimiters preserved. */
function printedBase(segment: string, baseTokens: string[]): string {
    const first = baseTokens[0]!;
    const last = baseTokens[baseTokens.length - 1]!;
    const start = segment.indexOf(first);
    const end = start >= 0 ? segment.indexOf(last, start) : -1;
    if (start >= 0 && end >= start) {
        return segment.slice(start, end + last.length).trim();
    }
    return baseTokens.join(' ');
}

export interface BaseItemSide {
    spec: string;
    manufacturer?: string;
}

/** True when two manufacturer keys name the same brand ("LUMENS/TOOY" carries "TOOY"). */
function manufacturersAgree(a: string, b: string): boolean {
    if (a === b) return true;
    if (a.length < 3 || b.length < 3) return false;
    return a.includes(b) || b.includes(a);
}

/**
 * True when two bid lines name the SAME BASE ITEM — same product, options may
 * differ. This is the family rule the engine adds on top of prefix/series
 * matching: `3-515-25- HALO` and `3-515-15 HALO` are one Oxygen sconce;
 * `BLOC WALL SCONCE` and `BLOC WALL SCONCE AGED BRASS` are one B-TD sconce.
 *
 * Identical strings are not family (that is the exact tier's business). A
 * base needs its brand unless it is long enough to stand alone, and a product
 * NAME always does.
 */
export function sameBaseItem(a: BaseItemSide, b: BaseItemSide): boolean {
    const A = splitBaseItem(a.spec, a.manufacturer);
    if (A.kind === 'none') return false;
    const B = splitBaseItem(b.spec, b.manufacturer);
    if (B.kind === 'none') return false;
    const keyA = baseItemKey(A.base);
    if (keyA !== baseItemKey(B.base)) return false;
    if (baseItemKey(a.spec) === baseItemKey(b.spec)) return false;

    const mfrA = manufacturerKey(a.manufacturer);
    const mfrB = manufacturerKey(b.manufacturer);
    if (mfrA && mfrB) return manufacturersAgree(mfrA, mfrB);
    if (A.kind === 'name' || B.kind === 'name') return false;
    return keyA.length >= 6;
}

/**
 * The base item, when it is a genuine simplification of the string the
 * estimator typed — what the UI shows next to the spec and what "Look up
 * spec" searches. null when the whole string already IS the base (or none
 * could be read).
 */
export function simplifiedBaseItem(spec: string, manufacturer?: string): BaseItem | null {
    const item = splitBaseItem(spec, manufacturer);
    if (item.kind === 'none') return null;
    if (baseItemKey(item.base) === baseItemKey(spec)) return null;
    return item;
}
