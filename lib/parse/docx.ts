/**
 * Word (.docx) reader — the format most fixture schedules actually arrive in.
 *
 * Why this exists: schedules in the Box account are overwhelmingly Word files,
 * and dropping one on the app failed outright (2026-09-01). Saving it as a PDF
 * first worked, which made the Word step a pure manual tax on every sample.
 *
 * What a schedule .docx really is: the one Jesse sent is 99 paragraphs of index
 * text plus 27 embedded PNG screenshots — the schedule grids are IMAGES pasted
 * into the document, not Word tables. Others are genuine Word tables. Both have
 * to work, so this reader returns the document as an ordered list of blocks —
 * text and images interleaved as they appear — and the caller decides how to
 * read them. The text immediately above an image is what labels it
 * ("FIXTURE SCHEDULE – UNIT – E0.4"), which is worth keeping in order.
 *
 * ISOMORPHIC on purpose (no node:zlib, no Buffer): the API route reads a .docx
 * server-side, and the browser reads one BEFORE upload so it can recompress the
 * page images under Vercel's 4.5 MB request-body limit — a 4.9 MB Word file is
 * refused by the platform before the route ever runs, which is what the
 * estimator saw as a bare "Failed to fetch". One implementation, both callers.
 *
 * A .docx is a ZIP; only the entries we need are inflated, so `word/settings.xml`
 * and friends cost nothing.
 */

/** ZIP end-of-central-directory signature. */
const EOCD_SIGNATURE = 0x06054b50;
/** Local file header signature. */
const LOCAL_SIGNATURE = 0x04034b50;
/** ZIP entries are stored (0) or deflated (8); a .docx uses nothing else. */
const STORED = 0;
const DEFLATED = 8;

/** A .docx never legitimately holds more than this — a guard, not a spec limit. */
const MAX_ENTRIES = 5000;

/**
 * Inflation caps. A ZIP's compressed size says nothing about what it expands to:
 * a few hundred KB of crafted (or simply damaged) `document.xml` can inflate to
 * hundreds of megabytes, and the upload limit bounds only the compressed bytes.
 * So every entry is checked against its DECLARED uncompressed size before it is
 * touched, and the actual output is capped as it streams — the declared size is
 * a claim in the file, not a fact.
 *
 * Both ceilings sit far above any real schedule: images are already compressed
 * and barely deflate, and the largest document.xml in the samples is 73 KB.
 */
const MAX_ENTRY_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_INFLATED_BYTES = 64 * 1024 * 1024;

interface ZipEntry {
    name: string;
    method: number;
    compressedSize: number;
    /** As DECLARED by the central directory — verified against real output. */
    uncompressedSize: number;
    offset: number;
}

/** Remaining inflation allowance for one readDocx call. */
interface InflateBudget {
    remaining: number;
}

function tooBig(name: string, bytes: number): Error {
    return new Error(
        `That Word file expands to more than this reader will inflate (${name} alone is ${Math.round(bytes / 1024 / 1024)} MB). ` +
        'If it is a genuine schedule, save it as a PDF and upload that.',
    );
}

function readU16(bytes: Uint8Array, at: number): number {
    return bytes[at]! | (bytes[at + 1]! << 8);
}

function readU32(bytes: Uint8Array, at: number): number {
    return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
}

