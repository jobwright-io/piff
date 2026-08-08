export type PdfPageStatus =
  | 'equal'
  | 'modified'
  | 'inserted'
  | 'deleted'
  | 'moved'

export interface PdfResourceLimits {
  /** Maximum bytes accepted for each input PDF. Defaults to 256 MiB. */
  maxInputBytes?: number
  /** Maximum pages accepted in either input PDF. Defaults to 1,000. */
  maxPages?: number
  /** Maximum raster pixels allowed for one rendered page. Defaults to 25 million. */
  maxPagePixels?: number
}

/** Reading-order policy for positioned semantic text. */
export type PdfReadingOrder = 'auto' | 'rows' | 'columns'

export interface PiffOptions {
  dpi?: number
  pageMatching?: 'index' | 'sequence'
  mode?: 'visual' | 'semantic'
  /** Use conservative detection, row-major order, or column-major order. Defaults to `auto`. */
  readingOrder?: PdfReadingOrder
  /** Unchanged text lines kept around each changed block. Defaults to 3. */
  contextLines?: number
  /** Shared password used to open encrypted before and after PDFs. */
  password?: string
  /** Password for the before PDF; falls back to `password` when omitted. */
  beforePassword?: string
  /** Password for the after PDF; falls back to `password` when omitted. */
  afterPassword?: string
  /** Pass an empty object to opt out of the runtime defaults. */
  limits?: PdfResourceLimits
  channelTolerance?: number
  changedPixelRatio?: number
  /** Maximum translation search radius. Values above 64 are rejected. */
  maxShiftPx?: number
  alignmentSampleStep?: number
  minRegionArea?: number
}

export type PiffProgressPhase =
  | 'loading'
  | 'fingerprinting'
  | 'rendering'
  | 'comparing'

export interface PiffProgress {
  phase: PiffProgressPhase
  completed: number
  total: number
}

export interface PiffRunOptions {
  signal?: AbortSignal
  onProgress?: (event: PiffProgress) => void
}

export interface PdfPagePreviewOptions {
  format?: 'png'
  view?: PdfPagePreviewView
  signal?: AbortSignal
}

export type PdfPagePreviewView = 'before' | 'after' | 'diff'

export interface PdfDocumentSummary {
  pageCount: number
}

/** Engine metadata carried by every completed comparison. */
export interface PdfEngineInfo {
  name: string
  version: string
  renderer: string
  binding: string
}

export interface PiffBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PiffRegion {
  id: string
  /** Bounds are expressed in rendered pixel space; map them to beforeSize/afterSize for page overlays. */
  bounds: PiffBounds
  changedPixels: number
  /** Changed pixels whose before-side sample contains visible page content. */
  beforeContentPixels?: number
  /** Changed pixels whose after-side sample contains visible page content. */
  afterContentPixels?: number
}

export type PdfFigureStatus = 'added' | 'removed' | 'modified' | 'moved' | 'swapped'

/** Image-backed figure identity evidence extracted from the PDF page object stream. */
export interface PdfFigureDiff {
  id: string
  status: PdfFigureStatus
  beforeBounds?: PdfSemanticBounds
  afterBounds?: PdfSemanticBounds
  confidence: number
}

export interface PdfPageAlignment {
  offsetX: number
  offsetY: number
  confidence: number
}

/** Unscaled PDF page dimensions used to place semantic change markers. */
export interface PdfPageGeometry {
  width: number
  height: number
}

/** Machine-readable evidence caveats attached to an individual page comparison. */
export type PdfPageWarning =
  | 'low-alignment-confidence'
  | 'content-reordered'
  | 'text-unavailable'
  | 'text-partial'
  | 'text-suspect'
  | 'text-diff-truncated'
  | 'text-changes-truncated'
  | 'page-geometry-changed'
  | 'semantic-visual-disagreement'

export interface PdfPageDiff {
  beforePage?: number
  afterPage?: number
  status: PdfPageStatus
  beforeSize?: PdfPageGeometry
  afterSize?: PdfPageGeometry
  width: number
  height: number
  changedPixels: number
  changedRatio: number
  alignment: PdfPageAlignment
  regions: PiffRegion[]
  figures: PdfFigureDiff[]
  warnings: PdfPageWarning[]
  semantic?: PdfSemanticPageDiff
}

