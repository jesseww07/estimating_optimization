/**
 * SERVER-ONLY batched category identification (Phase 4, backlog item "close the
 * null-category gap").
 *
 * WHY THIS EXISTS
 * `detectFixtureCategory` returns null on 472 of the 966 lines in the eval
 * corpus, and 100% of the 349 lines where the engine shows the estimator
 * NOTHING are null-category lines — the in-category fallback in
 * `lib/engine/recommend.ts` is gated entirely on a non-null category. Injecting
 * the true category on those lines (oracle experiment, nothing else changed)
 * moved top-1 from 8.2% → 34.5% and dropped fully-silent lines from 80.2% →
 * 4.6%. The only existing way to get a category for such a line is
 * `/api/identify`, which is ONE line per request behind a human click: 472
 * uncategorized lines means 472 clicks, which is why it never happens.
 *
 * WHAT THIS DOES
 * One Claude call per CHUNK of uncategorized lines — the same structural shape
 * `lib/identify/schedule.ts` already proves in this codebase (one streamed call,
 * `output_config` JSON schema, an array of rows out). Each row comes back as a
 * full `IdentifiedSpec` (source `'batch'`) whose `category` is constrained to
 * the engine's own `CATEGORY_GROUPS` vocabulary and re-validated on the way out.
 *
 * COST GUARDRAIL (see the amended block at the top of ./claude.ts)
 * The Phase 2 rule — "every call is user-triggered per line — routes must never
 * sweep a whole sheet" — banned a sweep because a sweep meant N calls. This is
 * a different cost profile: ~25 lines per call, a hard cap of MAX_BATCH_CALLS
 * per request, no web-search turns, and nothing fires automatically — the
 * estimator presses "Identify N unrecognized lines". User-triggered and bounded
 * are both preserved; only "one line per call" is relaxed, deliberately.
 *
 * TESTABILITY
 * Everything except `identifyCategoriesInBatch` is a pure function: candidate
 * filtering, id assignment, chunking, schema building, prompt rendering, and
 * result merging are all exported and unit-tested with no network and no
 * ANTHROPIC_API_KEY (`__tests__/identify-batch.test.ts`).
 */

import Anthropic from '@anthropic-ai/sdk';
import { detectFixtureCategory, isLedTape, isRfiPlaceholder, isUrlLike } from '../engine/matcher';
import type { ParsedLineItem } from '../types';
import { ENGINE_CATEGORY_LABELS, SPEC_REQUIRED_KEYS, specSchemaProperties, toIdentifiedSpec, type RawSpec } from './spec';
import type { IdentifiedSpec } from './types';

if (typeof window !== 'undefined') {
    throw new Error('lib/identify/batch.ts is server-only and must never be bundled for the browser.');
}

// ── Budget constants ─────────────────────────────────────────────────────────
//
// The latency chain, budgeted the same way ./claude.ts budgets the per-line one
// (worst case must stay under the client abort, which stays under maxDuration):
//
//   25 lines/chunk × ~250 output tokens/line ≈ 6.3k output tokens per call,
//   well inside max_tokens=16000, and streamed so a long chunk can't trip an
//   HTTP timeout mid-response.
//   12 calls max × 25 = 300 lines — the "300-line schedule" ceiling. Anything
//   beyond that is reported as skipped, never silently dropped.
//   6 concurrent calls ⇒ at most ceil(12/6) = 2 waves.
//   2 waves × 120s per-call ceiling = 240s worst case
//     < 270s client abort (app/page.tsx BATCH_IDENTIFY_TIMEOUT_MS)
//     < 300s route maxDuration (app/api/identify-batch/route.ts).
//
// maxRetries: 0 for the same reason as the per-line path — the SDK's default 2
// retries would turn the 120s ceiling into 360s and blow the whole chain while
// the estimator has already given up.

/** Lines per Claude call. */
export const BATCH_CHUNK_SIZE = 25;
/** Hard ceiling on calls per request, so a pathological upload cannot run away. */
export const MAX_BATCH_CALLS = 12;
/** Calls in flight at once. */
export const BATCH_CONCURRENCY = 6;
/** Per-call latency ceiling. */
export const BATCH_CALL_TIMEOUT_MS = 120_000;
/** Wall-clock budget for the whole batch; a wave that cannot finish inside it is not started. */
export const BATCH_TOTAL_BUDGET_MS = 240_000;
/** Output ceiling per call — ~2.5× the expected size of a full 25-line chunk. */
const BATCH_MAX_TOKENS = 16_000;
/** Longest field value handed to the model; long option strings are the norm, essays are not. */
const MAX_FIELD_CHARS = 220;

