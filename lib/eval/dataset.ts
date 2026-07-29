/**
 * Eval dataset (snapshot) I/O — node-only companion to lib/eval/harness.ts.
 *
 * The snapshot is a full EngineContext frozen from the live Airtable base,
 * stored gzipped so a ~10 MB context commits as well under 1 MB. Provenance
 * (fetch date, row counts, notes) is embedded AND mirrored to a plain-JSON
 * meta file so reviewers can see what changed without gunzipping.
 *
 * referenceDate is pinned to the snapshot's fetch time: recency weighting must
 * not drift as calendar time passes, or metrics would move with no code change.
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { EngineContext } from '../types';

export interface SnapshotMeta {
    fetchedAt: string;               // ISO timestamp — also the eval referenceDate
    source: string;                  // e.g. 'airtable-mcp' | 'airtable-pat'
    baseId: string;
    counts: {
        history: number;
        premierItems: number;
        thirdPartyItems: number;
        fans: number;
    };
    notes: string[];
}

export interface Snapshot {
    meta: SnapshotMeta;
    context: EngineContext;
}

export const SNAPSHOT_FILENAME = 'eval.context.json.gz';
export const SNAPSHOT_META_FILENAME = 'eval.context.meta.json';
export const BASELINE_FILENAME = 'eval.baseline.json';

/** Default location: alongside the parity fixtures in __tests__/. */
export function defaultSnapshotPath(repoRoot: string = process.cwd()): string {
    return path.join(repoRoot, '__tests__', SNAPSHOT_FILENAME);
}

export function defaultBaselinePath(repoRoot: string = process.cwd()): string {
    return path.join(repoRoot, '__tests__', BASELINE_FILENAME);
}

export function loadSnapshot(filePath: string): Snapshot {
    const raw = gunzipSync(readFileSync(filePath)).toString('utf-8');
    const snapshot = JSON.parse(raw) as Snapshot;
    if (!snapshot.meta?.fetchedAt || !snapshot.context?.history) {
        throw new Error(`${filePath} is not a valid eval snapshot (missing meta.fetchedAt or context.history)`);
    }
    // Pin recency weighting to the freeze date (idempotent if already set).
    snapshot.context.referenceDate = snapshot.meta.fetchedAt;
    return snapshot;
}

/** Writes the gzipped snapshot plus the human-readable meta mirror; returns the fingerprint. */
export function saveSnapshot(filePath: string, snapshot: Snapshot): string {
    snapshot.context.referenceDate = snapshot.meta.fetchedAt;
    const json = JSON.stringify(snapshot);
    // Deterministic gzip (no mtime) so identical data → identical bytes → stable fingerprint.
    const gz = gzipSync(Buffer.from(json, 'utf-8'), { level: 9, mtime: 0 } as Parameters<typeof gzipSync>[1]);
    writeFileSync(filePath, gz);
    writeFileSync(
        path.join(path.dirname(filePath), SNAPSHOT_META_FILENAME),
        JSON.stringify(snapshot.meta, null, 2) + '\n',
    );
    return fingerprintBuffer(gz);
}

/** sha256 of the snapshot file — baselines bind to it so a stale baseline is detectable. */
export function fingerprintFile(filePath: string): string {
    return fingerprintBuffer(readFileSync(filePath));
}

function fingerprintBuffer(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
}
