/**
 * SERVER-ONLY fixture-schedule extraction (pulled forward from Phase 3,
 * 2026-07-28 — Jesse hit the upload wall in live use).
 *
 * The schedule grid comes back as structured line items that feed the exact same
 * recommendation flow as a pre-converted CSV/XLSX. The document may be a PDF or
 * a photo/screenshot of the schedule — Claude reads both natively.
 *
 * Long schedules (2026-08-31): a 200-line schedule is a normal input, and one
 * call with `max_tokens: 32000` truncated on it and threw "split the PDF and try
 * again", which lost the upload. Extraction is now planned over PAGE RANGES: a
 * short document is still exactly one call, and a long one is read in several
 * passes whose rows are concatenated in document order. Every pass logs its own
 * token usage, so a chunked read is as visible in the logs as a single one.
 *
 * Why page ranges are an instruction rather than a physical split: the Messages
 * API takes a whole document, with no page-selection parameter, and splitting
 * the file would mean adding a PDF library for it. So each pass attaches the
 * same document (with a cache breakpoint, so passes 2..n read it from cache) and
 * is scoped to its pages in the prompt.
 *
 * Word documents (2026-09-01) take the second path in this module:
 * `extractScheduleFromPages` reads a document that arrives as an ordered LIST of
 * pages, because a .docx is a ZIP whose schedule grids are usually pasted-in
 * screenshots rather than anything the API can be handed whole (see
 * lib/parse/docx.ts). There the page ranges are sliced PHYSICALLY — only the
 * pass's own pages are attached — which is the same planning code with a
 * truthful scope sentence.
 *
 * The planning/joining logic is pure and injected-extractor driven
 * (`extractScheduleRows`) so it is unit-testable without an API key.
 */

import { createAnthropicClient, getApiKey } from './anthropic';
import { mediaContentBlock, type SupportedMedia } from './media';
import { countPdfPages } from './pdfPages';
import type Anthropic from '@anthropic-ai/sdk';
import type { ParsedLineItem } from '../types';

if (typeof window !== 'undefined') {
    throw new Error('lib/identify/schedule.ts is server-only and must never be bundled for the browser.');
}

function getModel(): string {
    return (process.env.IDENTIFY_MODEL ?? '').trim() || 'claude-sonnet-5';
}

/** Output ceiling for ONE extraction pass. Hitting it means the range is too wide. */
const MAX_OUTPUT_TOKENS = 32000;
/** Pages per pass. Wide enough that ordinary schedules stay a single call. */
export const PAGES_PER_CHUNK = 8;
/** Hard ceiling on passes per upload, so a pathological document cannot loop. */
export const MAX_CHUNKS = 12;

const SCHEDULE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['lineItems'],
    properties: {
        lineItems: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['mark', 'quantity', 'manufacturer', 'catalogNumber', 'section', 'description', 'specUrl'],
                properties: {
                    mark: { type: 'string', description: 'The fixture mark / type designation (e.g. "P1", "CG-400", "U2-CLF-1"). Empty string if the row has none.' },
                    quantity: { type: 'string', description: 'Quantity as printed; empty string when the schedule shows none.' },
                    manufacturer: { type: 'string', description: 'Manufacturer / brand as printed.' },
                    catalogNumber: { type: 'string', description: 'The full catalog / model / ordering string, verbatim including options. If the schedule only has a prose description, put that here.' },
                    section: { type: 'string', description: 'Location / area / building the row belongs to (from a location column or a section header above the row). Empty string if none.' },
                    description: { type: 'string', description: 'Fixture description text, if the schedule has a separate description column.' },
                    specUrl: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'A spec-sheet URL printed on the row, if any.' },
                },
            },
        },
    },
} as const;