// ── Candidate selection (pure) ───────────────────────────────────────────────

export type BatchSkipReason =
    /** The engine already resolves a category for this line — sending it would buy nothing. */
    | 'already-categorized'
    /** RFI / TBD placeholder: the engine deliberately refuses to fabricate a match. */
    | 'rfi-placeholder'
    /** LED tape: bid as-spec, never substituted. */
    | 'led-tape'
    /** Nothing on the line to identify from (no manufacturer, no usable catalog text). */
    | 'no-spec-text'
    /** Past MAX_BATCH_CALLS — not sent, so the caller can offer a second pass. */
    | 'call-budget'
    /** Sent, but the model returned no row for this line. */
    | 'no-result'
    /** The call covering this line failed. */
    | 'error';

export interface BatchCandidate {
    /**
     * Round-trip identity. Opaque, unique within one request, and carried in
     * BOTH directions — the model must echo it back verbatim. Array position in
     * the RESPONSE is never trusted: a model that reorders, drops, or duplicates
     * rows would otherwise silently attach one line's identification to another
     * line's spec, which is worse than no identification at all.
     */
    lineId: string;
    /** Position in the caller's input array — the unambiguous mapping key. */
    index: number;
    /** The line's own rowIndex, which the UI keys on. */
    rowIndex: number;
    line: ParsedLineItem;
}

export interface BatchLineOutcome {
    /** Position in the caller's input array. Always present, always unique. */
    index: number;
    /** The line's own rowIndex (what the UI keys on); not guaranteed unique in a hand-built payload. */
    rowIndex: number;
    /** The round-trip id — present only for lines that were actually sent to the model. */
    lineId?: string;
    /** The identification, or null when the line was skipped or produced nothing. */
    spec: IdentifiedSpec | null;
    /** Present exactly when `spec` is null. */
    skipped?: BatchSkipReason;
    /** Human-readable detail for the UI (error text, etc.). */
    note?: string;
}

/**
 * Mirrors the fixture-type-hint extraction inside `analyzeLineItem`
 * (lib/engine/recommend.ts). That logic is not exported and this module must
 * not edit the engine, so it is replicated here rather than approximated:
 * without it, a sheet with a dedicated fixture-type column would look
 * uncategorized to this filter and cost calls the engine did not need.
 * Drift can only ever cost extra tokens, never a wrong category — the engine
 * still recomputes the real one.
 */
const FIXTURE_HINT_RE = /^(fan|ceiling fan|vanity|bath bar|pendant|sconce|can|recessed|disc|disk|downlight|linear|strip|strip light|canopy|troffer|surface|flush|semi|semi-flush|post top|post|outdoor|bollard|pole|exit|exit sign|emergency|egress|up.?down|wall pack|flood|area light|closet|shelf|cabinet)$/i;

export function fixtureTypeHintFor(line: ParsedLineItem): string {
    const sectionNorm = (line.section || '').trim().toUpperCase();
    return Object.values(line.rawRow ?? {}).find(v => {
        const t = (v || '').trim();
        return t.length >= 3 && t.length <= 20 && t.toUpperCase() !== sectionNorm && FIXTURE_HINT_RE.test(t);
    }) || '';
}

/**
 * Why (or whether) a line belongs in the batch. Ordered exactly like
 * `analyzeLineItem`'s own pre-checks so the two agree about what the engine
 * will do with the line.
 */
export function batchSkipReason(line: ParsedLineItem): BatchSkipReason | null {
    const mark = line.mark ?? '';
    const manufacturer = line.manufacturer ?? '';
    const typedCatalog = line.catalogNumber ?? '';
    // URL-as-catalog protection, same as the engine: a pasted spec link is not
    // a catalog number and must not drive detection.
    const catalogNumber = isUrlLike(typedCatalog) ? '' : typedCatalog;

    if (isRfiPlaceholder(mark, typedCatalog, manufacturer)) return 'rfi-placeholder';
    if (isLedTape(mark, typedCatalog, manufacturer)) return 'led-tape';

    // A previous identification (any source) that already carries a category the
    // engine accepts wins over the text detector in recommend.ts — re-asking
    // would spend tokens to learn what we already know.
    if (line.identified?.category && ENGINE_CATEGORY_LABELS.includes(line.identified.category)) {
        return 'already-categorized';
    }
    if (detectFixtureCategory(mark, catalogNumber, manufacturer, fixtureTypeHintFor(line)) !== null) {
        return 'already-categorized';
    }
    // Nothing to reason from. Note the URL strip above: a line whose only
    // content is a pasted spec link has no text this pass can work with — that
    // one belongs to the per-line "Identify from link" flow, which actually
    // fetches the page. A `description`-style raw column counts as spec text,
    // since a prose-only row is exactly what this pass helps with.
    const hasText = manufacturer.trim() !== '' || catalogNumber.trim() !== '' || descriptionOf(line) !== '';
    if (!hasText) return 'no-spec-text';
    return null;
}