/** True when these bytes are a ZIP container (which every .docx / .xlsx is). */
export function isZipContainer(bytes: Uint8Array): boolean {
    return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
        && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

/**
 * Index a ZIP's central directory. The EOCD sits at the end, after a comment of
 * up to 64 KB, so it is found by scanning backwards for its signature.
 */
function readZipIndex(bytes: Uint8Array): Map<string, ZipEntry> {
    const minEocd = 22;
    if (bytes.length < minEocd) throw new Error('Not a readable Word file (too short to be a ZIP).');
    let eocd = -1;
    const lowest = Math.max(0, bytes.length - (minEocd + 0xffff));
    for (let at = bytes.length - minEocd; at >= lowest; at--) {
        if (readU32(bytes, at) === EOCD_SIGNATURE) { eocd = at; break; }
    }
    if (eocd < 0) throw new Error('Not a readable Word file (no ZIP directory found).');

    const count = readU16(bytes, eocd + 10);
    const directoryOffset = readU32(bytes, eocd + 16);
    if (count === 0xffff || directoryOffset === 0xffffffff) {
        throw new Error('This Word file uses ZIP64, which this reader does not support. Save it as a PDF and upload that.');
    }
    const entries = new Map<string, ZipEntry>();
    let at = directoryOffset;
    for (let i = 0; i < count && i < MAX_ENTRIES; i++) {
        if (at + 46 > bytes.length) break;
        const method = readU16(bytes, at + 10);
        const compressedSize = readU32(bytes, at + 20);
        const uncompressedSize = readU32(bytes, at + 24);
        const nameLength = readU16(bytes, at + 28);
        const extraLength = readU16(bytes, at + 30);
        const commentLength = readU16(bytes, at + 32);
        const offset = readU32(bytes, at + 42);
        const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
        entries.set(name, { name, method, compressedSize, uncompressedSize, offset });
        at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

/**
 * Inflate one entry, stopping the moment the output passes `limit` rather than
 * buffering whatever the stream decides to produce.
 */
async function inflateRaw(deflated: Uint8Array, limit: number, name: string): Promise<Uint8Array> {
    const stream = new Blob([deflated as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel();
            throw tooBig(name, total);
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.byteLength;
    }
    return out;
}

/** The bytes of one ZIP entry, inflated if it was deflated, within the budget. */
async function readEntry(bytes: Uint8Array, entry: ZipEntry, budget: InflateBudget): Promise<Uint8Array> {
    const at = entry.offset;
    if (readU32(bytes, at) !== LOCAL_SIGNATURE) {
        throw new Error(`Word file is corrupt (bad local header for ${entry.name}).`);
    }
    // Cheap rejection first, from what the directory claims.
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw tooBig(entry.name, entry.uncompressedSize);
    const nameLength = readU16(bytes, at + 26);
    const extraLength = readU16(bytes, at + 28);
    // The central directory's compressed size is authoritative; the local
    // header's copy is zero when the entry was written with a data descriptor.
    const start = at + 30 + nameLength + extraLength;
    const raw = bytes.subarray(start, start + entry.compressedSize);
    const limit = Math.min(MAX_ENTRY_BYTES, budget.remaining);
    if (entry.method === STORED) {
        if (raw.byteLength > limit) throw tooBig(entry.name, raw.byteLength);
        budget.remaining -= raw.byteLength;
        return raw;
    }
    if (entry.method === DEFLATED) {
        const inflated = await inflateRaw(raw, limit, entry.name);
        budget.remaining -= inflated.byteLength;
        return inflated;
    }
    throw new Error(`Word file uses an unsupported compression method (${entry.method}).`);
}

/** Media types this reader hands back for embedded images (what Claude can read). */
const IMAGE_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
};

export interface DocxImage {
    /** The zip path, e.g. `word/media/image7.png` — stable identity for logging. */
    name: string;
    mediaType: string;
    bytes: Uint8Array;
    /** Pixel size when it could be read from the header; null otherwise. */
    width: number | null;
    height: number | null;
}

export type DocxBlock =
    /**
     * `fromTable` is the difference between a caption and a schedule. A Word
     * schedule's rows live in a table; the prose around it is labels and index
     * text. The caller needs to know which is which — passing table rows as
     * "context, not line items" would suppress every row in them.
     */
    | { kind: 'text'; text: string; fromTable: boolean }
    | { kind: 'image'; image: DocxImage };

export interface DocxDocument {
    /** Text and images in document order. */
    blocks: DocxBlock[];
    /** All the document's text, in order — the index/cover content. */
    text: string;
    /** Every embedded image kept, in document order. */
    images: DocxImage[];
}

/** Read a PNG/JPEG/GIF header for pixel dimensions. Null when unreadable. */
function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
    // PNG: IHDR width/height are big-endian at bytes 16..23.
    if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    // GIF: little-endian width/height at bytes 6..9.
    if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
        return { width: readU16(bytes, 6), height: readU16(bytes, 8) };
    }
    // JPEG: walk the segment chain to the first SOFn frame header.
    if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let at = 2;
        while (at + 9 < bytes.length) {
            if (bytes[at] !== 0xff) { at++; continue; }
            const marker = bytes[at + 1]!;
            const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
            const isFrameHeader = marker >= 0xc0 && marker <= 0xcf
                && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            if (isFrameHeader) {
                return { height: (bytes[at + 5]! << 8) | bytes[at + 6]!, width: (bytes[at + 7]! << 8) | bytes[at + 8]! };
            }
            at += 2 + length;
        }
    }
    return null;
}

