import {
  asBuffer,
  createAbortError,
  loadNativeBinding,
  runWithNativeCancellation,
  toNativeProgress,
  toNativeOptions,
} from './native.js'
import type {
  PdfDiffOptions,
  PdfDiffRunOptions,
  PdfPagePreviewOptions,
  PdfPageWarning,
  PdfDiffRegion,
  PdfEngineInfo,
  PdfFigureDiff,
  PdfDiffResult,
  PdfSemanticPageDiff,
  PdfSemanticTextBlockKind,
  PdfSemanticTextBlockRole,
  PdfSemanticTextBlockDiff,
  PdfSemanticTextChange,
  PdfTextExtractionQuality,
  PdfTextExtractionStatus,
  PdfTextExtractionSummary,
  PdfTextDiff,
  PdfDocumentTextDiff,
  PdfDocumentReviewItem,
} from './types.js'

export type PdfDiffErrorCode =
  | 'cancelled'
  | 'invalid-options'
  | 'input-too-large'
  | 'input-metadata'
  | 'password-required'
  | 'pdf-security'
  | 'page-limit-exceeded'
  | 'page-pixels-exceeded'
  | 'page-dimensions-too-large'
  | 'pdfium-binding'
  | 'pdfium'
  | 'image-conversion'
  | 'page-index-out-of-bounds'
  | 'preview-encoding'
  | 'invalid-preview-view'
  | 'text-extraction'
  | 'comparison'
  | 'native-module'
  | 'unknown'

/** Stable SDK error with a machine-readable code and the original native cause. */
export class PdfDiffError extends Error {
  readonly code: PdfDiffErrorCode
  readonly cause: unknown

  constructor(code: PdfDiffErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'PdfDiffError'
    this.code = code
    this.cause = cause
  }
}

type RawTextExtractionSummary = {
  status: PdfTextExtractionStatus
  run_count: number
  char_count: number
  replacement_char_count: number
  error?: string | null
}

type RawTextDiff = {
  changed_lines: number
  truncated?: boolean | null
  hunks: Array<{
    before_start: number
    after_start: number
    lines: Array<{
      kind: 'context' | 'added' | 'removed'
      before_line?: number | null
      after_line?: number | null
      text: string
      spans: Array<{
        kind: 'equal' | 'added' | 'removed'
        text: string
      }>
    }>
  }>
}

type RawSemanticBounds = {
  x: number
  y: number
  width: number
  height: number
}

type RawTextBlockDiff = {
  id: string
  kind: PdfSemanticTextChange['kind']
  structure: PdfSemanticTextBlockKind
  confidence: number
  before_role?: PdfSemanticTextBlockRole | null
  after_role?: PdfSemanticTextBlockRole | null
  before_text?: string | null
  after_text?: string | null
  before_bounds?: RawSemanticBounds | null
  after_bounds?: RawSemanticBounds | null
  before_focus_bounds?: RawSemanticBounds | null
  after_focus_bounds?: RawSemanticBounds | null
  text_diff: RawTextDiff
}

type RawDocumentReviewItem = Omit<RawTextBlockDiff, 'id'> & {
  id: string
  page_index: number
  before_page?: number | null
  after_page?: number | null
  page_status: PdfDiffResult['pages'][number]['status']
  block_id: string
}

type RawDocumentTextDiff = {
  changed_lines: number
  truncated?: boolean | null
  stream?: RawDocumentReviewItem[] | null
  pages: Array<{
    before_page?: number | null
    after_page?: number | null
    status: PdfDiffResult['pages'][number]['status']
    blocks?: RawTextBlockDiff[] | null
    text_diff?: RawTextDiff | null
  }>
}