const SCHEDULE_PROMPT = `The attached document is a lighting fixture schedule (or bid sheet) from a construction project.
Extract EVERY fixture line item in document order. Rules:
- One entry per fixture row. Do not invent rows; do not merge distinct rows.
- catalogNumber must be verbatim from the document, including option suffixes. Never abbreviate it.
- Rows that are section/location headers are not line items — instead, apply that location to the
  rows beneath them via the section field.
- Skip notes, legends, totals, and legal boilerplate. Keep RFI/TBD placeholder rows (they matter to
  the estimator) with whatever text the schedule shows.
- Companion lamp/bulb rows (e.g. "CG-404.B — Bulb @ Pendant") are real line items — keep them.`;

export interface ScheduleRow {
    mark: string;
    quantity: string;
    manufacturer: string;
    catalogNumber: string;
    section: string;
    description: string;
    specUrl: string | null;
}

/** Pure mapping from extracted rows to the parser's line-item shape (unit-tested). */
export function scheduleRowsToLineItems(rows: ScheduleRow[]): ParsedLineItem[] {
    const items: ParsedLineItem[] = [];
    for (const row of rows) {
        const mark = (row.mark ?? '').trim();
        const catalogNumber = (row.catalogNumber ?? '').trim();
        const description = (row.description ?? '').trim();
        if (!mark && !catalogNumber && !description) continue; // nothing identifying — drop
        const specUrl = (row.specUrl ?? '').trim();
        items.push({
            rowIndex: items.length,
            section: (row.section ?? '').trim(),
            mark,
            // A description-only row still needs a catalog value for matching.
            quantity: (row.quantity ?? '').trim(),
            manufacturer: (row.manufacturer ?? '').trim(),
            catalogNumber: catalogNumber || description,
            // Only when it is genuinely a SEPARATE column — on a description-only
            // row the same text is already the catalog value above, and carrying
            // it twice would let one column vote twice.
            ...(catalogNumber && description ? { description } : {}),
            rawRow: {
                MARK: mark,
                QTY: (row.quantity ?? '').trim(),
                MAN: (row.manufacturer ?? '').trim(),
                'CATALOG #': catalogNumber,
                Location: (row.section ?? '').trim(),
                DESCRIPTION: description,
            },
            ...(specUrl ? { specUrls: [specUrl] } : {}),
        });
    }
    return items;
}

// ── Page-range planning ──────────────────────────────────────────────────────

/** `end: null` means "through the last page", whatever the real page count is. */
export interface PageRange {
    start: number;
    end: number | null;
}

/** The single pass that reads everything — used when the document is short. */
export const WHOLE_DOCUMENT: PageRange = { start: 1, end: null };

export function isWholeDocument(range: PageRange): boolean {
    return range.start === 1 && range.end === null;
}

/**
 * Split a document into extraction passes.
 *
 * A document at or under one chunk's worth of pages (and one whose page count
 * could not be read at all) is a SINGLE whole-document pass — the common case
 * must not get more expensive. The final range is left open-ended so a page
 * count that reads low can never drop the end of the document.
 */
export function planPageRanges(
    pageCount: number | null,
    pagesPerChunk: number = PAGES_PER_CHUNK,
    maxChunks: number = MAX_CHUNKS,
): PageRange[] {
    if (!pageCount || pageCount <= pagesPerChunk) return [WHOLE_DOCUMENT];
    const chunks = Math.ceil(pageCount / pagesPerChunk);
    if (chunks > maxChunks) {
        throw new Error(
            `Schedule is ${pageCount} pages — more than the ${maxChunks * pagesPerChunk}-page limit for one upload. ` +
            'Split it into smaller files and upload them one at a time.',
        );
    }
    const ranges: PageRange[] = [];
    for (let start = 1; start <= pageCount; start += pagesPerChunk) {
        const last = start + pagesPerChunk > pageCount;
        ranges.push({ start, end: last ? null : start + pagesPerChunk - 1 });
    }
    return ranges;
}

