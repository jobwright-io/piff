import type { PiffCacheDiagnostics, PiffOptions, PiffRunOptions, PiffSessionOptions, PdfPagePreviewOptions, PiffResult } from './types.js';
/** A reusable comparison session with lazy page preview rendering. */
export declare class PiffSession {
    private before;
    private after;
    private readonly options?;
    private closed;
    private comparison;
    private equality;
    private constructor();
    static open(before: Uint8Array, after: Uint8Array, options?: PiffOptions, sessionOptions?: PiffSessionOptions): Promise<PiffSession>;
    compare(runOptions?: PiffRunOptions): Promise<PiffResult>;
    isEqual(runOptions?: PiffRunOptions): Promise<boolean>;
    /** Render one zero-based page diff as PNG without materializing previews for other pages. */
    renderPageDiff(pageIndex: number, options?: PdfPagePreviewOptions): Promise<Uint8Array>;
    cacheDiagnostics(): PiffCacheDiagnostics;
    close(): Promise<void>;
    private ensureOpen;
}
/** Compare two PDF byte buffers through the asynchronous Rust/PDFium binding. */
export declare function piff(before: Uint8Array, after: Uint8Array, options?: PiffOptions, runOptions?: PiffRunOptions): Promise<PiffResult>;
export type { PiffBounds, PiffCacheDiagnostics, PiffOptions, PiffProgress, PiffProgressPhase, PiffRunOptions, PiffSessionOptions, PdfPagePreviewOptions, PdfPagePreviewView, PiffRegion, PiffResult, PiffStats, PdfDocumentSummary, PdfDocumentTextDiff, PdfDocumentTextDiffPage, PdfDocumentReviewItem, PdfPageAlignment, PdfPageDiff, PdfPageStatus, PdfReadingOrder, PdfResourceLimits, PdfSemanticBounds, PdfSemanticChangeKind, PdfSemanticPageDiff, PdfSemanticTextBlockKind, PdfSemanticTextBlockRole, PdfSemanticTextBlockDiff, PdfSemanticTextChange, PdfTextDiff, PdfTextDiffHunk, PdfTextDiffLine, PdfTextDiffLineKind, PdfTextDiffSpan, PdfTextDiffSpanKind, } from './types.js';
