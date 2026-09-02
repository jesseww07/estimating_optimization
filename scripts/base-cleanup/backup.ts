/**
 * Full local backup of every table in the base — schema and records.
 *
 *   npx tsx --env-file=.env scripts/base-cleanup/backup.ts
 *
 * Run this BEFORE any bulk write. Airtable's undo is a UI-session affordance
 * that is lost the moment you navigate away (2026-09-01, the hard way), and the
 * API has no undo at all. A restore from one of these files is the only
 * guaranteed way back from a scripted mistake.
 *
 * Output goes to base-backup/<timestamp>/ — gitignored, because it is the entire
 * customer catalog and bid history and this repo is PUBLIC.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { allRecords, schema } from './client';

async function main(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(process.cwd(), 'base-backup', stamp);
    mkdirSync(dir, { recursive: true });
    console.log(`backing up to ${dir}\n`);

    const tables = await schema();
    writeFileSync(path.join(dir, '_schema.json'), JSON.stringify(tables, null, 2));
    console.log(`  _schema.json                    ${tables.length} tables`);

    const manifest: Array<{ table: string; id: string; records: number; file: string }> = [];
    for (const t of tables) {
        const records = await allRecords(t.id);
        const file = `${t.name.replace(/[^A-Za-z0-9]+/g, '_')}.json`;
        writeFileSync(path.join(dir, file), JSON.stringify({ table: t.name, tableId: t.id, records }, null, 2));
        manifest.push({ table: t.name, id: t.id, records: records.length, file });
        console.log(`  ${file.padEnd(32)}${String(records.length).padStart(6)} records`);
    }
    writeFileSync(path.join(dir, '_manifest.json'), JSON.stringify({ takenAt: new Date().toISOString(), tables: manifest }, null, 2));

    const total = manifest.reduce((n, m) => n + m.records, 0);
    console.log(`\ndone — ${total} records across ${manifest.length} tables.`);
    console.log(`restore source: ${dir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