export type PdfSemanticChangeKind = 'added' | 'removed' | 'modified' | 'moved' | 'reflowed'

export interface PdfSemanticBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PdfSemanticTextChange {
  id: string
  kind: PdfSemanticChangeKind
  beforeText?: string
  afterText?: string
  beforeBounds?: PdfSemanticBounds
  afterBounds?: PdfSemanticBounds
  /** The focused changed-word bounds when character-level extraction is available. */
  beforeFocusBounds?: PdfSemanticBounds
  afterFocusBounds?: PdfSemanticBounds
}

export type PdfSemanticTextBlockKind = 'paragraph' | 'list-item' | 'table-row'

/** Conservative document-level role inferred from repeated edge-positioned text. */
export type PdfSemanticTextBlockRole = 'body' | 'header' | 'footer'

export interface PdfSemanticPageDiff {
  equal: boolean
  beforeCharCount: number
  afterCharCount: number
  changes: PdfSemanticTextChange[]
  /** Grouped review changes with side-aware anchors and block-scoped inline hunks. */
  blocks: PdfSemanticTextBlockDiff[]
  /** True when the positioned-text change list was bounded to protect the runtime. */
  changesTruncated: boolean
  quality: PdfTextExtractionQuality
  beforeExtraction: PdfTextExtractionSummary
  afterExtraction: PdfTextExtractionSummary
  /** Git-like page text diff with context and inline word spans. */
  textDiff?: PdfTextDiff
}

export type PdfTextExtractionStatus = 'empty' | 'text' | 'suspect'
export type PdfTextExtractionQuality = 'empty' | 'text' | 'partial' | 'suspect'

export interface PdfTextExtractionSummary {
  status: PdfTextExtractionStatus
  runCount: number
  charCount: number
  replacementCharCount: number
  error?: string
}

export type PdfTextDiffLineKind = 'context' | 'added' | 'removed'
export type PdfTextDiffSpanKind = 'equal' | 'added' | 'removed'

export interface PdfTextDiffSpan {
  kind: PdfTextDiffSpanKind
  text: string
}

export interface PdfTextDiffLine {
  kind: PdfTextDiffLineKind
  beforeLine?: number
  afterLine?: number
  text: string
  spans: PdfTextDiffSpan[]
}

export interface PdfTextDiffHunk {
  beforeStart: number
  afterStart: number
  lines: PdfTextDiffLine[]
}

export interface PdfTextDiff {
  changedLines: number
  /** True when the bounded diff matrix was exceeded and hunks were omitted. */
  truncated: boolean
  hunks: PdfTextDiffHunk[]
}

/** Canonical review unit for semantic text comparison. */
export interface PdfSemanticTextBlockDiff extends PdfSemanticTextChange {
  structure: PdfSemanticTextBlockKind
  confidence: number
  beforeRole?: PdfSemanticTextBlockRole
  afterRole?: PdfSemanticTextBlockRole
  textDiff: PdfTextDiff
}

/** Flattened, page-aware canonical operation sequence for inline review. */
export interface PdfDocumentReviewItem extends Omit<PdfSemanticTextBlockDiff, 'id'> {
  id: string
  pageIndex: number
  beforePage?: number
  afterPage?: number
  pageStatus: PdfPageStatus
  blockId: string
}

/** A page-ordered text diff suitable for inline document review. */
export interface PdfDocumentTextDiffPage {
  beforePage?: number
  afterPage?: number
  status: PdfPageStatus
  blocks: PdfSemanticTextBlockDiff[]
  textDiff?: PdfTextDiff
}

export interface PdfDocumentTextDiff {
  changedLines: number
  /** True when any page-level semantic evidence was bounded. */
  truncated: boolean
  pages: PdfDocumentTextDiffPage[]
  /** Canonical block operations in paired document order. */
  stream: PdfDocumentReviewItem[]
}

export interface PiffStats {
  renderMs: number
  compareMs: number
  totalMs: number
}

export interface PiffResult {
  schemaVersion: number
  engine: PdfEngineInfo
  equal: boolean
  before: PdfDocumentSummary
  after: PdfDocumentSummary
  pages: PdfPageDiff[]
  /** Present when mode is semantic; pages preserve document order and page boundaries. */
  textDiff?: PdfDocumentTextDiff
  stats: PiffStats
}
