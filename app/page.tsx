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

interface IdentifiedSpec {
    manufacturer: string;
    catalogNumber: string;
    productName: string;
    category: string | null;
    attributes: Record<string, string | undefined>;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    source: 'url' | 'web' | 'pdf';
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
    premierLinkId?: string;
    thirdPartyLinkId?: string;
    productCategory?: string;
    specDescription?: string;
    specVendor?: string;
    specEnrichConfidence?: string;
    matchedOriginalSpec?: string;
}

interface LineItemAnalysis {
    lineItem: ParsedLineItem;
    recommendations: Recommendation[];
    infoMessage?: string;
}

interface HealthCounts {
    history: number;
    premierItems: number;
    thirdPartyItems: number;
    fans: number;
}

const AS_SPEC = 'AS_SPEC';

const IDENTIFY_SOURCE_LABEL: Record<IdentifiedSpec['source'], string> = {
    url: 'spec link',
    web: 'web lookup',
    pdf: 'spec sheet',
};

function looksLikeUrl(value: string): boolean {
    return /^https?:\/\//i.test(value.trim()) || /^www\./i.test(value.trim());
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
    const fileInputRef = useRef<HTMLInputElement>(null);
    const identifyFileRef = useRef<HTMLInputElement>(null);
    const identifyTargetRow = useRef<number | null>(null);

    useEffect(() => {
        fetch('/api/recommendations')
            .then(r => (r.ok ? r.json() : null))
            .then(setHealth)
            .catch(() => setHealth(null));
    }, []);

    async function handleFile(file: File) {
        setError(null);
        setWarning(null);
        setResults(null);
        setSelections({});
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
                const top = a.recommendations[0];
                initial[a.lineItem.rowIndex] = top && !top.isPassthrough ? top.id : AS_SPEC;
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
        try {
            let res: Response;
            if (mode === 'pdf') {
                const form = new FormData();
                form.append('mode', 'pdf');
                form.append('lineItem', JSON.stringify(analysis.lineItem));
                if (payload?.file) form.append('file', payload.file);
                res = await fetch('/api/identify', { method: 'POST', body: form });
            } else {
                res = await fetch('/api/identify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode, lineItem: analysis.lineItem, url: payload?.url }),
                });
            }
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || `Identification failed (${res.status}).`);
            const identified: IdentifiedSpec = json.identified;
            const result: LineItemAnalysis = json.result;
            setResults(rs => (rs ? rs.map(a => (a.lineItem.rowIndex === rowIndex ? result : a)) : rs));
            // Confidence gate: LOW identifications never auto-select a recommendation.
            const top = result.recommendations[0];
            setSelections(s => ({
                ...s,
                [rowIndex]: identified.confidence !== 'LOW' && top && !top.isPassthrough ? top.id : AS_SPEC,
            }));
        } catch (e) {
            setIdentifyError(s => ({ ...s, [rowIndex]: e instanceof Error ? e.message : 'Identification failed.' }));
        } finally {
            setIdentifyBusy(s => ({ ...s, [rowIndex]: null }));
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
                    note: a.infoMessage ?? (rec?.isPassthrough ? 'Left as specified (high-end decorative)' : ''),
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
                                                        </span>
                                                    )}
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
                                                const category = rec.productCategory || rec.itemAttributes?.category;
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
                                                                {category && (
                                                                    <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 bg-steel text-white">
                                                                        {category}
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