interface NativeResult {
  schema_version: number
  engine: PdfEngineInfo
  equal: boolean
  before_page_count: number
  after_page_count: number
  text_diff?: RawDocumentTextDiff | null
  pages: Array<{
    before_page?: number | null
    after_page?: number | null
    status: PdfDiffResult['pages'][number]['status']
    before_size?: {
      width: number
      height: number
    } | null
    after_size?: {
      width: number
      height: number
    } | null
    width: number
    height: number
    changed_pixels: number
    changed_ratio: number
    alignment: {
      offset_x: number
      offset_y: number
      confidence: number
    }
    warnings?: PdfPageWarning[] | null
    regions: Array<{
      id: string
      bounds: {
        x: number
        y: number
        width: number
        height: number
      }
      changed_pixels: number
      before_content_pixels?: number
      after_content_pixels?: number
    }>
    figures?: Array<{
      id: string
      status: PdfFigureDiff['status']
      before_bounds?: {
        x: number
        y: number
        width: number
        height: number
      } | null
      after_bounds?: {
        x: number
        y: number
        width: number
        height: number
      } | null
      confidence: number
    }>
    semantic?: {
      equal: boolean
      before_char_count: number
      after_char_count: number
      changes_truncated?: boolean | null
      quality?: PdfTextExtractionQuality | null
      before_extraction?: RawTextExtractionSummary | null
      after_extraction?: RawTextExtractionSummary | null
      blocks?: RawTextBlockDiff[] | null
      changes: Array<{
        id: string
        kind: PdfSemanticTextChange['kind']
        before_text?: string | null
        after_text?: string | null
        before_bounds?: {
          x: number
          y: number
          width: number
          height: number
        } | null
        after_bounds?: {
          x: number
          y: number
          width: number
          height: number
        } | null
        before_focus_bounds?: {
          x: number
          y: number
          width: number
          height: number
        } | null
        after_focus_bounds?: {
          x: number
          y: number
          width: number
          height: number
        } | null
      }>
      text_diff?: RawTextDiff | null
    } | null
  }>
  stats: {
    render_ms: number
    compare_ms: number
    total_ms: number
  }
}

/** A reusable comparison session with lazy page preview rendering. */
export class PdfDiffSession {
  private closed = false
  private comparison: Promise<PdfDiffResult> | undefined
  private equality: Promise<boolean> | undefined
  private readonly previews = new Map<string, Promise<Uint8Array>>()

  private constructor(
    private before: Uint8Array,
    private after: Uint8Array,
    private readonly options?: PdfDiffOptions,
  ) {}

  static async open(
    before: Uint8Array,
    after: Uint8Array,
    options?: PdfDiffOptions,
  ): Promise<PdfDiffSession> {
    return new PdfDiffSession(before, after, options)
  }

  async compare(runOptions?: PdfDiffRunOptions): Promise<PdfDiffResult> {
    this.ensureOpen()
    throwIfAborted(runOptions?.signal)
    if (this.comparison === undefined) {
      let comparison: Promise<PdfDiffResult>
      comparison = compareNative(this.before, this.after, this.options, runOptions).catch(
        (error: unknown) => {
          if (this.comparison === comparison) {
            this.comparison = undefined
          }
          throw toPdfDiffError(error)
        },
      )
      this.comparison = comparison
    }
    return this.comparison
  }

  async isEqual(runOptions?: PdfDiffRunOptions): Promise<boolean> {
    this.ensureOpen()
    throwIfAborted(runOptions?.signal)
    if (this.comparison !== undefined) {
      return (await this.comparison).equal
    }
    if (this.equality === undefined) {
      let equality: Promise<boolean>
      equality = runWithNativeCancellation(runOptions?.signal, (cancellationToken) =>
        loadNativeBinding().isEqualPdf(
          asBuffer(this.before),
          asBuffer(this.after),
          toNativeOptions(this.options),
          toNativeProgress(runOptions),
          runOptions?.signal,
          cancellationToken,
        ),
      ).catch((error: unknown) => {
        if (this.equality === equality) {
          this.equality = undefined
        }
        throw toPdfDiffError(error)
      })
      this.equality = equality
    }
    return this.equality
  }

