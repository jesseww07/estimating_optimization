/**
 * Batch category identification — pure-logic tests (Phase 4).
 *
 * No live API calls and no ANTHROPIC_API_KEY: everything that decides what a
 * batch run costs and how a model response maps back onto lines is a pure
 * function, and this suite pins all of it — candidate filtering, id assignment,
 * chunking, the call cap, the structured-output schema, prompt rendering, and
 * (the one that can silently corrupt a whole sheet) result merging by line id.
 *
 * Fixtures are synthetic: invented brands and part numbers only.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { CATEGORY_GROUPS } from '@/lib/engine/matcher';
import {
    BATCH_SYSTEM_PROMPT,
    batchSchema,
    batchSkipReason,
    chunkCandidates,
    fixtureTypeHintFor,
    identifyCategoriesInBatch,
    mergeBatchRows,
    planBatchIdentify,
    renderBatchLines,
    selectBatchCandidates,
    summarizeOutcomes,
    type BatchCandidate,
    type RawBatchRow,
} from '@/lib/identify/batch';
import { toIdentifiedSpec } from '@/lib/identify/spec';
import type { ParsedLineItem } from '@/lib/types';

const line = (o: Partial<ParsedLineItem> = {}): ParsedLineItem => ({
    rowIndex: 0,
    section: '',
    mark: '',
    quantity: '',
    manufacturer: '',
    catalogNumber: '',
    rawRow: {},
    ...o,
});

/** Lines the text detector cannot categorize — the population this feature exists for. */
const UNKNOWN_LINES: ParsedLineItem[] = [
    line({ rowIndex: 10, mark: 'GG', manufacturer: 'GENERICCO', catalogNumber: 'WIDGET-7788' }),
    line({ rowIndex: 11, mark: 'HH', manufacturer: 'FOO LIGHTING', catalogNumber: 'BLARG-2200-QT' }),
    line({ rowIndex: 12, mark: 'QQ', manufacturer: 'NOVACORP', catalogNumber: 'NVX-8810-Z' }),
];

const row = (o: Partial<RawBatchRow> & { lineId: string }): RawBatchRow => ({
    manufacturer: '',
    catalogNumber: '',
    productName: '',
    category: null,
    attributes: {},
    confidence: 'MEDIUM',
    evidence: '',
    ...o,
});

const candidate = (lineId: string, index: number): BatchCandidate => ({
    lineId,
    index,
    rowIndex: index,
    line: line({ rowIndex: index, mark: lineId }),
});

describe('batchSkipReason — only lines the engine cannot already handle are sent', () => {
    it('keeps a line the text detector returns null for', () => {
        expect(batchSkipReason(line({ mark: 'GG', manufacturer: 'GENERICCO', catalogNumber: 'WIDGET-7788' }))).toBeNull();
    });

    it('skips lines the engine already categorizes', () => {
        // Fan brand + CF mark → 'Ceiling Fan' straight from detectFixtureCategory.
        expect(batchSkipReason(line({ mark: 'CF-1', manufacturer: 'HUNTER', catalogNumber: 'CF-006-52-SN' })))
            .toBe('already-categorized');
        // Learned series knowledge also counts as "already categorized".
        expect(batchSkipReason(line({ mark: 'V1', manufacturer: 'KICHLER', catalogNumber: '52527BK' })))
            .toBe('already-categorized');
    });

    it('skips a line whose fixture-type hint column already resolves the category', () => {
        const withHint = line({
            mark: 'GG',
            manufacturer: 'GENERICCO',
            catalogNumber: 'WIDGET-7788',
            rawRow: { 'QTY LAMPS': 'VANITY' },
        });
        expect(batchSkipReason(withHint)).toBe('already-categorized');
    });

    it('skips RFI placeholders and LED tape — the engine suppresses both on purpose', () => {
        expect(batchSkipReason(line({ mark: 'T1', manufacturer: 'TBD', catalogNumber: '' }))).toBe('rfi-placeholder');
        expect(batchSkipReason(line({ mark: 'TAPE-1', manufacturer: 'DIODE LED', catalogNumber: 'LED TAPE 24V 5M' })))
            .toBe('led-tape');
    });

    it('skips a line whose only content is a pasted link — that one needs the per-line fetch flow', () => {
        expect(batchSkipReason(line({ mark: 'X1', manufacturer: '', catalogNumber: 'https://example.com/spec.pdf' })))
            .toBe('no-spec-text');
    });

    it('keeps a description-only row (prose is exactly what this pass helps)', () => {
        const prose = line({ mark: 'D9', manufacturer: 'GENERICCO', rawRow: { DESCRIPTION: 'CUSTOM RESIN DIFFUSER LUMINAIRE, 18IN' } });
        expect(batchSkipReason(prose)).toBeNull();
        const { candidates } = selectBatchCandidates([prose]);
        expect(renderBatchLines(candidates)).toContain('description: CUSTOM RESIN DIFFUSER LUMINAIRE, 18IN');
    });

    it('skips a line already identified with a category the engine accepts, and keeps one with a junk label', () => {
        const ident = { manufacturer: '', catalogNumber: '', productName: '', attributes: {}, confidence: 'HIGH' as const, source: 'web' as const, evidence: '' };
        expect(batchSkipReason(line({ mark: 'GG', catalogNumber: 'WIDGET-7788', identified: { ...ident, category: 'Pendant' } })))
            .toBe('already-categorized');
        expect(batchSkipReason(line({ mark: 'GG', catalogNumber: 'WIDGET-7788', identified: { ...ident, category: 'Chandelier-ish thing' } })))
            .toBeNull();
    });

    it('does not treat a pasted spec URL as a catalog number', () => {
        // isUrlLike stripping is what the engine does; the line still needs help.
        expect(batchSkipReason(line({ mark: 'ZZ', manufacturer: 'FOO', catalogNumber: 'https://example.com/spec.pdf' })))
            .toBeNull();
    });
});

