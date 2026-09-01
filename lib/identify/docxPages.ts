/**
 * Turn a Word document into the ordered page list the schedule extractor reads.
 *
 * Two shapes of schedule .docx exist in the wild:
 *
 *   1. SCREENSHOTS. The estimator pastes the schedule sheets out of the drawing
 *      set as images, with a caption above each ("FIXTURE SCHEDULE – UNIT –
 *      E0.4"). This is what Jesse's Box samples are: 27 PNGs and 99 lines of
 *      index text. The images ARE the schedule, so each becomes a page and its
 *      caption becomes the page label — which is where the section/location on
 *      every extracted row comes from.
 *
 *   2. WORD TABLES. The schedule is real document content, so the table rows —
 *      rendered pipe-delimited by lib/parse/docx — become text pages.
 *
 * These are NOT alternatives, and treating them as one was a bug worth naming:
 * picking the image path whenever ANY image survived meant a Word-TABLE schedule
 * with an ordinary letterhead logo sent the logo as its only page and passed the
 * real table down as "context, not line items" — which suppresses every row in
 * it. So both kinds of page are collected, in document order, and only genuine
 * PROSE (captions, index text, general notes) becomes context.
 *
 * Server-side (Buffer for base64) but pure — no network, no env — so the page
 * plan is unit-testable without an API key.
 */

import { detectSupportedMedia } from './media';
import type { DocxDocument } from '../parse/docx';
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
    /** Prose only (captions, index text, notes) — sent to every pass as context. */
    context: string;
    /** How the document was read — for the log line and the route's response. */
    shape: 'images' | 'text' | 'mixed' | 'empty';
}

function shapeOf(images: number, texts: number, prose: string): DocxPagePlan['shape'] {
    if (images > 0 && texts > 0) return 'mixed';
    if (images > 0) return 'images';
    if (texts > 0) return 'text';
    return prose.trim() ? 'text' : 'empty';
}

/**
 * Plan the passes for one Word document, walking its blocks in order.
 *
 * An image whose bytes are not a media type Claude reads (EMF/WMF vector art
 * pasted from CAD) is dropped here rather than sent as a broken block — the
 * media type comes from the BYTES, never from the name inside the zip, for the
 * same reason the upload route sniffs uploads.
 */
export function planDocxPages(doc: DocxDocument): DocxPagePlan {
    const pages: SchedulePage[] = [];
    const prose: string[] = [];
    let imageCount = 0;
    let textCount = 0;
    // The prose line most recently seen, which is what labels the next page.
    let caption = '';

    for (const block of doc.blocks) {
        if (block.kind === 'text') {
            if (block.fromTable) {
                // Table rows are schedule content: pages, never context.
                for (const page of splitTextPages(block.text)) {
                    pages.push({ kind: 'text', text: page, label: caption || undefined });
                    textCount++;
                }
                caption = '';
            } else {
                prose.push(block.text);
                caption = block.text.split('\n').filter(Boolean).pop() ?? '';
            }
            continue;
        }
        const media = detectSupportedMedia(block.image.bytes);
        if (!media || media.kind !== 'image') {
            caption = '';
            continue;
        }
        pages.push({
            kind: 'media',
            media,
            base64: Buffer.from(block.image.bytes).toString('base64'),
            label: caption || undefined,
        });
        imageCount++;
        caption = '';
    }

    const context = prose.join('\n').trim();
    const shape = shapeOf(imageCount, textCount, context);
    if (shape === 'empty') return { pages: [], context: '', shape: 'empty' };

    // No pages at all but prose exists: the schedule is written as paragraphs
    // rather than a table, so the prose IS the content and must not also arrive
    // as "context, not line items" — that instruction would suppress every row.
    if (pages.length === 0) {
        return {
            pages: splitTextPages(context).map(text => ({ kind: 'text' as const, text })),
            context: '',
            shape: 'text',
        };
    }
    return { pages, context, shape };
}