/**
 * The prompt for one pass: the shared extraction rules, the page scope, and the
 * section heading that was in force at the end of the previous pass.
 *
 * Section carry-over is the whole reason chunk boundaries are not a data loss:
 * a schedule prints "LEVEL 2 — CORRIDOR" once and then runs rows under it for
 * three pages, so the pass that starts mid-run has no heading to read. It is
 * told the heading instead, and told it only applies until the document shows a
 * new one.
 */
export function buildSchedulePrompt(range: PageRange, carrySection: string): string {
    if (isWholeDocument(range)) return SCHEDULE_PROMPT;
    const pages = range.end === null
        ? `pages ${range.start} to the end of the document`
        : `pages ${range.start}-${range.end}`;
    const scope =
        `\n\nPAGE SCOPE: this pass covers ${pages} (the first page of the document is page 1). ` +
        'Extract ONLY rows printed on those pages. The other pages are read in separate passes, so a ' +
        'row repeated here would be duplicated in the result, and a row skipped here would be lost. ' +
        'A row that starts on the last page of this range and wraps onto the next page belongs to this pass.';
    const carry = carrySection
        ? `\n\nCARRIED CONTEXT: the last section/location heading printed before page ${range.start} was ` +
        `"${carrySection}". Rows at the top of page ${range.start} that continue under that heading — with no ` +
        'new heading above them — take that section. Stop using it as soon as the document shows a new heading.'
        : '';
    return `${SCHEDULE_PROMPT}${scope}${carry}`;
}

/** The section still in force after these rows — what the next pass inherits. */
export function lastSectionOf(rows: ScheduleRow[]): string {
    for (let i = rows.length - 1; i >= 0; i--) {
        const section = (rows[i]?.section ?? '').trim();
        if (section) return section;
    }
    return '';
}

/** How many rows back a boundary duplicate is looked for. */
const BOUNDARY_LOOKBACK = 2;

function rowKey(row: ScheduleRow): string {
    return [row.mark, row.catalogNumber, row.quantity]
        .map(v => (v ?? '').trim().toUpperCase().replace(/\s+/g, ' '))
        .join('|');
}

/**
 * Append one pass's rows, dropping a leading row that repeats the tail of what
 * we already have.
 *
 * Page ranges are disjoint and the prompt says so, but a row that straddles a
 * page break is genuinely ambiguous and can come back from both passes. Only the
 * HEAD of the incoming pass is checked, only against the last couple of rows,
 * and only on an exact mark+catalog+qty match — a real repeat elsewhere in the
 * schedule (the same fixture in another area) is untouched, because dropping a
 * real row is worse than keeping a duplicate one.
 */
export function appendChunkRows(accumulated: ScheduleRow[], incoming: ScheduleRow[]): ScheduleRow[] {
    if (accumulated.length === 0) return [...incoming];
    const tail = accumulated.slice(-BOUNDARY_LOOKBACK).map(rowKey);
    let skip = 0;
    while (skip < incoming.length) {
        const key = rowKey(incoming[skip]!);
        if (!key.replace(/\|/g, '').trim()) break; // blank row — not a duplicate signal
        if (!tail.includes(key)) break;
        skip++;
    }
    return [...accumulated, ...incoming.slice(skip)];
}

// ── Chunked extraction driver (network injected, so it is testable) ──────────

export interface ScheduleChunkRequest {
    range: PageRange;
    prompt: string;
}

export interface ScheduleChunkResult {
    rows: ScheduleRow[];
    /** The pass hit max_tokens — its rows are incomplete and must not be used. */
    truncated: boolean;
}

export type ScheduleChunkExtractor = (request: ScheduleChunkRequest) => Promise<ScheduleChunkResult>;

export interface ExtractScheduleOptions {
    /** null when the page count could not be read (an image, or an unreadable PDF). */
    pageCount: number | null;
    pagesPerChunk?: number;
    maxChunks?: number;
    /**
     * Prompt builder for one pass. Defaults to buildSchedulePrompt, whose page
     * scope is an INSTRUCTION because the whole document is attached every pass.
     * The pages path (see extractScheduleFromPages) attaches only its own pages,
     * so it overrides this with a prompt that says so.
     */
    buildPrompt?: (range: PageRange, carrySection: string) => string;
}

