/**
 * Fixture-category taxonomy — ONE vocabulary map for gating AND display.
 *
 * Three vocabularies exist in the wild and they don't agree:
 *
 *   detector label   — what detectFixtureCategory() infers from the bid line
 *                      ("Outdoor", "Linear", "Recessed", "Exit/Emergency")
 *   Premier Items    — the "Fixture Category" singleSelect on the Premier catalog
 *                      ("Pole Heads", "Linear Surface Mount", "Disk Light", "Exit Sign")
 *   3rd Party        — the linked "Product Categories" table on the resold catalog
 *                      ("Area Light", "Recessed Light", "Exit / Emergency")
 *
 * Before this file, gating used one hand-written map that mixed the two catalog
 * vocabularies and named several choices that don't exist in the live base
 * ("Post/Pier Head", "Post & Bollard", "Ceiling Fans + Accessories"). The
 * consequence was silent: a POST TOP spec inferred "Outdoor Pole" matched
 * nothing in the Premier catalog and fell through to wall packs, and every
 * 3rd-party item failed its category gate because the linked field resolves to
 * record ids, not names (see lib/airtable/fetch.ts).
 *
 * The display consequence was the one Jesse could see: the spec header said
 * OUTDOOR while every card said WALL MOUNT, so the cards read as a mismatch
 * even when the gate had passed them. groupOfCatalogCategory() closes that —
 * the UI renders the shared GROUP label on both sides and keeps the specific
 * catalog category as the detail line.
 *
 * Vocabularies below are verified against live base appWj912AEOvtxqJF
 * (2026-09-01): Premier Items "Fixture Category" (35 choices) and the Product
 * Categories table tblwHPGnJO6gYUxTL (40 records). Re-verify with
 * `npx tsx --env-file=.env scripts/schema-audit.ts` after any schema edit — a
 * name here that no longer exists live is a gate that silently passes nothing.
 *
 * The 3rd-party vocabulary grew in the 2026-09-01 consolidation, and several of
 * the new names are the SAME concept the Premier side already had ("Disk Light",
 * "Exit Sign", "Led Tape", "Linear Surface Mount", "Pole Heads"). They are mapped
 * to the group that concept already belongs to. "Undercabinet Lighting" is the
 * one that mattered most: it is what the Globalux undercabinet line is filed
 * under, and until it was mapped, every one of those items failed the category
 * gate for an undercabinet spec.
 *
 * Deliberately fixtures only. Accessory-ish choices ("Trim", "Accessories",
 * "Recessed Accessory", "Fan Controls", "Pole Accessories", "Driver / Power
 * Supply", "Connector / Hardware", "Ceiling Fan Accessory") are left OUT of
 * every group: they must not be offered as substitutions for a fixture spec,
 * which is the same posture as the accessory gate in matcher.ts.
 */

export interface CategoryGroupDef {
    /** Premier Items "Fixture Category" choices that belong to this group. */
    premier: string[];
    /** 3rd Party "Product Categories" names that belong to this group. */
    thirdParty: string[];
}

/**
 * The vocabulary of each group, as ONE list.
 *
 * Until 2026-09-02 this file had to carry two lists per group, because Premier
 * Items filed its own 35-choice select while the resold catalog linked to the
 * Product Categories table — two vocabularies for the same concepts, which is
 * what `premier` and `thirdParty` below existed to reconcile. The base has since
 * been consolidated: every catalog table links to Product Categories, so there
 * is one vocabulary and one list.
 *
 * Both old and new names are kept. The retired Premier choices ("Downlight",
 * "Sconce", "Flush / Surface Mount", "Undercabinet / Tape Light + Connectors")
 * still appear in any EngineContext captured before the migration — the frozen
 * eval snapshot among them — and a name that costs nothing to keep should not be
 * dropped just because the live base moved on.
 *
 * Accessory-ish categories stay OUT of every group, unchanged: "Accessories",
 * "Trim", "Recessed Accessory", "Pole Accessories", "Fan Controls",
 * "Switch / Control", "Driver / Power Supply", "Connector / Hardware",
 * "Ceiling Fan Accessory", "Glass / Shade", "Transformer", "Specialty Item",
 * "Track Light", "Accent" and "Other / Uncategorized". They must never be
 * offered as a substitution for a fixture, which is the same posture as the
 * accessory gate in matcher.ts.
 */
