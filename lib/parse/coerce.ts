/**
 * Shared request-body coercion for ParsedLineItem payloads.
 *
 * Route handlers receive line items back from the client (recommendations,
 * export, identify); this normalizes untrusted JSON into the ParsedLineItem
 * shape without throwing. Unknown/missing fields degrade to '' / defaults.
 */

import type { ParsedLineItem } from '../types';
import type { IdentifiedSpec } from '../identify/types';

export function str(v: unknown): string {
    return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function coerceIdentified(raw: unknown): IdentifiedSpec | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const o = raw as Record<string, unknown>;
    const attrs = (o.attributes && typeof o.attributes === 'object' ? o.attributes : {}) as Record<string, unknown>;
    const opt = (v: unknown): string | undefined => {
        const s = str(v).trim();
        return s ? s : undefined;
    };
    const confidence = o.confidence === 'HIGH' || o.confidence === 'MEDIUM' ? o.confidence : 'LOW';
    const source = o.source === 'web' || o.source === 'pdf' ? o.source : 'url';
    return {
        manufacturer: str(o.manufacturer),
        catalogNumber: str(o.catalogNumber),
        productName: str(o.productName),
        category: typeof o.category === 'string' && o.category ? o.category : null,
        attributes: {
            finish: opt(attrs.finish),
            colorTemp: opt(attrs.colorTemp),
            wattage: opt(attrs.wattage),
            lumens: opt(attrs.lumens),
            dimensions: opt(attrs.dimensions),
            voltage: opt(attrs.voltage),
            mounting: opt(attrs.mounting),
        },
        confidence,
        source,
        evidence: str(o.evidence),
    };
}

export function coerceLineItem(raw: unknown, index: number): ParsedLineItem | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const rawRow: Record<string, string> = {};
    if (o.rawRow && typeof o.rawRow === 'object') {
        for (const [k, v] of Object.entries(o.rawRow as Record<string, unknown>)) {
            rawRow[k] = str(v);
        }
    }
    const specUrls = Array.isArray(o.specUrls)
        ? o.specUrls.map(str).filter(Boolean)
        : undefined;
    return {
        rowIndex: typeof o.rowIndex === 'number' ? o.rowIndex : index,
        section: str(o.section),
        mark: str(o.mark),
        quantity: str(o.quantity),
        manufacturer: str(o.manufacturer),
        catalogNumber: str(o.catalogNumber),
        rawRow,
        ...(specUrls && specUrls.length > 0 ? { specUrls } : {}),
        ...(o.identified ? { identified: coerceIdentified(o.identified) } : {}),
    };
}
