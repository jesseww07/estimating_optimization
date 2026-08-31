/**
 * The IdentifiedSpec wire contract, shared by every identification path.
 *
 * Deliberately SDK-free and side-effect-free (no Anthropic import, no
 * server-only guard): the JSON-schema shape and the defensive normalizer are
 * pure functions, so they are unit-testable without a network call or an API
 * key. `lib/identify/claude.ts` (per-line: url / web / pdf) and
 * `lib/identify/batch.ts` (sheet-level batch) both build on this so the two
 * paths cannot drift apart on the one thing that matters most — the category
 * vocabulary the engine will actually accept.
 */

import { CATEGORY_GROUPS } from '../engine/matcher';
import type { IdentifiedSpec, IdentifyConfidence, IdentifySource } from './types';

/**
 * The engine's category vocabulary — identification must map onto these labels
 * so an identified line plugs straight into the existing category gates.
 */
export const ENGINE_CATEGORY_LABELS = Object.keys(CATEGORY_GROUPS);

/** Keys every structured-output spec object must carry (strict schema: nullables are explicit). */
export const SPEC_REQUIRED_KEYS = [
    'manufacturer',
    'catalogNumber',
    'productName',
    'category',
    'attributes',
    'confidence',
    'evidence',
] as const;

/**
 * JSON-schema properties for one IdentifiedSpec. The `category` enum is built
 * from the engine's own CATEGORY_GROUPS keys, so the model is constrained to
 * labels the engine can act on — a label the engine does not know is worse
 * than null (it silently fails every category gate downstream).
 */
export function specSchemaProperties(): Record<string, unknown> {
    const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
    return {
        manufacturer: { type: 'string', description: 'Brand/manufacturer name, e.g. "LITHONIA LIGHTING". Empty string if unknown.' },
        catalogNumber: { type: 'string', description: 'The orderable catalog / model number, e.g. "CSVT L48 4000LM". Empty string if unknown.' },
        productName: { type: 'string', description: 'Human product name / family, e.g. "Contractor Select Vapor Tight".' },
        category: {
            anyOf: [
                { type: 'string', enum: ENGINE_CATEGORY_LABELS },
                { type: 'null' },
            ],
            description: 'The fixture category, chosen ONLY from the allowed labels; null if none fits.',
        },
        attributes: {
            type: 'object',
            additionalProperties: false,
            required: ['finish', 'colorTemp', 'wattage', 'lumens', 'dimensions', 'voltage', 'mounting'],
            properties: {
                finish: nullableString,
                colorTemp: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'e.g. "3000K" or "3CCT selectable"' },
                wattage: nullableString,
                lumens: nullableString,
                dimensions: nullableString,
                voltage: nullableString,
                mounting: nullableString,
            },
        },
        confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
        evidence: { type: 'string', description: 'One or two sentences: what in the source supports this identification. For web lookups, MUST name the page/URL used.' },
    };
}

/** JSON schema for a single structured IdentifiedSpec response. */
export function specSchema(): Record<string, unknown> {
    return {
        type: 'object',
        additionalProperties: false,
        required: [...SPEC_REQUIRED_KEYS],
        properties: specSchemaProperties(),
    };
}

/** The raw JSON the model emits for one spec, before normalization. */
export interface RawSpec {
    manufacturer: string;
    catalogNumber: string;
    productName: string;
    category: string | null;
    attributes: Record<string, string | null>;
    confidence: IdentifyConfidence;
    evidence: string;
}

/**
 * Normalize a raw model payload into an IdentifiedSpec, re-validating the
 * category against the engine vocabulary even though the schema already
 * constrains it. Structured output is a strong constraint, not a guarantee —
 * and an unknown label would pass silently through the engine's gates as a
 * category that matches nothing.
 */
export function toIdentifiedSpec(raw: RawSpec, source: IdentifySource): IdentifiedSpec {
    const category = raw?.category && CATEGORY_GROUPS[raw.category] ? raw.category : null;
    const attrs = raw?.attributes ?? {};
    const s = (v: string | null | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);
    return {
        manufacturer: (raw?.manufacturer ?? '').trim(),
        catalogNumber: (raw?.catalogNumber ?? '').trim(),
        productName: (raw?.productName ?? '').trim(),
        category,
        attributes: {
            finish: s(attrs.finish),
            colorTemp: s(attrs.colorTemp),
            wattage: s(attrs.wattage),
            lumens: s(attrs.lumens),
            dimensions: s(attrs.dimensions),
            voltage: s(attrs.voltage),
            mounting: s(attrs.mounting),
        },
        confidence: raw?.confidence === 'HIGH' || raw?.confidence === 'MEDIUM' ? raw.confidence : 'LOW',
        source,
        evidence: (raw?.evidence ?? '').trim(),
    };
}
