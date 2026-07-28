/**
 * In-memory (per-instance) cache for the engine context.
 *
 * Replaces Next's unstable_cache, whose data cache rejects entries over 2 MB —
 * the full context (≈9.4K history rows + 3.2K catalog items) serializes well past
 * that, which turned every cache write into a runtime 500 on Vercel.
 *
 * Module scope survives warm serverless invocations; a cold start just refetches.
 * Stale-while-revalidate: after the TTL we serve the stale context immediately and
 * refresh in the background, so estimator requests never wait on a full re-pull.
 * Plain TypeScript — no Next imports (lib/** rule).
 */

import type { EngineContext } from '../types';
import { fetchEngineContext } from './fetch';

const TTL_MS = 5 * 60_000;

let cached: { ctx: EngineContext; fetchedAt: number } | null = null;
let inflight: Promise<EngineContext> | null = null;

function refresh(): Promise<EngineContext> {
    if (!inflight) {
        inflight = fetchEngineContext()
            .then(ctx => {
                cached = { ctx, fetchedAt: Date.now() };
                return ctx;
            })
            .finally(() => {
                inflight = null;
            });
    }
    return inflight;
}

/**
 * Drop the cached context (e.g. after a successful History write batch) so the
 * next analysis sees the new rows immediately instead of waiting out the TTL.
 */
export function invalidateEngineContext(): void {
    cached = null;
}

export async function getEngineContext(): Promise<EngineContext> {
    if (cached) {
        if (Date.now() - cached.fetchedAt >= TTL_MS) {
            // Stale: kick a background refresh, serve the stale copy now.
            void refresh().catch(() => { /* keep serving stale on refresh failure */ });
        }
        return cached.ctx;
    }
    return refresh();
}
