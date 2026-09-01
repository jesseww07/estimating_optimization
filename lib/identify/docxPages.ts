/**
 * Turn a Word document into the ordered page list the schedule extractor reads.
 *
 * Two shapes of schedule .docx exist in the wild, and the difference decides
 * everything about how it should be read:
 *
 *   1. SCREENSHOTS. The estimator pastes the schedule sheets out of the drawing
 *      set as images, with a caption above each ("FIXTURE SCHEDULE – UNIT –
 *      E0.4"). This is what Jesse's Box samples are: 27 PNGs and 99 lines of
 *      index text. The images ARE the schedule, so each one becomes a page and
 *      its caption becomes the page label — which is where the section/location
 *      on every extracted row comes from.
 *
 *   2. WORD TABLES. The schedule is real document content. Then there are no
 *      page images at all, and the document text — tables rendered as
 *      pipe-delimited rows by lib/parse/docx — is chunked into text pages.
 *
 * Mixed documents get both: images as pages, with the text kept as context.
 *
 * Server-side (Buffer for base64) but pure — no network, no env — so the page
 * plan is unit-testable without an API key.
 */

import { imageCaptions, type DocxDocument } from '../parse/docx';
import { detectSupportedMedia } from './media';
import type { SchedulePage } from './schedule';

/**
 * Characters of document text per text page. Sized so an ordinary Word-table
 * schedule stays a single pass (PAGES_PER_CHUNK = 8 pages ≈ 96k characters,
 * comfortably more than any real schedule's text).
 */
export const TEXT_PAGE_CHARS = 12_000;

/**
 * Split text into pages on line boundaries, so a schedule row is never cut in
 * half by a page break.
 */
export function splitTextPages(text: string, perPage: number = TEXT_PAGE_CHARS): string[] {
    const lines = text.split('\n');
    const pages: string[] = [];
    let current = '';
    for (const line of lines) {
        if (current && current.length + line.length + 1 > perPage) {
            pages.push(current);
            current = '';
        }
        current = current ? `${current}\n${line}` : line;
    }
    if (current.trim()) pages.push(current);
    return pages;
}

export interface DocxPagePlan {
    pages: SchedulePage[];
    /** The document's own text, passed to every pass as context (image documents only). */
    context: string;
    /** How the document was read — for the log line and the route's response. */
    shape: 'images' | 'text' | 'empty';
}

/**
 * Plan the passes for one Word document.
 *
 * An image whose bytes are not a media type Claude reads (EMF/WMF vector art
 * pasted from CAD) is dropped here rather than sent as a broken block — the
 * media type comes from the BYTES, never from the name inside the zip, for the
 * same reason the upload route sniffs uploads.
 */
export function planDocxPages(doc: DocxDocument): DocxPagePlan {
    const captions = imageCaptions(doc);
    const pages: SchedulePage[] = [];
    doc.images.forEach((image, index) => {
        const media = detectSupportedMedia(image.bytes);
        if (!media || media.kind !== 'image') return;
        pages.push({
            kind: 'media',
            media,
            base64: Buffer.from(image.bytes).toString('base64'),
            label: captions[index] || undefined,
        });
    });

    if (pages.length > 0) {
        return { pages, context: doc.text, shape: 'images' };
    }

    const text = doc.text.trim();
    if (!text) return { pages: [], context: '', shape: 'empty' };
    return {
        // The text IS the schedule here, so it must not also arrive as
        // "context, not line items" — that instruction would suppress every row.
        pages: splitTextPages(text).map(page => ({ kind: 'text' as const, text: page })),
        context: '',
        shape: 'text',
    };
}
