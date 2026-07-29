/**
 * SERVER-ONLY History write-back (Phase 2 learning loop).
 *
 * Exported selections become new History rows so the next upload benefits from
 * them — and Bid Date is finally populated going forward, which is what
 * activates recency weighting.
 *
 * Safety contract (handoff guardrails):
 *   - CREATE-ONLY. This module never updates or deletes records.
 *   - Mode: HISTORY_WRITEBACK env var (live/dry_run/off) always wins. When
 *     unset, production defaults to "live" (approved by Jesse 2026-07-28);
 *     previews and local dev default to "dry_run" (payload logged, no writes).
 *   - Dedupe guard: a row whose (project, normalized mark, normalized Original
 *     Spec, normalized Bid Item) already exists in History is skipped.
 *
 * Requires the upgraded PAT (data.records:read + data.records:write, scoped to
 * base appWj912AEOvtxqJF only).
 */

import Airtable from 'airtable';
import { normalizeProductId, normalizeSpecKey } from '../engine/matcher';
import type { HistoryRow } from '../types';
import { BASE_ID, HISTORY_FIELDS, TABLES } from './schema';

if (typeof window !== 'undefined') {
    throw new Error('lib/airtable/writeback.ts is server-only and must never be bundled for the browser.');
}

export type WritebackMode = 'dry_run' | 'live' | 'off';

export function getWritebackMode(): WritebackMode {
    const raw = (process.env.HISTORY_WRITEBACK ?? '').trim().toLowerCase();
    if (raw === 'live') return 'live';
    if (raw === 'off' || raw === 'disabled') return 'off';
    if (raw === 'dry_run') return 'dry_run';
    // Unset: live on production deployments only. Previews and local dev stay
    // dry_run so non-production exports never write to History.
    return process.env.VERCEL_ENV === 'production' ? 'live' : 'dry_run';
}

export interface WritebackRow {
    project: string;
    mark: string;
    /** Verbatim catalog # from the bid line. */
    originalSpec: string;
    /** The selected substitution item. */
    bidItem: string;
    specManufacturer: string;
    bidManufacturer: string;
    /** Export date, YYYY-MM-DD — becomes Bid Date. */
    bidDate: string;
    premierLinkId?: string;
    thirdPartyLinkId?: string;
    /**
     * Engine confidence (0-100) of the selected recommendation at export time.
     * Recorded to "Spec Match Confidence" so a 30% category guess an estimator
     * accepted is distinguishable in History from a 95% authoritative swap.
     */
    matchConfidence?: number;
}

export interface WritebackResult {
    mode: WritebackMode;
    attempted: number;
    written: number;
    skippedDuplicates: number;
    errors: string[];
}

/** Dedupe key shared by existing-history rows and incoming write rows. */
export function writebackKey(project: string, mark: string, originalSpec: string, bidItem: string): string {
    return [
        project.trim().toLowerCase(),
        normalizeSpecKey(mark),
        normalizeSpecKey(originalSpec),
        normalizeProductId(bidItem),
    ].join('|');
}

/** Rows eligible for write-back must be substantive on both sides of the swap. */
export function isWritebackEligible(row: WritebackRow): boolean {
    return row.originalSpec.trim().length >= 3 && row.bidItem.trim().length >= 3 && row.project.trim().length > 0;
}

/** Exported for tests — the exact field payload a live create would send. */
export function toAirtableFields(row: WritebackRow): Record<string, unknown> {
    const F = HISTORY_FIELDS;
    const fields: Record<string, unknown> = {
        [F.MARK]: row.mark,
        [F.BID_ITEM]: row.bidItem,
        [F.ORIGINAL_SPEC]: row.originalSpec,
        [F.PROJECT]: row.project,
        [F.BID_DATE]: row.bidDate,
        // "EXACT" describes the spec→item LINKAGE (we know exactly which item
        // was bid — it came from a user selection), matching the singleSelect's
        // existing EXACT / NON-ITEM / UNMAPPED vocabulary. Swap QUALITY lives
        // in Spec Match Confidence below.
        [F.MATCH_TYPE]: 'EXACT',
    };
    if (row.specManufacturer) fields[F.SPEC_MFR_BACKUP] = row.specManufacturer;
    if (row.bidManufacturer) fields[F.BID_MFR_BACKUP] = row.bidManufacturer;
    if (row.premierLinkId) fields[F.PREMIER_LINK] = [row.premierLinkId];
    else if (row.thirdPartyLinkId) fields[F.THIRD_PARTY_LINK] = [row.thirdPartyLinkId];
    if (typeof row.matchConfidence === 'number' && Number.isFinite(row.matchConfidence)) {
        fields[F.SPEC_MATCH_CONFIDENCE] = `${Math.round(row.matchConfidence)}%`;
    }
    return fields;
}

