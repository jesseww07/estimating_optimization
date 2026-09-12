/**
 * Which of the links on a bid line are worth reading for identification.
 *
 * Estimators paste more than one kind of link into a row. A completed bid
 * sheet carries the internal quote file (a Box link in column A) AND the
 * manufacturer's product page (in a trailing column) — 3rd & Flower D17 had
 * both, and the parser hands the UI whichever came first in the row. A
 * file-share link needs a login, so fetching it returns a sign-in page and
 * Claude is asked to identify a product from nothing; the product page is the
 * one that actually names the fixture.
 *
 * Pure and dependency-free so the client (which decides what buttons to show)
 * and the identify route (which refuses what it cannot read) share one rule.
 */

/** Hosts that serve files behind a login — never a readable product page. */
const FILE_SHARE_HOST = /(^|\.)(box\.com|dropbox\.com|drive\.google\.com|docs\.google\.com|sharepoint\.com|onedrive\.live\.com|1drv\.ms|wetransfer\.com|egnyte\.com)$/i;
/** Search engines: the query names the product, the page itself does not. */
const SEARCH_HOST = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.com)$/i;

function parse(url: string): URL | null {
    try {
        const parsed = new URL(url.trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
    } catch {
        return null;
    }
}

/** The link's host without a leading www., for button labels. '' when unparsable. */
export function specUrlHost(url: string): string {
    return parse(url)?.hostname.replace(/^www\./i, '').toLowerCase() ?? '';
}

/** True for a Box / Dropbox / Drive / SharePoint style link — a file behind a login. */
export function isFileShareUrl(url: string): boolean {
    const host = parse(url)?.hostname ?? '';
    return FILE_SHARE_HOST.test(host);
}

/** True for a search-results link (the `q=` names the product; the page is not it). */
export function isSearchUrl(url: string): boolean {
    const parsed = parse(url);
    return !!parsed && SEARCH_HOST.test(parsed.hostname) && /search/i.test(parsed.pathname);
}

/**
 * The links worth offering as "Identify from link", best first: manufacturer
 * and distributor product pages, then search-results links (the web fallback
 * can still read the query), never file-share links. Order among equals is
 * the printed order; duplicates and unparsable values are dropped.
 */
export function preferredSpecUrls(urls: readonly string[]): string[] {
    const ranked: Array<{ url: string; rank: number; index: number }> = [];
    const seen = new Set<string>();
    urls.forEach((raw, index) => {
        const parsed = parse(raw);
        if (!parsed) return;
        const url = raw.trim();
        if (seen.has(url)) return;
        seen.add(url);
        if (isFileShareUrl(url)) return;
        ranked.push({ url, rank: isSearchUrl(url) ? 1 : 0, index });
    });
    ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
    return ranked.map(r => r.url);
}
