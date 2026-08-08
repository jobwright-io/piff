import type {
  PiffOptions,
  PiffResult,
  PdfEngineInfo,
  PdfPagePreviewView,
  PdfPageWarning,
  PdfTextExtractionQuality,
  PdfTextExtractionStatus,
  PdfTextExtractionSummary,
  PdfTextDiff,
  PdfDocumentTextDiff,
  PdfDocumentReviewItem,
  PdfSemanticTextBlockKind,
  PdfSemanticTextBlockRole,
  PdfSemanticTextBlockDiff,
} from 'piff'

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
      spans: Array<{ kind: 'equal' | 'added' | 'removed'; text: string }>
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
  kind: NonNullable<PiffResult['pages'][number]['semantic']>['blocks'][number]['kind']
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
  page_status: PiffResult['pages'][number]['status']
  block_id: string
}

type RawDocumentTextDiff = {
  changed_lines: number
  truncated?: boolean | null
  stream?: RawDocumentReviewItem[] | null
  pages: Array<{
    before_page?: number | null
    after_page?: number | null
    status: PiffResult['pages'][number]['status']
    blocks?: RawTextBlockDiff[] | null
    text_diff?: RawTextDiff | null
  }>
}

type InitializePdfium = (
  pdfiumModule: unknown,
  localModule: unknown,
  debug: boolean,
) => boolean
type PiffCall = (
  before: Uint8Array,
  after: Uint8Array,
  optionsJson?: string,
) => string
type EqualCall = (
  before: Uint8Array,
  after: Uint8Array,
  optionsJson?: string,
) => boolean
type RenderPageDiff = (
  before: Uint8Array,
  after: Uint8Array,
  pageIndex: number,
  view?: string,
  optionsJson?: string,
) => Uint8Array

export interface PiffWasmModule {
  initialize_pdfium_render?: (
    pdfiumModule: unknown,
    localModule: unknown,
    debug: boolean,
  ) => boolean
  initializePdfiumRender?: (
    pdfiumModule: unknown,
    localModule: unknown,
    debug: boolean,
  ) => boolean
  piff?: (
    before: Uint8Array,
    after: Uint8Array,
    optionsJson?: string,
  ) => string
  is_equal?: (
    before: Uint8Array,
    after: Uint8Array,
    optionsJson?: string,
  ) => boolean
  isEqual?: (
    before: Uint8Array,
    after: Uint8Array,
    optionsJson?: string,
  ) => boolean
  render_page_diff?: (
    before: Uint8Array,
    after: Uint8Array,
    pageIndex: number,
    view?: string,
    optionsJson?: string,
  ) => Uint8Array
  renderPageDiff?: (
    before: Uint8Array,
    after: Uint8Array,
    pageIndex: number,
    view?: string,
    optionsJson?: string,
  ) => Uint8Array
}

export interface PiffWasmRuntimeOptions {
  /** The wasm-bindgen instance object passed to pdfium-render's initializer. */
  localModule?: unknown
}

/**
 * Synchronous calls into a browser WASM module. Use PiffWasmWorkerClient when these calls
 * must not block the browser event loop.
 */
export class PiffWasmRuntime {
  constructor(
    private readonly module: PiffWasmModule,
    private readonly runtimeOptions: PiffWasmRuntimeOptions = {},
  ) {}

  /**
   * Binds an externally loaded PDFium WASM module to pdfium-render.
   *
   * The PDFium binary is intentionally not bundled here. The host owns its PDFium WASM asset,
   * its license notices, and the Emscripten module loader.
   */
  initializePdfium(pdfiumModule: unknown, debug = false): void {
    const initialize = resolveExport<InitializePdfium>(
      this.module,
      'initialize_pdfium_render',
      'initializePdfiumRender',
    )
    const localModule = this.runtimeOptions.localModule ?? this.module
    if (!initialize(pdfiumModule, localModule, debug)) {
      throw new Error('pdfium-render could not initialize the external PDFium WASM module')
    }
  }

  piff(
    before: Uint8Array,
    after: Uint8Array,
    options?: PiffOptions,
  ): PiffResult {
    const raw = resolveExport<PiffCall>(this.module, 'piff', 'piff')(
      before,
      after,
      serializeOptions(options),
    )
    return mapResult(JSON.parse(raw) as WasmResult)
  }

  isEqual(
    before: Uint8Array,
    after: Uint8Array,
    options?: PiffOptions,
  ): boolean {
    return resolveExport<EqualCall>(this.module, 'is_equal', 'isEqual')(
      before,
      after,
      serializeOptions(options),
    )
  }

  renderPageDiff(
    before: Uint8Array,
    after: Uint8Array,
    pageIndex: number,
    view: PdfPagePreviewView = 'diff',
    options?: PiffOptions,
  ): Uint8Array {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
      throw new RangeError('pageIndex must be a non-negative safe integer')
    }
    return resolveExport<RenderPageDiff>(this.module, 'render_page_diff', 'renderPageDiff')(
      before,
      after,
      pageIndex,
      view,
      serializeOptions(options),
    )
  }
}

