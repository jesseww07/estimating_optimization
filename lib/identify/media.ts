/**
 * What the Claude-read intake accepts, and how to hand it to the API.
 *
 * Fixture schedules and cut sheets arrive as PDFs, but just as often as a phone
 * photo or a screenshot (live use, 2026-08-31 — those uploads came back 415 and
 * were simply lost). Claude reads images natively through the same vision path
 * as a PDF, with one difference that matters: a PDF goes in a `document` content
 * block, an image goes in an `image` block, and the `media_type` has to be the
 * file's REAL type — a JPEG announced as `image/png` is a 400.
 *
 * So the type is sniffed from the leading bytes rather than taken from the
 * filename or the browser-supplied MIME; both are routinely wrong (a screenshot
 * saved as `schedule.pdf`, a `.jpg` that is really a PNG, an empty `file.type`
 * on a drag-and-drop).
 *
 * Pure module: no SDK runtime import, no env — safe to import from routes.
 */

import type Anthropic from '@anthropic-ai/sdk';

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export type SupportedMediaType = 'application/pdf' | ImageMediaType;

/** A file the Claude paths can read, with the media type taken from its bytes. */
export type SupportedMedia =
    | { kind: 'pdf'; mediaType: 'application/pdf'; label: string }
    | { kind: 'image'; mediaType: ImageMediaType; label: string };

export const PDF_MEDIA: SupportedMedia = { kind: 'pdf', mediaType: 'application/pdf', label: 'PDF' };

/**
 * Spelled out for user-facing errors: an estimator who hits a 415 should learn
 * the fix from the message, not from the source.
 */
export const ACCEPTED_MEDIA_LABEL = 'PDF, PNG, JPEG, WebP, or GIF';

function matches(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
    if (bytes.length < offset + signature.length) return false;
    for (let i = 0; i < signature.length; i++) {
        if (bytes[offset + i] !== signature[i]) return false;
    }
    return true;
}

/** Signatures are written as literals for readability. */
function ascii(text: string): number[] {
    return [...text].map(c => c.charCodeAt(0));
}

/**
 * Identify an upload from its magic bytes. Returns null for anything Claude
 * cannot read as a document (a CSV, an XLSX, a Word file, junk).
 */
export function detectSupportedMedia(bytes: Uint8Array): SupportedMedia | null {
    if (matches(bytes, 0, ascii('%PDF-'))) return PDF_MEDIA;
    if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return { kind: 'image', mediaType: 'image/png', label: 'PNG image' };
    }
    if (matches(bytes, 0, [0xff, 0xd8, 0xff])) {
        return { kind: 'image', mediaType: 'image/jpeg', label: 'JPEG image' };
    }
    if (matches(bytes, 0, ascii('GIF87a')) || matches(bytes, 0, ascii('GIF89a'))) {
        return { kind: 'image', mediaType: 'image/gif', label: 'GIF image' };
    }
    // WebP is a RIFF container: "RIFF" <4-byte size> "WEBP".
    if (matches(bytes, 0, ascii('RIFF')) && matches(bytes, 8, ascii('WEBP'))) {
        return { kind: 'image', mediaType: 'image/webp', label: 'WebP image' };
    }
    return null;
}

/**
 * The content block for an upload: `document` for a PDF, `image` for an image.
 * Not a soft distinction — the API rejects a base64 image sent as a document
 * source, and vice versa.
 */
export function mediaContentBlock(media: SupportedMedia, base64: string): Anthropic.Messages.ContentBlockParam {
    if (media.kind === 'pdf') {
        return {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        };
    }
    return {
        type: 'image',
        source: { type: 'base64', media_type: media.mediaType, data: base64 },
    };
}
