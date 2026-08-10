/**
 * Merge an IdentifiedSpec back into a ParsedLineItem.
 *
 * The engine re-runs cleanly on the merged line: an identified line is just
 * the same ParsedLineItem with manufacturer/catalogNumber filled in, plus the
 * `identified` passthrough for provenance (and the category gate override in
 * lib/engine/recommend.ts). Pure function — safe for tests and the client.
 */

import { isUrlLike } from '../engine/matcher';
import type { ParsedLineItem } from '../types';
import type { IdentifiedSpec } from './types';

export function applyIdentifiedSpec(line: ParsedLineItem, spec: IdentifiedSpec): ParsedLineItem {
    // The TYPED catalog # stays the line's catalogNumber whenever it's usable:
    // History is filed under the spec as the estimator wrote it, so overwriting
    // it with the identified part number silently threw away every prior
    // decision on that line (Firecrest R13 — identifying "LUMIERE 1003" left the
    // recommendations looking untouched because the history key had changed out
    // from under them). The identified number is not lost: the engine reads it
    // off `identified` and scores against BOTH keys, so identification can only
    // add matches. It only replaces the typed value when there is nothing usable
    // to keep — an empty cell or a pasted spec-sheet URL.
    const typed = line.catalogNumber.trim();
    const typedIsUsable = typed !== '' && !isUrlLike(typed);
    return {
        ...line,
        // Identified values win only when the identification actually produced one.
        manufacturer: spec.manufacturer || line.manufacturer,
        catalogNumber: typedIsUsable ? line.catalogNumber : (spec.catalogNumber || line.catalogNumber),
        identified: spec,
    };
}