  /** Render one zero-based page diff as PNG without materializing previews for other pages. */
  async renderPageDiff(
    pageIndex: number,
    options?: PdfPagePreviewOptions,
  ): Promise<Uint8Array> {
    this.ensureOpen()
    throwIfAborted(options?.signal)
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
      throw new PdfDiffError('page-index-out-of-bounds', 'pageIndex must be a non-negative safe integer')
    }
    if (options?.format !== undefined && options.format !== 'png') {
      throw new PdfDiffError('invalid-preview-view', `Unsupported page preview format: ${options.format}`)
    }
    if (
      options?.view !== undefined &&
      !['before', 'after', 'diff'].includes(options.view)
    ) {
      throw new PdfDiffError('invalid-preview-view', `Unsupported page preview view: ${options.view}`)
    }
    const render = () => runWithNativeCancellation(options?.signal, (cancellationToken) =>
      loadNativeBinding().renderPageDiff(
        asBuffer(this.before),
        asBuffer(this.after),
        pageIndex,
        toNativeOptions(this.options),
        options?.view,
        options?.signal,
        cancellationToken,
      ),
    )
    if (options?.signal !== undefined) {
      return render().catch((error: unknown) => {
        throw toPdfDiffError(error)
      })
    }

    const key = `${pageIndex}:${options?.view ?? 'diff'}`
    const cached = this.previews.get(key)
    if (cached !== undefined) {
      return cached
    }
    let preview: Promise<Uint8Array>
    preview = render().catch((error: unknown) => {
      if (this.previews.get(key) === preview) {
        this.previews.delete(key)
      }
      throw toPdfDiffError(error)
    })
    this.previews.set(key, preview)
    return preview
  }

  async close(): Promise<void> {
    this.closed = true
    this.comparison = undefined
    this.equality = undefined
    this.previews.clear()
    this.before = new Uint8Array(0)
    this.after = new Uint8Array(0)
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('PdfDiffSession is closed')
    }
  }
}

/** Compare two PDF byte buffers through the asynchronous Rust/PDFium binding. */
export async function diffPdf(
  before: Uint8Array,
  after: Uint8Array,
  options?: PdfDiffOptions,
  runOptions?: PdfDiffRunOptions,
): Promise<PdfDiffResult> {
  const session = await PdfDiffSession.open(before, after, options)
  try {
    return await session.compare(runOptions)
  } finally {
    await session.close()
  }
}

async function compareNative(
  before: Uint8Array,
  after: Uint8Array,
  options?: PdfDiffOptions,
  runOptions?: PdfDiffRunOptions,
): Promise<PdfDiffResult> {
  const raw = await runWithNativeCancellation(runOptions?.signal, (cancellationToken) =>
    loadNativeBinding().diffPdf(
      asBuffer(before),
      asBuffer(after),
      toNativeOptions(options),
      toNativeProgress(runOptions),
      runOptions?.signal,
      cancellationToken,
    ),
  )
  return mapResult(JSON.parse(raw) as NativeResult)
}

function mapResult(raw: NativeResult): PdfDiffResult {
  return {
    schemaVersion: raw.schema_version,
    engine: raw.engine,
    equal: raw.equal,
    before: { pageCount: raw.before_page_count },
    after: { pageCount: raw.after_page_count },
    pages: raw.pages.map((page) => ({
      beforePage: page.before_page ?? undefined,
      afterPage: page.after_page ?? undefined,
      status: page.status,
      beforeSize: page.before_size ?? undefined,
      afterSize: page.after_size ?? undefined,
      width: page.width,
      height: page.height,
      changedPixels: page.changed_pixels,
      changedRatio: page.changed_ratio,
      alignment: {
        offsetX: page.alignment.offset_x,
        offsetY: page.alignment.offset_y,
        confidence: page.alignment.confidence,
      },
      warnings: page.warnings ?? [],
      regions: page.regions.map(mapRegion),
      figures: (page.figures ?? []).map((figure) => ({
        id: figure.id,
        status: figure.status,
        beforeBounds: figure.before_bounds ?? undefined,
        afterBounds: figure.after_bounds ?? undefined,
        confidence: figure.confidence,
      })),
      semantic: page.semantic == null ? undefined : mapSemantic(page.semantic),
    })),
    textDiff: raw.text_diff == null ? undefined : mapDocumentTextDiff(raw.text_diff),
    stats: {
      renderMs: raw.stats.render_ms,
      compareMs: raw.stats.compare_ms,
      totalMs: raw.stats.total_ms,
    },
  }
}

