/**
 * SERVER-ONLY Airtable adapter.
 *
 * Replaces the Interface engine's live `getCellValueAsString` reads: fetches the
 * History + catalog tables via the `airtable` npm package and emits the plain row
 * shapes in lib/types.ts. This module (and the route handlers that call it) are
 * the only places the Airtable credential is read. It must never be imported from
 * a client component — the key must never reach the browser.
 *
 * Without AIRTABLE_PAT set, every fetch returns an empty context (mock fallback)
 * so the app builds and runs credential-less; isLiveDataAvailable() tells routes
 * to say so in their responses.
 */

import Airtable from 'airtable';
import type { EngineContext, FanRow, HistoryRow, PremierItemRow, ThirdPartyItemRow } from '../types';
import { BASE_ID, FANS_FIELDS, HISTORY_FIELDS, PREMIER_FIELDS, TABLES, THIRD_PARTY_FIELDS } from './schema';

if (typeof window !== 'undefined') {
    throw new Error('lib/airtable/fetch.ts is server-only and must never be bundled for the browser.');
}

function getApiKey(): string {
    // Trim defensively: a trailing newline/space pasted into the Vercel env editor
    // turns into an Airtable 401 (AUTHENTICATION_REQUIRED) that is miserable to spot.
    return (process.env.AIRTABLE_PAT ?? '').trim();
}

export function isLiveDataAvailable(): boolean {
    return getApiKey().length > 0;
}

function getBase(): Airtable.Base | null {
    const apiKey = getApiKey();
    if (!apiKey) return null;
    return new Airtable({ apiKey }).base(BASE_ID);
}

// ── Cell coercion helpers ─────────────────────────────────────────────────────
// REST cell values (json cellFormat): text → string; singleSelect → name string;
// date → ISO string; count → number; multipleRecordLinks → array of record ids;
// multipleLookupValues → array of primitives. These coercions mirror what
// getCellValueAsString produced in the Interface engine.

type CellValue = unknown;
type FieldsById = Record<string, CellValue>;

function asString(v: CellValue): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map(asString).filter(Boolean).join(', ');
    if (typeof v === 'object' && v !== null && 'name' in v) return asString((v as { name: unknown }).name);
    return String(v);
}

function asNumber(v: CellValue): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const n = Number(asString(v));
    return Number.isFinite(n) ? n : 0;
}

function asLinkIds(v: CellValue): string[] {
    if (!Array.isArray(v)) return [];
    return v
        .map(entry => {
            if (typeof entry === 'string') return entry;
            if (entry && typeof entry === 'object' && 'id' in entry) return String((entry as { id: unknown }).id);
            return '';
        })
        .filter(id => id.startsWith('rec'));
}

async function selectAll(
    base: Airtable.Base,
    tableId: string,
    fieldIds: string[],
): Promise<Array<{ id: string; fields: FieldsById }>> {
    const rows: Array<{ id: string; fields: FieldsById }> = [];
    await base(tableId)
        .select({ fields: fieldIds, returnFieldsByFieldId: true })
        .eachPage((records, next) => {
            for (const r of records) {
                rows.push({ id: r.id, fields: r.fields as FieldsById });
            }
            next();
        });
    return rows;
}

// ── Table fetchers ────────────────────────────────────────────────────────────

export async function fetchHistory(): Promise<HistoryRow[]> {
    const base = getBase();
    if (!base) return [];
    const F = HISTORY_FIELDS;
    const rows = await selectAll(base, TABLES.HISTORY, Object.values(F));
    return rows.map(({ id, fields }) => {
        // For MAPPED records the lookup pulls from the linked Premier Item; for
        // UNMAPPED records it is empty — fall back to the enriched text field.
        const specDescription = asString(fields[F.SPEC_DESCRIPTION]) || asString(fields[F.SPEC_DESCRIPTION_ENRICHED]);
        return {
            id,
            mark: asString(fields[F.MARK]),
            bidItem: asString(fields[F.BID_ITEM]),
            originalSpec: asString(fields[F.ORIGINAL_SPEC]),
            project: asString(fields[F.PROJECT]),
            bidDate: asString(fields[F.BID_DATE]),
            // Linked manufacturer fields come back as record ids over REST — display
            // resolution is deferred; the text backup fields below carry the value the
            // engine actually uses (specManufacturer || specMfrBackup).
            specManufacturer: '',
            bidManufacturer: '',
            specMfrBackup: asString(fields[F.SPEC_MFR_BACKUP]),
            bidMfrBackup: asString(fields[F.BID_MFR_BACKUP]),
            matchType: asString(fields[F.MATCH_TYPE]),
            productCategory: asString(fields[F.PRODUCT_CATEGORY]),
            specDescription,
            specVendor: asString(fields[F.SPEC_VENDOR]),
            specEnrichConfidence: asString(fields[F.SPEC_MATCH_CONFIDENCE]),
            premierLinkIds: asLinkIds(fields[F.PREMIER_LINK]),
            thirdPartyLinkIds: asLinkIds(fields[F.THIRD_PARTY_LINK]),
        };
    });
}

