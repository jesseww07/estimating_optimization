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
import { planCatalogSearch } from './catalogNumber';
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
// client-side abort, which in turn stays under the route's maxDuration. Any
// retry would break that chain — the SDK's default 2 retries turn a 150s ceiling
// into a 450s one, and the server would still be doing billable work long after
// the UI gave up.
//
// The research ceiling was 90s until 2026-09-01, and that was the whole reason
// "Look up spec" had never once succeeded in live use: every attempt came back
// "Identification failed: Request timed out.", which is the SDK's own message for
// hitting it. A server-side web_search turn that runs several searches and reads
// the pages it finds routinely needs longer than 90s, so the button was timing
// out on work that was going fine. Two changes rather than one: the ceiling moved
// up, AND the research turn is now STREAMED against a soft deadline, so findings
// already gathered are extracted from instead of thrown away when the budget runs
// out. A slow search degrades to a partial answer rather than to a failure.
//
// The chain, end to end:
// 150 (research hard) + 45 (extract) = 195s < 240s browser abort < 300s route.
const RESEARCH_TIMEOUT_MS = 150_000;
/** Stop the research turn here and extract from whatever it has already found. */
const RESEARCH_SOFT_DEADLINE_MS = 120_000;
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
- confidence: HIGH when the evidence explicitly shows this product — the exact catalog number, OR the
  BASE item number with its product type unambiguous (a trailing finish/CCT/wattage code that the
  evidence doesn't spell out does not reduce confidence; those are configuration, not identity);
  MEDIUM when the family/series is clear but the product itself is inferred; LOW when it is a guess.
- catalogNumber: report the BASE item number the evidence confirms, not the configured string from
  the bid line. The estimator keeps their own typed spec — what identification adds is the item.
- productName must say what the product IS in the words a person would use ("2-light 18\" bar vanity",
  "7\" recessed disk light"), not just repeat the model code.
- Never invent a catalog number. If the evidence does not identify the product, return empty strings
  and LOW confidence.`;

/**
 * The research turn's brief. Asks for the high-level identity an estimator
 * actually needs — what the product IS — and explicitly licenses a base-item
 * answer, because a configuration-exact page usually does not exist.
 */
const RESEARCH_SYSTEM_PROMPT = `You research lighting-fixture products for an estimating team. Search the web to identify the product a bid line refers to.
- Search the BASE item number (manufacturer + item number). Trailing finish, colour-temperature,
  wattage and voltage codes are configuration: leave them OUT of the query. They narrow a search to
  nothing, and the estimator can adjust them anyway.
- What matters most is the product's IDENTITY: what kind of fixture it is (vanity bar, disk light,
  wall pack, pendant…), its lamp count, size/dimensions, mounting, and the finish and
  colour-temperature OPTIONS the family offers. Report those even when the exact configured SKU has
  no page of its own.
- If the bid line lists several catalog numbers, identify each one and say how they differ.
- If a stripped code appears in a finish/option table on a page you read, say what it maps to.
- ALWAYS name the URL/page each fact came from.
- Stop searching as soon as you can name the product. If you genuinely cannot identify it, say so
  plainly and report what the closest evidence was.`;

/**
 * The bid line as evidence, with the catalog cell already split into the item
 * number and its configuration codes (see ./catalogNumber).
 *
 * Every mode gets this, not just the web lookup: knowing that `112` in
 * `4430802-112` is a finish code is what stops the extraction from reporting the
 * configured string as the product's catalog number.
 */
function lineContext(line: ParsedLineItem): string {
    const plan = planCatalogSearch(line.catalogNumber);
    return [
        'Bid-line context:',
        `  Mark: ${line.mark || '(none)'}`,
        `  Manufacturer (as typed): ${line.manufacturer || '(none)'}`,
        `  Catalog # (as typed): ${line.catalogNumber || '(none)'}`,
        plan.alternates.length > 1
            ? `  This cell lists ${plan.alternates.length} catalog numbers: ${plan.alternates.join(', ')}`
            : '',
        plan.hasBase ? `  Base item number(s): ${plan.baseNumbers.join(', ')}` : '',
        plan.optionCodes.length
            ? `  Trailing configuration codes (finish / colour temperature / wattage — NOT part of the item's identity): ${plan.optionCodes.join(', ')}`
            : '',
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
 * Identify via web search (mode: web) — the "Look up spec" button.
 *
 * Two calls on purpose: a research turn with the server-side web_search tool
 * (whose results carry citations), then the shared structured-output extraction
 * over the findings — structured output and search citations cannot share one
 * response.
 *
 * Search the ITEM, not the configuration. The estimator's own instinct is the
 * spec here (2026-09-01): given `VISUAL COMFORT 4430802-112` they type
 * `visual comfort 4430802` into Google and immediately learn it is a two-light
 * bar vanity and which finishes it comes in — the `-112` is a finish code and
 * searching it only narrows the results to nothing. So the research turn is
 * pointed at the base item number, told what was stripped and why, and asked for
 * the high-level identity (what the product IS, its type, size, lamp count,
 * mounting, and the finish/CCT options the family offers) rather than a
 * configuration-exact match.
 *
 * The turn is streamed against a soft deadline so a slow search degrades to a
 * partial answer instead of a dead button: whatever findings arrived before the
 * deadline still go to extraction.
 *
 * blockedUrl: a spec link the estimator pasted that could not be fetched
 * directly (bot-blocked / 403 / timeout). It still identifies the product
 * better than anything else on the line, so it is handed to the research turn
 * as the primary lead.
 */