function resolveEnd(range: PageRange, pageCount: number | null): number | null {
    if (range.end !== null) return range.end;
    return pageCount && pageCount >= range.start ? pageCount : null;
}

/** Halve a range that produced too much output. Keeps an open end open. */
function splitRange(range: PageRange, pageCount: number | null): [PageRange, PageRange] | null {
    const end = resolveEnd(range, pageCount);
    if (end === null || end <= range.start) return null;
    const mid = range.start + Math.floor((end - range.start) / 2);
    return [
        { start: range.start, end: mid },
        { start: mid + 1, end: range.end },
    ];
}

/**
 * Run the passes and join their rows in document order.
 *
 * The joined array is mapped to line items ONCE by the caller, which is what
 * keeps `rowIndex` continuous and unique across the whole document —
 * `scheduleRowsToLineItems` indexes from zero per call, so mapping per pass
 * would restart the numbering at every boundary.
 */
export async function extractScheduleRows(
    extract: ScheduleChunkExtractor,
    options: ExtractScheduleOptions,
): Promise<ScheduleRow[]> {
    const pagesPerChunk = options.pagesPerChunk ?? PAGES_PER_CHUNK;
    const maxChunks = options.maxChunks ?? MAX_CHUNKS;
    const queue = planPageRanges(options.pageCount, pagesPerChunk, maxChunks);

    let rows: ScheduleRow[] = [];
    let passes = 0;
    while (queue.length > 0) {
        const range = queue.shift()!;
        if (passes >= maxChunks) {
            throw new Error(
                `Schedule needed more than ${maxChunks} extraction passes — it is too dense to read in one upload. ` +
                'Split it into smaller files and upload them one at a time.',
            );
        }
        passes++;
        const buildPrompt = options.buildPrompt ?? buildSchedulePrompt;
        const result = await extract({ range, prompt: buildPrompt(range, lastSectionOf(rows)) });
        if (result.truncated) {
            // Too many rows for one pass: read this range in halves instead of
            // failing the upload. Rows from a truncated pass are discarded —
            // the halves re-read the same pages.
            const halves = splitRange(range, options.pageCount);
            if (!halves) {
                throw new Error(
                    resolveEnd(range, options.pageCount) === null
                        ? 'Schedule extraction was truncated and the document\'s page count could not be read, so it cannot be split automatically. Split the file and upload the parts separately.'
                        : `Page ${range.start} alone holds more rows than one extraction pass can return. Re-export that page as a CSV/Excel sheet and upload that instead.`,
                );
            }
            queue.unshift(...halves);
            continue;
        }
        rows = appendChunkRows(rows, result.rows);
    }
    return rows;
}

// ── Live extraction ──────────────────────────────────────────────────────────

function chunkLabel(range: PageRange, pageCount: number | null): string {
    if (isWholeDocument(range)) return pageCount ? `1-${pageCount}` : 'all';
    return `${range.start}-${range.end ?? (pageCount ?? '')}`;
}

/**
 * Read a fixture schedule (PDF or image) into line items.
 *
 * Named for the document rather than the format: the same call reads a phone
 * photo of a schedule taped to a wall.
 */
