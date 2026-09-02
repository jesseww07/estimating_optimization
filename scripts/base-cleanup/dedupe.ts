/**
 * Merge duplicate catalog rows in Premier Items and 3rd Party Domestic Items.
 *
 *   npx tsx --env-file=.env scripts/base-cleanup/dedupe.ts           # dry run
 *   npx tsx --env-file=.env scripts/base-cleanup/dedupe.ts --apply
 *
 * Two separate duplicate populations, same cause — an import that ran twice:
 *
 *   3rd Party: 17 Globalux item numbers, each present as a "Globalux" row WITH
 *              a Product Categories link and a "GLOBALUX LIGHTING, LLC" row with
 *              none. Half the line was invisible to category-gated matching.
 *   Premier:   63 item numbers, each twice, sharing a NetSuite ID. 58 of the 63
 *              pairs DISAGREE on Fixture Category, so the duplicates were also
 *              feeding contradictory categories into matching (a "Bollard Light"
 *              filed as both Bollards and Pole Heads).
 *
 * Merge rules, in order:
 *   1. The survivor is the row with the most History links — bid precedent is
 *      the one thing that cannot be reconstructed.
 *   2. Then the row that carries a category at all.
 *   3. Then higher Times Used, then the oldest record for stability.
 *   4. Field-level union: any field empty on the survivor is filled from a
 *      duplicate, so merging can only add information.
 *   5. On a category disagreement, the item DESCRIPTION decides — but only when
 *      it names one of the two candidates unambiguously. Anything else keeps the
 *      survivor's value and is reported for a human.
 *
 * Losers are deleted only after the survivor has been updated.
 */

import { APPLY, TABLE, allRecords, banner, deleteRecords, linkIds, normKey, updateRecords, val } from './client';

/** Description wording that unambiguously names a Premier Fixture Category. */
const CATEGORY_EVIDENCE: Array<[string, RegExp]> = [
    ['Bollards', /\bBOLLARD/],
    ['Pole Heads', /AREA LIGHT|SHOEBOX|POLE HEAD|STREET LIGHT/],
    ['Wall Mount', /WALL ?(MOUNT|PACK)/],
    ['Disk Light', /\bDIS[KC]\b/],
    ['Downlight', /DOWNLIGHT/],
    ['Vanity', /VANITY|BATH BAR/],
    ['Pendant', /PENDANT/],
    ['Chandelier', /CHANDELIER/],
    ['Exit Sign', /EXIT/],
    ['Led Tape', /\bTAPE\b/],
    ['Linear Surface Mount', /LINEAR|STRIP LIGHT/],
    ['Step Light', /STEP LIGHT/],
    ['Flood Light', /FLOOD/],
    ['LED Mirror', /MIRROR/],
    ['Wall Sconce', /SCONCE/],
    ['Ceiling Fans', /CEILING FAN/],
    ['Undercabinet / Tape Light + Connectors', /UNDER ?CAB/],
    ['Accent', /ACCENT/],
    ['Trim', /TRIM/],
    ['Lamp', /\bLAMP\b|\bBULB\b/],
];

/** Which of the candidate categories the description supports, if exactly one. */
function categoryFromDescription(description: string, candidates: string[]): string | null {
    const d = description.toUpperCase();
    const supported = candidates.filter(c => CATEGORY_EVIDENCE.some(([name, re]) => name === c && re.test(d)));
    return supported.length === 1 ? supported[0]! : null;
}

interface Group { key: string; rows: Array<{ id: string; fields: Record<string, unknown>; createdTime?: string }> }

interface Plan {
    survivor: string;
    itemId: string;
    deletes: string[];
    fill: Record<string, unknown>;
    categoryNote?: string;
    unresolved?: string;
}

