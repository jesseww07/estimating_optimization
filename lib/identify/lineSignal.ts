/**
 * Does a bid line give identification anything to read?
 *
 * The batch identify pass reads a line's own text and nothing else — no page
 * fetch, no web search, no cut sheet. So a line carrying no manufacturer, no
 * part number and no description spends a Claude call to come back with the
 * same nothing it started with. On Aura Santan that was most of the candidates:
 * 21 of 33 were `TBD` + `9" UNDER CABINET` (2026-09-01).
 *
 * This decides only the INITIAL checkbox state in the identify panel. Which
 * lines are worth a call is a judgement about the document that the estimator
 * makes, and every line stays one click away — nothing is hidden or blocked.
 *
 * Pure and Next/React-free so the panel's default and its tests share one
 * definition.
 */

import { isUrlLike } from '../engine/matcher';
import type { ParsedLineItem } from '../types';

/** Manufacturer cells that name no manufacturer. */
const PLACEHOLDER_MANUFACTURER = /^(TBD|TBA|N\/?A|NONE|NO SPEC|\?+|-+)$/i;

/**
 * True when the catalog cell carries something that reads as an orderable part
 * number rather than a description: a token mixing letters and digits
 * ("AKT30401-III", "GPX6-SO"), or a long run of digits ("12418-062").
 */
export function hasPartNumber(catalogNumber: string): boolean {
    return catalogNumber
        .toUpperCase()
        .split(/[\s,;]+/)
        .some(token => {
            const bare = token.replace(/[^A-Z0-9]/g, '');
            if (bare.length < 4) return false;
            if (/^\d{4,}$/.test(bare)) return true;
            return /[A-Z]/.test(bare) && /\d/.test(bare);
        });
}

/**
 * True when the text reads as a DESCRIPTION — two or more real words.
 *
 * Deliberately not the engine's `looksLikeProse`, which additionally requires a
 * word from its own fixture vocabulary. That is the right bar for driving a
 * prose-token catalog search; it is the wrong bar here, because the question is
 * only whether a person would say there is something to read. "CUSTOM RESIN
 * DIFFUSER LUMINAIRE" names no vocabulary word the engine knows and is still
 * obviously worth a lookup (Copilot review, PR #28); "JBOX" is one token and is
 * not.
 */
export function readsAsDescription(text: string): boolean {
    const words = text.toUpperCase().match(/[A-Z]{3,}/g) ?? [];
    return words.length >= 2;
}

/** True when the manufacturer cell names an actual manufacturer. */
export function hasManufacturer(manufacturer: string): boolean {
    const trimmed = manufacturer.trim();
    return trimmed !== '' && !PLACEHOLDER_MANUFACTURER.test(trimmed);
}

/**
 * True when a line has something identification could work from.
 *
 * DESCRIPTIVE TEXT COUNTS: the batch path is built to read prose, and
 * `TBD` + `ELEVATOR PIT LIGHT` is a line Claude can place even though nothing
 * on it is a part number. `TBD` + `JBOX` is not.
 */
export function hasIdentifiableSignal(line: ParsedLineItem): boolean {
    if (hasManufacturer(line.manufacturer)) return true;
    // A pasted spec-sheet URL is not a catalog value — same rule as the engine.
    const catalog = isUrlLike(line.catalogNumber) ? '' : line.catalogNumber;
    if (hasPartNumber(catalog)) return true;
    const description = line.description ?? line.rawRow?.DESCRIPTION ?? '';
    return readsAsDescription(`${catalog} ${description}`);
}