/** Description-ish raw column, if the sheet has one. */
function descriptionOf(line: ParsedLineItem): string {
    for (const [k, v] of Object.entries(line.rawRow ?? {})) {
        if (/desc/i.test(k) && (v ?? '').trim()) return v.trim();
    }
    return '';
}

export interface BatchSelection {
    candidates: BatchCandidate[];
    /** Lines deliberately not sent, with the reason. */
    ineligible: BatchLineOutcome[];
}

/**
 * Split a sheet into "needs a category from Claude" and "does not". A sheet the
 * engine already understands yields zero candidates and therefore ZERO calls.
 */
export function selectBatchCandidates(lines: ParsedLineItem[]): BatchSelection {
    const candidates: BatchCandidate[] = [];
    const ineligible: BatchLineOutcome[] = [];
    lines.forEach((line, index) => {
        const reason = batchSkipReason(line);
        const rowIndex = typeof line.rowIndex === 'number' ? line.rowIndex : index;
        if (reason) {
            ineligible.push({ index, rowIndex, spec: null, skipped: reason });
            return;
        }
        // Ids are assigned over the CANDIDATE list, not the sheet, so they stay
        // short and dense inside a chunk; index/rowIndex travel alongside for
        // the caller's mapping.
        candidates.push({ lineId: `L${candidates.length + 1}`, index, rowIndex, line });
    });
    return { candidates, ineligible };
}

/** Fixed-size chunks, in order. */
export function chunkCandidates(candidates: BatchCandidate[], size: number = BATCH_CHUNK_SIZE): BatchCandidate[][] {
    const chunkSize = Math.max(1, Math.floor(size));
    const chunks: BatchCandidate[][] = [];
    for (let i = 0; i < candidates.length; i += chunkSize) {
        chunks.push(candidates.slice(i, i + chunkSize));
    }
    return chunks;
}

export interface BatchPlan {
    /** Chunks that will actually be sent (already truncated to the call cap). */
    chunks: BatchCandidate[][];
    /** Lines the engine never needed identified. */
    ineligible: BatchLineOutcome[];
    /** Eligible lines dropped by the call cap — reported, never silently lost. */
    overBudget: BatchLineOutcome[];
    /** Total lines that needed identification, before the call cap. */
    candidateCount: number;
}

/**
 * Everything that decides what a run will cost, with no side effects: which
 * lines are eligible, how they chunk, and where the call cap bites. Callable
 * (and unit-tested) without an API key, so the cost of a sheet can be inspected
 * before a single token is spent.
 */
export function planBatchIdentify(
    lines: ParsedLineItem[],
    opts: { chunkSize?: number; maxCalls?: number } = {},
): BatchPlan {
    const { candidates, ineligible } = selectBatchCandidates(lines);
    const maxCalls = Math.max(0, Math.floor(opts.maxCalls ?? MAX_BATCH_CALLS));
    const all = chunkCandidates(candidates, opts.chunkSize ?? BATCH_CHUNK_SIZE);
    const chunks = all.slice(0, maxCalls);
    const overBudget = all.slice(maxCalls).flat().map(c => ({
        index: c.index,
        rowIndex: c.rowIndex,
        lineId: c.lineId,
        spec: null,
        skipped: 'call-budget' as const,
        note: `Not sent: this request is capped at ${maxCalls} Claude call(s). Run the identify pass again to cover the rest.`,
    }));
    return { chunks, ineligible, overBudget, candidateCount: candidates.length };
}

// ── Structured output contract (pure) ────────────────────────────────────────

/**
 * Array-of-rows schema: one IdentifiedSpec per line, each stamped with the
 * lineId it answers. `lineId` is required and first so the model treats it as
 * part of the record rather than an afterthought.
 */
