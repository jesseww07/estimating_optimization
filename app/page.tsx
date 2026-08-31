'use client';

/**
 * Estimator UI — upload a converted bid sheet, review VE recommendations,
 * pick substitutions, export the corporate-template workbook.
 *
 * Typography: brand serifs (Playfair/Cardo) for the header, nav, and section
 * titles; Inter (--font-data) for all dense card/data content — mirrors the
 * premier-brand data-typography rule.
 *
 * Card content mirrors the Airtable Interface (index.tsx): category chip,
 * enriched NS spec description/vendor, item attributes, match-detail
 * breakdown, and the spec swap-metrics strip.
 */

import { useEffect, useRef, useState } from 'react';
import { defaultSelection } from '@/lib/engine/ranking';

interface IdentifiedSpec {
    manufacturer: string;
    catalogNumber: string;
    productName: string;
    category: string | null;
    attributes: Record<string, string | undefined>;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    source: 'url' | 'web' | 'pdf' | 'batch';
    evidence: string;
}

interface ParsedLineItem {
    rowIndex: number;
    section: string;
    mark: string;
    quantity: string;
    manufacturer: string;
    catalogNumber: string;
    rawRow: Record<string, string>;
    specUrls?: string[];
    identified?: IdentifiedSpec;
}

interface ItemAttributes {
    category?: string;
    productCategory?: string;
    finish?: string;
    colorTemp?: string;
    wattage?: string;
    lightOutput?: string;
    manufacturer?: string;
    fanSize?: string;
    bladeCount?: number;
    hasLight?: boolean;
}

interface Recommendation {
    id: string;
    source: string;
    matchType: string;
    confidence: number;
    bidItem?: string;
    premierItem?: string;
    fanItem?: string;
    matchReason: string;
    swapCount?: number;
    exactMatchCount?: number;
    totalSpecAppearances?: number;
    matchDetails?: string[];
    itemAttributes?: ItemAttributes;
    specManufacturer?: string;
    bidManufacturer?: string;
    projectsUsed?: string[];
    isPassthrough?: boolean;
    /** Family-evidence History match (Phase 4) — never pre-checked by shouldAutoSelect. */
    familyMatch?: boolean;
    /** Explicit auto-select veto from evidence-calibrated tiers (see lib/engine/ranking). */
    autoSelectSafe?: boolean;
    autoSelectReason?: string;
    premierLinkId?: string;
    thirdPartyLinkId?: string;
    productCategory?: string;
    /** Shared display group for productCategory — same vocabulary as specCategory. */
    categoryGroup?: string | null;
    specDescription?: string;
    specVendor?: string;
    specEnrichConfidence?: string;
    matchedOriginalSpec?: string;
}

interface LineItemAnalysis {
    lineItem: ParsedLineItem;
    recommendations: Recommendation[];
    infoMessage?: string;
    /** The engine's inferred fixture category for the SPEC line (null/absent = unknown). */
    specCategory?: string | null;
}

interface HealthCounts {
    history: number;
    premierItems: number;
    thirdPartyItems: number;
    fans: number;
}

const AS_SPEC = 'AS_SPEC';

/**
 * Client-side ceiling on one identification. The server bounds each Claude call
 * too; this is the backstop for anything between the browser and the route
 * (gateway timeouts, dropped connections) so the identify strip can never sit
 * on "Identifying…" forever.
 */
const IDENTIFY_TIMEOUT_MS = 180_000;

/**
 * Client-side ceiling on the batch pass. Sits inside the route's own budget
 * chain (see lib/identify/batch.ts): 240s of Claude calls server-side < 270s
 * here < the route's 300s maxDuration, so the button always comes back — with
 * results or with a reason.
 */
const BATCH_IDENTIFY_TIMEOUT_MS = 270_000;

/**
 * Mirrors BATCH_CHUNK_SIZE / MAX_BATCH_CALLS in lib/identify/batch.ts, which is
 * server-only and cannot be imported here. Used ONLY to tell the estimator what
 * pressing the button will cost before they press it — the server is
 * authoritative, and drift can only make this estimate slightly off.
 */
const BATCH_LINES_PER_CALL = 25;
const BATCH_MAX_CALLS = 12;

const IDENTIFY_SOURCE_LABEL: Record<IdentifiedSpec['source'], string> = {
    url: 'spec link',
    web: 'web lookup',
    pdf: 'spec sheet',
    batch: 'batch identify',
};

/** Per-line explanation when the batch pass could not resolve one line. */
const BATCH_FAILURE_TEXT: Record<string, string> = {
    'call-budget': 'Not covered by this identify pass (call budget) — run it again to include this line.',
    'no-result': 'The batch pass returned nothing for this line — try Look up spec or a cut-sheet PDF.',
    error: 'Batch identification failed for this line.',
};

function looksLikeUrl(value: string): boolean {
    return /^https?:\/\//i.test(value.trim()) || /^www\./i.test(value.trim());
}

/**
 * Lines the batch identify pass would actually spend a call on — the client-side
 * mirror of batchSkipReason() in lib/identify/batch.ts, for the button's count.
 * A line with no category is the whole problem: the engine's in-category
 * fallback is gated on one, so those lines are where "nothing came back" comes
 * from. `infoMessage` covers the two the engine suppresses on purpose (RFI
 * placeholders and LED tape), which specCategory alone doesn't exclude.
 */
