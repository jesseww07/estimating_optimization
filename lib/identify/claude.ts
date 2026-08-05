/**
 * SERVER-ONLY Claude identification engine.
 *
 * One engine for all three input types (URL page text, web search, spec-sheet
 * PDF): given raw evidence, return an IdentifiedSpec as structured output.
 * Same credential discipline as the Airtable adapter — ANTHROPIC_API_KEY is
 * read only here, trimmed, never bundled client-side.
 *
 * Cost control (Phase 2 guardrail): every call is user-triggered per line —
 * routes must never sweep a whole sheet. Token usage is logged per call.
 */

import Anthropic from '@anthropic-ai/sdk';
import { CATEGORY_GROUPS } from '../engine/matcher';
import type { ParsedLineItem } from '../types';
import type { IdentifiedSpec, IdentifySource } from './types';

if (typeof window !== 'undefined') {
    throw new Error('lib/identify/claude.ts is server-only and must never be bundled for the browser.');
}

function getApiKey(): string {
    // Trim defensively, same as AIRTABLE_PAT: a trailing newline pasted into the
    // Vercel env editor turns into an auth error that is miserable to spot.
    return (process.env.ANTHROPIC_API_KEY ?? '').trim();
}

export function isIdentifyAvailable(): boolean {
    return getApiKey().length > 0;
}

function getClient(): Anthropic {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set — identification is unavailable.');
    return new Anthropic({ apiKey });
}

/** Model is env-switchable; claude-sonnet-5 is the right cost/latency for extraction (decision 2026-07-20). */
function getModel(): string {
    return (process.env.IDENTIFY_MODEL ?? '').trim() || 'claude-sonnet-5';
}

// The engine's category vocabulary — identification must map onto these labels
// so an identified line plugs straight into the existing category gates.
const ENGINE_CATEGORY_LABELS = Object.keys(CATEGORY_GROUPS);

/** JSON schema for the structured IdentifiedSpec output (strict shape: all keys required, nullables explicit). */
function specSchema(): Record<string, unknown> {
    const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
    return {
        type: 'object',
        additionalProperties: false,
        required: ['manufacturer', 'catalogNumber', 'productName', 'category', 'attributes', 'confidence', 'evidence'],
        properties: {
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
        },
    };
}

const SYSTEM_PROMPT = `You identify lighting-fixture products for Premier Lighting's estimating team.
Given raw evidence (a product page, search findings, or a manufacturer cut sheet) plus the bid-line
context, extract the product's identity. Rules:
- catalogNumber is the orderable part number as printed by the manufacturer, not a marketing name.
- category must be one of the allowed labels; pick the closest, or null if genuinely none applies.
  Labels: ${ENGINE_CATEGORY_LABELS.join(', ')}.
- confidence: HIGH only when the evidence explicitly shows this exact catalog number; MEDIUM when the
  family/series is clear but the exact configuration is inferred; LOW when identification is a guess.
- Never invent a catalog number. If the evidence does not identify the product, return empty strings
  and LOW confidence.`;

function lineContext(line: ParsedLineItem): string {
    return [
        'Bid-line context:',
        `  Mark: ${line.mark || '(none)'}`,
        `  Manufacturer (as typed): ${line.manufacturer || '(none)'}`,
        `  Catalog # (as typed): ${line.catalogNumber || '(none)'}`,
        line.section ? `  Section: ${line.section}` : '',
    ].filter(Boolean).join('\n');
}

interface UsageLike {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
}

function logUsage(stage: string, source: IdentifySource, model: string, usage: UsageLike): void {
    // Guardrail: identification token usage must be visible in logs.
    console.log(
        `[identify] source=${source} stage=${stage} model=${model} ` +
        `input_tokens=${usage.input_tokens} output_tokens=${usage.output_tokens}` +
        (usage.cache_read_input_tokens ? ` cache_read=${usage.cache_read_input_tokens}` : ''),
    );
}

interface RawSpec {
    manufacturer: string;
    catalogNumber: string;
    productName: string;
    category: string | null;
    attributes: Record<string, string | null>;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    evidence: string;
}