describe('fixtureTypeHintFor', () => {
    it('finds a fixture-type label in any raw column', () => {
        expect(fixtureTypeHintFor(line({ rawRow: { 'QTY LAMPS': 'POST TOP', MARK: 'OP1' } }))).toBe('POST TOP');
    });

    it('ignores a column that merely echoes the section (a room name is not a fixture type)', () => {
        expect(fixtureTypeHintFor(line({ section: 'Vanity', rawRow: { Location: 'Vanity' } }))).toBe('');
    });
});

describe('selectBatchCandidates', () => {
    it('assigns dense, unique ids to candidates and leaves ineligible lines unsent', () => {
        const lines = [
            line({ rowIndex: 0, mark: 'CF-1', manufacturer: 'HUNTER', catalogNumber: 'CF-006-52-SN' }),
            ...UNKNOWN_LINES,
            line({ rowIndex: 13, mark: 'T1', manufacturer: 'TBD', catalogNumber: '' }),
        ];
        const { candidates, ineligible } = selectBatchCandidates(lines);
        expect(candidates.map(c => c.lineId)).toEqual(['L1', 'L2', 'L3']);
        expect(candidates.map(c => c.index)).toEqual([1, 2, 3]);
        expect(candidates.map(c => c.rowIndex)).toEqual([10, 11, 12]);
        expect(ineligible.map(o => o.skipped)).toEqual(['already-categorized', 'rfi-placeholder']);
        // Ineligible lines carry no round-trip id — they were never sent.
        expect(ineligible.every(o => o.lineId === undefined)).toBe(true);
    });

    it('produces no candidates at all for a sheet the engine already understands', () => {
        const understood = [
            line({ rowIndex: 0, mark: 'CF-1', manufacturer: 'HUNTER', catalogNumber: 'CF-006-52-SN' }),
            line({ rowIndex: 1, mark: 'V1', manufacturer: 'KICHLER', catalogNumber: '52527BK' }),
        ];
        expect(selectBatchCandidates(understood).candidates).toHaveLength(0);
    });
});

describe('chunking and the call cap', () => {
    const many = Array.from({ length: 55 }, (_, i) =>
        line({ rowIndex: i, mark: `M${i}`, manufacturer: 'GENERICCO', catalogNumber: `WIDGET-${1000 + i}` }));

    it('chunks candidates into bounded groups', () => {
        const { candidates } = selectBatchCandidates(many);
        expect(candidates).toHaveLength(55);
        const chunks = chunkCandidates(candidates, 25);
        expect(chunks.map(c => c.length)).toEqual([25, 25, 5]);
    });

    it('caps total calls and reports the overflow instead of dropping it', () => {
        const plan = planBatchIdentify(many, { chunkSize: 25, maxCalls: 2 });
        expect(plan.chunks).toHaveLength(2);
        expect(plan.candidateCount).toBe(55);
        expect(plan.overBudget).toHaveLength(5);
        expect(plan.overBudget[0]!.skipped).toBe('call-budget');
        expect(plan.overBudget.map(o => o.rowIndex)).toEqual([50, 51, 52, 53, 54]);
    });

    it('plans zero calls for a sheet with nothing to identify', () => {
        const plan = planBatchIdentify([
            line({ rowIndex: 0, mark: 'CF-1', manufacturer: 'HUNTER', catalogNumber: 'CF-006-52-SN' }),
        ]);
        expect(plan.chunks).toHaveLength(0);
        expect(plan.candidateCount).toBe(0);
    });

    it('a 300-line uncategorized schedule fits inside the default budget', () => {
        const sheet = Array.from({ length: 300 }, (_, i) =>
            line({ rowIndex: i, mark: `M${i}`, manufacturer: 'NOVACORP', catalogNumber: `NVX-${8000 + i}-Z` }));
        const plan = planBatchIdentify(sheet);
        expect(plan.candidateCount).toBe(300);
        expect(plan.chunks).toHaveLength(12);
        expect(plan.overBudget).toHaveLength(0);
    });
});

