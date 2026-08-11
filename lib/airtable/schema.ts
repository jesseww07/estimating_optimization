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
 * Verified against live base appWj912AEOvtxqJF via Airtable MCP on 2026-05-19.
 */

export const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appWj912AEOvtxqJF';

export const TABLES = {
    HISTORY: 'tblHhTXJDNyyZLdvZ',
    PREMIER_ITEMS: 'tblXfEOWWjDkpt5tw',
    FANS: 'tblII85uQlaASZMF0',
    THIRD_PARTY_DOMESTIC: 'tbl0CaWIugEoo8gwo',  // Non-PREMCOL items Premier resells but does not manufacture.
    PRODUCT_CATEGORIES: 'tblwHPGnJO6gYUxTL',    // Category names linked from 3rd Party Domestic Items.
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
    PRODUCT_CATEGORY: 'fldqOrLTPQRFAqLI0',     // "Product Category" (multipleLookupValues)
    SPEC_DESCRIPTION: 'fldc6kZHtIl12sBDP',     // "Item Description (from Spec Description)" (multipleLookupValues — read-only)
                                               //   For MAPPED records this pulls from the linked Premier Item.
                                               //   For UNMAPPED records it is empty — fall back to SPEC_DESCRIPTION_ENRICHED.
    SPEC_DESCRIPTION_ENRICHED: 'flddza1FsokZq8fNQ', // "Spec Description (enriched)" (singleLineText, writable)
                                               //   Populated by spec_enrichment_netsuite.py for UNMAPPED records.
    SPEC_VENDOR: 'fldQ6fGnT2G5dXieo',          // "Spec Vendor" (singleLineText)
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
    STYLE: 'fldQxkvUdLmal6gsx',                // "Style" (singleSelect)
    FINISH: 'fldfSrO7rsC9Erj6H',               // "Finish" (singleSelect)
    COLOR_TEMPERATURE: 'fldy86LucQTddOSMO',    // "Color Temperature" (singleSelect)
    LIGHT_OUTPUT: 'fld85KnxYQnf3grj6',         // "Light Output" (singleSelect)
    MAX_WATTAGE: 'fldQjPNGYXive6tUS',          // "Max Wattage" (singleSelect)
    TIMES_USED: 'fldblsmKGuplDzKJO',           // "Times Used" (count)
} as const;

// Fans table — Premier ceiling-fan catalog.
export const FANS_FIELDS = {
    ITEM_NUMBER: 'fldxjl4W0PI4epPH4',          // "Item_Number" (singleLineText, primary)
    FAN_SIZE: 'fldySkkSvC5s9gHiE',             // "Fan_Size" (multilineText)
    BLADE_COUNT: 'fldSXZxqD9KuVA4Ap',          // "Blade_Count" (number)
    LIGHT: 'fldLs8tGIquBV5Vhr',                // "Light" (singleSelect)
    HOUSING_FINISH: 'fldzFYg2zLpaUzIGM',       // "Housing_Finish" (singleSelect)
    BLADE_FINISH: 'fldmdBn8UPpUyTqSl',         // "Blade_Finish" (singleSelect)
} as const;

// 3rd Party Domestic Items table — non-PREMCOL items Premier resells but does
// not manufacture. Symmetric in role with PREMIER_FIELDS. The full table has 54
// fields; only the subset the app actually reads is declared here. Note: many
// fields here are singleLineText where the Premier table uses singleSelect —
// the adapter stringifies both identically, do not normalize types.
// No TIMES_USED here (not tracked for 3rd party).
export const THIRD_PARTY_FIELDS = {
    ITEM_ID: 'fldWG74OVmhxDLYIH',              // "Item ID" (singleLineText, primary)
    ITEM_DESCRIPTION: 'fldfLg23tvDEZhHB7',     // "Item Description" (multilineText)
    MANUFACTURER: 'fld9x4NzxcgXFXG8k',         // "Manufacturer" (singleLineText)
    FINISH: 'fldwNteitRWqPvMc8',               // "Finish" (singleLineText)
    COLOR_TEMPERATURE: 'fld5opb6i6VoApLIR',    // "Color Temperature" (singleLineText)
    MAX_WATTAGE: 'fldogRWXKSzIXREve',          // "Max Wattage" (singleLineText)
    LIGHT_OUTPUT: 'fld1jB4gYDMZtpKrZ',         // "Light Output" (singleLineText)
    PRODUCT_CATEGORIES: 'fldVZ4Hoz9UYiSj5F',   // "Product Categories" (multipleRecordLinks → Product Categories)
                                               //   REST returns record IDS here, never names — resolve through
                                               //   PRODUCT_CATEGORY_FIELDS.NAME or the app renders "recVezggjIVgwPmsg"
                                               //   as a category badge (Firecrest Ridge review, 2026-08-10).
} as const;

// Product Categories table — the category vocabulary the 3rd Party catalog links to.
export const PRODUCT_CATEGORY_FIELDS = {
    NAME: 'fldRd5i8lylxIteDl',                 // "Name" (singleLineText, primary)
} as const;