/**
 * Images too small to carry any schedule content — bullets, rules, icons.
 *
 * The threshold is deliberately far below "looks like a page": schedules are
 * pasted in as strips as well as full grids, and the strips are thin. On Jesse's
 * document a 100px floor silently dropped a 438x99 image sitting directly under
 * "FIXTURE SCHEDULE – LANDSCAPING – L155" — a whole section of the bid. A
 * letterhead logo surviving costs a few hundred tokens; a dropped section costs
 * the estimator the section.
 */
const MIN_IMAGE_EDGE_PX = 40;

function keepImage(image: DocxImage): boolean {
    if (image.width === null || image.height === null) return true;
    return Math.min(image.width, image.height) >= MIN_IMAGE_EDGE_PX;
}

/** XML entity decoding, limited to the five predefined entities plus numerics. */
function decodeXmlText(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&amp;/g, '&');
}

/** Relationship id → target path (relative to `word/`), from document.xml.rels. */
function readRelationships(relsXml: string): Map<string, string> {
    const rels = new Map<string, string>();
    const pattern = /<Relationship\b[^>]*>/g;
    for (const [tag] of relsXml.matchAll(pattern)) {
        const id = /\bId="([^"]+)"/.exec(tag)?.[1];
        const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
        if (id && target) rels.set(id, target);
    }
    return rels;
}

/**
 * Document-order scan of `word/document.xml`.
 *
 * Event-driven rather than tree-based: one alternation over the handful of tags
 * that carry content (`w:t` text, cell/row/paragraph ends, and the `r:embed`
 * relationship id on a drawing). Streaming past nesting is exactly why tables
 * inside tables and images inside cells need no special case.
 */
type ScanEvent =
    | { kind: 'text'; text: string; fromTable: boolean }
    | { kind: 'image'; relId: string };

function scanDocumentXml(xml: string): ScanEvent[] {
    const events: ScanEvent[] = [];
    const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)\s*\/?>|<w:tbl(?:\s[^>]*)?>|<\/w:tbl>|<w:tc(?:\s[^>]*)?>|<\/w:tc>|<\/w:tr>|<\/w:p>|<w:(?:drawing|pict)(?:\s[^>]*)?>|\br:(?:embed|link)="([^"]+)"/g;
    let text = '';
    // Cell depth, so a paragraph break INSIDE a cell does not end the row: Word
    // wraps every cell's content in <w:p>, and treating that as a line break put
    // each cell of a schedule row on its own line.
    let cellDepth = 0;
    // Table depth, so table rows are flushed as their own blocks and tagged.
    let tableDepth = 0;
    // Relationship ids already emitted for the CURRENT drawing. Word writes both
    // r:embed and r:link on one <a:blip> for a linked-and-embedded picture, which
    // is one image, not two — but the SAME id used by a later drawing is a
    // genuine second occurrence with its own place in the document, so this
    // resets per drawing rather than spanning the file.
    let drawingIds = new Set<string>();
    const flush = (): void => {
        if (text.trim()) events.push({ kind: 'text', text, fromTable: tableDepth > 0 });
        text = '';
    };
    for (const match of xml.matchAll(pattern)) {
        const [tag, runText, relId] = match;
        if (runText !== undefined) {
            text += decodeXmlText(runText);
        } else if (relId !== undefined) {
            if (drawingIds.has(relId)) continue;
            drawingIds.add(relId);
            // An image ends the text block, so the caption above it stays with it.
            flush();
            events.push({ kind: 'image', relId });
        } else if (tag.startsWith('<w:drawing') || tag.startsWith('<w:pict')) {
            drawingIds = new Set();
        } else if (tag.startsWith('<w:tab')) {
            text += '\t';
        } else if (tag.startsWith('<w:tbl')) {
            if (tableDepth === 0) flush();  // the prose before the table is not a row
            tableDepth++;
        } else if (tag.startsWith('</w:tbl>')) {
            flush();                        // ...and the table's rows are not prose
            tableDepth = Math.max(0, tableDepth - 1);
        } else if (tag.startsWith('</w:tc>')) {
            cellDepth = Math.max(0, cellDepth - 1);
            text += ' | ';
        } else if (tag.startsWith('<w:tc')) {
            cellDepth++;
        } else if (tag.startsWith('</w:p>')) {
            text += cellDepth > 0 ? ' ' : '\n';
        } else {
            // Row end and explicit breaks are line breaks wherever they appear.
            text += '\n';
        }
    }
    flush();
    return events;
}

