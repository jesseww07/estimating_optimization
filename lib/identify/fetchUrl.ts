/**
 * SERVER-ONLY spec-URL fetcher for POST /api/identify (mode: url).
 *
 * Contract from the Phase 2 handoff: ~10s timeout, follow redirects,
 * text/html + PDF only, size cap. HTML is stripped to readable text before it
 * reaches Claude (spec pages are template-heavy; tags are token waste).
 */

if (typeof window !== 'undefined') {
    throw new Error('lib/identify/fetchUrl.ts is server-only.');
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;  // 10 MB — covers real cut-sheet PDFs
const MAX_TEXT_CHARS = 40_000;            // ~10-12k tokens of page text

export type FetchedSpecSource =
    | { kind: 'text'; text: string; finalUrl: string }
    | { kind: 'pdf'; base64: string; finalUrl: string };

/** Basic SSRF hygiene: only public http(s) hosts. Internal tool, but no reason to allow probing. */
export function isFetchableSpecUrl(raw: string): boolean {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    // Numeric-IP hosts: block loopback / RFC1918 / link-local ranges.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        const [a, b] = host.split('.').map(Number);
        if (a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) {
            return false;
        }
    }
    if (host === '[::1]' || host === '::1') return false;
    return true;
}

/** Strip an HTML document down to its readable text. Regex-based on purpose — no DOM dependency. */
export function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .trim();
}

export async function fetchSpecUrl(rawUrl: string): Promise<FetchedSpecSource> {
    if (!isFetchableSpecUrl(rawUrl)) {
        throw new Error('URL must be a public http(s) address.');
    }
    let res: Response;
    try {
        res = await fetch(rawUrl, {
            redirect: 'follow',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: {
                // Some manufacturer sites block default fetch UAs outright.
                'User-Agent': 'Mozilla/5.0 (compatible; PremierEstimatorBot/1.0)',
                'Accept': 'text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5',
            },
        });
    } catch (err) {
        const msg = err instanceof Error && err.name === 'TimeoutError'
            ? `Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s.`
            : `Fetch failed: ${err instanceof Error ? err.message : String(err)}`;
        throw new Error(msg);
    }
    if (!res.ok) {
        throw new Error(`The page returned HTTP ${res.status}.`);
    }

    const declaredLength = Number(res.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_BODY_BYTES) {
        throw new Error(`Response too large (${Math.round(declaredLength / 1024 / 1024)} MB; max ${MAX_BODY_BYTES / 1024 / 1024} MB).`);
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const isPdf = contentType.includes('application/pdf') || /\.pdf(\?|#|$)/i.test(res.url || rawUrl);
    const isTextLike = contentType.includes('text/html') || contentType.includes('text/plain') || contentType === '';
    if (!isPdf && !isTextLike) {
        throw new Error(`Unsupported content type "${contentType}" — only web pages and PDFs can be identified.`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_BODY_BYTES) {
        throw new Error(`Response too large (max ${MAX_BODY_BYTES / 1024 / 1024} MB).`);
    }

    const finalUrl = res.url || rawUrl;
    if (isPdf) {
        return { kind: 'pdf', base64: buf.toString('base64'), finalUrl };
    }
    const text = htmlToText(buf.toString('utf-8')).slice(0, MAX_TEXT_CHARS);
    if (!text) throw new Error('The page had no readable text.');
    return { kind: 'text', text: `Source URL: ${finalUrl}\n\n${text}`, finalUrl };
}
