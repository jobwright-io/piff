import { asBuffer, createAbortError, loadNativeBinding, runWithNativeCancellation, toNativeProgress, toNativeOptions, } from './native.js';
/** A reusable comparison session with lazy page preview rendering. */
export class PdfDiffSession {
    before;
    after;
    options;
    closed = false;
    comparison;
    equality;
    constructor(before, after, options) {
        this.before = before;
        this.after = after;
        this.options = options;
    }
    static async open(before, after, options) {
        return new PdfDiffSession(before, after, options);
    }
    async compare(runOptions) {
        this.ensureOpen();
        if (this.comparison === undefined) {
            throwIfAborted(runOptions?.signal);
            let comparison;
            comparison = compareNative(this.before, this.after, this.options, runOptions).catch((error) => {
                if (this.comparison === comparison) {
                    this.comparison = undefined;
                }
                throw error;
            });
            this.comparison = comparison;
        }
        return this.comparison;
    }
    async isEqual(runOptions) {
        this.ensureOpen();
        if (this.comparison !== undefined) {
            return (await this.comparison).equal;
        }
        if (this.equality === undefined) {
            throwIfAborted(runOptions?.signal);
            let equality;
            equality = runWithNativeCancellation(runOptions?.signal, (cancellationToken) => loadNativeBinding().isEqualPdf(asBuffer(this.before), asBuffer(this.after), toNativeOptions(this.options), toNativeProgress(runOptions), runOptions?.signal, cancellationToken)).catch((error) => {
                if (this.equality === equality) {
                    this.equality = undefined;
                }
                throw error;
            });
            this.equality = equality;
        }
        return this.equality;
    }
    /** Render one zero-based page diff as PNG without materializing previews for other pages. */
    async renderPageDiff(pageIndex, options) {
        this.ensureOpen();
        throwIfAborted(options?.signal);
        if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
            throw new RangeError('pageIndex must be a non-negative safe integer');
        }
        if (options?.format !== undefined && options.format !== 'png') {
            throw new Error(`Unsupported page preview format: ${options.format}`);
        }
        if (options?.view !== undefined &&
            !['before', 'after', 'diff'].includes(options.view)) {
            throw new Error(`Unsupported page preview view: ${options.view}`);
        }
        return runWithNativeCancellation(options?.signal, (cancellationToken) => loadNativeBinding().renderPageDiff(asBuffer(this.before), asBuffer(this.after), pageIndex, toNativeOptions(this.options), options?.view, options?.signal, cancellationToken));
    }
    async close() {
        this.closed = true;
        this.comparison = undefined;
        this.equality = undefined;
        this.before = new Uint8Array(0);
        this.after = new Uint8Array(0);
    }
    ensureOpen() {
        if (this.closed) {
            throw new Error('PdfDiffSession is closed');
        }
    }
}
/** Compare two PDF byte buffers through the asynchronous Rust/PDFium binding. */
export async function diffPdf(before, after, options, runOptions) {
    const session = await PdfDiffSession.open(before, after, options);
    try {
        return await session.compare(runOptions);
    }
    finally {
        await session.close();
    }
}
async function compareNative(before, after, options, runOptions) {
    const raw = await runWithNativeCancellation(runOptions?.signal, (cancellationToken) => loadNativeBinding().diffPdf(asBuffer(before), asBuffer(after), toNativeOptions(options), toNativeProgress(runOptions), runOptions?.signal, cancellationToken));
    return mapResult(JSON.parse(raw));
}
function mapResult(raw) {
    return {
        equal: raw.equal,
        before: { pageCount: raw.before_page_count },
        after: { pageCount: raw.after_page_count },
        pages: raw.pages.map((page) => ({
            beforePage: page.before_page ?? undefined,
            afterPage: page.after_page ?? undefined,
            status: page.status,
            width: page.width,
            height: page.height,
            changedPixels: page.changed_pixels,
            changedRatio: page.changed_ratio,
            alignment: {
                offsetX: page.alignment.offset_x,
                offsetY: page.alignment.offset_y,
                confidence: page.alignment.confidence,
            },
            regions: page.regions.map(mapRegion),
            semantic: page.semantic == null ? undefined : mapSemantic(page.semantic),
        })),
        stats: {
            renderMs: raw.stats.render_ms,
            compareMs: raw.stats.compare_ms,
            totalMs: raw.stats.total_ms,
        },
    };
}
function mapSemantic(semantic) {
    return {
        equal: semantic.equal,
        beforeCharCount: semantic.before_char_count,
        afterCharCount: semantic.after_char_count,
        changes: semantic.changes.map((change) => ({
            id: change.id,
            kind: change.kind,
            beforeText: change.before_text ?? undefined,
            afterText: change.after_text ?? undefined,
            beforeBounds: change.before_bounds ?? undefined,
            afterBounds: change.after_bounds ?? undefined,
        })),
    };
}
function mapRegion(region) {
    return {
        id: region.id,
        bounds: region.bounds,
        changedPixels: region.changed_pixels,
    };
}
function throwIfAborted(signal) {
    if (signal?.aborted !== true) {
        return;
    }
    throw createAbortError();
}