function needsBatchIdentify(a: LineItemAnalysis): boolean {
    if (a.specCategory) return false;
    if (a.infoMessage) return false;
    const li = a.lineItem;
    const catalog = looksLikeUrl(li.catalogNumber) ? '' : li.catalogNumber.trim();
    return li.manufacturer.trim() !== '' || catalog !== '';
}

function recItemName(rec: Recommendation): string {
    return rec.premierItem || rec.bidItem || rec.fanItem || '';
}

function isAuthoritative(rec: Recommendation): boolean {
    return (rec.swapCount ?? 0) >= 3 && rec.confidence >= 95;
}

function attrChips(attrs?: ItemAttributes): string[] {
    if (!attrs) return [];
    const chips: string[] = [];
    if (attrs.finish) chips.push(attrs.finish);
    if (attrs.colorTemp) chips.push(attrs.colorTemp);
    if (attrs.wattage) chips.push(attrs.wattage.match(/w$/i) ? attrs.wattage : `${attrs.wattage}W`);
    if (attrs.lightOutput) chips.push(attrs.lightOutput.match(/lm$/i) ? attrs.lightOutput : `${attrs.lightOutput} lm`);
    if (attrs.fanSize) chips.push(attrs.fanSize.match(/"$/) ? attrs.fanSize : `${attrs.fanSize}"`);
    if (attrs.bladeCount) chips.push(`${attrs.bladeCount} blades`);
    if (attrs.hasLight !== undefined) chips.push(attrs.hasLight ? 'With light' : 'No light');
    return chips;
}

export default function Home() {
    const [health, setHealth] = useState<{ liveData: boolean; counts?: HealthCounts } | null>(null);
    const [phase, setPhase] = useState<'idle' | 'uploading' | 'reading-pdf' | 'analyzing'>('idle');
    const [error, setError] = useState<string | null>(null);
    const [warning, setWarning] = useState<string | null>(null);
    const [fileName, setFileName] = useState<string | null>(null);
    const [results, setResults] = useState<LineItemAnalysis[] | null>(null);
    const [selections, setSelections] = useState<Record<number, string>>({});
    const [jobName, setJobName] = useState('');
    const [jobLocation, setJobLocation] = useState('');
    const [customer, setCustomer] = useState('');
    const [salesRep, setSalesRep] = useState('');
    const [estimator, setEstimator] = useState('');
    const [bidDate, setBidDate] = useState('');
    const [exporting, setExporting] = useState(false);
    const [recordToHistory, setRecordToHistory] = useState(true);
    const [writebackNotice, setWritebackNotice] = useState<string | null>(null);
    const [dragOver, setDragOver] = useState(false);
    const [identifyBusy, setIdentifyBusy] = useState<Record<number, string | null>>({});
    const [identifyError, setIdentifyError] = useState<Record<number, string | null>>({});
    const [batchBusy, setBatchBusy] = useState(false);
    const [batchElapsed, setBatchElapsed] = useState(0);
    const [batchNotice, setBatchNotice] = useState<string | null>(null);
    const [batchError, setBatchError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const identifyFileRef = useRef<HTMLInputElement>(null);
    const identifyTargetRow = useRef<number | null>(null);

    useEffect(() => {
        fetch('/api/recommendations')
            .then(r => (r.ok ? r.json() : null))
            .then(setHealth)
            .catch(() => setHealth(null));
    }, []);

    // The batch pass is one long request with no intermediate signal, so the
    // only honest progress we can show is elapsed time against the known ceiling.
    useEffect(() => {
        if (!batchBusy) return;
        setBatchElapsed(0);
        const started = Date.now();
        const id = setInterval(() => setBatchElapsed(Math.round((Date.now() - started) / 1000)), 1000);
        return () => clearInterval(id);
    }, [batchBusy]);

    async function handleFile(file: File) {
        setError(null);
        setWarning(null);
        setResults(null);
        setSelections({});
        setBatchNotice(null);
        setBatchError(null);
        setIdentifyError({});
        setFileName(file.name);
        setPhase(file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf' ? 'reading-pdf' : 'uploading');
        try {
            const form = new FormData();
            form.append('file', file);
            const upRes = await fetch('/api/upload', { method: 'POST', body: form });
            const upJson = await upRes.json();
            if (!upRes.ok) throw new Error(upJson.error || `Upload failed (${upRes.status}).`);
            if (upJson.warning) setWarning(upJson.warning);
            const lineItems: ParsedLineItem[] = upJson.lineItems ?? [];
            if (lineItems.length === 0) {
                setPhase('idle');
                return;
            }
            setPhase('analyzing');
            const recRes = await fetch('/api/recommendations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lineItems }),
            });
            const recJson = await recRes.json();
            if (!recRes.ok) throw new Error(recJson.error || `Analysis failed (${recRes.status}).`);
            const analyses: LineItemAnalysis[] = recJson.results ?? [];
            setResults(analyses);
            const initial: Record<number, string> = {};
            for (const a of analyses) {
                // Only pre-check strong evidence — low-confidence category
                // guesses stay one click away instead of becoming the default
                // (and thus a History row) by inertia. Passthrough cards ARE the
                // leave-as-specified answer, so they select themselves.
                initial[a.lineItem.rowIndex] = defaultSelection(a.recommendations)?.id ?? AS_SPEC;
            }
            setSelections(initial);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Something went wrong.');
        } finally {
            setPhase('idle');
        }
    }

    /** Per-line identification (Phase 2): send one line + evidence pointer, swap in the re-analyzed card. */
    async function handleIdentify(analysis: LineItemAnalysis, mode: 'url' | 'web' | 'pdf', payload?: { url?: string; file?: File }) {
        const rowIndex = analysis.lineItem.rowIndex;
        setIdentifyBusy(s => ({ ...s, [rowIndex]: mode }));
        setIdentifyError(s => ({ ...s, [rowIndex]: null }));
        // Web lookup does a search turn plus an extraction turn, and a hung one
        // used to leave the button row reading "Identifying (web)…" indefinitely
        // with nothing to click. Bound it here as well as server-side, so the
        // strip always comes back — with a result or with a reason.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), IDENTIFY_TIMEOUT_MS);
        try {
            let res: Response;
            if (mode === 'pdf') {
                const form = new FormData();
                form.append('mode', 'pdf');
                form.append('lineItem', JSON.stringify(analysis.lineItem));
                if (payload?.file) form.append('file', payload.file);
                res = await fetch('/api/identify', { method: 'POST', body: form, signal: controller.signal });
            } else {
                res = await fetch('/api/identify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode, lineItem: analysis.lineItem, url: payload?.url }),
                    signal: controller.signal,
                });
            }
            // A gateway timeout or proxy error answers with HTML, not JSON —
            // parsing it blind turned a readable failure into "Unexpected token <".
            const raw = await res.text();
            let json: { error?: string; identified?: IdentifiedSpec; result?: LineItemAnalysis };
            try {
                json = JSON.parse(raw) as typeof json;
            } catch {
                throw new Error(res.ok
                    ? 'Identification returned an unreadable response.'
                    : `Identification failed (${res.status} ${res.statusText || 'error'}).`);
            }
            if (!res.ok) throw new Error(json.error || `Identification failed (${res.status}).`);
            if (!json.identified || !json.result) throw new Error('Identification returned no result.');
            const identified: IdentifiedSpec = json.identified;
            const result: LineItemAnalysis = json.result;
            setResults(rs => (rs ? rs.map(a => (a.lineItem.rowIndex === rowIndex ? result : a)) : rs));
            // Confidence gates: LOW identifications never auto-select, and the
            // recommendation itself must clear the auto-select bar too.
            const pick = identified.confidence === 'LOW' ? null : defaultSelection(result.recommendations);
            setSelections(s => ({ ...s, [rowIndex]: pick?.id ?? AS_SPEC }));
        } catch (e) {
            const aborted = e instanceof DOMException && e.name === 'AbortError';
            setIdentifyError(s => ({
                ...s,
                [rowIndex]: aborted
                    ? `Identification timed out after ${Math.round(IDENTIFY_TIMEOUT_MS / 1000)}s — try again, or identify from the spec-sheet PDF.`
                    : e instanceof Error ? e.message : 'Identification failed.',
            }));
        } finally {
            clearTimeout(timer);
            setIdentifyBusy(s => ({ ...s, [rowIndex]: null }));
        }
    }

    /**
     * Batch identification (Phase 4): ONE request covering every line the engine
     * could not categorize. Explicitly user-triggered — nothing here runs on
     * upload, and the button says up front how many lines and roughly how many
     * Claude calls it will spend. A line that fails comes back as a per-line
     * message in that line's identify strip; the rest of the sheet is untouched.
     */
    async function handleBatchIdentify() {
        if (!results || batchBusy) return;
        const targets = results.filter(needsBatchIdentify);
        if (targets.length === 0) return;
        setBatchBusy(true);
        setBatchError(null);
        setBatchNotice(null);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), BATCH_IDENTIFY_TIMEOUT_MS);
        try {
            const res = await fetch('/api/identify-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // The whole sheet goes over; the server decides which lines it
                // actually spends a call on, so its filter is the one that counts.
                body: JSON.stringify({ lineItems: results.map(a => a.lineItem) }),
                signal: controller.signal,
            });
            // A gateway timeout answers with HTML, not JSON — parsing it blind
            // turns a readable failure into "Unexpected token <".
            const raw = await res.text();
            let json: {
                error?: string;
                results?: LineItemAnalysis[];
                failures?: Array<{ rowIndex: number; reason: string; note?: string }>;
                stats?: { candidates: number; identified: number; categorized: number; unidentified: number; calls: number; inputTokens: number; outputTokens: number };
            };
            try {
                json = JSON.parse(raw) as typeof json;
            } catch {
                throw new Error(res.ok
                    ? 'Batch identification returned an unreadable response.'
                    : `Batch identification failed (${res.status} ${res.statusText || 'error'}).`);
            }
            if (!res.ok) throw new Error(json.error || `Batch identification failed (${res.status}).`);

            const updated = json.results ?? [];
            const byRow = new Map(updated.map(r => [r.lineItem.rowIndex, r]));
            setResults(rs => (rs ? rs.map(a => byRow.get(a.lineItem.rowIndex) ?? a) : rs));
            setSelections(s => {
                const next = { ...s };
                for (const r of updated) {
                    // Same gate as the per-line flow: a LOW identification never
                    // pre-selects, and the recommendation must clear the
                    // auto-select bar on its own merits too.
                    const pick = r.lineItem.identified?.confidence === 'LOW' ? null : defaultSelection(r.recommendations);
                    next[r.lineItem.rowIndex] = pick?.id ?? AS_SPEC;
                }
                return next;
            });
            // Per-line failures render in that line's own identify strip — one
            // bad line never fails the sheet.
            const failures = json.failures ?? [];
            setIdentifyError(s => {
                const next = { ...s };
                for (const r of updated) next[r.lineItem.rowIndex] = null;
                for (const f of failures) {
                    const base = BATCH_FAILURE_TEXT[f.reason] ?? 'Batch identification did not resolve this line.';
                    next[f.rowIndex] = f.note ? `${base} (${f.note})` : base;
                }
                return next;
            });

            const st = json.stats;
            setBatchNotice(st
                ? `Batch identify: ${st.identified} of ${st.candidates} unrecognized line${st.candidates === 1 ? '' : 's'} identified, ` +
                `${st.categorized} now carry a fixture category` +
                `${st.unidentified > 0 ? `, ${st.unidentified} unresolved` : ''}. ` +
                `${st.calls} Claude call${st.calls === 1 ? '' : 's'} · ${st.inputTokens.toLocaleString()} in / ${st.outputTokens.toLocaleString()} out tokens.`
                : `Batch identify: ${updated.length} line(s) updated.`);
        } catch (e) {
            const aborted = e instanceof DOMException && e.name === 'AbortError';
            setBatchError(aborted
                ? `Batch identification timed out after ${Math.round(BATCH_IDENTIFY_TIMEOUT_MS / 1000)}s — nothing was changed. Try again, or identify the worst lines individually.`
                : e instanceof Error ? e.message : 'Batch identification failed.');
        } finally {
            clearTimeout(timer);
            setBatchBusy(false);
        }
    }

    async function handleExport() {
        if (!results) return;
        setExporting(true);
        setError(null);
        try {
            const rows = results.map(a => {
                const selId = selections[a.lineItem.rowIndex] ?? AS_SPEC;
                const rec = selId === AS_SPEC ? null : a.recommendations.find(r => r.id === selId) ?? null;
                return {
                    lineItem: a.lineItem,
                    substitution: rec && !rec.isPassthrough
                        ? {
                            item: recItemName(rec),
                            manufacturer: rec.bidManufacturer ?? '',
                            source: rec.source,
                            confidence: rec.confidence,
                            matchReason: rec.matchReason,
                            premierLinkId: rec.premierLinkId,
                            thirdPartyLinkId: rec.thirdPartyLinkId,
                        }
                        : null,
                    // A passthrough's own reason is the accurate note — "high-end
                    // decorative" was also being stamped on resold-item and
                    // already-a-Premier-item cards, which it never described.
                    note: a.infoMessage ?? (rec?.isPassthrough ? rec.matchReason : ''),
                };
            });
            setWritebackNotice(null);
            const res = await fetch('/api/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobName, jobLocation, customer, salesRep, estimator, bidDate, sourceFileName: fileName, recordToHistory, rows }),
            });
            if (!res.ok) {
                const j = await res.json().catch(() => null);
                throw new Error(j?.error || `Export failed (${res.status}).`);
            }
            const wbMode = res.headers.get('X-Writeback-Mode');
            if (wbMode === 'dry_run') {
                setWritebackNotice(`Bid history: DRY RUN — ${res.headers.get('X-Writeback-Attempted') ?? 0} row(s) inspected, nothing written (flip HISTORY_WRITEBACK=live to enable).`);
            } else if (wbMode === 'live') {
                setWritebackNotice(`Bid history: ${res.headers.get('X-Writeback-Written') ?? 0} row(s) recorded, ${res.headers.get('X-Writeback-Skipped') ?? 0} skipped as duplicates.`);
            } else if (wbMode === 'error' || wbMode === 'unavailable') {
                setWritebackNotice('Bid history write-back did not run (see server logs) — the export itself is unaffected.');
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `VE DRAFT - ${(jobName || fileName || 'ESTIMATE').replace(/\.[^.]+$/, '')}.xlsx`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Export failed.');
        } finally {
            setExporting(false);
        }
    }

    const substituted = results
        ? results.filter(a => {
            const sel = selections[a.lineItem.rowIndex];
            if (!sel || sel === AS_SPEC) return false;
            const rec = a.recommendations.find(r => r.id === sel);
            return !!rec && !rec.isPassthrough;
        }).length
        : 0;

    return (
        <div className="flex flex-col min-h-screen">
            {/* Top utility bar */}
            <div className="bg-ink text-white text-xs tracking-widest uppercase px-6 py-2 font-data">
                Premier Lighting — Internal Estimating Tool
            </div>
            {/* Logo bar */}
            <header className="bg-white border-b-2 border-line px-6 py-5 text-center">
                <div className="font-heading text-steel text-3xl font-bold tracking-[0.35em]">PREMIER</div>
                <div className="font-heading text-steel text-sm tracking-[0.8em] -mr-[0.8em]">LIGHTING</div>
            </header>
            {/* Nav strip */}
            <nav className="bg-steel text-white px-6 py-3 flex items-center justify-between">
                <span className="font-heading text-lg">VE &amp; Estimating — Substitution Finder</span>
                <span className="text-xs text-bluelight font-data">
                    {health === null
                        ? 'Checking data…'
                        : health.liveData
                            ? `Live catalog: ${health.counts?.history.toLocaleString()} history · ${health.counts?.premierItems.toLocaleString()} Premier · ${health.counts?.thirdPartyItems.toLocaleString()} 3rd-party · ${health.counts?.fans.toLocaleString()} fans`
                            : 'Catalog offline — recommendations unavailable'}
                </span>
            </nav>

            <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-8">
                {health !== null && !health.liveData && (
                    <div className="border-2 border-danger text-danger px-4 py-3 mb-6 text-sm font-data">
                        The Airtable connection is not available, so the engine has no catalog or history to
                        match against. Uploads will parse, but no recommendations will come back.
                    </div>
                )}

                {/* Upload card */}
                <section
                    className={`border-2 ${dragOver ? 'border-plteal bg-offwhite' : 'border-line'} bg-white px-8 py-10 text-center`}
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={e => {
                        e.preventDefault();
                        setDragOver(false);
                        const f = e.dataTransfer.files?.[0];
                        if (f) handleFile(f);
                    }}
                >
                    <h2 className="text-2xl mb-2">Upload a bid sheet or fixture schedule</h2>
                    <p className="text-muted text-sm mb-6 font-data">
                        CSV / single-sheet Excel with Mark / Qty / Manufacturer / Catalog # columns —
                        or a fixture-schedule PDF (read automatically; takes a minute or two).
                    </p>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv,.txt,.tsv,.xlsx,.xls,.xlsm,.xlsb,.pdf,application/pdf"
                        className="hidden"
                        onChange={e => {
                            const f = e.target.files?.[0];
                            if (f) handleFile(f);
                            e.target.value = '';
                        }}
                    />
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={phase !== 'idle'}
                        className="bg-plteal text-white px-8 py-3 text-sm tracking-widest uppercase hover:bg-steel disabled:opacity-50 font-data"
                    >
                        {phase === 'uploading' ? 'Parsing…' : phase === 'reading-pdf' ? 'Reading PDF…' : phase === 'analyzing' ? 'Analyzing…' : 'Choose file'}
                    </button>
                    {fileName && phase === 'idle' && (
                        <p className="text-xs text-muted mt-3 font-data">{fileName}</p>
                    )}
                </section>

                {error && (
                    <div className="border-2 border-danger text-danger px-4 py-3 mt-6 text-sm font-data">{error}</div>
                )}
                {warning && (
                    <div className="border-2 border-warn text-warn px-4 py-3 mt-6 text-sm font-data">{warning}</div>
                )}

                {/* Results */}
                {results && results.length > 0 && (
                    <>
                        <section className="mt-10 flex flex-wrap items-end justify-between gap-4">
                            <div>
                                <h2 className="text-2xl">{results.length} line items</h2>
                                <p className="text-sm text-muted font-data">
                                    {substituted} substitution{substituted === 1 ? '' : 's'} selected ·{' '}
                                    {results.length - substituted} left as specified
                                </p>
                            </div>
                            <div className="flex flex-wrap gap-3 items-end font-data">
                                <label className="text-xs uppercase tracking-wider text-muted">
                                    Job name
                                    <input
                                        value={jobName}
                                        onChange={e => setJobName(e.target.value)}
                                        className="block border-2 border-line px-2 py-1 text-sm text-body w-44 focus:border-plteal outline-none"
                                        placeholder="e.g. LUNA LANDING"
                                    />
                                </label>
                                <label className="text-xs uppercase tracking-wider text-muted">
                                    Job location
                                    <input
                                        value={jobLocation}
                                        onChange={e => setJobLocation(e.target.value)}
                                        className="block border-2 border-line px-2 py-1 text-sm text-body w-44 focus:border-plteal outline-none"
                                        placeholder="City, ST"
                                    />
                                </label>
                                <label className="text-xs uppercase tracking-wider text-muted">
                                    Customer
                                    <input
                                        value={customer}
                                        onChange={e => setCustomer(e.target.value)}
                                        className="block border-2 border-line px-2 py-1 text-sm text-body w-36 focus:border-plteal outline-none"
                                    />
                                </label>
                                <label className="text-xs uppercase tracking-wider text-muted">
                                    Sales rep
                                    <input
                                        value={salesRep}
                                        onChange={e => setSalesRep(e.target.value)}
                                        className="block border-2 border-line px-2 py-1 text-sm text-body w-32 focus:border-plteal outline-none"
                                    />
                                </label>
                                <label className="text-xs uppercase tracking-wider text-muted">
                                    Estimator
                                    <input
                                        value={estimator}
                                        onChange={e => setEstimator(e.target.value)}
                                        className="block border-2 border-line px-2 py-1 text-sm text-body w-32 focus:border-plteal outline-none"
                                    />
                                </label>
                                <label className="text-xs uppercase tracking-wider text-muted">
                                    Bid date
                                    <input
                                        value={bidDate}
                                        onChange={e => setBidDate(e.target.value)}
                                        placeholder="M/D/YY"
                                        className="block border-2 border-line px-2 py-1 text-sm text-body w-24 focus:border-plteal outline-none"
                                    />
                                </label>
                                <div className="flex flex-col gap-1">
                                    <label className="flex items-center gap-2 text-xs text-body cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={recordToHistory}
                                            onChange={e => setRecordToHistory(e.target.checked)}
                                            className="accent-[#176e8d]"
                                        />
                                        Record selections to bid history ({substituted} row{substituted === 1 ? '' : 's'})
                                    </label>
                                    <button
                                        onClick={handleExport}
                                        disabled={exporting}
                                        className="bg-steel text-white px-6 py-2 text-sm tracking-widest uppercase hover:bg-plteal disabled:opacity-50"
                                    >
                                        {exporting ? 'Building…' : 'Export Bid Selections'}
                                    </button>
                                </div>
                            </div>
                        </section>

                        {/* Batch identification (Phase 4). Explicitly user-triggered:
                            it never fires on upload, and it says what it will spend
                            before the estimator spends it. */}
                        {(() => {
                            const pending = results.filter(needsBatchIdentify).length;
                            if (pending === 0 && !batchNotice && !batchError) return null;
                            const calls = Math.min(Math.ceil(pending / BATCH_LINES_PER_CALL), BATCH_MAX_CALLS);
                            const covered = Math.min(pending, BATCH_LINES_PER_CALL * BATCH_MAX_CALLS);
                            return (
                                <div className="mt-4 font-data">
                                    {pending > 0 && (
                                        <div className="border-2 border-line bg-offwhite px-4 py-3 flex flex-wrap items-center justify-between gap-4">
                                            <div className="max-w-3xl">
                                                <div className="text-xs uppercase tracking-wider text-muted">Unrecognized lines</div>
                                                <p className="text-sm text-body mt-1">
                                                    The engine could not work out what {pending} line{pending === 1 ? ' is' : 's are'}. Without a
                                                    fixture category it has no in-category fallback, so those lines usually come back empty.
                                                    One batched pass reads them all in {calls} Claude call{calls === 1 ? '' : 's'}
                                                    {covered < pending ? ` (covering the first ${covered}; run it again for the rest)` : ''}.
                                                </p>
                                            </div>
                                            <button
                                                onClick={handleBatchIdentify}
                                                disabled={batchBusy}
                                                className="bg-plteal text-white px-6 py-2 text-sm tracking-widest uppercase hover:bg-steel disabled:opacity-50 whitespace-nowrap"
                                                title="Sends the unrecognized lines to Claude in one batched request — nothing runs automatically"
                                            >
                                                {batchBusy
                                                    ? `Identifying ${pending} lines… ${batchElapsed}s`
                                                    : `Identify ${pending} unrecognized line${pending === 1 ? '' : 's'}`}
                                            </button>
                                        </div>
                                    )}
                                    {batchBusy && (
                                        <p className="text-xs text-muted mt-2">
                                            One request covering every unrecognized line; it can take a couple of minutes.
                                            Results land line by line when it returns — the rest of the sheet is untouched.
                                        </p>
                                    )}
                                    {batchNotice && !batchBusy && (
                                        <div className="border-2 border-line bg-offwhite text-body px-4 py-3 mt-2 text-sm">
                                            {batchNotice}
                                        </div>
                                    )}
                                    {batchError && (
                                        <div className="border-2 border-danger text-danger px-4 py-3 mt-2 text-sm">{batchError}</div>
                                    )}
                                </div>
                            );
                        })()}

                        {writebackNotice && (
                            <div className="border-2 border-line bg-offwhite text-body px-4 py-3 mt-4 text-sm font-data">
                                {writebackNotice}
                            </div>
                        )}

                        {/* Shared picker for per-line cut-sheet PDFs */}
                        <input
                            ref={identifyFileRef}
                            type="file"
                            accept=".pdf,application/pdf"
                            className="hidden"
                            onChange={e => {
                                const f = e.target.files?.[0];
                                const target = results.find(x => x.lineItem.rowIndex === identifyTargetRow.current);
                                if (f && target) handleIdentify(target, 'pdf', { file: f });
                                e.target.value = '';
                            }}
                        />

                        <section className="mt-6 space-y-4 font-data">
                            {results.map(a => {
                                const sel = selections[a.lineItem.rowIndex] ?? AS_SPEC;
                                const top = a.recommendations[0];
                                return (
                                    <div
                                        key={a.lineItem.rowIndex}
                                        className="border-2 border-line bg-white"
                                        onDragOver={e => {
                                            if (e.dataTransfer.types.includes('Files')) e.preventDefault();
                                        }}
                                        onDrop={e => {
                                            const f = e.dataTransfer.files?.[0];
                                            if (f && (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))) {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                handleIdentify(a, 'pdf', { file: f });
                                            }
                                        }}
                                        title="Drop a cut-sheet PDF here to identify this line"
                                    >
                                        {/* Line-item header */}
                                        <div className="flex flex-wrap gap-x-8 gap-y-1 px-4 py-3 bg-offwhite border-b-2 border-line text-sm">
                                            <span className="font-semibold text-heading">{a.lineItem.mark || '—'}</span>
                                            {a.lineItem.section && <span className="text-muted">{a.lineItem.section}</span>}
                                            <span>Qty {a.lineItem.quantity || '—'}</span>
                                            <span className="text-muted">{a.lineItem.manufacturer}</span>
                                            <span className="font-mono text-xs self-center">{a.lineItem.catalogNumber}</span>
                                            {/* What the engine thinks the SPEC item IS. Every recommendation card
                                                below renders its category in this same vocabulary, so a card that
                                                passed the category gate reads as a match instead of a mismatch. */}
                                            <span
                                                className={`text-[10px] uppercase tracking-wider px-2 py-0.5 self-center ${a.specCategory ? 'bg-steel text-white' : 'border border-line text-muted'}`}
                                                title={a.specCategory
                                                    ? 'Fixture category the engine identified for this spec line'
                                                    : 'The engine could not categorize this spec — use Look up spec / Identify to sharpen matching'}
                                            >
                                                {a.specCategory ?? 'category unknown'}
                                            </span>
                                        </div>

                                        {/* Identify strip (Phase 2): identification actions + provenance */}
                                        {(() => {
                                            const li = a.lineItem;
                                            const busy = identifyBusy[li.rowIndex];
                                            const idErr = identifyError[li.rowIndex];
                                            const linkUrl = li.specUrls?.[0] ?? (looksLikeUrl(li.catalogNumber) ? li.catalogNumber.trim() : undefined);
                                            const ident = li.identified;
                                            // Web lookup: offered when the line has something to search for,
                                            // recommendations are weak, and the line isn't RFI/tape-suppressed.
                                            const topConfidence = a.recommendations[0]?.confidence ?? 0;
                                            const webEligible =
                                                !a.infoMessage &&
                                                (li.manufacturer.trim() !== '' || li.catalogNumber.trim() !== '') &&
                                                !looksLikeUrl(li.catalogNumber) &&
                                                topConfidence < 70;
                                            if (!linkUrl && !webEligible && !ident && !idErr && !busy) return null;
                                            return (
                                                <div className="px-4 py-2 border-b border-line text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
                                                    {ident && (
                                                        <span
                                                            className={`uppercase tracking-wider px-2 py-0.5 text-white ${ident.confidence === 'LOW' ? 'bg-warn' : 'bg-plteal'}`}
                                                            title={ident.evidence}
                                                        >
                                                            {ident.confidence === 'LOW' ? '? Possible identification — verify' : `✓ Identified via ${IDENTIFY_SOURCE_LABEL[ident.source]}`}
                                                        </span>
                                                    )}
                                                    {ident && (ident.productName || ident.catalogNumber) && (
                                                        <span className="text-body">
                                                            {[ident.manufacturer, ident.catalogNumber].filter(Boolean).join(' ')}
                                                            {ident.productName ? ` — ${ident.productName}` : ''}
                                                            {ident.category ? ` · ${ident.category}` : ''}
                                                        </span>
                                                    )}
                                                    {ident && (() => {
                                                        const attrs = Object.entries(ident.attributes)
                                                            .filter(([, v]) => v)
                                                            .map(([k, v]) => `${k}: ${v}`);
                                                        return attrs.length > 0 ? (
                                                            <span className="text-muted">{attrs.join(' · ')}</span>
                                                        ) : null;
                                                    })()}
                                                    {busy ? (
                                                        <span className="text-muted">Identifying ({busy})…</span>
                                                    ) : (
                                                        <>
                                                            {linkUrl && (
                                                                <button
                                                                    onClick={() => handleIdentify(a, 'url', { url: linkUrl })}
                                                                    className="border-2 border-plteal text-plteal px-3 py-1 uppercase tracking-wider hover:bg-plteal hover:text-white"
                                                                    title={linkUrl}
                                                                >
                                                                    Identify from link
                                                                </button>
                                                            )}
                                                            {webEligible && (
                                                                <button
                                                                    onClick={() => handleIdentify(a, 'web')}
                                                                    className="border-2 border-line text-muted px-3 py-1 uppercase tracking-wider hover:border-plteal hover:text-plteal"
                                                                    title="Search the web to identify this spec"
                                                                >
                                                                    Look up spec
                                                                </button>
                                                            )}
                                                            <button
                                                                onClick={() => {
                                                                    identifyTargetRow.current = li.rowIndex;
                                                                    identifyFileRef.current?.click();
                                                                }}
                                                                className="border-2 border-line text-muted px-3 py-1 uppercase tracking-wider hover:border-plteal hover:text-plteal"
                                                                title="Upload (or drop anywhere on this card) a manufacturer cut-sheet PDF"
                                                            >
                                                                Identify from PDF
                                                            </button>
                                                        </>
                                                    )}
                                                    {idErr && <span className="text-danger">{idErr}</span>}
                                                </div>
                                            );
                                        })()}

                                        {/* Swap-metrics strip (Interface parity: consolidated spec history) */}
                                        {top && (top.totalSpecAppearances ?? 0) > 0 && (
                                            <div className="px-4 py-2 bg-bluelight/25 border-b border-line text-xs text-steel flex flex-wrap gap-x-6 gap-y-1">
                                                <span>
                                                    Spec seen <strong>{top.totalSpecAppearances}</strong> time{top.totalSpecAppearances === 1 ? '' : 's'} in bid history
                                                </span>
                                                {(top.exactMatchCount ?? 0) > 0 && (
                                                    <span>
                                                        <strong>{top.exactMatchCount}</strong> exact swap{top.exactMatchCount === 1 ? '' : 's'} to {recItemName(top)}
                                                    </span>
                                                )}
                                                {top.specDescription && (
                                                    <span className="text-muted">
                                                        NS: {top.specDescription}
                                                        {top.specVendor ? ` — ${top.specVendor}` : ''}
                                                        {top.specEnrichConfidence ? ` (${top.specEnrichConfidence})` : ''}
                                                    </span>
                                                )}
                                            </div>
                                        )}

                                        {a.infoMessage && (
                                            <div className="px-4 py-3 text-sm text-info border-b border-line">
                                                {a.infoMessage}
                                            </div>
                                        )}

                                        <div className="px-4 py-3 space-y-2">
                                            {a.recommendations.map(rec => {
                                                const catalogCategory = rec.productCategory || rec.itemAttributes?.category || '';
                                                // Group first: the spec header and this badge must speak one
                                                // vocabulary, or a passing gate reads as a mismatch ("OUTDOOR"
                                                // spec vs "WALL MOUNT" card). The specific catalog category
                                                // stays visible as the sub-label.
                                                const group = rec.categoryGroup || null;
                                                const badge = group || catalogCategory;
                                                const detail = catalogCategory && catalogCategory !== badge ? catalogCategory : '';
                                                const offCategory = !!(a.specCategory && group && group !== a.specCategory);
                                                const chips = attrChips(rec.itemAttributes);
                                                return (
                                                    <label
                                                        key={rec.id}
                                                        className={`flex items-start gap-3 border-2 px-3 py-2 cursor-pointer ${sel === rec.id ? 'border-plteal bg-offwhite' : 'border-line'}`}
                                                    >
                                                        <input
                                                            type="radio"
                                                            name={`li-${a.lineItem.rowIndex}`}
                                                            checked={sel === rec.id}
                                                            onChange={() =>
                                                                setSelections(s => ({ ...s, [a.lineItem.rowIndex]: rec.id }))
                                                            }
                                                            className="mt-1 accent-[#176e8d]"
                                                        />
                                                        <span className="flex-1">
                                                            <span className="flex flex-wrap items-center gap-2">
                                                                <span className="font-semibold text-heading">{recItemName(rec) || '(as specified)'}</span>
                                                                {isAuthoritative(rec) && (
                                                                    <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 bg-success text-white">
                                                                        ✓ Bid {rec.swapCount} times
                                                                    </span>
                                                                )}
                                                                {rec.isPassthrough && (
                                                                    <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 bg-muted text-white">
                                                                        ↻ Left as-spec
                                                                    </span>
                                                                )}
                                                                <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 border border-line text-muted">
                                                                    {rec.source}
                                                                </span>
                                                                {badge && (
                                                                    <span
                                                                        className={`text-[10px] uppercase tracking-wider px-2 py-0.5 ${offCategory ? 'border-2 border-warn text-warn' : 'bg-steel text-white'}`}
                                                                        title={detail
                                                                            ? `Catalog category: ${detail}${offCategory ? ` — differs from the spec's (${a.specCategory})` : ''}`
                                                                            : offCategory ? `Differs from the spec's category (${a.specCategory})` : undefined}
                                                                    >
                                                                        {offCategory ? '≠ ' : ''}{badge}
                                                                        {detail ? <span className="normal-case opacity-70"> · {detail}</span> : null}
                                                                    </span>
                                                                )}
                                                                <span className={`text-xs font-semibold ${rec.confidence >= 90 ? 'text-success' : rec.confidence >= 70 ? 'text-warn' : 'text-muted'}`}>
                                                                    {Math.round(rec.confidence)}%
                                                                </span>
                                                            </span>
                                                            <span className="block text-xs text-muted mt-0.5">{rec.matchReason}</span>
                                                            {chips.length > 0 && (
                                                                <span className="flex flex-wrap gap-1 mt-1">
                                                                    {chips.map(c => (
                                                                        <span key={c} className="text-[10px] px-1.5 py-0.5 bg-offwhite border border-line text-body">
                                                                            {c}
                                                                        </span>
                                                                    ))}
                                                                </span>
                                                            )}
                                                            {rec.projectsUsed && rec.projectsUsed.length > 0 && (
                                                                <span className="block text-xs text-muted mt-0.5 italic">
                                                                    {rec.projectsUsed.slice(0, 3).join(' · ')}
                                                                    {rec.projectsUsed.length > 3 ? ` · +${rec.projectsUsed.length - 3} more` : ''}
                                                                </span>
                                                            )}
                                                            {rec.matchDetails && rec.matchDetails.length > 0 && (
                                                                <details className="mt-1" onClick={e => e.stopPropagation()}>
                                                                    <summary className="text-[11px] text-plteal cursor-pointer select-none">
                                                                        Match details
                                                                    </summary>
                                                                    <span className="block text-xs text-muted mt-1 space-y-0.5">
                                                                        {rec.matchDetails.map((d, i) => (
                                                                            <span key={i} className="block">• {d}</span>
                                                                        ))}
                                                                    </span>
                                                                </details>
                                                            )}
                                                        </span>
                                                    </label>
                                                );
                                            })}

                                            <label
                                                className={`flex items-center gap-3 border-2 px-3 py-2 cursor-pointer ${sel === AS_SPEC ? 'border-plteal bg-offwhite' : 'border-line'}`}
                                            >
                                                <input
                                                    type="radio"
                                                    name={`li-${a.lineItem.rowIndex}`}
                                                    checked={sel === AS_SPEC}
                                                    onChange={() =>
                                                        setSelections(s => ({ ...s, [a.lineItem.rowIndex]: AS_SPEC }))
                                                    }
                                                    className="accent-[#176e8d]"
                                                />
                                                <span className="text-sm">
                                                    Leave as specified — {a.lineItem.manufacturer}{' '}
                                                    <span className="font-mono text-xs">{a.lineItem.catalogNumber}</span>
                                                    {/* A strong-looking card sitting unchecked is only confusing while
                                                        the rule is invisible — say why the engine didn't pre-pick it. */}
                                                    {sel === AS_SPEC && top?.autoSelectReason && (
                                                        <span className="block text-xs text-muted mt-0.5">{top.autoSelectReason}</span>
                                                    )}
                                                </span>
                                            </label>
                                        </div>
                                    </div>
                                );
                            })}
                        </section>
                    </>
                )}
            </main>

            <footer className="bg-ink text-white text-xs px-6 py-4 text-center tracking-wider font-data">
                Premier Lighting — 4024 E Broadway Rd, Suite 1001 Phoenix AZ 85040 — 1-866-907-2669
            </footer>
        </div>
    );
}