function mapDocumentTextDiff(raw: RawDocumentTextDiff): PdfDocumentTextDiff {
  return {
    changedLines: raw.changed_lines,
    truncated: raw.truncated ?? false,
    stream: (raw.stream ?? []).map((item) => ({
      ...mapTextBlock(item),
      id: item.id,
      pageIndex: item.page_index,
      beforePage: item.before_page ?? undefined,
      afterPage: item.after_page ?? undefined,
      pageStatus: item.page_status,
      blockId: item.block_id,
    } satisfies PdfDocumentReviewItem)),
    pages: raw.pages.map((page) => ({
      beforePage: page.before_page ?? undefined,
      afterPage: page.after_page ?? undefined,
      status: page.status,
      blocks: (page.blocks ?? []).map(mapTextBlock),
      textDiff: page.text_diff == null ? undefined : mapTextDiff(page.text_diff),
    })),
  }
}

function mapSemantic(
  semantic: NonNullable<NativeResult['pages'][number]['semantic']>,
): PdfSemanticPageDiff {
  const beforeExtraction = mapExtraction(semantic.before_extraction, semantic.before_char_count)
  const afterExtraction = mapExtraction(semantic.after_extraction, semantic.after_char_count)
  return {
    equal: semantic.equal,
    beforeCharCount: semantic.before_char_count,
    afterCharCount: semantic.after_char_count,
    changesTruncated: semantic.changes_truncated ?? false,
    quality: semantic.quality ?? inferQuality(beforeExtraction, afterExtraction),
    beforeExtraction,
    afterExtraction,
    changes: semantic.changes.map((change) => ({
      id: change.id,
      kind: change.kind,
      beforeText: change.before_text ?? undefined,
      afterText: change.after_text ?? undefined,
      beforeBounds: change.before_bounds ?? undefined,
      afterBounds: change.after_bounds ?? undefined,
      beforeFocusBounds: change.before_focus_bounds ?? undefined,
      afterFocusBounds: change.after_focus_bounds ?? undefined,
    })),
    blocks: (semantic.blocks ?? []).map(mapTextBlock),
    textDiff: semantic.text_diff == null ? undefined : mapTextDiff(semantic.text_diff),
  }
}

function mapTextBlock(raw: RawTextBlockDiff): PdfSemanticTextBlockDiff {
  return {
    id: raw.id,
    kind: raw.kind,
    structure: raw.structure,
    confidence: raw.confidence,
    beforeRole: raw.before_role ?? undefined,
    afterRole: raw.after_role ?? undefined,
    beforeText: raw.before_text ?? undefined,
    afterText: raw.after_text ?? undefined,
    beforeBounds: raw.before_bounds ?? undefined,
    afterBounds: raw.after_bounds ?? undefined,
    beforeFocusBounds: raw.before_focus_bounds ?? undefined,
    afterFocusBounds: raw.after_focus_bounds ?? undefined,
    textDiff: mapTextDiff(raw.text_diff),
  }
}

function mapTextDiff(raw: RawTextDiff): PdfTextDiff {
  return {
    changedLines: raw.changed_lines,
    truncated: raw.truncated ?? false,
    hunks: raw.hunks.map((hunk) => ({
      beforeStart: hunk.before_start,
      afterStart: hunk.after_start,
      lines: hunk.lines.map((line) => ({
        kind: line.kind,
        beforeLine: line.before_line ?? undefined,
        afterLine: line.after_line ?? undefined,
        text: line.text,
        spans: line.spans.map((span) => ({ kind: span.kind, text: span.text })),
      })),
    })),
  }
}

function mapExtraction(
  raw: RawTextExtractionSummary | null | undefined,
  fallbackCharCount: number,
): PdfTextExtractionSummary {
  return {
    status: raw?.status ?? (fallbackCharCount > 0 ? 'text' : 'empty'),
    runCount: raw?.run_count ?? 0,
    charCount: raw?.char_count ?? fallbackCharCount,
    replacementCharCount: raw?.replacement_char_count ?? 0,
    error: raw?.error ?? undefined,
  }
}

