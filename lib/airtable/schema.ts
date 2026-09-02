/**
 * SCHEMA — single source of truth for Airtable table + field IDs.
 *
 * Field NAMES drift (someone renames a column in the live base and the app
 * silently breaks). Field IDs are immutable for the life of the field. Always
 * bind by ID.
 *
 * Convention:
 *   - Constant identifier  = the field's ROLE in the application (e.g. PREMIER_LINK).
 *                             This is what code reads. It does not change when the human label is renamed.
 *   - Comment after value  = the human label as of the date noted below.
 *                             This is documentation only; future renames update only the comment.
 *
 * Verified against live base appWj912AEOvtxqJF on 2026-09-01 by
 * `npx tsx --env-file=.env scripts/schema-audit.ts`, which is the tool to re-run
 * after ANY schema edit in Airtable. Run it first when matching quality drops
 * for no reason: a pinned ID that no longer exists is a hard 422 on the whole
 * table fetch, and a field that changed TYPE (lookup -> linked record) silently
 * changes what the adapter receives.
 */

export const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appWj912AEOvtxqJF';

export const TABLES = {
    HISTORY: 'tblHhTXJDNyyZLdvZ',
    PREMIER_ITEMS: 'tblXfEOWWjDkpt5tw',
    FANS: 'tblII85uQlaASZMF0',
    THIRD_PARTY_DOMESTIC: 'tbl0CaWIugEoo8gwo',  // Non-PREMCOL items Premier resells but does not manufacture.
    PRODUCT_CATEGORIES: 'tblwHPGnJO6gYUxTL',    // The ONE category vocabulary — every catalog table links to it.
    MANUFACTURERS: 'tbleN09zl5u0LNQjI',         // The brand registry — 3rd Party and History link to it.
} as const;

// History table — bid line items from past projects.
export const HISTORY_FIELDS = {
    MARK: 'fldlM8S2KnXXHQJtc',                 // "Mark" (singleLineText)
    BID_ITEM: 'fldBpP7Dwlhu3UtL8',             // "Bid Item" (singleLineText)
    ORIGINAL_SPEC: 'fldsGUnOgeNdNHKli',        // "Original Spec" (singleLineText)
    PROJECT: 'fld4MWlM2HejfZyjC',              // "project" (singleSelect)
    BID_DATE: 'fldJpt4KyXOY93ubE',             // "Bid Date" (date)
    SPEC_MANUFACTURER: 'fldCETjmd6SMKHcdz',    // "Spec Manufacturer" (multipleRecordLinks)
    BID_MANUFACTURER: 'fldi6GrwnkVfJpWSY',     // "Bid Manufacturer" (multipleRecordLinks)
    SPEC_MFR_BACKUP: 'fldirxeLofTbLJDnF',      // "Spec Manufacturer (text)" (singleLineText)
    BID_MFR_BACKUP: 'fldhuThP8MOFUwrn4',       // "Bid Manufacturer (text)" (singleLineText)
    MATCH_TYPE: 'fldUKD6C2FdMu4Mg8',           // "Match Type" (singleSelect: EXACT / NON-ITEM / UNMAPPED)
    PREMIER_LINK: 'fldo68HE8BddAUrz4',         // "NetSuite ID" — linked record to Premier Items (multipleRecordLinks)
    PRODUCT_CATEGORY: 'fldqOrLTPQRFAqLI0',     // "Product Category" (multipleRecordLinks)
                                               //   WAS a lookup (returned names); became a linked record in the
                                               //   2026-09-01 consolidation, so REST now returns record IDS.
                                               //   fetch.ts resolves them through the Product Categories table —
                                               //   without that the value arrives empty, because asString()
                                               //   deliberately drops bare record ids.
    SPEC_DESCRIPTION: 'fldc6kZHtIl12sBDP',     // "Item Description (from Spec Description)" (multipleLookupValues — read-only)
                                               //   For MAPPED records this pulls from the linked Premier Item.
                                               //   For UNMAPPED records it is empty — fall back to SPEC_DESCRIPTION_ENRICHED.
    SPEC_DESCRIPTION_ENRICHED: 'flddza1FsokZq8fNQ', // "Spec Description (enriched)" (singleLineText, writable)
                                               //   Populated by spec_enrichment_netsuite.py for UNMAPPED records.
    SPEC_MATCH_CONFIDENCE: 'fldeBaFMSzb7q8l05',// "Spec Match Confidence" (singleLineText)
    THIRD_PARTY_LINK: 'fldrk5HtOCs4BdE7Q',     // "3rd Party Items" — linked record to 3rd Party Domestic Items (multipleRecordLinks)
                                               //   Mutually exclusive with PREMIER_LINK per design contract — a History
                                               //   row links to one catalog or neither, never both.
} as const;

