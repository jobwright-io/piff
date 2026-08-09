import {
  asBuffer,
  loadNativeBinding,
  runWithNativeCancellation,
  toNativeDocumentSetProgress,
  toNativeProgress,
  toNativeOptions,
} from './native.js'
import type {
  PiffOptions,
  PiffRunOptions,
  PdfPagePreviewOptions,
  PdfPageWarning,
  PiffRegion,
  PdfEngineInfo,
  PdfFigureDiff,
  PiffResult,
  PiffStats,
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
  PiffCacheDiagnostics,
  PiffSessionOptions,
  PdfPagePreviewTiming,
  PdfChangeOperation,
  PdfChangeSource,
  PdfDocumentChangeKind,
  PdfDocumentRevision,
  PdfDocumentSetComparison,
  PdfDocumentSetStrategy,
  PdfRevisionAnchor,
  PdfRevisionChangeState,
  PdfRevisionComparisonDetail,
  PdfRevisionVariant,
  PiffDocumentInput,
  PiffDocumentSetOptions,
  PiffDocumentSetProgress,
  PiffDocumentSetResult,
  PiffDocumentSetRunOptions,
  PiffDocumentSetStats,
} from './types.js'

export type PiffErrorCode =
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
export class PiffError extends Error {
  readonly code: PiffErrorCode
  readonly cause: unknown