export function batchSchema(): Record<string, unknown> {
    return {
        type: 'object',
        additionalProperties: false,
        required: ['lines'],
        properties: {
            lines: {
                type: 'array',
                description: 'Exactly one entry per input line, using the same lineId.',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['lineId', ...SPEC_REQUIRED_KEYS],
                    properties: {
                        lineId: {
                            type: 'string',
                            description: 'Copy the bid line\'s id VERBATIM (e.g. "L7"). Never renumber, never merge two lines into one entry.',
                        },
                        ...specSchemaProperties(),
                    },
                },
            },
        },
    };
}

export const BATCH_SYSTEM_PROMPT = `You classify lighting-fixture bid lines for Premier Lighting's estimating team.

You are given several bid lines at once. For EACH line, decide what the specified product is,
working ONLY from the text on the line (mark, manufacturer, catalog/ordering string, location,
description). You have no spec sheet, no product page, and no web search — say so through the
confidence field rather than guessing confidently.

The single most valuable output is \`category\`. Downstream, a line with no category gets no
recommendations at all, so a well-judged category is worth far more than a polished product name.
Rules:
- category MUST be one of these labels, or null when genuinely none applies:
  ${ENGINE_CATEGORY_LABELS.join(', ')}.
- catalogNumber: echo the line's catalog/ordering string as printed (trimmed). NEVER substitute a
  different part number and never invent one — nothing here verifies it, and a fabricated part
  number would corrupt matching. Use an empty string when the line has no catalog value.
- manufacturer: the brand as printed, normalized to its common name (e.g. "Philips"/"SIGNIFY").
  Empty string when the line names none.
- productName: the product family/type in plain words ("7in SlimSurface LED downlight",
  "4ft vapor-tight linear"). This is where inference belongs.
- attributes: only what the line's own text supports (option codes count — "835" is 3500K/80CRI,
  "-4-" or "4FT" is a 4-foot length, "L50" ≈ 5000 lumens, "UNV"/"MV" is universal voltage). Use
  null for anything the text does not support. Never fill an attribute from memory of the product.
- confidence, judged on THIS evidence only:
    HIGH   — the manufacturer + ordering string name a series you can place with certainty
             (e.g. Lithonia DSXB is a shoebox area light).
    MEDIUM — the family or fixture type is clear from naming conventions, option codes, or the
             description, but the exact product is inferred.
    LOW    — the category is a reasonable guess from weak signals. Prefer LOW + a category over
             null when you have a real lean; prefer null over a coin flip.
- evidence: one short sentence naming the tokens on the line that drove the call
  ("mark 'BH' + 'VLO' + '4' with a 120-277 suffix reads as a 4ft vapor-tight linear").
- Return exactly one entry per input line, echoing its lineId verbatim. Do not add, drop, merge,
  or reorder lines.`;