describe('batchSchema — the category enum is the engine vocabulary', () => {
    const schema = batchSchema() as {
        properties: {
            lines: {
                items: {
                    additionalProperties: boolean;
                    required: string[];
                    properties: Record<string, { anyOf?: Array<{ enum?: string[] }> }>;
                };
            };
        };
    };
    const items = schema.properties.lines.items;

    it('requires the round-trip id alongside every spec field', () => {
        expect(items.required).toEqual([
            'lineId', 'manufacturer', 'catalogNumber', 'productName', 'category', 'attributes', 'confidence', 'evidence',
        ]);
        expect(items.additionalProperties).toBe(false);
    });

    it('constrains category to exactly Object.keys(CATEGORY_GROUPS)', () => {
        const enumValues = items.properties.category!.anyOf!.find(a => a.enum)!.enum!;
        expect(enumValues).toEqual(Object.keys(CATEGORY_GROUPS));
        expect(enumValues).not.toHaveLength(0);
    });

    it('names the allowed labels in the system prompt too', () => {
        for (const label of Object.keys(CATEGORY_GROUPS)) {
            expect(BATCH_SYSTEM_PROMPT).toContain(label);
        }
    });
});

describe('renderBatchLines', () => {
    it('emits one record per line, each carrying its id', () => {
        const { candidates } = selectBatchCandidates(UNKNOWN_LINES);
        const text = renderBatchLines(candidates);
        expect(text).toContain('lineId: L1');
        expect(text).toContain('lineId: L3');
        expect(text).toContain('catalog: NVX-8810-Z');
        expect(text).toContain('Bid lines to classify (3)');
    });

    it('clamps pathological field values so one bad cell cannot blow the input budget', () => {
        const long = 'X'.repeat(4000);
        const { candidates } = selectBatchCandidates([line({ rowIndex: 1, mark: 'GG', manufacturer: 'FOO', catalogNumber: long })]);
        const text = renderBatchLines(candidates);
        expect(text.length).toBeLessThan(600);
        expect(text).toContain('…');
    });
});