export interface PiffWasmWorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  terminate?: () => void
}

export type PiffWasmWorkerRequest =
  | {
      id: number
      type: 'diff'
      before: ArrayBuffer
      after: ArrayBuffer
      options?: PiffOptions
    }
  | {
      id: number
      type: 'equal'
      before: ArrayBuffer
      after: ArrayBuffer
      options?: PiffOptions
    }
  | {
      id: number
      type: 'preview'
      before: ArrayBuffer
      after: ArrayBuffer
      pageIndex: number
      view: PdfPagePreviewView
      options?: PiffOptions
    }
  | {
      id: number
      type: 'cancel'
    }

export type PiffWasmWorkerResponse =
  | { id: number; ok: true; type: 'diff'; result: PiffResult }
  | { id: number; ok: true; type: 'equal'; result: boolean }
  | { id: number; ok: true; type: 'preview'; result: ArrayBuffer }
  | { id: number; ok: false; error: string }

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

type WorkerOperation = Exclude<PiffWasmWorkerRequest, { type: 'cancel' }>
type WorkerRequestInput =
  | Omit<Extract<WorkerOperation, { type: 'diff' }>, 'id'>
  | Omit<Extract<WorkerOperation, { type: 'equal' }>, 'id'>
  | Omit<Extract<WorkerOperation, { type: 'preview' }>, 'id'>

/** A small request/response client for a dedicated browser Worker. */
export class PiffWasmWorkerClient {
  private nextId = 1
  private closed = false
  private readonly pending = new Map<number, PendingRequest>()
  private readonly onMessage = (event: MessageEvent<PiffWasmWorkerResponse>): void => {
    const response = event.data
    const request = this.pending.get(response.id)
    if (request === undefined) {
      return
    }
    this.pending.delete(response.id)
    if (response.ok === false) {
      request.reject(new Error(response.error))
      return
    }
    request.resolve(response.result)
  }

  constructor(private readonly worker: PiffWasmWorkerPort) {
    worker.addEventListener('message', this.onMessage)
  }

  piff(
    before: Uint8Array,
    after: Uint8Array,
    options?: PiffOptions,
    signal?: AbortSignal,
  ): Promise<PiffResult> {
    return this.request(
      {
        type: 'diff',
        before: copyBuffer(before),
        after: copyBuffer(after),
        options,
      },
      signal,
      (value) => value as PiffResult,
    )
  }

  isEqual(
    before: Uint8Array,
    after: Uint8Array,
    options?: PiffOptions,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.request(
      {
        type: 'equal',
        before: copyBuffer(before),
        after: copyBuffer(after),
        options,
      },
      signal,
      (value) => value as boolean,
    )
  }

  renderPageDiff(
    before: Uint8Array,
    after: Uint8Array,
    pageIndex: number,
    view: PdfPagePreviewView = 'diff',
    options?: PiffOptions,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.request(
      {
        type: 'preview',
        before: copyBuffer(before),
        after: copyBuffer(after),
        pageIndex,
        view,
        options,
      },
      signal,
      (value) => new Uint8Array(value as ArrayBuffer),
    )
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.worker.removeEventListener('message', this.onMessage)
    for (const pending of this.pending.values()) {
      pending.reject(new Error('PDF WASM worker client is closed'))
    }
    this.pending.clear()
    this.worker.terminate?.()
  }

  private request<T>(
    request: WorkerRequestInput,
    signal: AbortSignal | undefined,
    map: (value: unknown) => T,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('PDF WASM worker client is closed'))
    }
    if (signal?.aborted === true) {
      return Promise.reject(createAbortError())
    }
    const id = this.nextId++
    const message = { ...request, id } as PiffWasmWorkerRequest
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(id)
        this.worker.postMessage({ id, type: 'cancel' } satisfies PiffWasmWorkerRequest)
        reject(createAbortError())
      }
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(map(value))
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      const transfer = 'before' in message
        ? [message.before, message.after]
        : []
      this.worker.postMessage(message, transfer)
    })
  }
}

/** Installs a worker message handler around an initialized WASM runtime. */
export function createPiffWasmWorkerHandler(
  runtime: PiffWasmRuntime,
  scope: { postMessage(message: unknown, transfer?: Transferable[]): void },
): (event: MessageEvent<PiffWasmWorkerRequest>) => void {
  const cancelled = new Set<number>()
  return (event) => {
    const request = event.data
    if (request.type === 'cancel') {
      cancelled.add(request.id)
      return
    }
    void handleWorkerRequest(runtime, scope, request, cancelled)
  }
}

