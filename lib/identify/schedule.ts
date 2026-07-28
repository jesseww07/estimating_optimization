/**
 * SERVER-ONLY fixture-schedule PDF extraction (pulled forward from Phase 3,
 * 2026-07-28 — Jesse hit the upload wall in live use).
 *
 * One Claude call per uploaded document (user-triggered, token usage logged —
 * consistent with the Phase 2 cost guardrails): the schedule grid comes back
 * as structured line items that feed the exact same recommendation flow as a
 * pre-converted CSV/XLSX.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ParsedLineItem } from '../types';

if (typeof window !== 'undefined') {
    throw new Error('lib/identify/schedule.ts is server-only and must never be bundled for the browser.');
}

function getApiKey(): string {
    return (process.env.ANTHROPIC_API_KEY ?? '').trim();
}

function getModel(): string {
    return (process.env.IDENTIFY_MODEL ?? '').trim() || 'claude-sonnet-5';
}

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

const SCHEDULE_PROMPT = `The attached PDF is a lighting fixture schedule (or bid sheet) from a construction project.
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

export async function extractScheduleFromPdf(pdfBase64: string): Promise<ParsedLineItem[]> {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set — PDF schedule parsing is unavailable.');
    const client = new Anthropic({ apiKey });
    const model = getModel();

    // Streamed on purpose: a long schedule can produce well past the safe
    // non-streaming output size.
    const stream = client.messages.stream({
        model,
        max_tokens: 32000,
        output_config: { format: { type: 'json_schema', schema: SCHEDULE_SCHEMA as unknown as Record<string, unknown> } },
        messages: [{
            role: 'user',
            content: [
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
                { type: 'text', text: SCHEDULE_PROMPT },
            ],
        }],
    });
    const response = await stream.finalMessage();
    console.log(
        `[identify] source=schedule stage=extract model=${model} ` +
        `input_tokens=${response.usage.input_tokens} output_tokens=${response.usage.output_tokens}`,
    );
    if (response.stop_reason === 'refusal') {
        throw new Error('Schedule extraction declined by the model (refusal).');
    }
    if (response.stop_reason === 'max_tokens') {
        throw new Error('Schedule too large — extraction output was truncated. Split the PDF and try again.');
    }
    const text = response.content.find((b): b is Anthropic.Messages.TextBlock => b.type === 'text')?.text ?? '';
    if (!text) throw new Error('Schedule extraction returned no output.');
    const parsed = JSON.parse(text) as { lineItems: ScheduleRow[] };
    return scheduleRowsToLineItems(parsed.lineItems ?? []);
}
