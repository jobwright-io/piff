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
    /** Compute full pixel evidence or semantic text evidence only. Defaults to `full`. */
    render?: 'full' | 'none';
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
export interface PiffSessionOptions {
    maxPreviewCacheBytes?: number;
}
export interface PiffCacheDiagnostics {
    maxPreviewCacheBytes: number;
    previewCacheBytes: number;
    previewCacheEntries: number;
    previewCacheHits: number;
    previewCacheMisses: number;
    previewCacheEvictions: number;
}
export interface PdfPagePreviewOptions {
    format?: 'png';
    view?: PdfPagePreviewView;
    signal?: AbortSignal;
}
export type PdfPagePreviewView = 'before' | 'after' | 'diff';
/** Native preview bytes and the time spent encoding them as PNG. */
export interface PdfPagePreviewTiming {
    bytes: Uint8Array;
    encodeMs: number;
}
export interface PdfDocumentSummary {
    pageCount: number;
}
/** Engine metadata carried by every completed comparison. */
export interface PdfEngineInfo {
    name: string;
    version: string;
    renderer: string;
    binding: string;
    /** FPDF API headers used by the compiled pdfium-render binding. */
    pdfiumApi: string;
    /** Exact artifact version read from the loaded PDFium VERSION file, when available. */
    pdfiumVersion?: string;
}
export interface PiffBounds {
    x: number;
    y: number;
    width: number;
    height: number;
    /** False when `render: 'none'` was used and only semantic evidence was computed. */
    visualComputed: boolean;
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
export type PdfReviewSide = 'before' | 'after' | 'both';
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
    /** Added anchors belong to `after`, removed anchors to `before`, and replacements to `both`. */
    side: PdfReviewSide;
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
    loadMs: number;
    fingerprintMs: number;
    matchingMs: number;
    renderMs: number;
    compareMs: number;
    regionMs: number;
    semanticMs: number;
    totalMs: number;
}
export interface PiffResult {
    schemaVersion: number;
    engine: PdfEngineInfo;
    equal: boolean;
    /** Render policy used to produce this result. */
    renderMode: 'full' | 'none';
    before: PdfDocumentSummary;
    after: PdfDocumentSummary;
    pages: PdfPageDiff[];
    textDiff?: PdfDocumentTextDiff;
    stats: PiffStats;
}
