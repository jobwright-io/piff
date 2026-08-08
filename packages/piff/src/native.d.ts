import { Buffer } from 'node:buffer';
import type { PiffOptions, PiffRunOptions, PdfPagePreviewView } from './types.js';
type NativeProgressCallback = (payload: [string, number, number]) => void;
interface NativeDiffOptions {
    dpi?: number;
    pageMatching?: 'index' | 'sequence';
    mode?: 'visual' | 'semantic';
    readingOrder?: 'auto' | 'rows' | 'columns';
    contextLines?: number;
    password?: string;
    limits?: {
        maxInputBytes?: number;
        maxPages?: number;
        maxPagePixels?: number;
    };
    channelTolerance?: number;
    changedPixelRatio?: number;
    maxShiftPx?: number;
    alignmentSampleStep?: number;
    minRegionArea?: number;
}
interface NativeBinding {
    piff(before: Buffer, after: Buffer, options?: NativeDiffOptions, progress?: NativeProgressCallback, signal?: AbortSignal, cancellationToken?: number): Promise<string>;
    isEqual(before: Buffer, after: Buffer, options?: NativeDiffOptions, progress?: NativeProgressCallback, signal?: AbortSignal, cancellationToken?: number): Promise<boolean>;
    renderPageDiff(before: Buffer, after: Buffer, pageIndex: number, options?: NativeDiffOptions, view?: PdfPagePreviewView, signal?: AbortSignal, cancellationToken?: number): Promise<Buffer>;
    createCancellationToken(): number;
    cancelCancellationToken(token: number): void;
    releaseCancellationToken(token: number): void;
}
export declare function loadNativeBinding(): NativeBinding;
export declare function toNativeOptions(options: PiffOptions | undefined): NativeDiffOptions | undefined;
export declare function asBuffer(bytes: Uint8Array): Buffer;
export declare function toNativeProgress(options: PiffRunOptions | undefined): NativeProgressCallback | undefined;
export declare function runWithNativeCancellation<T>(signal: AbortSignal | undefined, operation: (cancellationToken?: number) => Promise<T>): Promise<T>;
export declare function createAbortError(): Error;
export {};
