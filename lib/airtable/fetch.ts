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
import { BASE_ID, FANS_FIELDS, HISTORY_FIELDS, MANUFACTURER_FIELDS, PREMIER_FIELDS, PRODUCT_CATEGORY_FIELDS, TABLES, THIRD_PARTY_FIELDS } from './schema';

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

/** Airtable record id shape — never a display value, however it reached us. */
const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

function asString(v: CellValue): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return RECORD_ID_RE.test(v) ? '' : v;
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

/** Airtable's 422 when a requested field id is not on the table any more. */
const UNKNOWN_FIELD_RE = /Unknown field name(?: or id)?: \"?(fld[A-Za-z0-9]{14})\"?/;

async function selectPage(
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

/**
 * Fetch a table by pinned field IDs, dropping any field the base no longer has.
 *
 * Requesting a deleted field id is a hard 422 on the WHOLE table, so one column
 * removed in the Airtable UI took the entire catalog and history offline — the
 * app showed "Catalog offline" with nothing to explain it (2026-09-01: a schema
 * consolidation removed Premier "Style" and History "Spec Vendor" and did
 * exactly that). A missing field should cost that field, not the app.
 *
 * The drop is logged loudly rather than silently tolerated, because a field the
 * code binds to going missing is a real defect — it just shouldn't be an
 * outage. `scripts/schema-audit.ts` is the deliberate way to find them.
 */
async function selectAll(
    base: Airtable.Base,
    tableId: string,
    fieldIds: string[],
): Promise<Array<{ id: string; fields: FieldsById }>> {
    let requested = [...fieldIds];
    // Bounded: each retry removes one field, so it cannot loop.
    for (let attempt = 0; attempt <= fieldIds.length; attempt++) {
        try {
            return await selectPage(base, tableId, requested);
        } catch (err) {
            const missing = UNKNOWN_FIELD_RE.exec(err instanceof Error ? err.message : String(err))?.[1];
            if (!missing || !requested.includes(missing)) throw err;
            console.error(
                `[airtable] table ${tableId}: field ${missing} no longer exists — continuing without it. ` +
                'Run `npx tsx --env-file=.env scripts/schema-audit.ts` and update lib/airtable/schema.ts.',
            );
            requested = requested.filter(id => id !== missing);
        }
    }
    return selectPage(base, tableId, requested);
}

/**
 * Product Categories lookup (record id → name). The 3rd Party table's
 * "Product Categories" is a linked-record field, so REST hands back record ids;
 * without this map the app both DISPLAYED ids as category badges and failed
 * every 3rd-party category gate (nothing in the Premier vocabulary is spelled
 * "recVezggjIVgwPmsg"). The table is ~30 rows — one extra request.
 */
async function fetchLinkedNames(
    base: Airtable.Base,
    tableId: string,
    nameFieldId: string,
    label: string,
): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
        const rows = await selectAll(base, tableId, [nameFieldId]);
        for (const { id, fields } of rows) {
            const name = asString(fields[nameFieldId]).trim();
            if (name) names.set(id, name);
        }
    } catch (err) {
        // Degrade to "no value" rather than failing the whole context fetch:
        // an unresolved link is a missed gate, an exception is a dead app.
        console.error(`${label} lookup failed — those values will be blank:`, err);
    }
    return names;
}

function fetchProductCategoryNames(base: Airtable.Base): Promise<Map<string, string>> {
    return fetchLinkedNames(base, TABLES.PRODUCT_CATEGORIES, PRODUCT_CATEGORY_FIELDS.NAME, 'Product Categories');
}

function fetchManufacturerNames(base: Airtable.Base): Promise<Map<string, string>> {
    return fetchLinkedNames(base, TABLES.MANUFACTURERS, MANUFACTURER_FIELDS.NAME, 'Manufacturers');
}

/** First linked record's resolved name, or '' — the shape every link field here has. */
function firstLinkedName(cell: unknown, names: Map<string, string>): string {
    for (const id of asLinkIds(cell)) {
        const name = names.get(id);
        if (name) return name;
    }
    return '';
}

// ── Table fetchers ────────────────────────────────────────────────────────────

export async function fetchHistory(): Promise<HistoryRow[]> {
    const base = getBase();
    if (!base) return [];
    const F = HISTORY_FIELDS;
    // History's "Product Category" became a LINKED RECORD in the 2026-09-01
    // consolidation (it was a lookup, which returned names). Linked records come
    // back as record ids, and asString drops those on purpose — so without this
    // resolution every history row's category silently reads empty.
    const categoryNames = await fetchProductCategoryNames(base);
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
            // Linked ids first, then the plain-value path — the field has been
            // both shapes, and a snapshot taken before the change still holds names.
            productCategory: asLinkIds(fields[F.PRODUCT_CATEGORY])
                .map(linkId => categoryNames.get(linkId) ?? '')
                .filter(Boolean)
                .join(', ') || asString(fields[F.PRODUCT_CATEGORY]),
            specDescription,
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
    // The linked vocabulary is authoritative since the 2026-09-02 consolidation;
    // the old select is the fallback so a base (or a snapshot) captured before
    // the migration still reads.
    const categoryNames = await fetchProductCategoryNames(base);
    const rows = await selectAll(base, TABLES.PREMIER_ITEMS, Object.values(F));
    return rows.map(({ id, fields }) => ({
        id,
        itemId: asString(fields[F.ITEM_ID]),
        fixtureCategory: firstLinkedName(fields[F.PRODUCT_CATEGORIES], categoryNames)
            || asString(fields[F.FIXTURE_CATEGORY]),
        itemDescription: asString(fields[F.ITEM_DESCRIPTION]),
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
    const [categoryNames, manufacturerNames] = await Promise.all([
        fetchProductCategoryNames(base),
        fetchManufacturerNames(base),
    ]);
    const rows = await selectAll(base, TABLES.THIRD_PARTY_DOMESTIC, Object.values(F));
    return rows.map(({ id, fields }) => ({
        id,
        itemId: asString(fields[F.ITEM_ID]),
        itemDescription: asString(fields[F.ITEM_DESCRIPTION]),
        // Linked to the registry since 2026-09-02; asString on a link yields ''
        // (record ids are dropped on purpose), so resolve, then fall back for
        // any context captured while it was still free text.
        manufacturer: firstLinkedName(fields[F.MANUFACTURER], manufacturerNames)
            || asString(fields[F.MANUFACTURER]),
        finish: asString(fields[F.FINISH]),
        colorTemp: asString(fields[F.COLOR_TEMPERATURE]),
        maxWattage: asString(fields[F.MAX_WATTAGE]),
        lightOutput: asString(fields[F.LIGHT_OUTPUT]),
        productCategories: asLinkIds(fields[F.PRODUCT_CATEGORIES])
            .map(linkId => categoryNames.get(linkId) ?? '')
            .filter(Boolean)
            .join(', '),
        // The Premier table stores a count; this table stores the links, so the
        // count is their length. Same meaning either way: how many past bids
        // used this item.
        timesUsed: asLinkIds(fields[F.HISTORY]).length,
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