function inferQuality(
  before: PdfTextExtractionSummary,
  after: PdfTextExtractionSummary,
): PdfTextExtractionQuality {
  if (before.status === 'suspect' || after.status === 'suspect') return 'suspect'
  if (before.status === 'empty' && after.status === 'empty') return 'empty'
  if (before.status === 'empty' || after.status === 'empty') return 'partial'
  return 'text'
}

function mapRegion(region: NativeResult['pages'][number]['regions'][number]): PdfDiffRegion {
  return {
    id: region.id,
    bounds: region.bounds,
    changedPixels: region.changed_pixels,
    beforeContentPixels: region.before_content_pixels,
    afterContentPixels: region.after_content_pixels,
  }
}

function toPdfDiffError(error: unknown): PdfDiffError {
  if (error instanceof PdfDiffError) return error
  const message = error instanceof Error ? error.message : String(error)
  const nativeCode = error !== null && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  if (typeof nativeCode === 'string' && isPdfDiffErrorCode(nativeCode)) {
    return new PdfDiffError(nativeCode, message, error)
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new PdfDiffError('cancelled', message, error)
  }

  const normalized = message.toLowerCase()
  const code: PdfDiffErrorCode = normalized.includes('native module')
    ? 'native-module'
    : normalized.includes('cancel') || normalized.includes('aborted')
      ? 'cancelled'
      : normalized.includes('exceeding the') && normalized.includes('input limit')
        ? 'input-too-large'
        : normalized.includes('page limit')
          ? 'page-limit-exceeded'
          : normalized.includes('requires a password') || normalized.includes('password is incorrect')
            ? 'password-required'
            : normalized.includes('unsupported security settings')
              ? 'pdf-security'
          : normalized.includes('pixel limit')
            ? 'page-pixels-exceeded'
            : normalized.includes('could not bind to pdfium')
              ? 'pdfium-binding'
              : normalized.startsWith('pdfium error')
                ? 'pdfium'
                : normalized.includes('unsupported page preview')
                  ? 'invalid-preview-view'
                  : normalized.includes('must be greater') || normalized.includes('must be at most') || normalized.includes('must be between') || normalized.includes('must be "')
                    ? 'invalid-options'
                    : 'unknown'
  return new PdfDiffError(code, message, error)
}

function isPdfDiffErrorCode(value: string): value is PdfDiffErrorCode {
  return [
    'cancelled',
    'invalid-options',
    'input-too-large',
    'input-metadata',
    'password-required',
    'pdf-security',
    'page-limit-exceeded',
    'page-pixels-exceeded',
    'page-dimensions-too-large',
    'pdfium-binding',
    'pdfium',
    'image-conversion',
    'page-index-out-of-bounds',
    'preview-encoding',
    'invalid-preview-view',
    'text-extraction',
    'comparison',
    'native-module',
    'unknown',
  ].includes(value)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return
  }
  throw createAbortError()
}

export type {
  PdfDiffBounds,
  PdfDiffOptions,
  PdfDiffProgress,
  PdfDiffProgressPhase,
  PdfDiffRunOptions,
  PdfPagePreviewOptions,
  PdfPagePreviewView,
  PdfDiffRegion,
  PdfFigureDiff,
  PdfDiffResult,
  PdfEngineInfo,
  PdfDiffStats,
  PdfDocumentSummary,
  PdfDocumentTextDiff,
  PdfDocumentTextDiffPage,
  PdfDocumentReviewItem,
  PdfPageAlignment,
  PdfPageDiff,
  PdfPageGeometry,
  PdfPageWarning,
  PdfPageStatus,
  PdfResourceLimits,
  PdfSemanticBounds,
  PdfSemanticChangeKind,
  PdfSemanticPageDiff,
  PdfSemanticTextBlockKind,
  PdfSemanticTextBlockRole,
  PdfSemanticTextBlockDiff,
  PdfSemanticTextChange,
  PdfTextExtractionQuality,
  PdfTextExtractionStatus,
  PdfTextExtractionSummary,
  PdfTextDiff,
  PdfTextDiffHunk,
  PdfTextDiffLine,
  PdfTextDiffLineKind,
  PdfTextDiffSpan,
  PdfTextDiffSpanKind,
} from './types.js'
