/**
 * SERVER-ONLY Claude identification engine.
 *
 * One engine for all three input types (URL page text, web search, an uploaded
 * cut sheet — PDF or image): given raw evidence, return an IdentifiedSpec as
 * structured output.
 * Same credential discipline as the Airtable adapter — ANTHROPIC_API_KEY is
 * read only here, trimmed, never bundled client-side.
 *
 * Cost control — the Phase 2 guardrail, AMENDED for Phase 4 (2026-08-31; needs
 * a human sign-off before it ships):
 *
 *   Phase 2 rule (as written): "every call is user-triggered per line — routes
 *   must never sweep a whole sheet."
 *
 *   Why it said that: a sheet sweep through THIS module means one Claude call
 *   per line. 472 uncategorized lines = 472 calls, each with its own research
 *   turn. That cost profile is what the rule banned, and it still is: nothing
 *   in this file may ever be called in a loop over a sheet.
 *
 *   Phase 4 amendment: `lib/identify/batch.ts` sweeps a sheet with ONE call per
 *   CHUNK of ~18 lines (at most 12 calls per pass, hard-capped)
 *   and no web-search turns at all. The property the rule was protecting —
 *   the estimator explicitly chooses to spend the call, nothing fires on
 *   upload — is preserved there: the batch route is only reachable from an
 *   explicit "Identify N unrecognized lines" button.
 *
 *   So the contract is now: identification is always USER-TRIGGERED and always
 *   BOUNDED. Per-line calls (this module) stay one-line-per-request; sheet-wide
 *   identification goes through the batched module, never through here.
 *
 * Token usage is logged per call in both modules.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, isIdentifyAvailable } from './anthropic';
import { mediaContentBlock, type SupportedMedia } from './media';
import type { ParsedLineItem } from '../types';
import { ENGINE_CATEGORY_LABELS, specSchema, toIdentifiedSpec, type RawSpec } from './spec';
import type { IdentifiedSpec, IdentifySource } from './types';

if (typeof window !== 'undefined') {
    throw new Error('lib/identify/claude.ts is server-only and must never be bundled for the browser.');
}

export { isIdentifyAvailable };

// Hard latency ceiling per Claude call. The SDK defaults to a 10-minute timeout
// AND two automatic retries, so a single slow web-lookup could occupy the route
// for half an hour — which is exactly what "Look up spec" looked like from the
// estimator's side: the button row swapped to "Identifying (web)…" and never
// came back (Firecrest review, 2026-08-10). Bounded here so the route always
// returns something the UI can render, error included.
// Budgeted so the WORST case (web = research + extraction) stays under the
// client-side abort, which in turn stays under the route's maxDuration:
// 90 + 45 = 135s < 180s browser abort < 300s route. Any retry would break that
// chain — the SDK's default 2 retries turn a 90s ceiling into a 270s one, and
// the server would still be doing billable work long after the UI gave up.
const RESEARCH_TIMEOUT_MS = 90_000;
const EXTRACT_TIMEOUT_MS = 45_000;

function getClient(timeoutMs: number): Anthropic {
    // Credentials, retry policy, and the identity-linked-key workspace header
    // all live in ./anthropic — see that module for why the header is required.
    return createAnthropicClient({ timeoutMs });
}

/** Model is env-switchable; claude-sonnet-5 is the right cost/latency for extraction (decision 2026-07-20). */
function getModel(): string {
    return (process.env.IDENTIFY_MODEL ?? '').trim() || 'claude-sonnet-5';
}

// The structured-output schema (and its category enum, built from the engine's
// own CATEGORY_GROUPS) lives in ./spec.ts so the batch identifier speaks the
// exact same vocabulary and the two paths cannot drift apart.

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
    const client = getClient(EXTRACT_TIMEOUT_MS);
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

/**
 * Identify from an uploaded cut sheet (mode: pdf) — Claude reads it natively,
 * no OCR pipeline. The file may be a PDF or a photo/screenshot of the cut sheet;
 * `media` decides which content block and media type it is sent as.
 *
 * The IdentifySource stays 'pdf' for an image too: it is the route's public
 * contract for "identified from an uploaded document", and the UI renders it as
 * "spec sheet".
 */
export async function identifyFromDocument(
    base64: string,
    media: SupportedMedia,
    line: ParsedLineItem,
): Promise<IdentifiedSpec> {
    return extract(
        [
            mediaContentBlock(media, base64),
            {
                type: 'text',
                text: `${lineContext(line)}\n\nThe attached ${media.label} is the manufacturer cut sheet / spec sheet for this bid line. Identify the product it specifies (respect any option boxes that are marked/circled).`,
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
    const client = getClient(RESEARCH_TIMEOUT_MS);
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
