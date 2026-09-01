/**
 * Browser-side upload preparation.
 *
 * BROWSER-ONLY (canvas, createImageBitmap) — which is why it lives here and not
 * under lib/, where everything has to run in Node for the tests and the eval.
 * The .docx reading it builds on is isomorphic (lib/parse/docx.ts) and shared
 * with the API route.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * Vercel refuses a request body over 4.5 MB at the platform edge, BEFORE the
 * route runs — no JSON, no status the app can read, so `fetch` rejects and the
 * estimator sees a bare "Failed to fetch" with no idea why. That is what
 * happened to a 4.9 MB Word fixture schedule in live use (2026-09-01), and the
 * only workaround was saving it as a PDF (2.5 MB) by hand.
 *
 * A Word schedule's bulk is not its content: it is 27 PNG screenshots of the
 * schedule sheets, ~5 MB of them, wrapped around 73 KB of XML. So the browser
 * reads the .docx, re-encodes those page images as JPEG (capped at the 1568 px
 * edge the vision API downsamples to anyway — so nothing Claude would have seen
 * is lost), and posts them as separate parts. ~5 MB becomes ~1 MB, the upload
 * fits, and the read is cheaper on both sides.
 *
 * When a document still cannot be made to fit, that is said plainly rather than
 * left to the browser's generic failure.
 */

import { imageCaptions, readDocx, type DocxDocument } from '@/lib/parse/docx';

/**
 * Vercel's request-body ceiling. Not a knob — the platform enforces it, and
 * exceeding it is invisible to the route.
 */
export const PLATFORM_BODY_LIMIT_BYTES = Math.floor(4.5 * 1024 * 1024);

/**
 * Headroom for multipart framing: every part carries a boundary line, a
 * Content-Disposition header and a filename, so the request body is always
 * larger than the bytes it carries. 64 KB covers ~100 parts several times over,
 * and is small enough that a file just under the ceiling is not turned away for
 * no reason.
 */
const MULTIPART_RESERVE_BYTES = 64 * 1024;

/** What the payload's own content may add up to. */
const UPLOAD_BUDGET_BYTES = PLATFORM_BODY_LIMIT_BYTES - MULTIPART_RESERVE_BYTES;

/**
 * Mirrors MAX_CONTEXT_CHARS in lib/identify/schedule.ts, which is server-only
 * and cannot be imported here. The server truncates the context to this anyway,
 * so sending more would spend upload budget on bytes it discards. Drift can only
 * cost a little context, never correctness.
 */
const MAX_CONTEXT_CHARS = 6_000;

function utf8Length(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

/** The vision API downsamples past this edge, so encoding beyond it is waste. */
const MAX_PAGE_EDGE_PX = 1568;

/** Quality ladder, tried in order until the whole document fits the budget. */
const QUALITY_STEPS = [0.85, 0.7, 0.55] as const;

export function isWordDocument(file: File): boolean {
    return /\.docx$/i.test(file.name)
        || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

/** A canvas that works whether or not OffscreenCanvas is available. */
function makeCanvas(width: number, height: number): { canvas: OffscreenCanvas | HTMLCanvasElement; context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null } {
    if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(width, height);
        return { canvas, context: canvas.getContext('2d') };
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return { canvas, context: canvas.getContext('2d') };
}

async function toBlob(canvas: OffscreenCanvas | HTMLCanvasElement, quality: number): Promise<Blob> {
    if (canvas instanceof OffscreenCanvas) {
        return canvas.convertToBlob({ type: 'image/jpeg', quality });
    }
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
            blob => (blob ? resolve(blob) : reject(new Error('Could not re-encode a page image.'))),
            'image/jpeg',
            quality,
        );
    });
}

/**
 * Re-encode one page image as JPEG, scaled so its long edge is at most
 * MAX_PAGE_EDGE_PX. Returns the ORIGINAL bytes when re-encoding would not
 * actually be smaller — a small screenshot is already as cheap as it gets.
 */
async function recompress(bytes: Uint8Array, mediaType: string, quality: number): Promise<Blob> {
    const original = new Blob([bytes as BlobPart], { type: mediaType });
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(original);
    } catch {
        return original; // undecodable here; let the server sniff and decide
    }
    try {
        const scale = Math.min(1, MAX_PAGE_EDGE_PX / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const { canvas, context } = makeCanvas(width, height);
        if (!context) return original;
        // Schedule screenshots are line art on white; a white ground keeps any
        // transparent PNG margin from flattening to black under JPEG.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        const encoded = await toBlob(canvas, quality);
        return encoded.size < bytes.byteLength ? encoded : original;
    } finally {
        bitmap.close();
    }
}

