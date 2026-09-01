/**
 * Page count from raw PDF bytes — deliberately WITHOUT a PDF library.
 *
 * The schedule extractor needs a page count to plan page ranges. Adding a PDF
 * parser (pdf-lib, pdfjs) to a repo whose only heavy dependency is `xlsx` buys
 * one integer, so this reads the two things the file already states about
 * itself:
 *
 *   1. `/Type /Pages ... /Count N` — the page-tree node's own total.
 *   2. `/Type /Page` object headers — one per page.
 *
 * Both can hide inside a compressed object stream (`/Type /ObjStm`, PDF 1.5+),
 * which is why FlateDecode streams are inflated with node:zlib before scanning.
 *
 * The number is a PLANNING input, not a fact the output depends on: it decides
 * where chunk boundaries fall. It is therefore biased high (max of the two
 * signals) and the caller keeps the final range open-ended, so an undercount can
 * never drop the tail of a document. Returns null when nothing can be read —
 * the caller then falls back to a single whole-document pass.
 */

import { inflateSync } from 'node:zlib';

/** Bound the work on a hostile/huge file: inflate at most this many streams. */
const MAX_INFLATED_STREAMS = 64;
/** ...and stop scanning once this much inflated text has been examined. */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;

// "/Type /Page" but not "/Pages" and not "/PageLabels" etc.
const PAGE_OBJECT_RE = /\/Type\s*\/Page(?![a-zA-Z])/g;
const PAGES_NODE_RE = /\/Type\s*\/Pages(?![a-zA-Z])/g;
const COUNT_RE = /\/Count\s+(\d+)/;

/**
 * `/Count` on its own is not safe to trust — the document outline tree uses the
 * same key and routinely holds a bigger number (bookmarks) than the page count.
 * Only a `/Count` inside the same dictionary as a `/Type /Pages` marker is a
 * page-tree count, so the search is bounded by the enclosing `<< ... >>`.
 */
function pageTreeCount(text: string): number {
    let best = 0;
    for (const match of text.matchAll(PAGES_NODE_RE)) {
        const at = match.index ?? 0;
        const open = text.lastIndexOf('<<', at);
        const close = text.indexOf('>>', at);
        const window = text.slice(
            open >= 0 ? open : Math.max(0, at - 400),
            close >= 0 ? close : at + 400,
        );
        const count = COUNT_RE.exec(window);
        if (count) best = Math.max(best, Number(count[1]));
    }
    return best;
}

function pageObjectCount(text: string): number {
    return [...text.matchAll(PAGE_OBJECT_RE)].length;
}

/**
 * Inflate every FlateDecode object stream and return the concatenated text.
 * Latin-1 keeps the byte↔character mapping 1:1, so offsets found in the text
 * are valid offsets into the buffer.
 */
function inflatedObjectStreams(buffer: Buffer, text: string): string {
    const parts: string[] = [];
    let inflated = 0;
    let streams = 0;
    let searchFrom = 0;
    while (streams < MAX_INFLATED_STREAMS && inflated < MAX_INFLATED_BYTES) {
        const at = text.indexOf('/ObjStm', searchFrom);
        if (at < 0) break;
        searchFrom = at + 7;
        // The dict continues to `stream`; the data runs to `endstream`.
        const streamAt = text.indexOf('stream', at);
        if (streamAt < 0) break;
        const dict = text.slice(at, streamAt);
        if (!dict.includes('FlateDecode')) continue;
        let dataAt = streamAt + 'stream'.length;
        if (text[dataAt] === '\r') dataAt++;
        if (text[dataAt] === '\n') dataAt++;
        let endAt = text.indexOf('endstream', dataAt);
        if (endAt < 0) continue;
        // `endstream` is preceded by an EOL that is not part of the stream data.
        while (endAt > dataAt && (text[endAt - 1] === '\n' || text[endAt - 1] === '\r')) endAt--;
        streams++;
        try {
            const out = inflateSync(buffer.subarray(dataAt, endAt));
            inflated += out.byteLength;
            parts.push(out.toString('latin1'));
        } catch {
            // A stream we cannot inflate just contributes nothing.
        }
        searchFrom = endAt;
    }
    return parts.join('\n');
}

/** Best-effort page count, or null when the bytes say nothing usable. */
export function countPdfPages(bytes: Uint8Array): number | null {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (buffer.byteLength === 0) return null;
    const text = buffer.toString('latin1');

    let count = Math.max(pageTreeCount(text), pageObjectCount(text));
    // A 1.5+ writer puts most objects in compressed streams, and a hybrid file
    // can leave a couple of page objects in the clear while the rest (and the
    // page tree's own /Count) are compressed — so always look inside when there
    // are object streams, and keep the larger answer.
    if (text.includes('/ObjStm')) {
        const expanded = inflatedObjectStreams(buffer, text);
        if (expanded) {
            count = Math.max(count, pageTreeCount(expanded), pageObjectCount(expanded));
        }
    }
    return count > 0 ? count : null;
}
