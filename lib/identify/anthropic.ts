/**
 * SERVER-ONLY Anthropic client factory.
 *
 * Every Claude call in this app goes through here so credential handling has
 * exactly one home — the same discipline the Airtable adapter follows.
 *
 * ── Why the workspace header exists ─────────────────────────────────────────
 * An IDENTITY-LINKED API key cannot make any request without naming the
 * workspace it acts in; the API rejects it outright:
 *
 *   400 anthropic-workspace-id is required when authenticating with an
 *       identity-linked API key
 *
 * That is not a per-endpoint quirk — a bare two-token messages.create fails the
 * same way, which means EVERY Claude feature (schedule PDF reading, per-line
 * identification, batch categorisation) is dead on such a key. A
 * workspace-scoped key needs no header, so ANTHROPIC_WORKSPACE_ID is optional
 * and simply absent for those.
 *
 * Discovered 2026-08-31 the only way it can be: by making a real call.
 */

import Anthropic from '@anthropic-ai/sdk';

if (typeof window !== 'undefined') {
    throw new Error('lib/identify/anthropic.ts is server-only and must never be bundled for the browser.');
}

/**
 * Trimmed defensively, same as AIRTABLE_PAT: a trailing newline pasted into the
 * Vercel env editor turns into an auth error that is miserable to spot.
 */
export function getApiKey(): string {
    return (process.env.ANTHROPIC_API_KEY ?? '').trim();
}

/** The workspace an identity-linked key acts in. Empty for workspace-scoped keys. */
export function getWorkspaceId(): string {
    return (process.env.ANTHROPIC_WORKSPACE_ID ?? '').trim();
}

export function isIdentifyAvailable(): boolean {
    return getApiKey().length > 0;
}

export interface ClientOptions {
    /** Hard per-request ceiling. Callers set this from their own latency budget. */
    timeoutMs?: number;
}

/**
 * A configured client, or a thrown error when the key is absent.
 *
 * maxRetries is 0 everywhere by deliberate policy: these calls are
 * user-triggered and someone is watching them, so the SDK's default two retries
 * would silently multiply every latency budget by three (see the timeout-chain
 * reasoning in claude.ts).
 */
export function createAnthropicClient({ timeoutMs }: ClientOptions = {}): Anthropic {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set — identification is unavailable.');
    const workspaceId = getWorkspaceId();
    return new Anthropic({
        apiKey,
        maxRetries: 0,
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
        ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
    });
}
