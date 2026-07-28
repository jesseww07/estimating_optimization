/**
 * Parity test runner for the VE engine port.
 *
 * Run: npm test  (npx vitest run)
 *
 * BIND 1 (engine entry point): lib/engine/recommend.recommendForLineItem.
 * BIND 2 (data context): parity.context.json — rows frozen from the live Airtable
 * base (appWj912AEOvtxqJF) on 2026-07-19 so parity stays stable as the base moves.
 * Cases with `ready: false` are skipped, so an unfilled suite reports skips, never
 * false passes.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import type { EngineContext, ParsedLineItem, Recommendation } from '@/lib/types';
import { analyzeLineItem, recommendForLineItem } from '@/lib/engine/recommend';
import { PARITY_CASES, PLACEHOLDERS, type ExpectSpec } from './parity.fixtures';

async function runEngine(input: ParsedLineItem, ctx: EngineContext): Promise<Recommendation[]> {
    return recommendForLineItem(input, ctx);
}

let CTX: EngineContext;
beforeAll(async () => {
    const raw = readFileSync(path.join(__dirname, 'parity.context.json'), 'utf-8');
    CTX = JSON.parse(raw) as EngineContext;
});

// ── generic assertion helpers ───────────────────────────────────────────────
/** The item value a recommendation surfaces, whichever field carries it. */
const recItem = (r: Recommendation) => r.premierItem ?? r.bidItem ?? r.fanItem;
const idxOf = (recs: Recommendation[], item: string) =>
    recs.findIndex((r) => recItem(r) === item);

function assertExpectations(recs: Recommendation[], e: ExpectSpec) {
    const top = recs[0];

    if (e.expectNoRecommendations) {
        expect(recs, 'expected no recommendations').toHaveLength(0);
        return; // nothing else meaningful to assert
    }

    expect(top, 'expected at least one recommendation').toBeDefined();
    if (!top) return;

    if (e.topPremierItem !== undefined) expect(top.premierItem).toBe(e.topPremierItem);
    if (e.minConfidence !== undefined) expect(top.confidence).toBeGreaterThanOrEqual(e.minConfidence);
    if (e.topMatchType !== undefined) expect(top.matchType).toBe(e.topMatchType);
    if (e.topSource !== undefined) expect(top.source).toBe(e.topSource);
    if (e.swapCountAtLeast !== undefined) expect(top.swapCount ?? 0).toBeGreaterThanOrEqual(e.swapCountAtLeast);
    if (e.exactMatchCountAtLeast !== undefined)
        expect(top.exactMatchCount ?? 0).toBeGreaterThanOrEqual(e.exactMatchCountAtLeast);
    if (e.matchReasonContains !== undefined)
        expect((top.matchReason ?? '').toLowerCase()).toContain(e.matchReasonContains.toLowerCase());

    if (e.mustInclude) {
        const present = new Set(recs.map(recItem));
        for (const sku of e.mustInclude) expect(present, `must include ${sku}`).toContain(sku);
    }
    if (e.mustNotInclude) {
        const present = new Set(recs.map(recItem));
        for (const sku of e.mustNotInclude) expect(present, `must NOT include ${sku}`).not.toContain(sku);
    }
    if (e.mustRankAbove) {
        const [a, b] = e.mustRankAbove;
        const ia = idxOf(recs, a);
        const ib = idxOf(recs, b);
        expect(ia, `${a} must be present`).toBeGreaterThanOrEqual(0);
        expect(ib, `${b} must be present`).toBeGreaterThanOrEqual(0);
        expect(ia, `${a} must rank above ${b}`).toBeLessThan(ib);
    }
}

/** Flag a case marked ready that still holds an illustrative placeholder value. */
function hasLeftoverPlaceholder(c: (typeof PARITY_CASES)[number]): string | null {
    const strings = [
        ...Object.values(c.input).filter((v) => typeof v === 'string'),
        ...Object.values(c.expect).flat().filter((v) => typeof v === 'string'),
    ] as string[];
    return strings.find((s) => PLACEHOLDERS.has(s)) ?? null;
}

// ── the suite ────────────────────────────────────────────────────────────────
describe('VE engine parity (known-good bids)', () => {
    for (const c of PARITY_CASES) {
        const run = c.ready ? it : it.skip;
        run(`[${c.id}] ${c.rule}`, async () => {
            const leftover = hasLeftoverPlaceholder(c);
            expect(
                leftover,
                `case "${c.id}" is marked ready but still contains placeholder "${leftover}" — fill it with a real value from ${c.sourceBid}`,
            ).toBeNull();

            const recs = await runEngine(c.input, CTX);
            assertExpectations(recs, c.expect);
        });
    }

    it('[led-tape-suppress] carries an informational message alongside the empty list', () => {
        const tapeCase = PARITY_CASES.find((c) => c.id === 'led-tape-suppress');
        expect(tapeCase).toBeDefined();
        if (!tapeCase) return;
        const analysis = analyzeLineItem(tapeCase.input, CTX);
        expect(analysis.recommendations).toHaveLength(0);
        expect(analysis.infoMessage ?? '').toContain('LED tape');
    });
});