// Premier Items table — Premier private-label product catalog.
export const PREMIER_FIELDS = {
    ITEM_ID: 'fldZXQ1zFp4Zzkq99',              // "Item ID" (singleLineText, primary)
    FIXTURE_CATEGORY: 'fldvrEsaVx6MWg1to',     // "Fixture Category" (singleSelect)
    ITEM_DESCRIPTION: 'fldCbTk7cFKd3Ex3U',     // "Item Description" (singleLineText)
    FINISH: 'fldfSrO7rsC9Erj6H',               // "Finish" (singleSelect)
    COLOR_TEMPERATURE: 'fldy86LucQTddOSMO',    // "Color Temperature" (singleSelect)
    LIGHT_OUTPUT: 'fld85KnxYQnf3grj6',         // "Light Output" (singleSelect)
    MAX_WATTAGE: 'fldQjPNGYXive6tUS',          // "Wattage" (singleSelect) — relabelled from "Max Wattage" 2026-09-01
    TIMES_USED: 'fldblsmKGuplDzKJO',           // "Times Used" (count)
    PRODUCT_CATEGORIES: 'fldkHsUZIimdcAAI6',   // "Product Categories" (multipleRecordLinks -> Product Categories)
                                               //   THE category as of the 2026-09-02 consolidation. Premier used to
                                               //   carry its own 35-choice select while this link sat empty on all
                                               //   2,402 rows; now every catalog table points at one vocabulary.
                                               //   FIXTURE_CATEGORY is kept as the fallback so a context captured
                                               //   before the migration still reads.
} as const;

// Fans table — Premier ceiling-fan catalog.
export const FANS_FIELDS = {
    ITEM_NUMBER: 'fldxjl4W0PI4epPH4',          // "Item_Number" (singleLineText, primary)
    FAN_SIZE: 'fldySkkSvC5s9gHiE',             // "Fan_Size" (multilineText)
    BLADE_COUNT: 'fldSXZxqD9KuVA4Ap',          // "Blade_Count" (number)
    LIGHT: 'fldLs8tGIquBV5Vhr',                // "Light" (singleSelect)
    HOUSING_FINISH: 'fldzFYg2zLpaUzIGM',       // "Housing_Finish" (singleSelect)
    BLADE_FINISH: 'fldmdBn8UPpUyTqSl',         // "Blade_Finish" (singleSelect)
    PRODUCT_CATEGORIES: 'fld6RoY7Ko0Q9NaOk',   // "Product Categories" (multipleRecordLinks) — populated 2026-09-02
} as const;

// 3rd Party Domestic Items table — non-PREMCOL items Premier resells but does
// not manufacture. Symmetric in role with PREMIER_FIELDS. The full table has 54
// fields; only the subset the app actually reads is declared here. Note: many
// fields here are singleLineText where the Premier table uses singleSelect —
// the adapter stringifies both identically, do not normalize types.
// TIMES_USED is derived here rather than stored: the Premier table has a real
// "Times Used" count field, while this table exposes the History LINK, so the
// adapter counts the linked rows. Same signal, one hop further.
export const THIRD_PARTY_FIELDS = {
    ITEM_ID: 'fldWG74OVmhxDLYIH',              // "Item ID" (singleLineText, primary)
    ITEM_DESCRIPTION: 'fldfLg23tvDEZhHB7',     // "Item Description" (multilineText)
    MANUFACTURER: 'fldHpNAcZSzn1uGCN',         // "Manufacturer" (multipleRecordLinks -> Manufacturers)
                                               //   Was free text on 83 brands spelled several ways; linked to the
                                               //   registry 2026-09-02, so this returns RECORD IDS and the adapter
                                               //   resolves them to the canonical name. Spelling variants live in
                                               //   Manufacturers.Aliases.
    FINISH: 'fldwNteitRWqPvMc8',               // "Finish" (multilineText)
    COLOR_TEMPERATURE: 'fld5opb6i6VoApLIR',    // "Color Temperature" (singleLineText)
    MAX_WATTAGE: 'fldogRWXKSzIXREve',          // "Max Wattage" (singleLineText)
    LIGHT_OUTPUT: 'fld1jB4gYDMZtpKrZ',         // "Light Output" (singleLineText)
    HISTORY: 'fldxfublGlYwKf1t6',              // "History" (multipleRecordLinks) — reverse link to the bids that used
                                               //   this item. Its LENGTH is the item's times-used count; the app read
                                               //   0 for every resold item until 2026-09-01, so a resold item that had
                                               //   genuinely been bid could never rank on usage the way a Premier one does.
    PRODUCT_CATEGORIES: 'fldVZ4Hoz9UYiSj5F',   // "Product Categories" (multipleRecordLinks → Product Categories)
                                               //   REST returns record IDS here, never names — resolve through
                                               //   PRODUCT_CATEGORY_FIELDS.NAME or the app renders "recVezggjIVgwPmsg"
                                               //   as a category badge (Firecrest Ridge review, 2026-08-10).
} as const;

// Manufacturers table — the brand registry every catalog and History links to.
export const MANUFACTURER_FIELDS = {
    NAME: 'fldwKnfqzqk9LiWim',                 // "Manufacturer Name" (singleLineText, primary)
    ALIASES: 'fldxkOA1RsOiYcO8w',              // "Aliases" (multilineText) — the other spellings seen in the wild
} as const;

// Product Categories table — the ONE category vocabulary every catalog links to.
export const PRODUCT_CATEGORY_FIELDS = {
    NAME: 'fldRd5i8lylxIteDl',                 // "Category Name" (singleLineText, primary)
} as const;
