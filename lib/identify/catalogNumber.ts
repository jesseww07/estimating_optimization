/**
 * Base-item extraction for catalog / ordering strings — the LOOKUP planner.
 *
 * A schedule prints the ORDERING string, not the product. "VISUAL COMFORT
 * 4430802-112" is one product — 4430802, a two-light bar vanity — configured in
 * finish 112. Handing the whole string to a web search is what made "Look up
 * spec" fail in live use (2026-09-01): searching `4430802-112` returns little to
 * nothing, while `4430802` returns the manufacturer page, the product type, and
 * the finish list. The suffix is a configuration code, and configuration is
 * what the estimator adjusts anyway — identity is what they need looked up.
 *
 * Two reads are combined here:
 *
 *   1. Option stripping (this module): trailing tokens that the option grammar
 *      plainly names — finish, CCT, wattage, voltage — come off the end.
 *   2. The structural read (lib/engine/baseItem.ts): inside what is left, the
 *      base item is the first run of characters that carries identity, and
 *      what follows is the product's name or its variant. `3-515-25- HALO`
 *      strips nothing by grammar (HALO is not an option code) but is plainly
 *      product 3-515, named Halo, in size 25 — which is exactly what the
 *      estimator types into Google (ownership review, 2026-09-11).
 *
 * The option vocabulary itself lives in the engine module so the two readers
 * cannot disagree about what a configuration code is; it is re-exported here
 * for the tests and callers that always imported it from this file.
 */

import { isOptionToken, simplifiedBaseItem } from '../engine/baseItem';

export { isOptionToken };

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
    /**
     * The product name printed alongside the code ("HALO" in `3-515-25- HALO`,
     * "MQUAN CIRCLE" in `WAC-042-MQUAN CIRCLE`), when the line carries one. A
     * search lead in its own right — it is the word the manufacturer's page
     * uses — but never part of the item number.
     */
    productName?: string;
}

/**
 * The lookup plan for one catalog cell: what to search, and what was set aside
 * as configuration or as the product's name. Pure so the prompt builder and its
 * tests share one source.
 *
 * `manufacturer` is context for the structural read: when the estimator typed
 * the brand into the catalog cell as well, it is not part of the item number.
 */
export function planCatalogSearch(spec: string, manufacturer?: string): CatalogSearchPlan {
    const alternates = splitCatalogAlternates(spec);
    const baseNumbers: string[] = [];
    const optionCodes: string[] = [];
    let productName: string | undefined;
    const addOptions = (codes: string[]): void => {
        for (const code of codes) {
            if (!optionCodes.includes(code)) optionCodes.push(code);
        }
    };
    for (const alternate of alternates) {
        const { base: stripped, options } = splitCatalogParts(alternate);
        // Grammar first (trailing codes), then structure inside what is left:
        // the base item and the name / variant printed after it.
        const structural = simplifiedBaseItem(stripped, manufacturer);
        const base = structural?.base ?? stripped;
        if (base && !baseNumbers.includes(base)) baseNumbers.push(base);
        addOptions(options);
        if (structural) {
            addOptions(structural.variant);
            if (!productName && structural.name) productName = structural.name;
        }
    }
    const hasBase = baseNumbers.length > 0
        && (optionCodes.length > 0 || baseNumbers.length !== 1 || baseNumbers[0] !== (spec ?? '').trim());
    return { alternates, baseNumbers, optionCodes, hasBase, ...(productName ? { productName } : {}) };
}
