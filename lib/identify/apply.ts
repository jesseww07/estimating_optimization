/**
 * Merge an IdentifiedSpec back into a ParsedLineItem.
 *
 * The engine re-runs cleanly on the merged line: an identified line is just
 * the same ParsedLineItem with manufacturer/catalogNumber filled in, plus the
 * `identified` passthrough for provenance (and the category gate override in
 * lib/engine/recommend.ts). Pure function — safe for tests and the client.
 */

import type { ParsedLineItem } from '../types';
import type { IdentifiedSpec } from './types';

export function applyIdentifiedSpec(line: ParsedLineItem, spec: IdentifiedSpec): ParsedLineItem {
    return {
        ...line,
        // Identified values win only when the identification actually produced one.
        manufacturer: spec.manufacturer || line.manufacturer,
        catalogNumber: spec.catalogNumber || line.catalogNumber,
        identified: spec,
    };
}
