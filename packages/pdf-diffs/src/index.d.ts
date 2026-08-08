import type { PdfDiffOptions, PdfDiffRunOptions, PdfPagePreviewOptions, PdfDiffResult } from './types.js';
/** A reusable comparison session with lazy page preview rendering. */
export declare class PdfDiffSession {
    private before;
    private after;
    private readonly options?;
    private closed;
    private comparison;
    private equality;
    private constructor();
    static open(before: Uint8Array, after: Uint8Array, options?: PdfDiffOptions): Promise<PdfDiffSession>;
    compare(runOptions?: PdfDiffRunOptions): Promise<PdfDiffResult>;
    isEqual(runOptions?: PdfDiffRunOptions): Promise<boolean>;
    /** Render one zero-based page diff as PNG without materializing previews for other pages. */
    renderPageDiff(pageIndex: number, options?: PdfPagePreviewOptions): Promise<Uint8Array>;
    close(): Promise<void>;
    private ensureOpen;
}
/** Compare two PDF byte buffers through the asynchronous Rust/PDFium binding. */
export declare function diffPdf(before: Uint8Array, after: Uint8Array, options?: PdfDiffOptions, runOptions?: PdfDiffRunOptions): Promise<PdfDiffResult>;
export type { PdfDiffBounds, PdfDiffOptions, PdfDiffProgress, PdfDiffProgressPhase, PdfDiffRunOptions, PdfPagePreviewOptions, PdfPagePreviewView, PdfDiffRegion, PdfDiffResult, PdfDiffStats, PdfDocumentSummary, PdfDocumentTextDiff, PdfDocumentTextDiffPage, PdfDocumentReviewItem, PdfPageAlignment, PdfPageDiff, PdfPageStatus, PdfReadingOrder, PdfResourceLimits, PdfSemanticBounds, PdfSemanticChangeKind, PdfSemanticPageDiff, PdfSemanticTextBlockKind, PdfSemanticTextBlockRole, PdfSemanticTextBlockDiff, PdfSemanticTextChange, PdfTextDiff, PdfTextDiffHunk, PdfTextDiffLine, PdfTextDiffLineKind, PdfTextDiffSpan, PdfTextDiffSpanKind, } from './types.js';
