/**
 * Shared Airtable REST client for the base-cleanup scripts.
 *
 * Deliberately not the Airtable SDK: these scripts do schema reads, bulk record
 * writes and deletes, and want explicit control of batching, rate limiting and
 * dry-run behaviour. The app's own adapter (lib/airtable/) stays the only thing
 * the RUNTIME uses; this is admin tooling.
 *
 * Every script that writes takes `--apply`. Without it, it reports what it would
 * do and touches nothing. That is the house rule for this directory.
 */

export const BASE_ID = 'appWj912AEOvtxqJF';

export const TABLE = {
    HISTORY: 'tblHhTXJDNyyZLdvZ',
    PREMIER: 'tblXfEOWWjDkpt5tw',
    THIRD_PARTY: 'tbl0CaWIugEoo8gwo',
    FANS: 'tblII85uQlaASZMF0',
    MANUFACTURERS: 'tbleN09zl5u0LNQjI',
    PRODUCT_CATEGORIES: 'tblwHPGnJO6gYUxTL',
    PROJECTS: 'tblnNiEAbvfTpGbJv',
    HISTORY_ARCHIVE: 'tbl0wzIbqxCTfAd8Z',
} as const;

/** Airtable allows 5 requests/second per base. */
const SPACING_MS = 220;
/** The API caps record writes and deletes at 10 per request. */
export const BATCH = 10;

export const APPLY = process.argv.includes('--apply');

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function pat(): string {
    const v = (process.env.AIRTABLE_PAT ?? '').trim();
    if (!v) throw new Error('AIRTABLE_PAT is not set — run with `npx tsx --env-file=.env`.');
    return v;
}

export interface AirtableRecord { id: string; fields: Record<string, unknown>; createdTime?: string }

export async function api<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`https://api.airtable.com/v0/${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${pat()}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`Airtable ${res.status} on ${path}: ${(await res.text()).slice(0, 400)}`);
    return res.json() as Promise<T>;
}

export interface FieldMeta { id: string; name: string; type: string; options?: { choices?: Array<{ id: string; name: string }> } }
export interface TableMeta { id: string; name: string; primaryFieldId: string; fields: FieldMeta[] }

export async function schema(): Promise<TableMeta[]> {
    const { tables } = await api<{ tables: TableMeta[] }>(`meta/bases/${BASE_ID}/tables`);
    return tables;
}

/** Every record in a table. `fields` narrows the payload; omit for all fields. */
export async function allRecords(tableId: string, fields?: string[]): Promise<AirtableRecord[]> {
    const out: AirtableRecord[] = [];
    let offset: string | undefined;
    do {
        const params = new URLSearchParams({ pageSize: '100' });
        for (const f of fields ?? []) params.append('fields[]', f);
        if (offset) params.set('offset', offset);
        const page = await api<{ records: AirtableRecord[]; offset?: string }>(`${BASE_ID}/${tableId}?${params}`);
        out.push(...page.records);
        offset = page.offset;
        if (offset) await sleep(SPACING_MS);
    } while (offset);
    return out;
}

/** Cell value as a readable string. Linked records stay as ids — callers resolve them. */
export function val(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map(val).filter(Boolean).join(', ');
    if (typeof v === 'object' && v !== null && 'name' in v) return String((v as { name: unknown }).name);
    return String(v);
}

/** Linked-record ids from a cell. */
export function linkIds(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.map(e => (typeof e === 'string' ? e : e && typeof e === 'object' && 'id' in e ? String((e as { id: unknown }).id) : ''))
        .filter(id => id.startsWith('rec'));
}

/** Comparison key for an item number: case- and punctuation-insensitive. */
export function normKey(s: string): string {
    return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function inBatches<T>(items: T[], run: (batch: T[]) => Promise<void>, label: string): Promise<void> {
    let done = 0;
    for (let i = 0; i < items.length; i += BATCH) {
        const batch = items.slice(i, i + BATCH);
        await run(batch);
        done += batch.length;
        if (done % 100 === 0 || done === items.length) console.log(`    ${label}: ${done}/${items.length}`);
        await sleep(SPACING_MS);
    }
}

export async function updateRecords(
    tableId: string,
    updates: Array<{ id: string; fields: Record<string, unknown> }>,
): Promise<void> {
    if (updates.length === 0) return;
    await inBatches(updates, async batch => {
        await api(`${BASE_ID}/${tableId}`, { method: 'PATCH', body: JSON.stringify({ records: batch }) });
    }, 'updated');
}

export async function createRecords(
    tableId: string,
    records: Array<{ fields: Record<string, unknown> }>,
): Promise<AirtableRecord[]> {
    const created: AirtableRecord[] = [];
    if (records.length === 0) return created;
    await inBatches(records, async batch => {
        const res = await api<{ records: AirtableRecord[] }>(`${BASE_ID}/${tableId}`, {
            method: 'POST', body: JSON.stringify({ records: batch }),
        });
        created.push(...res.records);
    }, 'created');
    return created;
}

export async function deleteRecords(tableId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await inBatches(ids, async batch => {
        const params = new URLSearchParams();
        for (const id of batch) params.append('records[]', id);
        await api(`${BASE_ID}/${tableId}?${params}`, { method: 'DELETE' });
    }, 'deleted');
}

/** Create a field on a table. Returns its id. */
export async function createField(
    tableId: string,
    body: { name: string; type: string; description?: string; options?: Record<string, unknown> },
): Promise<string> {
    const res = await api<{ id: string }>(`meta/bases/${BASE_ID}/tables/${tableId}/fields`, {
        method: 'POST', body: JSON.stringify(body),
    });
    return res.id;
}

/** Rename / re-describe a field. Airtable's API cannot change a field's TYPE or delete it. */
export async function updateField(
    tableId: string,
    fieldId: string,
    body: { name?: string; description?: string },
): Promise<void> {
    await api(`meta/bases/${BASE_ID}/tables/${tableId}/fields/${fieldId}`, {
        method: 'PATCH', body: JSON.stringify(body),
    });
}

export function banner(title: string): void {
    console.log(`\n${'='.repeat(72)}\n${title}${APPLY ? '' : '   [DRY RUN — nothing will be written]'}\n${'='.repeat(72)}`);
}