function planMerges(
    groups: Group[],
    opts: { categoryField: string; historyField: string; timesUsedField?: string; descriptionField: string },
): Plan[] {
    const plans: Plan[] = [];
    for (const { rows } of groups) {
        const score = (r: Group['rows'][number]) => [
            linkIds(r.fields[opts.historyField]).length,
            val(r.fields[opts.categoryField]) ? 1 : 0,
            Number(val(r.fields[opts.timesUsedField ?? '']) || 0),
            -(new Date(r.createdTime ?? 0).getTime()),
        ];
        const sorted = [...rows].sort((a, b) => {
            const [sa, sb] = [score(a), score(b)];
            for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return (sb[i] ?? 0) - (sa[i] ?? 0);
            return 0;
        });
        const survivor = sorted[0]!;
        const losers = sorted.slice(1);

        // Field-level union — never lose a value the duplicate had.
        const fill: Record<string, unknown> = {};
        const skip = new Set(['Times Used', 'Last Modified', 'Created Time', 'History']);
        for (const loser of losers) {
            for (const [field, value] of Object.entries(loser.fields)) {
                if (skip.has(field)) continue;
                if (val(survivor.fields[field])) continue;   // survivor already has it
                if (!val(value)) continue;                    // nothing to copy
                if (fill[field] === undefined) fill[field] = value;
            }
        }

        const plan: Plan = { survivor: survivor.id, itemId: val(survivor.fields['Item ID']), deletes: losers.map(l => l.id), fill };

        // Category disagreement: let the description decide, or report it.
        const values = [...new Set(rows.map(r => val(r.fields[opts.categoryField])).filter(Boolean))];
        if (values.length > 1) {
            const description = val(survivor.fields[opts.descriptionField]) || val(losers[0]?.fields[opts.descriptionField]);
            const chosen = categoryFromDescription(description, values);
            if (chosen && chosen !== val(survivor.fields[opts.categoryField])) {
                plan.fill[opts.categoryField] = chosen;
                plan.categoryNote = `${values.join(' vs ')} -> "${chosen}" (description: "${description.slice(0, 44)}")`;
            } else if (chosen) {
                plan.categoryNote = `${values.join(' vs ')} -> kept "${chosen}"`;
            } else {
                plan.unresolved = `${values.join(' vs ')}  desc="${description.slice(0, 50)}"`;
            }
        }
        plans.push(plan);
    }
    return plans;
}

async function run(
    label: string,
    tableId: string,
    opts: { categoryField: string; historyField: string; timesUsedField?: string; descriptionField: string; only?: (r: { fields: Record<string, unknown> }) => boolean },
): Promise<void> {
    banner(`${label} — duplicate merge`);
    const records = await allRecords(tableId);
    const scoped = opts.only ? records.filter(opts.only) : records;
    const byKey = new Map<string, Group['rows']>();
    for (const r of scoped) {
        const key = normKey(val(r.fields['Item ID']));
        if (!key) continue;
        byKey.set(key, [...(byKey.get(key) ?? []), r]);
    }
    const groups: Group[] = [...byKey.entries()].filter(([, rows]) => rows.length > 1).map(([key, rows]) => ({ key, rows }));
    console.log(`${records.length} rows, ${groups.length} duplicated item numbers, ${groups.reduce((n, g) => n + g.rows.length - 1, 0)} redundant rows`);
    if (groups.length === 0) return;

    const plans = planMerges(groups, opts);
    const resolved = plans.filter(p => p.categoryNote);
    const unresolved = plans.filter(p => p.unresolved);

    console.log(`\ncategory conflicts resolved from the description: ${resolved.length}`);
    resolved.slice(0, 12).forEach(p => console.log(`   ${p.itemId.slice(0, 34).padEnd(36)} ${p.categoryNote}`));
    if (unresolved.length) {
        console.log(`\nNOT resolved — survivor's value kept, review these ${unresolved.length}:`);
        unresolved.forEach(p => console.log(`   ${p.itemId.slice(0, 34).padEnd(36)} ${p.unresolved}`));
    }
    const filling = plans.filter(p => Object.keys(p.fill).length > 0);
    console.log(`\nsurvivors gaining a value from their duplicate: ${filling.length}`);
    filling.slice(0, 8).forEach(p => console.log(`   ${p.itemId.slice(0, 30).padEnd(32)} <- ${Object.keys(p.fill).join(', ')}`));
    console.log(`\nrows to delete: ${plans.reduce((n, p) => n + p.deletes.length, 0)}`);

    if (!APPLY) { console.log('\nDRY RUN — nothing written.'); return; }

    const updates = plans.filter(p => Object.keys(p.fill).length > 0).map(p => ({ id: p.survivor, fields: p.fill }));
    console.log(`\napplying ${updates.length} survivor updates…`);
    await updateRecords(tableId, updates);
    const deletes = plans.flatMap(p => p.deletes);
    console.log(`deleting ${deletes.length} redundant rows…`);
    await deleteRecords(tableId, deletes);
    console.log('done.');
}

async function main(): Promise<void> {
    await run('3rd Party Domestic Items', TABLE.THIRD_PARTY, {
        categoryField: 'Product Categories',
        historyField: 'History',
        descriptionField: 'Item Description',
    });
    await run('Premier Items', TABLE.PREMIER, {
        categoryField: 'Fixture Category',
        historyField: 'History',
        timesUsedField: 'Times Used',
        descriptionField: 'Item Description',
    });
}

main().catch(e => { console.error(e); process.exit(1); });
