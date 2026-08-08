export type PdfPageStatus = 'equal' | 'modified' | 'inserted' | 'deleted' | 'moved';
export interface PdfResourceLimits {
    /** Maximum bytes accepted for each input PDF. */
    maxInputBytes?: number;
    /** Maximum pages accepted in either input PDF. */
    maxPages?: number;
    /** Maximum raster pixels allowed for one rendered page. */
    maxPagePixels?: number;
}
/** Reading-order policy for positioned semantic text. */
export type PdfReadingOrder = 'auto' | 'rows' | 'columns';
export interface PiffOptions {
    dpi?: number;
    pageMatching?: 'index' | 'sequence';
    mode?: 'visual' | 'semantic';
    /** Use conservative detection, row-major order, or column-major order. Defaults to `auto`. */
    readingOrder?: PdfReadingOrder;
    /** Unchanged text lines kept around each changed block. Defaults to 3. */
    contextLines?: number;
    /** Shared password used to open encrypted before and after PDFs. */
    password?: string;
    /** Password for the before PDF; falls back to `password` when omitted. */
    beforePassword?: string;
    /** Password for the after PDF; falls back to `password` when omitted. */
    afterPassword?: string;
    limits?: PdfResourceLimits;
    channelTolerance?: number;
    changedPixelRatio?: number;
    maxShiftPx?: number;
    alignmentSampleStep?: number;
    minRegionArea?: number;
}
export type PiffProgressPhase = 'loading' | 'fingerprinting' | 'rendering' | 'comparing';
export interface PiffProgress {
    phase: PiffProgressPhase;
    completed: number;
    total: number;
}
export interface PiffRunOptions {
    signal?: AbortSignal;
    onProgress?: (event: PiffProgress) => void;
}
export interface PdfPagePreviewOptions {
    format?: 'png';
    view?: PdfPagePreviewView;
    signal?: AbortSignal;
}
export type PdfPagePreviewView = 'before' | 'after' | 'diff';
export interface PdfDocumentSummary {
    pageCount: number;
}
export interface PiffBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface PiffRegion {
    id: string;
    bounds: PiffBounds;
    changedPixels: number;
}
export interface PdfPageAlignment {
    offsetX: number;
    offsetY: number;
    confidence: number;
}
export interface PdfPageDiff {
    beforePage?: number;
    afterPage?: number;
    status: PdfPageStatus;
    width: number;
    height: number;
    changedPixels: number;
    changedRatio: number;
    alignment: PdfPageAlignment;
    regions: PiffRegion[];
    semantic?: PdfSemanticPageDiff;
}
export type PdfSemanticChangeKind = 'added' | 'removed' | 'modified' | 'moved' | 'reflowed';
export interface PdfSemanticBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface PdfSemanticTextChange {
    id: string;
    kind: PdfSemanticChangeKind;
    beforeText?: string;
    afterText?: string;
    beforeBounds?: PdfSemanticBounds;
    afterBounds?: PdfSemanticBounds;
    /** The focused changed-word bounds when character-level extraction is available. */
    beforeFocusBounds?: PdfSemanticBounds;
    afterFocusBounds?: PdfSemanticBounds;
}
export type PdfSemanticTextBlockKind = 'paragraph' | 'list-item' | 'table-row';
export type PdfSemanticTextBlockRole = 'body' | 'header' | 'footer';
export interface PdfSemanticPageDiff {
    equal: boolean;
    beforeCharCount: number;
    afterCharCount: number;
    changes: PdfSemanticTextChange[];
    /** Grouped review changes with side-aware anchors and block-scoped inline hunks. */
    blocks: PdfSemanticTextBlockDiff[];
    textDiff?: PdfTextDiff;
}
export type PdfTextDiffLineKind = 'context' | 'added' | 'removed';
export type PdfTextDiffSpanKind = 'equal' | 'added' | 'removed';
export interface PdfTextDiffSpan {
    kind: PdfTextDiffSpanKind;
    text: string;
}
export interface PdfTextDiffLine {
    kind: PdfTextDiffLineKind;
    beforeLine?: number;
    afterLine?: number;
    text: string;
    spans: PdfTextDiffSpan[];
}
export interface PdfTextDiffHunk {
    beforeStart: number;
    afterStart: number;
    lines: PdfTextDiffLine[];
}
export interface PdfTextDiff {
    changedLines: number;
    truncated: boolean;
    hunks: PdfTextDiffHunk[];
}
/** Canonical review unit for semantic text comparison. */
export interface PdfSemanticTextBlockDiff extends PdfSemanticTextChange {
    structure: PdfSemanticTextBlockKind;
    confidence: number;
    beforeRole?: PdfSemanticTextBlockRole;
    afterRole?: PdfSemanticTextBlockRole;
    textDiff: PdfTextDiff;
}
export interface PdfDocumentReviewItem extends Omit<PdfSemanticTextBlockDiff, 'id'> {
    id: string;
    pageIndex: number;
    beforePage?: number;
    afterPage?: number;
    pageStatus: PdfPageStatus;
    blockId: string;
}
export interface PdfDocumentTextDiffPage {
    beforePage?: number;
    afterPage?: number;
    status: PdfPageStatus;
    blocks: PdfSemanticTextBlockDiff[];
    textDiff?: PdfTextDiff;
}
export interface PdfDocumentTextDiff {
    changedLines: number;
    truncated: boolean;
    pages: PdfDocumentTextDiffPage[];
    stream: PdfDocumentReviewItem[];
}
export interface PiffStats {
    renderMs: number;
    compareMs: number;
    totalMs: number;
}
export interface PiffResult {
    equal: boolean;
    before: PdfDocumentSummary;
    after: PdfDocumentSummary;
    pages: PdfPageDiff[];
    textDiff?: PdfDocumentTextDiff;
    stats: PiffStats;
}