function toIdentifiedSpec(raw: RawSpec, source: IdentifySource): IdentifiedSpec {
    // Defensive re-validation of the category label (schema already constrains it).
    const category = raw.category && CATEGORY_GROUPS[raw.category] ? raw.category : null;
    const attrs = raw.attributes ?? {};
    const s = (v: string | null | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);
    return {
        manufacturer: (raw.manufacturer ?? '').trim(),
        catalogNumber: (raw.catalogNumber ?? '').trim(),
        productName: (raw.productName ?? '').trim(),
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
        confidence: raw.confidence === 'HIGH' || raw.confidence === 'MEDIUM' ? raw.confidence : 'LOW',
        source,
        evidence: (raw.evidence ?? '').trim(),
    };
}

function firstText(content: Array<{ type: string; text?: string }>): string {
    for (const block of content) {
        if (block.type === 'text' && block.text) return block.text;
    }
    return '';
}

/** Structured-output extraction call shared by all modes. */
async function extract(
    userContent: Anthropic.Messages.ContentBlockParam[],
    source: IdentifySource,
): Promise<IdentifiedSpec> {
    const client = getClient();
    const model = getModel();
    const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        output_config: { format: { type: 'json_schema', schema: specSchema() } },
        messages: [{ role: 'user', content: userContent }],
    });
    logUsage('extract', source, model, response.usage);
    if (response.stop_reason === 'refusal') {
        throw new Error('Identification declined by the model (refusal).');
    }
    if (response.stop_reason === 'max_tokens') {
        throw new Error('Identification output was truncated (max_tokens).');
    }
    const text = firstText(response.content);
    if (!text) throw new Error('Identification returned no output.');
    return toIdentifiedSpec(JSON.parse(text) as RawSpec, source);
}

/** Identify from fetched page text (mode: url) or any plain-text evidence. */
export async function identifyFromText(evidence: string, line: ParsedLineItem, source: IdentifySource = 'url'): Promise<IdentifiedSpec> {
    return extract(
        [{
            type: 'text',
            text: `${lineContext(line)}\n\nEvidence (fetched page content):\n---\n${evidence}\n---\nIdentify the product this evidence describes.`,
        }],
        source,
    );
}

/** Identify from a spec-sheet PDF (mode: pdf) — Claude reads the PDF natively, no OCR pipeline. */
export async function identifyFromPdf(pdfBase64: string, line: ParsedLineItem): Promise<IdentifiedSpec> {
    return extract(
        [
            {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
            },
            {
                type: 'text',
                text: `${lineContext(line)}\n\nThe attached document is the manufacturer cut sheet / spec sheet for this bid line. Identify the product it specifies (respect any option boxes that are marked/circled).`,
            },
        ],
        'pdf',
    );
}

/**
 * Identify via web search (mode: web). Two calls on purpose: a research turn
 * with the server-side web_search tool (whose results carry citations), then
 * the shared structured-output extraction over the findings — structured
 * output and search citations cannot share one response.
 *
 * blockedUrl: a spec link the estimator pasted that could not be fetched
 * directly (bot-blocked / 403 / timeout). It still identifies the product
 * better than anything else on the line, so it is handed to the research turn
 * as the primary lead.
 */
export async function identifyFromWeb(line: ParsedLineItem, blockedUrl?: string): Promise<IdentifiedSpec> {
    const client = getClient();
    const model = getModel();
    const urlLead = blockedUrl
        ? `\n\nThe estimator pasted this spec link, but the page refused a direct fetch: ${blockedUrl}\n` +
        'Treat it as the primary lead — search for the product that URL points to (its path segments usually name the product/SKU).'
        : '';
    const research = await client.messages.create({
        model,
        max_tokens: 8192,
        system: 'You research lighting-fixture products. Search the web to identify the exact product a bid line refers to. Report the manufacturer, exact catalog/model number, product name, category, key attributes (finish, color temperature, wattage, lumens, dimensions), and ALWAYS name the URL/page each fact came from. If you cannot identify it confidently, say so plainly.',
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
        messages: [{
            role: 'user',
            content: `${lineContext(line)}${urlLead}\n\nIdentify this product. Search for the manufacturer + catalog number; prefer the manufacturer's own site or distributor spec pages.`,
        }],
    });
    logUsage('research', 'web', model, research.usage);
    const findings = research.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    if (!findings.trim()) throw new Error('Web lookup returned no findings.');
    return identifyFromText(`Web research findings (already cited):\n${findings}`, line, 'web');
}
