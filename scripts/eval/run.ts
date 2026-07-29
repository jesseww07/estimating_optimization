/**
 * Accuracy eval runner — replays every labeled History outcome through the
 * engine (leave-one-project-out) and reports hit/junk/silence metrics.
 *
 *   npm run eval                      # run + report + compare against baseline
 *   npm run eval -- --failures=25     # also show the worst misses in detail
 *   npm run eval:update               # run + write __tests__/eval.baseline.json
 *   npm run eval -- --max-cases=200   # quick sampled run (deterministic prefix)
 *
 * Exit codes: 0 ok (or improved), 1 regression vs baseline, 2 setup problem.
 * The dataset comes from __tests__/eval.context.json.gz — refresh it with
 * `npm run eval:fetch` (requires AIRTABLE_PAT).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
    buildEvalCases,
    checkRegression,
    runEval,
    toBaseline,
    type Baseline,
    type CaseResult,
    type MetricBlock,
} from '../../lib/eval/harness';
import {
    defaultBaselinePath,
    defaultSnapshotPath,
    fingerprintFile,
    loadSnapshot,
} from '../../lib/eval/dataset';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
};

const updateBaseline = flag('update-baseline');
const failuresToShow = value('failures') ? Number(value('failures')) : flag('failures') ? 15 : 0;
const maxCases = value('max-cases') ? Number(value('max-cases')) : 0;
const snapshotPath = value('snapshot') ?? defaultSnapshotPath();
const baselinePath = defaultBaselinePath();

// ── Load ──────────────────────────────────────────────────────────────────────

if (!existsSync(snapshotPath)) {
    console.error(`No eval snapshot at ${snapshotPath}.`);
    console.error('Generate one with: npm run eval:fetch  (requires AIRTABLE_PAT)');
    process.exit(2);
}

const snapshot = loadSnapshot(snapshotPath);
const fingerprint = fingerprintFile(snapshotPath);
const { meta } = snapshot;

console.log(`Eval dataset: fetched ${meta.fetchedAt} from ${meta.baseId} via ${meta.source}`);
console.log(
    `  history=${meta.counts.history}  premier=${meta.counts.premierItems}  ` +
    `thirdParty=${meta.counts.thirdPartyItems}  fans=${meta.counts.fans}`,
);

// ── Run ───────────────────────────────────────────────────────────────────────

const built = buildEvalCases(snapshot.context);
const startedAt = Date.now();
const report = runEval(snapshot.context, built, {
    maxCases,
    onProgress: (done, total) => process.stderr.write(`\r  evaluating ${done}/${total} cases…`),
});
process.stderr.write('\n');
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

// ── Report ────────────────────────────────────────────────────────────────────

const fmt = (m: MetricBlock): string =>
    `n=${String(m.cases).padStart(5)}  top1 ${pad(m.top1Rate)}  top3 ${pad(m.top3Rate)}  ` +
    `junk ${pad(m.junkRate)}  silent ${pad(m.silentRate)}  autoWrong ${pad(m.autoWrongRate)}`;
const pad = (n: number): string => `${n.toFixed(2)}%`.padStart(7);

console.log(`\n═══ Accuracy eval — ${report.all.cases} cases in ${seconds}s ═══`);
console.log(`\nHEADLINE (standard + bulb lines — a recommendation is expected):`);
console.log(`  ${fmt(report.headline)}`);

console.log('\nBy pipeline class:');
for (const [name, m] of Object.entries(report.byClass)) {
    if (m.cases > 0) console.log(`  ${name.padEnd(9)} ${fmt(m)}`);
}
console.log('\nBy spec style:');
for (const [name, m] of Object.entries(report.bySpecStyle)) {
    if (m.cases > 0) console.log(`  ${name.padEnd(9)} ${fmt(m)}`);
}
console.log('\nBy label source:');
for (const [name, m] of Object.entries(report.byLabelSource)) {
    if (m.cases > 0) console.log(`  ${name.padEnd(11)} ${fmt(m)}`);
}

console.log('\nTop projects by case count:');
for (const p of report.byProject.slice(0, 15)) {
    console.log(`  ${p.project.slice(0, 32).padEnd(34)} ${fmt(p)}`);
}
if (report.byProject.length > 15) {
    console.log(`  … and ${report.byProject.length - 15} more projects`);
}

const sk = report.skipped;
console.log(
    `\nHistory rows not usable as cases: noLink=${sk.noLink} nonItem=${sk.nonItem} ` +
    `dangling=${sk.danglingLink} shortSpec=${sk.shortSpec} url=${sk.urlSpec} ` +
    `quarantined=${sk.quarantined} collapsedDupes=${sk.duplicate}`,
);

const silentKinds = report.results.filter(r => r.outcome === 'silent');
if (silentKinds.length > 0) {
    const byKind = new Map<string, number>();
    for (const r of silentKinds) byKind.set(r.silentKind ?? '?', (byKind.get(r.silentKind ?? '?') ?? 0) + 1);
    console.log(`Silent breakdown: ${[...byKind.entries()].map(([k, n]) => `${k}=${n}`).join('  ')}`);
}

if (failuresToShow > 0) {
    const misses = report.results
        .filter(r => (r.outcome === 'junk' || r.outcome === 'silent') &&
            (r.evalCase.pipelineClass === 'standard' || r.evalCase.pipelineClass === 'bulb'))
        .slice(0, failuresToShow);
    console.log(`\n─── Sample misses (${misses.length} of headline junk+silent) ───`);
    for (const r of misses) printMiss(r);
}

function printMiss(r: CaseResult): void {
    const c = r.evalCase;
    console.log(`\n  [${r.outcome}${r.silentKind ? `/${r.silentKind}` : ''}] ${c.project} — mark "${c.mark}"`);
    console.log(`    spec:     ${c.originalSpec.slice(0, 100)}${c.manufacturer ? `  (mfr: ${c.manufacturer})` : ''}`);
    const labels = c.expectedItems.slice(0, 4).join(' | ') + (c.expectedItems.length > 4 ? ` (+${c.expectedItems.length - 4} more)` : '');
    console.log(`    expected: ${labels}   [${c.labelSource}, ${c.specStyle}, x${c.rowCount}]`);
    if (r.surfaced.length > 0) {
        console.log(`    engine:   ${r.surfaced.join(', ')}  (top: ${r.topSource}/${r.topMatchType} @ ${r.topConfidence})`);
    } else if (r.infoMessage) {
        console.log(`    engine:   — (${r.infoMessage.slice(0, 90)})`);
    } else {
        console.log('    engine:   — (no recommendations)');
    }
}

// ── Baseline compare / update ────────────────────────────────────────────────

if (maxCases > 0) {
    console.log('\n(--max-cases run: baseline comparison and update are disabled on partial runs)');
    process.exit(0);
}

if (updateBaseline) {
    const baseline = toBaseline(report, fingerprint, new Date().toISOString());
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 1) + '\n');
    console.log(`\nBaseline written → ${baselinePath}`);
    console.log('Commit it together with the change that produced these numbers.');
    process.exit(0);
}

if (!existsSync(baselinePath)) {
    console.log(`\nNo baseline at ${baselinePath} — run \`npm run eval:update\` to create one.`);
    process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as Baseline;
if (baseline.datasetFingerprint !== fingerprint) {
    console.error('\n✗ Baseline was generated from a DIFFERENT snapshot (fingerprint mismatch).');
    console.error('  After refreshing the dataset, review the numbers and run `npm run eval:update`.');
    process.exit(1);
}

const check = checkRegression(report, baseline);
if (check.flips.length > 0) {
    console.log(`\nCase flips vs baseline (${check.flips.length}):`);
    for (const f of check.flips.slice(0, 25)) console.log(`  ${f.from} → ${f.to}  ${f.id}`);
    if (check.flips.length > 25) console.log(`  … and ${check.flips.length - 25} more`);
}
if (!check.ok) {
    console.error('\n✗ REGRESSION vs baseline:');
    for (const f of check.failures) console.error(`  - ${f}`);
    process.exit(1);
}
console.log(
    check.improved
        ? '\n✓ No regression — and the run BEATS the baseline; lock it in with `npm run eval:update`.'
        : '\n✓ No regression vs baseline.',
);