async function handleWorkerRequest(
  runtime: PiffWasmRuntime,
  scope: { postMessage(message: unknown, transfer?: Transferable[]): void },
  request: Exclude<PiffWasmWorkerRequest, { type: 'cancel' }>,
  cancelled: Set<number>,
): Promise<void> {
  try {
    const before = new Uint8Array(request.before)
    const after = new Uint8Array(request.after)
    if (request.type === 'diff') {
      const result = runtime.piff(before, after, request.options)
      if (!cancelled.has(request.id)) {
        scope.postMessage({ id: request.id, ok: true, type: 'diff', result })
      }
    } else if (request.type === 'equal') {
      const result = runtime.isEqual(before, after, request.options)
      if (!cancelled.has(request.id)) {
        scope.postMessage({ id: request.id, ok: true, type: 'equal', result })
      }
    } else {
      const result = runtime.renderPageDiff(
        before,
        after,
        request.pageIndex,
        request.view,
        request.options,
      )
      if (!cancelled.has(request.id)) {
        const transferable = result.slice()
        const buffer = transferable.buffer as ArrayBuffer
        scope.postMessage(
          { id: request.id, ok: true, type: 'preview', result: buffer },
          [buffer],
        )
      }
    }
  } catch (error) {
    if (!cancelled.has(request.id)) {
      scope.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies PiffWasmWorkerResponse)
    }
  } finally {
    cancelled.delete(request.id)
  }
}

interface WasmResult {
  schema_version: number
  engine: PdfEngineInfo
  equal: boolean
  before_page_count: number
  after_page_count: number
  text_diff?: RawDocumentTextDiff | null
  pages: Array<{
    before_page?: number | null
    after_page?: number | null
    status: PiffResult['pages'][number]['status']
    before_size?: { width: number; height: number } | null
    after_size?: { width: number; height: number } | null
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
      bounds: { x: number; y: number; width: number; height: number }
      changed_pixels: number
      before_content_pixels?: number
      after_content_pixels?: number
    }>
    figures?: Array<{
      id: string
      status: PiffResult['pages'][number]['figures'][number]['status']
      before_bounds?: { x: number; y: number; width: number; height: number } | null
      after_bounds?: { x: number; y: number; width: number; height: number } | null
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
        kind: NonNullable<PiffResult['pages'][number]['semantic']>['changes'][number]['kind']
        before_text?: string | null
        after_text?: string | null
        before_bounds?: { x: number; y: number; width: number; height: number } | null
        after_bounds?: { x: number; y: number; width: number; height: number } | null
        before_focus_bounds?: { x: number; y: number; width: number; height: number } | null
        after_focus_bounds?: { x: number; y: number; width: number; height: number } | null
      }>
      text_diff?: RawTextDiff | null
    } | null
  }>
  stats: { render_ms: number; compare_ms: number; total_ms: number }
}

function mapResult(raw: WasmResult): PiffResult {
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
      regions: page.regions.map((region) => ({
        id: region.id,
        bounds: region.bounds,
        changedPixels: region.changed_pixels,
        beforeContentPixels: region.before_content_pixels,
        afterContentPixels: region.after_content_pixels,
      })),
      figures: (page.figures ?? []).map((figure) => ({
        id: figure.id,
        status: figure.status,
        beforeBounds: figure.before_bounds ?? undefined,
        afterBounds: figure.after_bounds ?? undefined,
        confidence: figure.confidence,
      })),
      semantic: page.semantic == null
        ? undefined
        : {
            equal: page.semantic.equal,
            beforeCharCount: page.semantic.before_char_count,
            afterCharCount: page.semantic.after_char_count,
            changesTruncated: page.semantic.changes_truncated ?? false,
            quality: page.semantic.quality
              ?? inferQuality(
                mapExtraction(page.semantic.before_extraction, page.semantic.before_char_count),
                mapExtraction(page.semantic.after_extraction, page.semantic.after_char_count),
              ),
            beforeExtraction: mapExtraction(
              page.semantic.before_extraction,
              page.semantic.before_char_count,
            ),
            afterExtraction: mapExtraction(
              page.semantic.after_extraction,
              page.semantic.after_char_count,
            ),
            changes: page.semantic.changes.map((change) => ({
              id: change.id,
              kind: change.kind,
              beforeText: change.before_text ?? undefined,
              afterText: change.after_text ?? undefined,
              beforeBounds: change.before_bounds ?? undefined,
              afterBounds: change.after_bounds ?? undefined,
              beforeFocusBounds: change.before_focus_bounds ?? undefined,
              afterFocusBounds: change.after_focus_bounds ?? undefined,
            })),
            blocks: (page.semantic.blocks ?? []).map(mapTextBlock),
            textDiff: page.semantic.text_diff == null
              ? undefined
              : mapTextDiff(page.semantic.text_diff),
          },
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

function resolveExport<T extends (...args: any[]) => any>(
  module: PiffWasmModule,
  snakeName: string,
  camelName: string,
): T {
  const candidate = module[snakeName as keyof PiffWasmModule]
    ?? module[camelName as keyof PiffWasmModule]
  if (typeof candidate !== 'function') {
    throw new Error(`WASM module is missing its ${snakeName} export`)
  }
  return candidate as unknown as T
}

function serializeOptions(options: PiffOptions | undefined): string | undefined {
  return options === undefined ? undefined : JSON.stringify(options)
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

function createAbortError(): Error {
  const error = new Error('PDF WASM comparison aborted')
  error.name = 'AbortError'
  return error
}