function clamp(v: string | undefined | null): string {
    const s = (v ?? '').trim().replace(/\s+/g, ' ');
    return s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS)}…` : s;
}

/** The user-content block for one chunk: one compact record per line. */
export function renderBatchLines(chunk: BatchCandidate[]): string {
    const rows = chunk.map(({ lineId, line }) => {
        const parts = [
            `lineId: ${lineId}`,
            `mark: ${clamp(line.mark) || '(none)'}`,
            `manufacturer: ${clamp(line.manufacturer) || '(none)'}`,
            `catalog: ${clamp(line.catalogNumber) || '(none)'}`,
        ];
        const section = clamp(line.section);
        if (section) parts.push(`location: ${section}`);
        const description = clamp(descriptionOf(line));
        if (description) parts.push(`description: ${description}`);
        const qty = clamp(line.quantity);
        if (qty) parts.push(`qty: ${qty}`);
        return `- ${parts.join(' | ')}`;
    });
    return `Bid lines to classify (${chunk.length}):\n${rows.join('\n')}\n\n` +
        `Return one entry per line above, each echoing its lineId.`;
}

// ── Result merging (pure) ────────────────────────────────────────────────────

/** One row as the model emits it: an IdentifiedSpec payload plus the line it answers. */
export interface RawBatchRow extends RawSpec {
    lineId: string;
}

export interface BatchMergeResult {
    outcomes: BatchLineOutcome[];
    /** Ids the model returned that do not belong to this chunk, or that repeat one already used. */
    unmatchedIds: string[];
}

/**
 * Map model rows back onto the chunk's lines by lineId, defensively.
 *
 * Position is never used: an unknown id is dropped (reported, not guessed at),
 * a repeated id keeps the FIRST row only, and any candidate the model did not
 * answer for comes back as 'no-result' rather than vanishing. The category on
 * every surviving row is re-validated against the engine vocabulary by
 * `toIdentifiedSpec` — a label the engine does not know is worse than null.
 */
export function mergeBatchRows(chunk: BatchCandidate[], rows: RawBatchRow[] | undefined | null): BatchMergeResult {
    const byId = new Map(chunk.map(c => [c.lineId, c]));
    const specs = new Map<string, IdentifiedSpec>();
    const unmatchedIds: string[] = [];

    for (const row of rows ?? []) {
        const id = typeof row?.lineId === 'string' ? row.lineId.trim() : '';
        if (!id || !byId.has(id) || specs.has(id)) {
            unmatchedIds.push(id || '(missing lineId)');
            continue;
        }
        specs.set(id, toIdentifiedSpec(row, 'batch'));
    }

    const outcomes: BatchLineOutcome[] = chunk.map(c => {
        const spec = specs.get(c.lineId);
        const base = { index: c.index, rowIndex: c.rowIndex, lineId: c.lineId };
        return spec
            ? { ...base, spec }
            : { ...base, spec: null, skipped: 'no-result' as const, note: 'The model returned no entry for this line.' };
    });
    return { outcomes, unmatchedIds };
}

// ── Stats (pure) ─────────────────────────────────────────────────────────────

export interface BatchStats {
    /** Lines received. */
    lines: number;
    /** Lines that needed identification (before the call cap). */
    candidates: number;
    /** Lines the engine already understood, or deliberately suppresses — never sent. */
    ineligible: number;
    /** Candidates that came back with an IdentifiedSpec. */
    identified: number;
    /** …of those, the ones carrying a usable engine category — the whole point of the pass. */
    categorized: number;
    /** Candidates that produced nothing (call budget, no row returned, or a failed call). */
    unidentified: number;
    /** Claude calls actually made. */
    calls: number;
    inputTokens: number;
    outputTokens: number;
}

/** Roll outcomes up into the counts the UI reports. Pure. */
export function summarizeOutcomes(
    outcomes: BatchLineOutcome[],
): Pick<BatchStats, 'identified' | 'categorized' | 'unidentified' | 'ineligible'> {
    let identified = 0;
    let categorized = 0;
    let unidentified = 0;
    let ineligible = 0;
    for (const o of outcomes) {
        if (o.spec) {
            identified++;
            if (o.spec.category) categorized++;
        } else if (o.lineId === undefined) {
            // No lineId ⇒ never a candidate (already categorized, RFI, tape, blank).
            ineligible++;
        } else {
            unidentified++;
        }
    }
    return { identified, categorized, unidentified, ineligible };
}

// ── The one impure part ──────────────────────────────────────────────────────

function getApiKey(): string {
    // Trimmed defensively, same as the per-line path: a trailing newline pasted
    // into the Vercel env editor turns into an auth error that is miserable to spot.
    return (process.env.ANTHROPIC_API_KEY ?? '').trim();
}

export function isBatchIdentifyAvailable(): boolean {
    return getApiKey().length > 0;
}

function getModel(): string {
    return (process.env.IDENTIFY_MODEL ?? '').trim() || 'claude-sonnet-5';
}

function logUsage(chunkNo: number, chunkCount: number, lines: number, model: string, usage: { input_tokens: number; output_tokens: number }): void {
    // Guardrail: identification token usage must be visible in logs, in the same
    // shape as every other identify call so one grep covers all of them.
    console.log(
        `[identify] source=batch stage=extract model=${model} ` +
        `input_tokens=${usage.input_tokens} output_tokens=${usage.output_tokens} ` +
        `chunk=${chunkNo}/${chunkCount} lines=${lines}`,
    );
}

async function runChunk(
    client: Anthropic,
    model: string,
    chunk: BatchCandidate[],
    chunkNo: number,
    chunkCount: number,
): Promise<{ outcomes: BatchLineOutcome[]; inputTokens: number; outputTokens: number; unmatchedIds: string[] }> {
    // Streamed for the same reason schedule.ts streams: a full chunk's JSON is
    // well past the safe non-streaming output size, and streaming keeps the
    // connection alive instead of risking an HTTP timeout mid-response.
    const stream = client.messages.stream({
        model,
        max_tokens: BATCH_MAX_TOKENS,
        system: BATCH_SYSTEM_PROMPT,
        output_config: { format: { type: 'json_schema', schema: batchSchema() } },
        messages: [{ role: 'user', content: renderBatchLines(chunk) }],
    });
    const response = await stream.finalMessage();
    logUsage(chunkNo, chunkCount, chunk.length, model, response.usage);
    if (response.stop_reason === 'refusal') {
        throw new Error('Batch identification declined by the model (refusal).');
    }
    if (response.stop_reason === 'max_tokens') {
        throw new Error('Batch identification output was truncated (max_tokens) — reduce the chunk size.');
    }
    const text = response.content.find((b): b is Anthropic.Messages.TextBlock => b.type === 'text')?.text ?? '';
    if (!text) throw new Error('Batch identification returned no output.');
    const parsed = JSON.parse(text) as { lines?: RawBatchRow[] };
    const merged = mergeBatchRows(chunk, parsed.lines);
    if (merged.unmatchedIds.length > 0) {
        console.warn(`[identify] source=batch chunk=${chunkNo}/${chunkCount} dropped ${merged.unmatchedIds.length} unmappable row id(s): ${merged.unmatchedIds.join(', ')}`);
    }
    return {
        outcomes: merged.outcomes,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        unmatchedIds: merged.unmatchedIds,
    };
}

export interface BatchIdentifyReport {
    /**
     * One entry per INPUT line, in input order, each carrying its `index` and
     * `rowIndex` so callers can map results back to lines unambiguously.
     * Lines that were never eligible are present too, with their reason.
     */
    outcomes: BatchLineOutcome[];
    stats: BatchStats;
}

export interface BatchIdentifyOptions {
    chunkSize?: number;
    maxCalls?: number;
    concurrency?: number;
    /** Wall-clock budget; chunks that cannot be started inside it are reported as skipped. */
    totalBudgetMs?: number;
}

/**
 * Identify the uncategorized lines of ONE uploaded document.
 *
 * A failing chunk never fails the sheet: its lines come back with
 * `skipped: 'error'` and the note, and every other chunk still lands.
 */
export async function identifyCategoriesInBatch(
    lines: ParsedLineItem[],
    opts: BatchIdentifyOptions = {},
): Promise<BatchIdentifyReport> {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set — batch identification is unavailable.');

    const maxCalls = opts.maxCalls ?? MAX_BATCH_CALLS;
    const plan = planBatchIdentify(lines, { chunkSize: opts.chunkSize, maxCalls });
    const outcomes: BatchLineOutcome[] = [...plan.ineligible, ...plan.overBudget];
    let inputTokens = 0;
    let outputTokens = 0;
    let calls = 0;

    if (plan.chunks.length > 0) {
        const client = new Anthropic({ apiKey, timeout: BATCH_CALL_TIMEOUT_MS, maxRetries: 0 });
        const model = getModel();
        const deadline = Date.now() + (opts.totalBudgetMs ?? BATCH_TOTAL_BUDGET_MS);
        const concurrency = Math.max(1, Math.min(opts.concurrency ?? BATCH_CONCURRENCY, plan.chunks.length));
        let next = 0;

        const worker = async (): Promise<void> => {
            for (;;) {
                const i = next++;
                if (i >= plan.chunks.length) return;
                const chunk = plan.chunks[i]!;
                // Don't start a call that cannot finish inside the wall-clock
                // budget — a started-but-doomed call bills for work the route
                // will never get to return.
                if (Date.now() + BATCH_CALL_TIMEOUT_MS > deadline) {
                    outcomes.push(...chunk.map(c => ({
                        index: c.index,
                        rowIndex: c.rowIndex,
                        lineId: c.lineId,
                        spec: null,
                        skipped: 'call-budget' as const,
                        note: 'Not sent: the request ran out of its time budget. Run the identify pass again to cover the rest.',
                    })));
                    continue;
                }
                calls++;
                try {
                    const r = await runChunk(client, model, chunk, i + 1, plan.chunks.length);
                    outcomes.push(...r.outcomes);
                    inputTokens += r.inputTokens;
                    outputTokens += r.outputTokens;
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    console.error(`[identify] source=batch chunk=${i + 1}/${plan.chunks.length} failed:`, e);
                    outcomes.push(...chunk.map(c => ({
                        index: c.index,
                        rowIndex: c.rowIndex,
                        lineId: c.lineId,
                        spec: null,
                        skipped: 'error' as const,
                        note: message,
                    })));
                }
            }
        };

        await Promise.all(Array.from({ length: concurrency }, worker));
    }

    outcomes.sort((a, b) => a.index - b.index);
    return {
        outcomes,
        stats: {
            lines: lines.length,
            candidates: plan.candidateCount,
            calls,
            inputTokens,
            outputTokens,
            ...summarizeOutcomes(outcomes),
        },
    };
}