export interface PreparedUpload {
    form: FormData;
    /** Pages posted, for the progress copy. */
    pageCount: number;
    bytes: number;
}

/**
 * Build the multipart body for a Word schedule: one `page` part per embedded
 * page image (plus its caption as `pageLabel`), the document's prose as
 * `docText`, and the original filename.
 *
 * Returns null — meaning "upload the raw .docx and let the route read it" — for
 * every document this shortcut is not needed for:
 *
 *   - no page images: a Word-TABLE schedule, whose whole content is a few KB of
 *     text, so it fits comfortably as-is;
 *   - table rows present: the rows are content the server turns into pages of
 *     their own, and this path only knows how to post images. Sending it from
 *     here would post the pictures and drop the table.
 *
 * The route reads every shape, including mixed ones; this exists only to get a
 * screenshot-heavy document under the platform's body limit.
 */
export async function prepareWordUpload(file: File): Promise<PreparedUpload | null> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let doc: DocxDocument;
    try {
        doc = await readDocx(bytes);
    } catch (err) {
        // A Word file we cannot read here might still be under the body limit,
        // in which case the route's reader gets a turn and reports properly.
        if (file.size <= UPLOAD_BUDGET_BYTES) return null;
        throw err instanceof Error ? err : new Error(String(err));
    }
    if (doc.images.length === 0) return null;
    if (doc.blocks.some(block => block.kind === 'text' && block.fromTable)) return null;

    const captions = imageCaptions(doc);
    const labels = doc.images.map((_, index) => captions[index] ?? '');
    // Everything that is not an image still occupies the request body, and the
    // server truncates the context anyway — so cap it here and count it.
    const docText = doc.text.length > MAX_CONTEXT_CHARS ? doc.text.slice(0, MAX_CONTEXT_CHARS) : doc.text;
    const fixedBytes = utf8Length(docText) + utf8Length(file.name)
        + labels.reduce((sum, label) => sum + utf8Length(label), 0);

    let smallest = Number.POSITIVE_INFINITY;
    for (const quality of QUALITY_STEPS) {
        const parts: Blob[] = [];
        let total = fixedBytes;
        for (const image of doc.images) {
            const blob = await recompress(image.bytes, image.mediaType, quality);
            parts.push(blob);
            total += blob.size;
        }
        smallest = Math.min(smallest, total);
        if (total > UPLOAD_BUDGET_BYTES) continue;

        const form = new FormData();
        parts.forEach((blob, index) => {
            const extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/gif' ? 'gif' : blob.type === 'image/webp' ? 'webp' : 'jpg';
            form.append('page', blob, `page-${String(index + 1).padStart(2, '0')}.${extension}`);
            form.append('pageLabel', labels[index]!);
        });
        form.append('docText', docText);
        form.append('fileName', file.name);
        return { form, pageCount: parts.length, bytes: total };
    }
    throw new Error(
        `That Word file holds ${(smallest / 1024 / 1024).toFixed(1)} MB of schedule pages even re-encoded, more than one upload can carry ` +
        `(${(UPLOAD_BUDGET_BYTES / 1024 / 1024).toFixed(1)} MB). Split it into two documents and upload them one at a time.`,
    );
}

/**
 * The pre-flight the estimator needs for everything else: a file that cannot
 * physically reach the route should say so, not fail as "Failed to fetch".
 *
 * Checked against the budget rather than the raw ceiling, because the request
 * body is the file PLUS its multipart framing — a file a few bytes under the
 * ceiling still gets refused at the edge.
 */
export function tooLargeForUpload(file: File): string | null {
    if (file.size <= UPLOAD_BUDGET_BYTES) return null;
    const size = (file.size / 1024 / 1024).toFixed(1);
    return `That file is ${size} MB. Uploads are capped at ${(PLATFORM_BODY_LIMIT_BYTES / 1024 / 1024).toFixed(1)} MB by the hosting platform, `
        + 'so it has to be split (or exported at a lower resolution) before it can be read.';
}
