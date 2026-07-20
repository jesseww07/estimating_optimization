'use client';

/**
 * Estimator UI — upload a converted bid sheet, review VE recommendations,
 * pick substitutions, export the corporate-template workbook.
 *
 * Client-side mirror of the API types (kept structural: only the fields the
 * UI reads). The engine and parsing all live server-side in lib/**.
 */

import { useEffect, useRef, useState } from 'react';

interface ParsedLineItem {
    rowIndex: number;
    section: string;
    mark: string;
    quantity: string;
    manufacturer: string;
    catalogNumber: string;
    rawRow: Record<string, string>;
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
    matchDetails?: string[];
    specManufacturer?: string;
    bidManufacturer?: string;
    projectsUsed?: string[];
    isPassthrough?: boolean;
    specDescription?: string;
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

function recItemName(rec: Recommendation): string {
    return rec.premierItem || rec.bidItem || rec.fanItem || '';
}

function isAuthoritative(rec: Recommendation): boolean {
    return (rec.swapCount ?? 0) >= 3 && rec.confidence >= 95;
}

export default function Home() {
    const [health, setHealth] = useState<{ liveData: boolean; counts?: HealthCounts } | null>(null);
    const [phase, setPhase] = useState<'idle' | 'uploading' | 'analyzing'>('idle');
    const [error, setError] = useState<string | null>(null);
    const [warning, setWarning] = useState<string | null>(null);
    const [fileName, setFileName] = useState<string | null>(null);
    const [results, setResults] = useState<LineItemAnalysis[] | null>(null);
    const [selections, setSelections] = useState<Record<number, string>>({});
    const [jobName, setJobName] = useState('');
    const [jobLocation, setJobLocation] = useState('');
    const [customer, setCustomer] = useState('');
    const [exporting, setExporting] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

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
        setPhase('uploading');
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
                        }
                        : null,
                    note: a.infoMessage ?? (rec?.isPassthrough ? 'Left as specified (high-end decorative)' : ''),
                };
            });
            const res = await fetch('/api/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobName, jobLocation, customer, sourceFileName: fileName, rows }),
            });
            if (!res.ok) {
                const j = await res.json().catch(() => null);
                throw new Error(j?.error || `Export failed (${res.status}).`);
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
            <div className="bg-ink text-white text-xs tracking-widest uppercase px-6 py-2">
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
                <span className="text-xs text-bluelight">
                    {health === null
                        ? 'Checking data…'
                        : health.liveData
                            ? `Live catalog: ${health.counts?.history.toLocaleString()} history · ${health.counts?.premierItems.toLocaleString()} Premier · ${health.counts?.thirdPartyItems.toLocaleString()} 3rd-party · ${health.counts?.fans.toLocaleString()} fans`
                            : 'Catalog offline — recommendations unavailable'}
                </span>
            </nav>

            <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-8">
                {health !== null && !health.liveData && (
                    <div className="border-2 border-danger text-danger px-4 py-3 mb-6 text-sm">
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
                    <h2 className="text-2xl mb-2">Upload a bid sheet</h2>
                    <p className="text-muted text-sm mb-6">
                        Pre-converted CSV or single-sheet Excel with Mark / Qty / Manufacturer / Catalog # columns.
                    </p>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv,.txt,.tsv,.xlsx,.xls,.xlsm,.xlsb"
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
                        className="bg-plteal text-white px-8 py-3 text-sm tracking-widest uppercase hover:bg-steel disabled:opacity-50"
                    >
                        {phase === 'uploading' ? 'Parsing…' : phase === 'analyzing' ? 'Analyzing…' : 'Choose file'}
                    </button>
                    {fileName && phase === 'idle' && (
                        <p className="text-xs text-muted mt-3">{fileName}</p>
                    )}
                </section>

                {error && (
                    <div className="border-2 border-danger text-danger px-4 py-3 mt-6 text-sm">{error}</div>
                )}
                {warning && (
                    <div className="border-2 border-warn text-warn px-4 py-3 mt-6 text-sm">{warning}</div>
                )}

                {/* Results */}
                {results && results.length > 0 && (
                    <>
                        <section className="mt-10 flex flex-wrap items-end justify-between gap-4">
                            <div>
                                <h2 className="text-2xl">{results.length} line items</h2>
                                <p className="text-sm text-muted">
                                    {substituted} substitution{substituted === 1 ? '' : 's'} selected ·{' '}
                                    {results.length - substituted} left as specified
                                </p>
                            </div>
                            <div className="flex flex-wrap gap-3 items-end">
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
                                <button
                                    onClick={handleExport}
                                    disabled={exporting}
                                    className="bg-steel text-white px-6 py-2 text-sm tracking-widest uppercase hover:bg-plteal disabled:opacity-50"
                                >
                                    {exporting ? 'Building…' : 'Export corporate template'}
                                </button>
                            </div>
                        </section>

                        <section className="mt-6 space-y-4">
                            {results.map(a => {
                                const sel = selections[a.lineItem.rowIndex] ?? AS_SPEC;
                                return (
                                    <div key={a.lineItem.rowIndex} className="border-2 border-line bg-white">
                                        <div className="flex flex-wrap gap-x-8 gap-y-1 px-4 py-3 bg-offwhite border-b-2 border-line text-sm">
                                            <span className="font-bold text-heading">{a.lineItem.mark || '—'}</span>
                                            {a.lineItem.section && <span className="text-muted">{a.lineItem.section}</span>}
                                            <span>Qty {a.lineItem.quantity || '—'}</span>
                                            <span className="text-muted">{a.lineItem.manufacturer}</span>
                                            <span className="font-mono text-xs self-center">{a.lineItem.catalogNumber}</span>
                                        </div>

                                        {a.infoMessage && (
                                            <div className="px-4 py-3 text-sm text-info border-b border-line">
                                                {a.infoMessage}
                                            </div>
                                        )}

                                        <div className="px-4 py-3 space-y-2">
                                            {a.recommendations.map(rec => (
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
                                                            <span className="font-bold text-heading">{recItemName(rec) || '(as specified)'}</span>
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
                                                            <span className={`text-xs font-bold ${rec.confidence >= 90 ? 'text-success' : rec.confidence >= 70 ? 'text-warn' : 'text-muted'}`}>
                                                                {Math.round(rec.confidence)}%
                                                            </span>
                                                        </span>
                                                        <span className="block text-xs text-muted mt-0.5">{rec.matchReason}</span>
                                                        {rec.projectsUsed && rec.projectsUsed.length > 0 && (
                                                            <span className="block text-xs text-muted mt-0.5 italic">
                                                                {rec.projectsUsed.slice(0, 3).join(' · ')}
                                                            </span>
                                                        )}
                                                    </span>
                                                </label>
                                            ))}

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

            <footer className="bg-ink text-white text-xs px-6 py-4 text-center tracking-wider">
                Premier Lighting — 4024 E Broadway Rd, Suite 1001 Phoenix AZ 85040 — 1-866-907-2669
            </footer>
        </div>
    );
}