const GROUP_VOCABULARY: Record<string, string[]> = {
    'Ceiling Fan': ['Ceiling Fan', 'Ceiling Fans'],
    'Vanity': ['Vanity'],
    'Mirror': ['LED Mirror'],
    'Pendant': ['Pendant', 'Chandelier', 'Linear / Island Chandeliers'],
    'Sconce': ['Sconce', 'Wall Sconce', 'Wall Mount', 'Outdoor Wall Sconce', 'Wall Sconce — Outdoor'],
    'Outdoor Pole': ['Pole Heads', 'Poles', 'Bollards', 'Bollard', 'Area Light'],
    'Outdoor': [
        'Pole Heads', 'Poles', 'Bollards', 'Bollard', 'Flood Light', 'Area Light',
        'Outdoor Wall Sconce', 'Wall Sconce — Outdoor', 'Wall Mount',
        'Step Light', 'Step / Path Light', 'Column Mount',
    ],
    'Exit/Emergency': ['Exit Sign', 'Exit Sign / EMG', 'Exit / Emergency'],
    'Recessed': ['Disk Light', 'Downlight', 'Recessed Light'],
    'Linear': ['Linear Surface Mount', 'Surface Mount'],
    // "Undercabinet Lighting" is where the Globalux line lives — Premier's
    // primary source for undercabinet, and the reason this group has real
    // catalog depth at all.
    'Undercabinet': ['Undercabinet / Tape Light + Connectors', 'Undercabinet Lighting', 'Surface Mount', 'Tape / Strip / Channel'],
    'Ceiling': ['Ceiling Mount', 'Flush / Surface Mount', 'Flush Mount', 'Surface Mount'],
    'LED Tape': ['Led Tape', 'Undercabinet / Tape Light + Connectors', 'Tape / Strip / Channel'],
    'Light Bulb': ['Lamp', 'Light Bulb'],
};

/**
 * `premier` and `thirdParty` now hold the SAME list — kept as separate keys only
 * so the gate functions and their tests keep reading the way they always have.
 */
export const CATEGORY_TAXONOMY: Record<string, CategoryGroupDef> = Object.fromEntries(
    Object.entries(GROUP_VOCABULARY).map(([group, names]) => [group, { premier: names, thirdParty: names }]),
);

/** Every group label, in the order the taxonomy declares them. */
export const CATEGORY_GROUP_LABELS = Object.keys(CATEGORY_TAXONOMY);

function norm(label: string): string {
    return label.trim().toLowerCase();
}

/**
 * Reverse index: catalog category (either vocabulary, normalized) → the group
 * labels it belongs to. A category can sit in more than one group ("Wall Mount"
 * is both Sconce and Outdoor), so callers that know the spec's group should
 * prefer it — see groupOfCatalogCategory.
 */
const REVERSE_INDEX: Map<string, string[]> = (() => {
    const map = new Map<string, string[]>();
    for (const [group, def] of Object.entries(CATEGORY_TAXONOMY)) {
        for (const cat of [...def.premier, ...def.thirdParty]) {
            const key = norm(cat);
            const existing = map.get(key);
            if (existing) {
                if (!existing.includes(group)) existing.push(group);
            } else {
                map.set(key, [group]);
            }
        }
    }
    return map;
})();

/**
 * The group label a catalog category displays under. `preferred` (the spec
 * line's own group) wins whenever the category legitimately belongs to it, so
 * a Wall Mount card on an Outdoor spec reads "Outdoor" rather than "Sconce".
 * Returns null for catalog categories outside the taxonomy (accessories,
 * "Specialty Item", "Other / Uncategorized") — the caller falls back to the
 * raw catalog name rather than inventing a group.
 */
export function groupOfCatalogCategory(catalogCategory: string, preferred?: string | null): string | null {
    if (!catalogCategory) return null;
    // 3rd-party cells can list several categories ("Wall Sconce, Chandelier").
    // The compatibility gate already splits them, so the display has to as well
    // — resolving the joined string as one name found nothing and dropped those
    // cards back to raw text, which is the mismatch this file exists to remove.
    const groups: string[] = [];
    for (const entry of splitCategoryList(catalogCategory)) {
        for (const group of REVERSE_INDEX.get(norm(entry)) ?? []) {
            if (!groups.includes(group)) groups.push(group);
        }
    }
    if (groups.length === 0) return null;
    if (preferred && groups.includes(preferred)) return preferred;
    return groups[0]!;
}

/** Split a catalog category cell (which may list several) into individual names. */
export function splitCategoryList(value: string): string[] {
    return value.split(',').map(s => s.trim()).filter(Boolean);
}