export async function extractScheduleFromDocument(base64: string, media: SupportedMedia): Promise<ParsedLineItem[]> {
    if (!getApiKey()) throw new Error('ANTHROPIC_API_KEY is not set — schedule parsing is unavailable.');
    const client = createAnthropicClient();
    const model = getModel();
    // An image is a single page by definition; a PDF states its own page count.
    const pageCount = media.kind === 'image' ? 1 : countPdfPages(Buffer.from(base64, 'base64'));

    const rows = await extractScheduleRows(async ({ range, prompt }) => {
        // Streamed on purpose: a long schedule can produce well past the safe
        // non-streaming output size.
        const stream = client.messages.stream({
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            output_config: { format: { type: 'json_schema', schema: SCHEDULE_SCHEMA as unknown as Record<string, unknown> } },
            messages: [{
                role: 'user',
                content: [
                    // Cache the document ONLY when the read is chunked: every
                    // pass re-sends it, so from the second pass on it is read
                    // from cache instead of re-billed. A single-pass read would
                    // pay the cache-write premium for a cache nothing reads.
                    mediaContentBlock(media, base64, !isWholeDocument(range)),
                    { type: 'text', text: prompt },
                ],
            }],
        });
        const response = await stream.finalMessage();
        // Guardrail: every pass's token usage must be visible in the logs.
        console.log(
            `[identify] source=schedule stage=extract model=${model} ` +
            `input_tokens=${response.usage.input_tokens} output_tokens=${response.usage.output_tokens}` +
            (response.usage.cache_read_input_tokens ? ` cache_read=${response.usage.cache_read_input_tokens}` : '') +
            ` pages=${chunkLabel(range, pageCount)}`,
        );
        if (response.stop_reason === 'refusal') {
            throw new Error('Schedule extraction declined by the model (refusal).');
        }
        if (response.stop_reason === 'max_tokens') {
            return { rows: [], truncated: true };
        }
        const text = response.content.find((b): b is Anthropic.Messages.TextBlock => b.type === 'text')?.text ?? '';
        if (!text) throw new Error('Schedule extraction returned no output.');
        const parsed = JSON.parse(text) as { lineItems?: ScheduleRow[] };
        return { rows: parsed.lineItems ?? [], truncated: false };
    }, { pageCount });

    return scheduleRowsToLineItems(rows);
}

// ── Page-list extraction (Word documents) ────────────────────────────────────
// A .docx is not one document Claude can read — it is a ZIP whose schedule grids
// are usually pasted-in screenshots (see lib/parse/docx.ts). So the Word path
// arrives here as an ordered LIST of pages instead of one file, and each pass
// attaches only the pages in its own range. That is strictly better than the PDF
// arrangement above, where page scope can only be an instruction: a page outside
// the range is not in the request at all, so it cannot be double-read or missed.

/** One page of a document that arrived as a list of parts. */
export type SchedulePage =
    | { kind: 'media'; media: SupportedMedia; base64: string; label?: string }
    | { kind: 'text'; text: string; label?: string };

/** Hard ceiling on pages in one upload — MAX_CHUNKS passes' worth. */
export const MAX_PAGES = PAGES_PER_CHUNK * MAX_CHUNKS;

/**
 * Ceiling on the document-context preamble. It is re-sent on EVERY pass, so a
 * Word file with pages of prose ahead of the schedule would otherwise multiply
 * its own text by the pass count. A schedule's index/cover is a few hundred
 * characters; this is far above that and still bounded.
 */
export const MAX_CONTEXT_CHARS = 6_000;

/**
 * The per-pass prompt when the pages themselves are sliced. Same extraction
 * rules and same section carry-over; the scope sentence tells the truth about
 * what is attached.
 */
export function buildPagesPrompt(range: PageRange, carrySection: string, total: number): string {
    const end = range.end ?? total;
    const whole = range.start === 1 && end >= total;
    const scope = total === 1
        ? '\n\nThe page above is the whole document.'
        : whole
            ? `\n\nATTACHED: all ${total} pages of the document, in order, each one labelled above it.`
            : `\n\nATTACHED: page${range.start === end ? '' : 's'} ${range.start}${range.start === end ? '' : `-${end}`} of ${total}, in document order, each one labelled above it. ` +
            'Only these pages are attached — the rest of the document is read in separate passes, so extract every row printed on these pages and nothing else.';
    const carry = carrySection
        ? `\n\nCARRIED CONTEXT: the last section/location heading before page ${range.start} was "${carrySection}". ` +
        'Rows at the top of the first attached page that continue under that heading — with no new heading above them — take that section. ' +
        'Stop using it as soon as a page shows a new heading.'
        : '';
    return `${SCHEDULE_PROMPT}${scope}${carry}`;
}

