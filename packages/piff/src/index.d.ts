import type { PiffCacheDiagnostics, PiffDocumentInput, PiffDocumentSetOptions, PiffDocumentSetResult, PiffDocumentSetRunOptions, PiffOptions, PiffRunOptions, PiffSessionOptions, PdfPagePreviewOptions, PdfPagePreviewTiming, PiffResult } from './types.js';
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
    /** Render one page diff and return native PNG encoding time without using the preview cache. */
    renderPageDiffWithTiming(pageIndex: number, options?: PdfPagePreviewOptions): Promise<PdfPagePreviewTiming>;
    cacheDiagnostics(): PiffCacheDiagnostics;
    close(): Promise<void>;
    private ensureOpen;
}
/** Compare two PDF byte buffers through the asynchronous Rust/PDFium binding. */
export declare function piff(before: Uint8Array, after: Uint8Array, options?: PiffOptions, runOptions?: PiffRunOptions): Promise<PiffResult>;
/** Compares an ordered set of PDF revisions through revision-neutral change operations. */
export declare class PiffDocumentSet {
    private constructor();
    static open(documents: readonly PiffDocumentInput[], options?: PiffDocumentSetOptions, sessionOptions?: PiffSessionOptions): Promise<PiffDocumentSet>;
    compare(runOptions?: PiffDocumentSetRunOptions): Promise<PiffDocumentSetResult>;
    renderPageDiff(fromRevisionId: string, toRevisionId: string, pageIndex: number, options?: PdfPagePreviewOptions): Promise<Uint8Array>;
    close(): Promise<void>;
}
/** Compare multiple PDFs and return revision-neutral changes. */
export declare function piffSet(documents: readonly PiffDocumentInput[], options?: PiffDocumentSetOptions, runOptions?: PiffDocumentSetRunOptions): Promise<PiffDocumentSetResult>;
export type { PiffBounds, PiffCacheDiagnostics, PiffDocumentInput, PiffDocumentSetOptions, PiffDocumentSetProgress, PiffDocumentSetResult, PiffDocumentSetRunOptions, PiffDocumentSetStats, PiffOptions, PiffProgress, PiffProgressPhase, PiffRunOptions, PiffSessionOptions, PdfPagePreviewOptions, PdfPagePreviewView, PdfPagePreviewTiming, PiffRegion, PiffResult, PdfEngineInfo, PiffStats, PdfDocumentChangeKind, PdfDocumentRevision, PdfDocumentSetComparison, PdfDocumentSetStrategy, PdfDocumentSummary, PdfDocumentTextDiff, PdfDocumentTextDiffPage, PdfDocumentReviewItem, PdfPageAlignment, PdfPageDiff, PdfPageStatus, PdfReadingOrder, PdfResourceLimits, PdfRevisionAnchor, PdfRevisionChangeState, PdfRevisionComparisonDetail, PdfRevisionVariant, PdfChangeOperation, PdfChangeSource, PdfVisualChangeEvidence, PdfSemanticBounds, PdfSemanticChangeKind, PdfReviewSide, PdfSemanticPageDiff, PdfSemanticTextBlockKind, PdfSemanticTextBlockRole, PdfSemanticTextBlockDiff, PdfSemanticTextChange, PdfTextDiff, PdfTextDiffHunk, PdfTextDiffLine, PdfTextDiffLineKind, PdfTextDiffSpan, PdfTextDiffSpanKind, } from './types.js';