  constructor(code: PiffErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'PiffError'
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
  page_status: PiffResult['pages'][number]['status']
  side: 'before' | 'after' | 'both'
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

interface NativeResult {
  schema_version: number
  engine: NativeEngineInfo
  equal: boolean
  render_mode: 'full' | 'none'
  before_page_count: number
  after_page_count: number
  text_diff?: RawDocumentTextDiff | null
  pages: Array<{
    before_page?: number | null
    after_page?: number | null
    status: PiffResult['pages'][number]['status']
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
    visual_computed: boolean
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
    load_ms: number
    fingerprint_ms: number
    matching_ms: number
    render_ms: number
    compare_ms: number
    region_ms: number
    semantic_ms: number
    total_ms: number
  }
}

interface NativeEngineInfo {
  name: string
  version: string
  renderer: string
  binding: string
  pdfium_api?: string | null
  pdfium_version?: string | null
}

interface NativeDocumentSetResult {
  schema_version: number
  primitive: 'document-set'
  engine: NativeEngineInfo
  equal: boolean
  strategy: PdfDocumentSetStrategy
  revisions: Array<{
    id: string
    label: string
    index: number
    page_count?: number | null
  }>
  comparisons: Array<{
    from_revision_id: string
    to_revision_id: string
    equal: boolean
    changed_pages: number
    changed_lines: number
    truncated: boolean
  }>
  changes: Array<{
    id: string
    source: PdfChangeSource
    kind: PdfDocumentChangeKind
    page_index?: number | null
    structure?: PdfSemanticTextBlockKind | null
    anchors: Array<{
      id: string
      revision_id: string
      source: PdfChangeSource
      state: PdfRevisionChangeState
      page_index?: number | null
      page_status?: PiffResult['pages'][number]['status'] | null
      block_id?: string | null
      figure_id?: string | null
      structure?: PdfSemanticTextBlockKind | null
      confidence?: number | null
      text?: string | null
      bounds?: {
        x: number
        y: number
        width: number
        height: number
      } | null
      focus_bounds?: {
        x: number
        y: number
        width: number
        height: number
      } | null
    }>
    variants: Array<{
      id: string
      text?: string | null
      revision_ids: string[]
      anchor_ids: string[]
    }>
    comparisons: Array<{
      from_revision_id: string
      to_revision_id: string
      kind: PdfDocumentChangeKind
      text_diff?: RawTextDiff | null
    }>
    visual?: {
      changed_pixels: number
      changed_ratio: number
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
    } | null
  }>
  truncated: boolean
  stats: NativeResult['stats']
}

type PreviewCacheEntry = {
  promise: Promise<Uint8Array>
  bytes?: number
}

const DEFAULT_MAX_PREVIEW_CACHE_BYTES = 64 * 1024 * 1024

/** A reusable comparison session with lazy page preview rendering. */
export class PiffSession {
  private closed = false
  private comparison: Promise<PiffResult> | undefined
  private equality: Promise<boolean> | undefined
  private readonly previews = new Map<string, PreviewCacheEntry>()
  private readonly maxPreviewCacheBytes: number
  private previewCacheBytes = 0
  private previewCacheHits = 0
  private previewCacheMisses = 0
  private previewCacheEvictions = 0

  private constructor(
    private before: Uint8Array,
    private after: Uint8Array,
    private readonly options?: PiffOptions,
    sessionOptions?: PiffSessionOptions,
  ) {
    this.maxPreviewCacheBytes = normalizeMaxPreviewCacheBytes(sessionOptions?.maxPreviewCacheBytes)
  }

  static async open(
    before: Uint8Array,
    after: Uint8Array,
    options?: PiffOptions,
    sessionOptions?: PiffSessionOptions,
  ): Promise<PiffSession> {
    return new PiffSession(before, after, options, sessionOptions)
  }

  async compare(runOptions?: PiffRunOptions): Promise<PiffResult> {
    this.ensureOpen()
    throwIfAborted(runOptions?.signal)
    if (this.comparison === undefined) {
      let comparison: Promise<PiffResult>
      comparison = compareNative(this.before, this.after, this.options, runOptions).catch(
        (error: unknown) => {
          if (this.comparison === comparison) {
            this.comparison = undefined
          }
          throw toPiffError(error)
        },
      )
      this.comparison = comparison
    }
    return this.comparison
  }

  async isEqual(runOptions?: PiffRunOptions): Promise<boolean> {
    this.ensureOpen()
    throwIfAborted(runOptions?.signal)
    if (this.comparison !== undefined) {
      return (await this.comparison).equal
    }
    if (this.equality === undefined) {
      let equality: Promise<boolean>
      equality = runWithNativeCancellation(runOptions?.signal, (cancellationToken) =>
        loadNativeBinding().isEqual(
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
        throw toPiffError(error)
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
    validatePreviewRequest(pageIndex, options)
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
        throw toPiffError(error)
      })
    }

    const key = `${pageIndex}:${options?.view ?? 'diff'}`
    const cached = this.previews.get(key)
    if (cached !== undefined) {
      this.previewCacheHits += 1
      this.previews.delete(key)
      this.previews.set(key, cached)
      return cached.promise
    }
    this.previewCacheMisses += 1
    let preview: Promise<Uint8Array>
    preview = render().then((bytes) => {
      const entry = this.previews.get(key)
      if (entry?.promise !== preview) {
        return bytes
      }
      this.previews.delete(key)
      if (this.maxPreviewCacheBytes > 0 && bytes.byteLength <= this.maxPreviewCacheBytes) {
        this.previewCacheBytes += bytes.byteLength
        this.previews.set(key, { promise: preview, bytes: bytes.byteLength })
        this.trimPreviewCache()
      }
      return bytes
    }).catch((error: unknown) => {
      if (this.previews.get(key)?.promise === preview) {
        this.previews.delete(key)
      }
      throw toPiffError(error)
    })
    this.previews.set(key, { promise: preview })
    return preview
  }

  /** Render one page diff and return native PNG encoding time without using the preview cache. */
  async renderPageDiffWithTiming(
    pageIndex: number,
    options?: PdfPagePreviewOptions,
  ): Promise<PdfPagePreviewTiming> {
    this.ensureOpen()
    throwIfAborted(options?.signal)
    validatePreviewRequest(pageIndex, options)
    const result = await runWithNativeCancellation(options?.signal, (cancellationToken) =>
      loadNativeBinding().renderPageDiffWithTiming(
        asBuffer(this.before),
        asBuffer(this.after),
        pageIndex,
        toNativeOptions(this.options),
        options?.view,
        options?.signal,
        cancellationToken,
      ),
    )
    return {
      bytes: result.bytes,
      encodeMs: result.encodeMs,
    }
  }

  /** Returns bounded preview-cache counters without exposing cached image buffers. */
  cacheDiagnostics(): PiffCacheDiagnostics {
    this.ensureOpen()
    return {
      maxPreviewCacheBytes: this.maxPreviewCacheBytes,
      previewCacheBytes: this.previewCacheBytes,
      previewCacheEntries: this.previews.size,
      previewCacheHits: this.previewCacheHits,
      previewCacheMisses: this.previewCacheMisses,
      previewCacheEvictions: this.previewCacheEvictions,
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.comparison = undefined
    this.equality = undefined
    this.previews.clear()
    this.previewCacheBytes = 0
    this.before = new Uint8Array(0)
    this.after = new Uint8Array(0)
  }

  private trimPreviewCache(): void {
    while (this.previewCacheBytes > this.maxPreviewCacheBytes) {
      const oldest = [...this.previews.entries()].find(([, entry]) => entry.bytes !== undefined)
      if (oldest === undefined) {
        return
      }
      const [key, entry] = oldest
      this.previews.delete(key)
      this.previewCacheBytes -= entry.bytes ?? 0
      this.previewCacheEvictions += 1
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('PiffSession is closed')
    }
  }
}

type DocumentSetEdge = {
  from: PiffDocumentInput
  to: PiffDocumentInput
}

type DocumentSetPair = {
  edge: DocumentSetEdge
  result: PiffResult
}

type MutableRevisionVariant = {
  id: string
  text?: string
  revisionIds: Set<string>
  anchorIds: Set<string>
}

type MutableChangeOperation = {
  id: string
  source: PdfChangeSource
  kind: PdfDocumentChangeKind
  pageIndex?: number
  structure?: PdfSemanticTextBlockKind
  anchors: Map<string, PdfRevisionAnchor>
  variants: Map<string, MutableRevisionVariant>
  comparisons: Map<string, PdfRevisionComparisonDetail>
  visual?: {
    changedPixels: number
    changedRatio: number
    regions: PiffRegion[]
  }
  order: number
}

const MAX_DOCUMENT_SET_REVISIONS = 64

/**
 * Compares an ordered set of PDF revisions through revision-neutral change operations.
 *
 * The default baseline strategy compares revision zero with every other revision. The
 * adjacent strategy compares each revision with its predecessor. The set keeps pair sessions
 * alive so page previews can be requested lazily for any edge that has been compared.
 */
export class PiffDocumentSet {
  private closed = false
  private comparison: Promise<PiffDocumentSetResult> | undefined
  private readonly sessions = new Map<string, PiffSession>()

  private constructor(
    private readonly documents: readonly PiffDocumentInput[],
    private readonly options: PiffOptions,
    private readonly strategy: PdfDocumentSetStrategy,
    private readonly sessionOptions?: PiffSessionOptions,
  ) {}

  static async open(
    documents: readonly PiffDocumentInput[],
    options?: PiffDocumentSetOptions,
    sessionOptions?: PiffSessionOptions,
  ): Promise<PiffDocumentSet> {
    const normalized = normalizeDocumentSetInputs(documents)
    const strategy = options?.strategy ?? 'baseline'
    if (strategy !== 'baseline' && strategy !== 'adjacent') {
      throw new PiffError('invalid-options', `Unsupported document-set strategy: ${strategy}`)
    }
    const { strategy: _ignoredStrategy, ...comparisonOptions } = options ?? {}
    return new PiffDocumentSet(
      normalized,
      normalizeDocumentSetComparisonOptions(comparisonOptions),
      strategy,
      sessionOptions,
    )
  }

  async compare(runOptions?: PiffDocumentSetRunOptions): Promise<PiffDocumentSetResult> {
    this.ensureOpen()
    throwIfAborted(runOptions?.signal)
    if (this.comparison === undefined) {
      let comparison: Promise<PiffDocumentSetResult>
      comparison = this.compareSet(runOptions).catch((error: unknown) => {
        if (this.comparison === comparison) {
          this.comparison = undefined
        }
        throw toPiffError(error)
      })
      this.comparison = comparison
    }
    return this.comparison
  }

  /** Render a page diff for any two revisions without materializing other previews. */
  async renderPageDiff(
    fromRevisionId: string,
    toRevisionId: string,
    pageIndex: number,
    options?: PdfPagePreviewOptions,
  ): Promise<Uint8Array> {
    this.ensureOpen()
    const session = await this.sessionFor(fromRevisionId, toRevisionId)
    return session.renderPageDiff(pageIndex, options)
  }

  async close(): Promise<void> {
    this.closed = true
    this.comparison = undefined
    await Promise.all([...this.sessions.values()].map((session) => session.close()))
    this.sessions.clear()
  }

  private async compareSet(
    runOptions?: PiffDocumentSetRunOptions,
  ): Promise<PiffDocumentSetResult> {
    const native = loadNativeBinding()
    if (native.compareDocumentSet !== undefined) {
      return compareNativeDocumentSet(
        this.documents,
        this.strategy,
        this.options,
        runOptions,
      )
    }
    const edges = this.edges()
    const started = nowMs()
    const pairs: DocumentSetPair[] = []
    for (const [index, edge] of edges.entries()) {
      throwIfAborted(runOptions?.signal)
      const session = await this.sessionFor(edge.from.id, edge.to.id)
      const result = await session.compare({
        signal: runOptions?.signal,
        onProgress: (event) => {
          runOptions?.onProgress?.({
            ...event,
            comparisonIndex: index + 1,
            comparisonTotal: edges.length,
            fromRevisionId: edge.from.id,
            toRevisionId: edge.to.id,
          })
        },
      })
      pairs.push({ edge, result })
    }

    const pageCounts = new Map<string, number>()
    for (const pair of pairs) {
      pageCounts.set(pair.edge.from.id, pair.result.before.pageCount)
      pageCounts.set(pair.edge.to.id, pair.result.after.pageCount)
    }
    const revisions: PdfDocumentRevision[] = this.documents.map((document, index) => ({
      id: document.id,
      label: document.label ?? document.id,
      index,
      pageCount: pageCounts.get(document.id),
    }))
    const comparisons: PdfDocumentSetComparison[] = pairs.map(({ edge, result }) => ({
      fromRevisionId: edge.from.id,
      toRevisionId: edge.to.id,
      equal: result.equal,
      changedPages: result.pages.filter((page) => page.status !== 'equal').length,
      changedLines: result.textDiff?.changedLines ?? 0,
      truncated: result.textDiff?.truncated ?? false,
    }))
    const stats = sumDocumentSetStats(pairs.map(({ result }) => result.stats))
    stats.totalMs = Math.max(stats.totalMs, nowMs() - started)
    return {
      schemaVersion: 1,
      primitive: 'document-set',
      engine: pairs[0].result.engine,
      equal: pairs.every(({ result }) => result.equal),
      strategy: this.strategy,
      revisions,
      comparisons,
      changes: buildDocumentSetChanges(pairs, revisions),
      truncated: comparisons.some((comparison) => comparison.truncated),
      stats,
    }
  }

  private edges(): DocumentSetEdge[] {
    if (this.strategy === 'adjacent') {
      return this.documents.slice(1).map((to, index) => ({
        from: this.documents[index],
        to,
      }))
    }
    const [baseline, ...candidates] = this.documents
    return candidates.map((to) => ({ from: baseline, to }))
  }

  private async sessionFor(fromRevisionId: string, toRevisionId: string): Promise<PiffSession> {
    const from = this.documents.find((document) => document.id === fromRevisionId)
    const to = this.documents.find((document) => document.id === toRevisionId)
    if (from === undefined || to === undefined || from === to) {
      throw new PiffError(
        'invalid-options',
        `Unknown or identical document-set revisions: ${fromRevisionId} -> ${toRevisionId}`,
      )
    }
    const key = documentSetEdgeKey(from.id, to.id)
    const cached = this.sessions.get(key)
    if (cached !== undefined) {
      return cached
    }
    const session = await PiffSession.open(from.bytes, to.bytes, this.options, this.sessionOptions)
    this.sessions.set(key, session)
    return session
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('PiffDocumentSet is closed')
    }
  }
}

/** Compare multiple PDFs and return revision-neutral changes. */
export async function piffSet(
  documents: readonly PiffDocumentInput[],
  options?: PiffDocumentSetOptions,
  runOptions?: PiffDocumentSetRunOptions,
): Promise<PiffDocumentSetResult> {
  const set = await PiffDocumentSet.open(documents, options)
  try {
    return await set.compare(runOptions)
  } finally {
    await set.close()
  }
}

function normalizeDocumentSetInputs(
  documents: readonly PiffDocumentInput[],
): PiffDocumentInput[] {
  if (!Array.isArray(documents) || documents.length < 2) {
    throw new PiffError('invalid-options', 'A document set requires at least two PDFs')
  }
  if (documents.length > MAX_DOCUMENT_SET_REVISIONS) {
    throw new PiffError(
      'invalid-options',
      `A document set supports at most ${MAX_DOCUMENT_SET_REVISIONS} PDFs`,
    )
  }
  const ids = new Set<string>()
  return documents.map((document, index) => {
    if (document === undefined || typeof document.id !== 'string' || document.id.trim() === '') {
      throw new PiffError('invalid-options', `Document ${index + 1} must have a non-empty id`)
    }
    if (ids.has(document.id)) {
      throw new PiffError('invalid-options', `Document-set revision id is duplicated: ${document.id}`)
    }
    if (!(document.bytes instanceof Uint8Array) || document.bytes.byteLength === 0) {
      throw new PiffError('invalid-options', `Document ${document.id} must contain PDF bytes`)
    }
    ids.add(document.id)
    return {
      id: document.id,
      label: document.label ?? document.id,
      bytes: document.bytes,
    }
  })
}

function normalizeDocumentSetComparisonOptions(
  options: PiffOptions,
): PiffOptions {
  const mode = options.mode ?? 'semantic'
  return {
    ...options,
    mode,
    render: options.render ?? (mode === 'visual' ? 'full' : 'none'),
  }
}

function documentSetEdgeKey(fromRevisionId: string, toRevisionId: string): string {
  return `${fromRevisionId}\u0000${toRevisionId}`
}

function buildDocumentSetChanges(
  pairs: readonly DocumentSetPair[],
  revisions: readonly PdfDocumentRevision[],
): PdfChangeOperation[] {
  const revisionOrder = new Map(revisions.map((revision) => [revision.id, revision.index]))
  const operations = new Map<string, MutableChangeOperation>()
  let nextOrder = 0

  for (const { edge, result } of pairs) {
    const stream = result.textDiff?.stream ?? []
    const streamByPage = new Map<number, number>()
    for (const item of stream) {
      streamByPage.set(item.pageIndex, (streamByPage.get(item.pageIndex) ?? 0) + 1)
      const page = result.pages[item.pageIndex]
      const key = textOperationKey(edge, item)
      const operation = getMutableChange(
        operations,
        key,
        'text',
        item.kind,
        item.pageIndex,
        item.structure,
        nextOrder++,
      )
      addTextAnchors(operation, edge, item, page?.status)
      addComparisonDetail(operation, edge, item.kind, item.textDiff)
    }

    for (const [pageIndex, page] of result.pages.entries()) {
      for (const figure of page.figures) {
        const key = figureOperationKey(edge, pageIndex, figure)
        const operation = getMutableChange(
          operations,
          key,
          'figure',
          figure.status,
          pageIndex,
          undefined,
          nextOrder++,
        )
        addFigureAnchors(operation, edge, pageIndex, page.status, figure)
        addComparisonDetail(operation, edge, figure.status)
      }

      if (page.status === 'inserted' || page.status === 'deleted') {
        addPageOperation(operations, edge, pageIndex, page, page.status, nextOrder++)
      } else if (page.status === 'moved') {
        addPageOperation(operations, edge, pageIndex, page, page.status, nextOrder++)
      } else if (
        page.status !== 'equal'
        && (streamByPage.get(pageIndex) ?? 0) === 0
        && page.figures.length === 0
      ) {
        addPageOperation(operations, edge, pageIndex, page, 'visual', nextOrder++)
      }
    }
  }

  return [...operations.values()]
    .sort((left, right) => {
      const leftPage = left.pageIndex ?? Number.MAX_SAFE_INTEGER
      const rightPage = right.pageIndex ?? Number.MAX_SAFE_INTEGER
      return leftPage - rightPage || left.order - right.order
    })
    .map((operation) => ({
      id: operation.id,
      source: operation.source,
      kind: operation.kind,
      pageIndex: operation.pageIndex,
      structure: operation.structure,
      anchors: [...operation.anchors.values()].sort(
        (left, right) => (revisionOrder.get(left.revisionId) ?? 0) - (revisionOrder.get(right.revisionId) ?? 0),
      ),
      variants: [...operation.variants.values()].map((variant) => ({
        id: variant.id,
        text: variant.text,
        revisionIds: [...variant.revisionIds].sort(
          (left, right) => (revisionOrder.get(left) ?? 0) - (revisionOrder.get(right) ?? 0),
        ),
        anchorIds: [...variant.anchorIds],
      })),
      comparisons: [...operation.comparisons.values()],
      visual: operation.visual,
    }))
}

type DocumentSetReviewItem = NonNullable<PiffResult['textDiff']>['stream'][number]
type DocumentSetFigure = PiffResult['pages'][number]['figures'][number]
type DocumentSetPage = PiffResult['pages'][number]

function textOperationKey(edge: DocumentSetEdge, item: DocumentSetReviewItem): string {
  const page = item.beforePage ?? item.afterPage ?? item.pageIndex
  if (item.kind === 'added') {
    return `text:${edge.to.id}:${page}:added:${normalizeVariantText(item.afterText)}:${item.structure}`
  }
  return `text:${edge.from.id}:${page}:${item.blockId}`
}

function figureOperationKey(
  edge: DocumentSetEdge,
  pageIndex: number,
  figure: DocumentSetFigure,
): string {
  const revisionId = figure.status === 'added' ? edge.to.id : edge.from.id
  const bounds = figure.afterBounds ?? figure.beforeBounds
  return `figure:${revisionId}:${pageIndex}:${figure.id}:${boundsKey(bounds)}`
}

function getMutableChange(
  operations: Map<string, MutableChangeOperation>,
  key: string,
  source: PdfChangeSource,
  kind: PdfDocumentChangeKind,
  pageIndex: number | undefined,
  structure: PdfSemanticTextBlockKind | undefined,
  order: number,
): MutableChangeOperation {
  const existing = operations.get(key)
  if (existing !== undefined) {
    existing.kind = mergeDocumentChangeKinds(existing.kind, kind)
    existing.structure ??= structure
    return existing
  }
  const operation: MutableChangeOperation = {
    id: `change-${operations.size + 1}`,
    source,
    kind,
    pageIndex,
    structure,
    anchors: new Map(),
    variants: new Map(),
    comparisons: new Map(),
    order,
  }
  operations.set(key, operation)
  return operation
}

function addTextAnchors(
  operation: MutableChangeOperation,
  edge: DocumentSetEdge,
  item: DocumentSetReviewItem,
  pageStatus: PiffResult['pages'][number]['status'] | undefined,
): void {
  if (item.kind !== 'added') {
    addAnchor(operation, {
      id: `${operation.id}:anchor:${edge.from.id}`,
      revisionId: edge.from.id,
      source: 'text',
      state: revisionState(item.kind),
      pageIndex: item.beforePage,
      pageStatus,
      blockId: item.blockId,
      structure: item.structure,
      confidence: item.confidence,
      text: item.beforeText,
      bounds: item.beforeBounds,
      focusBounds: item.beforeFocusBounds,
    })
  }
  if (item.kind !== 'removed') {
    addAnchor(operation, {
      id: `${operation.id}:anchor:${edge.to.id}`,
      revisionId: edge.to.id,
      source: 'text',
      state: revisionState(item.kind),
      pageIndex: item.afterPage,
      pageStatus,
      blockId: item.blockId,
      structure: item.structure,
      confidence: item.confidence,
      text: item.afterText,
      bounds: item.afterBounds,
      focusBounds: item.afterFocusBounds,
    })
  }
}

function addFigureAnchors(
  operation: MutableChangeOperation,
  edge: DocumentSetEdge,
  pageIndex: number,
  pageStatus: PiffResult['pages'][number]['status'],
  figure: DocumentSetFigure,
): void {
  const state = figure.status === 'added'
    ? 'introduced'
    : figure.status === 'removed'
      ? 'removed'
      : figure.status
  if (figure.beforeBounds !== undefined) {
    addAnchor(operation, {
      id: `${operation.id}:anchor:${edge.from.id}`,
      revisionId: edge.from.id,
      source: 'figure',
      state,
      pageIndex,
      pageStatus,
      figureId: figure.id,
      confidence: figure.confidence,
      bounds: figure.beforeBounds,
    })
  }
  if (figure.afterBounds !== undefined) {
    addAnchor(operation, {
      id: `${operation.id}:anchor:${edge.to.id}`,
      revisionId: edge.to.id,
      source: 'figure',
      state,
      pageIndex,
      pageStatus,
      figureId: figure.id,
      confidence: figure.confidence,
      bounds: figure.afterBounds,
    })
  }
}

function addPageOperation(
  operations: Map<string, MutableChangeOperation>,
  edge: DocumentSetEdge,
  pageIndex: number,
  page: DocumentSetPage,
  status: 'inserted' | 'deleted' | 'moved' | 'visual',
  order: number,
): void {
  const kind: PdfDocumentChangeKind = status === 'inserted'
    ? 'added'
    : status === 'deleted'
      ? 'removed'
      : status === 'moved'
        ? 'moved'
        : 'visual'
  const keyRevision = status === 'inserted' ? edge.to.id : edge.from.id
  const keyPage = page.afterPage ?? page.beforePage ?? pageIndex
  const operation = getMutableChange(
    operations,
    `page:${keyRevision}:${keyPage}:${kind}`,
    status === 'visual' ? 'visual' : 'page',
    kind,
    pageIndex,
    undefined,
    order,
  )
  const state: PdfRevisionChangeState = status === 'inserted'
    ? 'introduced'
    : status === 'deleted'
      ? 'removed'
      : status === 'moved'
        ? 'moved'
        : 'modified'
  if (status !== 'inserted') {
    addAnchor(operation, {
      id: `${operation.id}:anchor:${edge.from.id}`,
      revisionId: edge.from.id,
      source: operation.source,
      state,
      pageIndex: page.beforePage,
      pageStatus: page.status,
      confidence: page.alignment.confidence,
    })
  }
  if (status !== 'deleted') {
    addAnchor(operation, {
      id: `${operation.id}:anchor:${edge.to.id}`,
      revisionId: edge.to.id,
      source: operation.source,
      state,
      pageIndex: page.afterPage,
      pageStatus: page.status,
      confidence: page.alignment.confidence,
    })
  }
  if (status === 'visual') {
    operation.visual = {
      changedPixels: page.changedPixels,
      changedRatio: page.changedRatio,
      regions: page.regions,
    }
  }
  addComparisonDetail(operation, edge, kind)
}

function addAnchor(operation: MutableChangeOperation, anchor: PdfRevisionAnchor): void {
  const existing = operation.anchors.get(anchor.revisionId)
  if (existing !== undefined) {
    return
  }
  operation.anchors.set(anchor.revisionId, anchor)
  if (anchor.text === undefined || anchor.text.trim() === '') {
    return
  }
  const key = normalizeVariantText(anchor.text)
  let variant = operation.variants.get(key)
  if (variant === undefined) {
    variant = {
      id: `${operation.id}:variant-${operation.variants.size + 1}`,
      text: anchor.text,
      revisionIds: new Set(),
      anchorIds: new Set(),
    }
    operation.variants.set(key, variant)
  }
  variant.revisionIds.add(anchor.revisionId)
  variant.anchorIds.add(anchor.id)
}

function addComparisonDetail(
  operation: MutableChangeOperation,
  edge: DocumentSetEdge,
  kind: PdfDocumentChangeKind,
  textDiff?: PdfTextDiff,
): void {
  const key = documentSetEdgeKey(edge.from.id, edge.to.id)
  if (operation.comparisons.has(key)) {
    return
  }
  operation.comparisons.set(key, {
    fromRevisionId: edge.from.id,
    toRevisionId: edge.to.id,
    kind,
    textDiff,
  })
}

function revisionState(kind: PdfSemanticTextChange['kind']): PdfRevisionChangeState {
  return kind === 'added'
    ? 'introduced'
    : kind === 'removed'
      ? 'removed'
      : kind
}

function mergeDocumentChangeKinds(
  left: PdfDocumentChangeKind,
  right: PdfDocumentChangeKind,
): PdfDocumentChangeKind {
  return left === right ? left : 'diverged'
}

function normalizeVariantText(text: string | undefined): string {
  return text?.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ?? ''
}

function boundsKey(
  bounds: { x: number; y: number; width: number; height: number } | undefined,
): string {
  return bounds === undefined
    ? 'none'
    : [bounds.x, bounds.y, bounds.width, bounds.height].map((value) => value.toFixed(2)).join(',')
}

function sumDocumentSetStats(stats: readonly PiffStats[]): PiffDocumentSetStats {
  return stats.reduce<PiffDocumentSetStats>(
    (total, current) => ({
      loadMs: total.loadMs + current.loadMs,
      fingerprintMs: total.fingerprintMs + current.fingerprintMs,
      matchingMs: total.matchingMs + current.matchingMs,
      renderMs: total.renderMs + current.renderMs,
      compareMs: total.compareMs + current.compareMs,
      regionMs: total.regionMs + current.regionMs,
      semanticMs: total.semanticMs + current.semanticMs,
      totalMs: total.totalMs + current.totalMs,
    }),
    {
      loadMs: 0,
      fingerprintMs: 0,
      matchingMs: 0,
      renderMs: 0,
      compareMs: 0,
      regionMs: 0,
      semanticMs: 0,
      totalMs: 0,
    },
  )
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now()
}

/** Compare two PDF byte buffers through the asynchronous Rust/PDFium binding. */
export async function piff(
  before: Uint8Array,
  after: Uint8Array,
  options?: PiffOptions,
  runOptions?: PiffRunOptions,
): Promise<PiffResult> {
  const session = await PiffSession.open(before, after, options)
  try {
    return await session.compare(runOptions)
  } finally {
    await session.close()
  }
}

async function compareNative(
  before: Uint8Array,
  after: Uint8Array,
  options?: PiffOptions,
  runOptions?: PiffRunOptions,
): Promise<PiffResult> {
  const raw = await runWithNativeCancellation(runOptions?.signal, (cancellationToken) =>
    loadNativeBinding().piff(
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

async function compareNativeDocumentSet(
  documents: readonly PiffDocumentInput[],
  strategy: PdfDocumentSetStrategy,
  options: PiffOptions,
  runOptions?: PiffDocumentSetRunOptions,
): Promise<PiffDocumentSetResult> {
  const native = loadNativeBinding()
  if (native.compareDocumentSet === undefined) {
    throw new PiffError('native-module', 'The native module does not support document sets')
  }
  const raw = await runWithNativeCancellation(runOptions?.signal, (cancellationToken) =>
    native.compareDocumentSet?.(
      documents.map((document) => ({
        id: document.id,
        label: document.label,
        bytes: asBuffer(document.bytes),
      })),
      strategy,
      toNativeOptions(options),
      toNativeDocumentSetProgress(runOptions, documents, strategy),
      runOptions?.signal,
      cancellationToken,
    ) ?? Promise.reject(new Error('native document-set comparison is unavailable')),
  )
  return mapDocumentSetResult(JSON.parse(raw) as NativeDocumentSetResult)
}

function mapResult(raw: NativeResult): PiffResult {
  return {
    schemaVersion: raw.schema_version,
    engine: mapEngine(raw.engine),
    equal: raw.equal,
    renderMode: raw.render_mode,
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
      visualComputed: page.visual_computed,
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
      loadMs: raw.stats.load_ms,
      fingerprintMs: raw.stats.fingerprint_ms,
      matchingMs: raw.stats.matching_ms,
      renderMs: raw.stats.render_ms,
      compareMs: raw.stats.compare_ms,
      regionMs: raw.stats.region_ms,
      semanticMs: raw.stats.semantic_ms,
      totalMs: raw.stats.total_ms,
    },
  }
}

function mapDocumentSetResult(raw: NativeDocumentSetResult): PiffDocumentSetResult {
  return {
    schemaVersion: raw.schema_version,
    primitive: raw.primitive,
    engine: mapEngine(raw.engine),
    equal: raw.equal,
    strategy: raw.strategy,
    revisions: raw.revisions.map((revision) => ({
      id: revision.id,
      label: revision.label,
      index: revision.index,
      pageCount: revision.page_count ?? undefined,
    })),
    comparisons: raw.comparisons.map((comparison) => ({
      fromRevisionId: comparison.from_revision_id,
      toRevisionId: comparison.to_revision_id,
      equal: comparison.equal,
      changedPages: comparison.changed_pages,
      changedLines: comparison.changed_lines,
      truncated: comparison.truncated,
    })),
    changes: raw.changes.map((change) => ({
      id: change.id,
      source: change.source,
      kind: change.kind,
      pageIndex: change.page_index ?? undefined,
      structure: change.structure ?? undefined,
      anchors: change.anchors.map((anchor) => ({
        id: anchor.id,
        revisionId: anchor.revision_id,
        source: anchor.source,
        state: anchor.state,
        pageIndex: anchor.page_index ?? undefined,
        pageStatus: anchor.page_status ?? undefined,
        blockId: anchor.block_id ?? undefined,
        figureId: anchor.figure_id ?? undefined,
        structure: anchor.structure ?? undefined,
        confidence: anchor.confidence ?? undefined,
        text: anchor.text ?? undefined,
        bounds: anchor.bounds ?? undefined,
        focusBounds: anchor.focus_bounds ?? undefined,
      })),
      variants: change.variants.map((variant) => ({
        id: variant.id,
        text: variant.text ?? undefined,
        revisionIds: variant.revision_ids,
        anchorIds: variant.anchor_ids,
      })),
      comparisons: change.comparisons.map((comparison) => ({
        fromRevisionId: comparison.from_revision_id,
        toRevisionId: comparison.to_revision_id,
        kind: comparison.kind,
        textDiff: comparison.text_diff == null
          ? undefined
          : mapTextDiff(comparison.text_diff),
      })),
      visual: change.visual == null
        ? undefined
        : {
            changedPixels: change.visual.changed_pixels,
            changedRatio: change.visual.changed_ratio,
            regions: change.visual.regions.map((region) => ({
              id: region.id,
              bounds: region.bounds,
              changedPixels: region.changed_pixels,
              beforeContentPixels: region.before_content_pixels,
              afterContentPixels: region.after_content_pixels,
            })),
          },
    })),
    truncated: raw.truncated,
    stats: {
      loadMs: raw.stats.load_ms,
      fingerprintMs: raw.stats.fingerprint_ms,
      matchingMs: raw.stats.matching_ms,
      renderMs: raw.stats.render_ms,
      compareMs: raw.stats.compare_ms,
      regionMs: raw.stats.region_ms,
      semanticMs: raw.stats.semantic_ms,
      totalMs: raw.stats.total_ms,
    },
  }
}

function mapEngine(raw: NativeEngineInfo): PdfEngineInfo {
  return {
    name: raw.name,
    version: raw.version,
    renderer: raw.renderer,
    binding: raw.binding,
    pdfiumApi: raw.pdfium_api ?? 'unknown',
    pdfiumVersion: raw.pdfium_version ?? undefined,
  }
}

function normalizeMaxPreviewCacheBytes(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_PREVIEW_CACHE_BYTES
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new PiffError(
      'invalid-options',
      'maxPreviewCacheBytes must be a non-negative safe integer',
    )
  }
  return normalized
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
      side: item.side,
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

function mapRegion(region: NativeResult['pages'][number]['regions'][number]): PiffRegion {
  return {
    id: region.id,
    bounds: region.bounds,
    changedPixels: region.changed_pixels,
    beforeContentPixels: region.before_content_pixels,
    afterContentPixels: region.after_content_pixels,
  }
}

function toPiffError(error: unknown): PiffError {
  if (error instanceof PiffError) return error
  const message = error instanceof Error ? error.message : String(error)
  const nativeCode = error !== null && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  if (typeof nativeCode === 'string' && isPiffErrorCode(nativeCode)) {
    return new PiffError(nativeCode, message, error)
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new PiffError('cancelled', message, error)
  }

  const normalized = message.toLowerCase()
  const code: PiffErrorCode = normalized.includes('native module')
    ? 'native-module'
    : normalized.includes('cancel') || normalized.includes('aborted')
      ? 'cancelled'
      : normalized.includes('invalid document set')
        ? 'invalid-options'
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
  return new PiffError(code, message, error)
}

function isPiffErrorCode(value: string): value is PiffErrorCode {
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
  throw new PiffError('cancelled', 'PDF comparison aborted')
}

function validatePreviewRequest(
  pageIndex: number,
  options: PdfPagePreviewOptions | undefined,
): void {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
    throw new PiffError('page-index-out-of-bounds', 'pageIndex must be a non-negative safe integer')
  }
  if (options?.format !== undefined && options.format !== 'png') {
    throw new PiffError('invalid-preview-view', `Unsupported page preview format: ${options.format}`)
  }
  if (options?.view !== undefined && !['before', 'after', 'diff'].includes(options.view)) {
    throw new PiffError('invalid-preview-view', `Unsupported page preview view: ${options.view}`)
  }
}

export type {
  PiffBounds,
  PiffOptions,
  PiffCacheDiagnostics,
  PiffProgress,
  PiffProgressPhase,
  PiffRunOptions,
  PiffSessionOptions,
  PdfPagePreviewOptions,
  PdfPagePreviewView,
  PdfPagePreviewTiming,
  PiffRegion,
  PdfFigureDiff,
  PiffResult,
  PdfEngineInfo,
  PiffStats,
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
  PdfReviewSide,
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
  PdfChangeOperation,
  PdfChangeSource,
  PdfDocumentChangeKind,
  PdfDocumentRevision,
  PdfDocumentSetComparison,
  PdfDocumentSetStrategy,
  PdfRevisionAnchor,
  PdfRevisionChangeState,
  PdfRevisionComparisonDetail,
  PdfRevisionVariant,
  PiffDocumentInput,
  PiffDocumentSetOptions,
  PiffDocumentSetProgress,
  PiffDocumentSetResult,
  PiffDocumentSetRunOptions,
  PiffDocumentSetStats,
} from './types.js'