export async function identifyFromWeb(line: ParsedLineItem, blockedUrl?: string): Promise<IdentifiedSpec> {
    const client = getClient(RESEARCH_TIMEOUT_MS);
    const model = getModel();
    const plan = planCatalogSearch(line.catalogNumber);
    const manufacturer = line.manufacturer.trim();
    const queries = (plan.baseNumbers.length ? plan.baseNumbers : plan.alternates)
        .map(base => [manufacturer, base].filter(Boolean).join(' '))
        .filter(Boolean);
    const urlLead = blockedUrl
        ? `\n\nThe estimator pasted this spec link, but the page refused a direct fetch: ${blockedUrl}\n` +
        'Treat it as the primary lead — search for the product that URL points to (its path segments usually name the product/SKU).'
        : '';
    const searchLead = queries.length
        ? `\n\nSearch for these first, exactly as written: ${queries.map(q => `"${q}"`).join(' then ')}.` +
        (plan.optionCodes.length
            ? ` Do NOT put the configuration codes (${plan.optionCodes.join(', ')}) in the query — they are finish / colour-temperature / wattage suffixes, and including them is what makes these searches return nothing.`
            : '')
        : '';

    // Streamed so a soft-deadline abort still leaves us the findings so far.
    const stream = client.messages.stream({
        model,
        max_tokens: 8192,
        system: RESEARCH_SYSTEM_PROMPT,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
        messages: [{
            role: 'user',
            content: `${lineContext(line)}${urlLead}${searchLead}\n\nIdentify this product. Prefer the manufacturer's own site, then distributor product pages.`,
        }],
    });
    let streamed = '';
    stream.on('text', delta => { streamed += delta; });
    const softDeadline = setTimeout(() => stream.abort(), RESEARCH_SOFT_DEADLINE_MS);
    let findings = '';
    try {
        const research = await stream.finalMessage();
        logUsage('research', 'web', model, research.usage);
        findings = research.content
            .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
            .map(b => b.text)
            .join('\n');
    } catch (researchErr) {
        // The research turn ran out of budget (or the connection dropped). Its
        // findings so far are still the best evidence we have — a lookup that
        // already found the product must not be thrown away over the clock.
        if (!streamed.trim()) {
            const message = researchErr instanceof Error ? researchErr.message : String(researchErr);
            throw new Error(
                `Web lookup found nothing before its ${RESEARCH_SOFT_DEADLINE_MS / 1000}s budget ran out (${message}). ` +
                'Try again, or identify from the cut sheet.',
            );
        }
        console.warn(`[identify] source=web stage=research cut short at the soft deadline — extracting from partial findings (${streamed.length} chars)`);
        findings = streamed;
    } finally {
        clearTimeout(softDeadline);
    }
    if (!findings.trim()) throw new Error('Web lookup returned no findings.');
    return identifyFromText(`Web research findings (already cited):\n${findings}`, line, 'web');
}