describe('mergeBatchRows — line identity survives the round trip', () => {
    const chunk = [candidate('L1', 0), candidate('L2', 1), candidate('L3', 2)];

    it('maps by lineId, not by array position', () => {
        const { outcomes, unmatchedIds } = mergeBatchRows(chunk, [
            row({ lineId: 'L3', category: 'Pendant', productName: 'third' }),
            row({ lineId: 'L1', category: 'Outdoor', productName: 'first' }),
            row({ lineId: 'L2', category: 'Vanity', productName: 'second' }),
        ]);
        expect(unmatchedIds).toEqual([]);
        expect(outcomes.map(o => o.spec?.category)).toEqual(['Outdoor', 'Vanity', 'Pendant']);
        expect(outcomes.map(o => o.spec?.productName)).toEqual(['first', 'second', 'third']);
        expect(outcomes.map(o => o.rowIndex)).toEqual([0, 1, 2]);
    });

    it('tolerates surrounding whitespace on the echoed id', () => {
        const { outcomes } = mergeBatchRows(chunk, [row({ lineId: '  L2 ', category: 'Sconce' })]);
        expect(outcomes[1]!.spec?.category).toBe('Sconce');
    });

    it('drops an id that does not belong to this chunk instead of guessing', () => {
        const { outcomes, unmatchedIds } = mergeBatchRows(chunk, [
            row({ lineId: 'L9', category: 'Outdoor' }),
            row({ lineId: 'L1', category: 'Recessed' }),
        ]);
        expect(unmatchedIds).toEqual(['L9']);
        expect(outcomes[0]!.spec?.category).toBe('Recessed');
        expect(outcomes[1]!.spec).toBeNull();
        expect(outcomes[1]!.skipped).toBe('no-result');
    });

    it('keeps the first row for a duplicated id and reports the repeat', () => {
        const { outcomes, unmatchedIds } = mergeBatchRows(chunk, [
            row({ lineId: 'L1', category: 'Outdoor' }),
            row({ lineId: 'L1', category: 'Vanity' }),
        ]);
        expect(outcomes[0]!.spec?.category).toBe('Outdoor');
        expect(unmatchedIds).toEqual(['L1']);
    });

    it('reports a row with no id at all', () => {
        const { outcomes, unmatchedIds } = mergeBatchRows(chunk, [row({ lineId: '' as unknown as string, category: 'Outdoor' })]);
        expect(unmatchedIds).toEqual(['(missing lineId)']);
        expect(outcomes.every(o => o.spec === null)).toBe(true);
    });

    it('returns no-result outcomes when the model answers nothing at all', () => {
        const { outcomes } = mergeBatchRows(chunk, undefined);
        expect(outcomes).toHaveLength(3);
        expect(outcomes.every(o => o.skipped === 'no-result')).toBe(true);
    });

    it('nulls a category the engine does not know, and keeps one it does', () => {
        const { outcomes } = mergeBatchRows(chunk, [
            row({ lineId: 'L1', category: 'Chandelier-ish thing' }),
            row({ lineId: 'L2', category: 'Exit/Emergency' }),
        ]);
        expect(outcomes[0]!.spec?.category).toBeNull();
        expect(outcomes[1]!.spec?.category).toBe('Exit/Emergency');
    });

    it('stamps source=batch and degrades a bogus confidence to LOW', () => {
        const { outcomes } = mergeBatchRows(chunk, [
            row({ lineId: 'L1', confidence: 'BOGUS' as unknown as 'HIGH', category: 'Linear' }),
            row({ lineId: 'L2', confidence: 'HIGH', category: 'Linear' }),
        ]);
        expect(outcomes[0]!.spec?.confidence).toBe('LOW');
        expect(outcomes[0]!.spec?.source).toBe('batch');
        expect(outcomes[1]!.spec?.confidence).toBe('HIGH');
    });

    it('trims and drops empty attributes', () => {
        const { outcomes } = mergeBatchRows(chunk, [
            row({ lineId: 'L1', category: 'Linear', attributes: { colorTemp: ' 3500K ', wattage: '  ', lumens: null } }),
        ]);
        expect(outcomes[0]!.spec?.attributes.colorTemp).toBe('3500K');
        expect(outcomes[0]!.spec?.attributes.wattage).toBeUndefined();
        expect(outcomes[0]!.spec?.attributes.lumens).toBeUndefined();
    });
});

describe('toIdentifiedSpec (shared normalizer)', () => {
    it('survives a structurally broken payload', () => {
        const spec = toIdentifiedSpec({} as never, 'batch');
        expect(spec.category).toBeNull();
        expect(spec.confidence).toBe('LOW');
        expect(spec.manufacturer).toBe('');
        expect(spec.source).toBe('batch');
    });
});

describe('summarizeOutcomes', () => {
    it('separates identified / categorized / unidentified / ineligible', () => {
        const stats = summarizeOutcomes([
            { index: 0, rowIndex: 0, spec: null, skipped: 'already-categorized' },
            { index: 1, rowIndex: 1, lineId: 'L1', spec: toIdentifiedSpec(row({ lineId: 'L1', category: 'Outdoor' }), 'batch') },
            { index: 2, rowIndex: 2, lineId: 'L2', spec: toIdentifiedSpec(row({ lineId: 'L2', category: null }), 'batch') },
            { index: 3, rowIndex: 3, lineId: 'L3', spec: null, skipped: 'error', note: 'boom' },
        ]);
        expect(stats).toEqual({ identified: 2, categorized: 1, unidentified: 1, ineligible: 1 });
    });
});

describe('identifyCategoriesInBatch — zero-candidate sheets cost zero calls', () => {
    const priorKey = process.env.ANTHROPIC_API_KEY;
    afterEach(() => {
        if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = priorKey;
    });

    it('makes no call and returns a full outcome list when the engine understands every line', async () => {
        // A key is present so the guard passes; if the code ever tried to call
        // out, this test would hang or fail rather than quietly pass.
        process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
        const report = await identifyCategoriesInBatch([
            line({ rowIndex: 0, mark: 'CF-1', manufacturer: 'HUNTER', catalogNumber: 'CF-006-52-SN' }),
            line({ rowIndex: 1, mark: 'T1', manufacturer: 'TBD', catalogNumber: '' }),
        ]);
        expect(report.stats).toEqual({
            lines: 2, candidates: 0, ineligible: 2, identified: 0, categorized: 0,
            unidentified: 0, calls: 0, inputTokens: 0, outputTokens: 0,
        });
        expect(report.outcomes.map(o => o.rowIndex)).toEqual([0, 1]);
    });

    it('refuses to run without an API key', async () => {
        delete process.env.ANTHROPIC_API_KEY;
        await expect(identifyCategoriesInBatch(UNKNOWN_LINES)).rejects.toThrow(/ANTHROPIC_API_KEY/);
    });
});
