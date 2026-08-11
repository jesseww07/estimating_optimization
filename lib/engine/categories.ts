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
 * (2026-08-10): Premier Items "Fixture Category" (35 choices) and the Product
 * Categories table tblwHPGnJO6gYUxTL (29 records).
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

export const CATEGORY_TAXONOMY: Record<string, CategoryGroupDef> = {
    'Ceiling Fan': {
        premier: ['Ceiling Fan', 'Ceiling Fans'],
        thirdParty: ['Ceiling Fan'],
    },
    'Vanity': {
        premier: ['Vanity'],
        thirdParty: ['Vanity'],
    },
    'Mirror': {
        premier: ['LED Mirror'],
        thirdParty: [],
    },
    'Pendant': {
        premier: ['Pendant', 'Chandelier', 'Linear / Island Chandeliers'],
        thirdParty: ['Pendant', 'Chandelier'],
    },
    'Sconce': {
        premier: ['Sconce', 'Wall Sconce', 'Wall Mount', 'Outdoor Wall Sconce'],
        thirdParty: ['Wall Sconce', 'Wall Mount', 'Wall Sconce — Outdoor'],
    },
    'Outdoor Pole': {
        premier: ['Pole Heads', 'Poles', 'Bollards'],
        thirdParty: ['Poles', 'Bollard', 'Bollards', 'Area Light'],
    },
    'Outdoor': {
        premier: ['Pole Heads', 'Poles', 'Bollards', 'Flood Light', 'Outdoor Wall Sconce', 'Wall Mount', 'Step Light'],
        thirdParty: ['Area Light', 'Bollard', 'Bollards', 'Flood Light', 'Poles', 'Wall Mount', 'Wall Sconce — Outdoor', 'Step / Path Light', 'Column Mount'],
    },
    'Exit/Emergency': {
        premier: ['Exit Sign', 'Exit Sign / EMG'],
        thirdParty: ['Exit / Emergency'],
    },
    'Recessed': {
        premier: ['Disk Light', 'Downlight'],
        thirdParty: ['Recessed Light'],
    },
    'Linear': {
        premier: ['Linear Surface Mount', 'Surface Mount'],
        thirdParty: [],
    },
    'Undercabinet': {
        premier: ['Undercabinet / Tape Light + Connectors', 'Surface Mount'],
        thirdParty: ['Tape / Strip / Channel'],
    },
    'Ceiling': {
        premier: ['Ceiling Mount', 'Flush / Surface Mount', 'Surface Mount'],
        thirdParty: ['Ceiling Mount', 'Flush Mount'],
    },
    'LED Tape': {
        premier: ['Led Tape', 'Undercabinet / Tape Light + Connectors'],
        thirdParty: ['Tape / Strip / Channel'],
    },
    'Light Bulb': {
        premier: ['Lamp'],
        thirdParty: ['Light Bulb'],
    },
};

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