export async function fetchPremierItems(): Promise<PremierItemRow[]> {
    const base = getBase();
    if (!base) return [];
    const F = PREMIER_FIELDS;
    const rows = await selectAll(base, TABLES.PREMIER_ITEMS, Object.values(F));
    return rows.map(({ id, fields }) => ({
        id,
        itemId: asString(fields[F.ITEM_ID]),
        fixtureCategory: asString(fields[F.FIXTURE_CATEGORY]),
        itemDescription: asString(fields[F.ITEM_DESCRIPTION]),
        style: asString(fields[F.STYLE]),
        finish: asString(fields[F.FINISH]),
        colorTemp: asString(fields[F.COLOR_TEMPERATURE]),
        maxWattage: asString(fields[F.MAX_WATTAGE]),
        lightOutput: asString(fields[F.LIGHT_OUTPUT]),
        timesUsed: asNumber(fields[F.TIMES_USED]),
    }));
}

export async function fetchThirdPartyItems(): Promise<ThirdPartyItemRow[]> {
    const base = getBase();
    if (!base) return [];
    const F = THIRD_PARTY_FIELDS;
    const rows = await selectAll(base, TABLES.THIRD_PARTY_DOMESTIC, Object.values(F));
    return rows.map(({ id, fields }) => ({
        id,
        itemId: asString(fields[F.ITEM_ID]),
        itemDescription: asString(fields[F.ITEM_DESCRIPTION]),
        manufacturer: asString(fields[F.MANUFACTURER]),
        finish: asString(fields[F.FINISH]),
        colorTemp: asString(fields[F.COLOR_TEMPERATURE]),
        maxWattage: asString(fields[F.MAX_WATTAGE]),
        lightOutput: asString(fields[F.LIGHT_OUTPUT]),
        productCategories: asString(fields[F.PRODUCT_CATEGORIES]),
    }));
}

export async function fetchFans(): Promise<FanRow[]> {
    const base = getBase();
    if (!base) return [];
    const F = FANS_FIELDS;
    let rows: Array<{ id: string; fields: FieldsById }>;
    try {
        rows = await selectAll(base, TABLES.FANS, Object.values(F));
    } catch {
        // The Fans table is optional in the Interface app; treat a missing/renamed
        // table as "no fans" rather than failing the whole context fetch.
        return [];
    }
    return rows.map(({ id, fields }) => ({
        id,
        itemNumber: asString(fields[F.ITEM_NUMBER]),
        fanSize: asString(fields[F.FAN_SIZE]),
        bladeCount: fields[F.BLADE_COUNT] === null || fields[F.BLADE_COUNT] === undefined ? null : asNumber(fields[F.BLADE_COUNT]),
        light: asString(fields[F.LIGHT]),
        housingFinish: asString(fields[F.HOUSING_FINISH]),
        bladeFinish: asString(fields[F.BLADE_FINISH]),
    }));
}

/** Fetch the full engine data context (History + all three catalogs). */
export async function fetchEngineContext(): Promise<EngineContext> {
    // Sequential on purpose: Airtable caps a base at 5 requests/second and answers
    // bursts with a 429 plus a 30-second penalty window. Pages within a table are
    // already fetched serially, so one table at a time keeps the whole ~130-request
    // pull safely under the cap (≈30s cold start, then held in the in-memory cache).
    const history = await fetchHistory();
    const premierItems = await fetchPremierItems();
    const thirdPartyItems = await fetchThirdPartyItems();
    const fans = await fetchFans();
    return { history, premierItems, thirdPartyItems, fans };
}