function pageHeading(page: SchedulePage, number: number): string {
    return page.label ? `— Page ${number}: ${page.label} —` : `— Page ${number} —`;
}

/**
 * Read a fixture schedule that arrives as an ordered list of pages.
 *
 * `context` is the document's own text (a Word schedule's cover/index), sent
 * with every pass. It is short and it names the sheets the screenshots came
 * from, which is exactly the section vocabulary the rows need.
 */
export async function extractScheduleFromPages(
    pages: SchedulePage[],
    options: { context?: string } = {},
): Promise<ParsedLineItem[]> {
    if (!getApiKey()) throw new Error('ANTHROPIC_API_KEY is not set — schedule parsing is unavailable.');
    if (pages.length === 0) return [];
    if (pages.length > MAX_PAGES) {
        throw new Error(
            `That document holds ${pages.length} pages of schedule — more than the ${MAX_PAGES}-page limit for one upload. ` +
            'Split it into smaller files and upload them one at a time.',
        );
    }
    const client = createAnthropicClient();
    const model = getModel();
    const fullContext = (options.context ?? '').trim();
    const context = fullContext.length > MAX_CONTEXT_CHARS
        ? `${fullContext.slice(0, MAX_CONTEXT_CHARS)}\n…(document text truncated)`
        : fullContext;

    const rows = await extractScheduleRows(async ({ range, prompt }) => {
        const from = range.start - 1;
        const to = range.end ?? pages.length;
        const slice = pages.slice(from, to);
        const content: Anthropic.Messages.ContentBlockParam[] = [];
        if (context) {
            content.push({
                type: 'text',
                text: `DOCUMENT TEXT (the Word file's own text, for section names and context — not line items):\n${context}`,
            });
        }
        slice.forEach((page, index) => {
            content.push({ type: 'text', text: pageHeading(page, from + index + 1) });
            content.push(page.kind === 'media'
                ? mediaContentBlock(page.media, page.base64)
                : { type: 'text', text: page.text });
        });
        content.push({ type: 'text', text: prompt });

        // Streamed for the same reason as the single-document path: a dense
        // schedule can produce well past the safe non-streaming output size.
        const stream = client.messages.stream({
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            output_config: { format: { type: 'json_schema', schema: SCHEDULE_SCHEMA as unknown as Record<string, unknown> } },
            messages: [{ role: 'user', content }],
        });
        const response = await stream.finalMessage();
        // Guardrail: every pass's token usage must be visible in the logs.
        console.log(
            `[identify] source=schedule-pages stage=extract model=${model} ` +
            `input_tokens=${response.usage.input_tokens} output_tokens=${response.usage.output_tokens}` +
            (response.usage.cache_read_input_tokens ? ` cache_read=${response.usage.cache_read_input_tokens}` : '') +
            ` pages=${range.start}-${to}/${pages.length}`,
        );
        if (response.stop_reason === 'refusal') {
            throw new Error('Schedule extraction declined by the model (refusal).');
        }
        if (response.stop_reason === 'max_tokens') {
            return { rows: [], truncated: true };
        }
        const text = response.content.find((b): b is Anthropic.Messages.TextBlock => b.type === 'text')?.text ?? '';
        if (!text) throw new Error('Schedule extraction returned no output.');
        const parsed = JSON.parse(text) as { lineItems?: ScheduleRow[] };
        return { rows: parsed.lineItems ?? [], truncated: false };
    }, {
        pageCount: pages.length,
        buildPrompt: (range, carrySection) => buildPagesPrompt(range, carrySection, pages.length),
    });

    return scheduleRowsToLineItems(rows);
}