/**
 * Fill an empty bidManufacturer from prior History rows for the same bid item
 * (majority vote). Ground truth from past bids — never a brand guess. The
 * MedSpa export left "Bid Manufacturer (text)" blank on items whose prefix
 * inference failed (REMINGTON…, FLAIRE…).
 */
export function backfillBidManufacturers(rows: WritebackRow[], existing: HistoryRow[]): void {
    const needed = rows.filter(r => !r.bidManufacturer.trim());
    if (needed.length === 0) return;

    const votes = new Map<string, Map<string, number>>();
    for (const h of existing) {
        const mfr = (h.bidManufacturer || h.bidMfrBackup || '').trim();
        if (!mfr) continue;
        const key = normalizeProductId(h.bidItem);
        if (!key) continue;
        const tally = votes.get(key) ?? new Map<string, number>();
        tally.set(mfr, (tally.get(mfr) ?? 0) + 1);
        votes.set(key, tally);
    }

    for (const row of needed) {
        const tally = votes.get(normalizeProductId(row.bidItem));
        if (!tally) continue;
        let best = '';
        let bestCount = 0;
        for (const [mfr, count] of tally) {
            if (count > bestCount) {
                best = mfr;
                bestCount = count;
            }
        }
        if (best) row.bidManufacturer = best;
    }
}

/**
 * Split incoming rows into new-vs-duplicate against existing History (and
 * within the batch itself). Pure — unit-testable without Airtable.
 */
export function partitionAgainstHistory(rows: WritebackRow[], existing: HistoryRow[]): { fresh: WritebackRow[]; duplicates: WritebackRow[] } {
    const seen = new Set(existing.map(h => writebackKey(h.project, h.mark, h.originalSpec, h.bidItem)));
    const fresh: WritebackRow[] = [];
    const duplicates: WritebackRow[] = [];
    for (const row of rows) {
        const key = writebackKey(row.project, row.mark, row.originalSpec, row.bidItem);
        if (seen.has(key)) {
            duplicates.push(row);
        } else {
            seen.add(key);
            fresh.push(row);
        }
    }
    return { fresh, duplicates };
}

const CREATE_CHUNK = 10;           // Airtable create cap per request
const CHUNK_DELAY_MS = 250;        // stay under the 5 req/s base cap

export async function writeSelectionsToHistory(rows: WritebackRow[], existingHistory: HistoryRow[]): Promise<WritebackResult> {
    const mode = getWritebackMode();
    const eligible = rows.filter(isWritebackEligible);
    backfillBidManufacturers(eligible, existingHistory);
    const { fresh, duplicates } = partitionAgainstHistory(eligible, existingHistory);
    const result: WritebackResult = {
        mode,
        attempted: eligible.length,
        written: 0,
        skippedDuplicates: duplicates.length,
        errors: [],
    };

    if (mode === 'off' || fresh.length === 0) return result;

    const payload = fresh.map(row => ({ fields: toAirtableFields(row) }));

    if (mode === 'dry_run') {
        // The inspectable payload — exactly what a live run would create.
        console.log(`[writeback] DRY RUN — ${fresh.length} row(s) would be created, ${duplicates.length} skipped as duplicates:`);
        console.log(JSON.stringify(payload, null, 2));
        return result;
    }

    const apiKey = (process.env.AIRTABLE_PAT ?? '').trim();
    if (!apiKey) {
        result.errors.push('AIRTABLE_PAT is not set — cannot write history.');
        return result;
    }
    const base = new Airtable({ apiKey }).base(BASE_ID);
    const table = base(TABLES.HISTORY);

    for (let i = 0; i < payload.length; i += CREATE_CHUNK) {
        const chunk = payload.slice(i, i + CREATE_CHUNK);
        try {
            // typecast lets the singleSelect project field accept a new job name.
            const created = await table.create(
                chunk as unknown as Array<{ fields: Airtable.FieldSet }>,
                { typecast: true },
            );
            result.written += Array.isArray(created) ? created.length : 1;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            result.errors.push(`Create batch ${i / CREATE_CHUNK + 1} failed: ${message}`);
            // Keep going — remaining chunks are independent creates.
        }
        if (i + CREATE_CHUNK < payload.length) {
            await new Promise(resolve => setTimeout(resolve, CHUNK_DELAY_MS));
        }
    }
    console.log(`[writeback] LIVE — wrote ${result.written}/${fresh.length} rows (${duplicates.length} duplicates skipped).`);
    return result;
}