/** Collapse the runaway whitespace a Word paragraph scan produces. */
function tidy(text: string): string {
    return text
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\| *(\n|$)/g, '$1')
        .replace(/\n{2,}/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n');
}

/**
 * True when these bytes are a Word document — a ZIP carrying word/document.xml.
 *
 * The extension is not the test: .docx and .xlsx are both ZIPs, and the sheet
 * parser and this reader must not be handed each other's files. Only the central
 * directory is read, so this is cheap enough to run before deciding a path.
 */
export function isDocxContainer(bytes: Uint8Array): boolean {
    if (!isZipContainer(bytes)) return false;
    try {
        return readZipIndex(bytes).has('word/document.xml');
    } catch {
        return false;
    }
}

/**
 * Read a .docx into ordered text and image blocks.
 *
 * Throws with an actionable message when the file is not a readable Word
 * document — the caller surfaces it to the estimator, whose fallback (save as
 * PDF) always works.
 */
export async function readDocx(bytes: Uint8Array): Promise<DocxDocument> {
    const entries = readZipIndex(bytes);
    const documentEntry = entries.get('word/document.xml');
    if (!documentEntry) {
        throw new Error('That file is a ZIP but not a Word document (no word/document.xml).');
    }
    const budget: InflateBudget = { remaining: MAX_TOTAL_INFLATED_BYTES };
    const xml = new TextDecoder().decode(await readEntry(bytes, documentEntry, budget));
    const relsEntry = entries.get('word/_rels/document.xml.rels');
    const rels = relsEntry
        ? readRelationships(new TextDecoder().decode(await readEntry(bytes, relsEntry, budget)))
        : new Map<string, string>();

    const blocks: DocxBlock[] = [];
    const images: DocxImage[] = [];
    // Bytes are cached per media path, so the same picture referenced twice is
    // inflated once but still occupies both of its places in the document.
    const decoded = new Map<string, DocxImage>();
    for (const event of scanDocumentXml(xml)) {
        if (event.kind === 'text') {
            const text = tidy(event.text);
            if (text) blocks.push({ kind: 'text', text, fromTable: event.fromTable });
            continue;
        }
        const target = rels.get(event.relId);
        if (!target) continue;
        const path = target.startsWith('/') ? target.slice(1) : `word/${target}`.replace(/\/\.\//g, '/');
        const entry = entries.get(path) ?? entries.get(target);
        if (!entry) continue;
        const cached = decoded.get(entry.name);
        if (cached) {
            blocks.push({ kind: 'image', image: cached });
            images.push(cached);
            continue;
        }
        const extension = (entry.name.split('.').pop() ?? '').toLowerCase();
        const mediaType = IMAGE_TYPES[extension];
        if (!mediaType) continue; // EMF/WMF and other vector art Claude cannot read
        const imageBytes = await readEntry(bytes, entry, budget);
        const size = imageSize(imageBytes);
        const image: DocxImage = {
            name: entry.name,
            mediaType,
            bytes: imageBytes,
            width: size?.width ?? null,
            height: size?.height ?? null,
        };
        if (!keepImage(image)) continue;
        decoded.set(entry.name, image);
        blocks.push({ kind: 'image', image });
        images.push(image);
    }

    const text = blocks
        .filter((b): b is { kind: 'text'; text: string; fromTable: boolean } => b.kind === 'text')
        .map(b => b.text)
        .join('\n');
    return { blocks, text, images };
}

/**
 * The text block immediately preceding each image, which is what the document
 * uses as its caption ("FIXTURE SCHEDULE – UNIT – E0.4"). Only the last line of
 * that block is taken: a long index paragraph is not a caption. Table rows are
 * never a caption — a schedule table that happens to sit above a logo describes
 * itself, not the picture.
 */
export function imageCaptions(doc: DocxDocument): string[] {
    const captions: string[] = [];
    let previous = '';
    for (const block of doc.blocks) {
        if (block.kind === 'text') {
            previous = block.fromTable ? '' : block.text.split('\n').filter(Boolean).pop() ?? '';
            continue;
        }
        captions.push(previous);
        previous = '';
    }
    return captions;
}
