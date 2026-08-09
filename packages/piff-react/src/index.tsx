import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  CSSProperties,
  KeyboardEvent,
  RefObject,
} from 'react'
import type {
  PiffBounds,
  PiffResult,
  PdfFigureDiff,
  PdfPageDiff,
  PdfPageGeometry,
  PdfPagePreviewView,
  PdfPageWarning,
  PdfSemanticTextChange,
  PdfTextDiffHunk,
  PdfTextDiffLine,
} from '@jobwright-io/piffjs'

export interface PiffPreviewRequest {
  view: PdfPagePreviewView
}

export type PiffPreview = Uint8Array | Blob | string

export type PiffPreviewLoader = (
  pageIndex: number,
  request: PiffPreviewRequest,
) => Promise<PiffPreview>

export interface PiffViewerProps {
  result: PiffResult
  loadPreview: PiffPreviewLoader
  initialPage?: number
  initialView?: PdfPagePreviewView
  initialMode?: PiffViewerMode
  title?: string
  className?: string
}

export type PiffViewerMode = 'review' | 'visual' | 'text'

export type PdfReviewChangeType = 'added' | 'removed' | 'modified' | 'moved' | 'reflowed' | 'swapped' | 'visual' | 'page'

export interface PdfReviewChange {
  id: string
  kind: 'text' | 'visual' | 'page'
  type: PdfReviewChangeType
  label: string
  operationId?: string
  operationLabel?: string
  beforeText?: string
  afterText?: string
  beforeBounds?: PiffBounds
  afterBounds?: PiffBounds
  changedPixels?: number
  confidence?: number
  textHunks?: PdfTextDiffHunk[]
}

export interface PdfReviewOperation {
  id: string
  type: PdfReviewChangeType
  label: string
  changes: PdfReviewChange[]
}

interface PreviewState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  source?: string
}

const VIEW_LABELS: Record<PdfPagePreviewView, string> = {
  before: 'Before',
  diff: 'Diff',
  after: 'After',
}

export function PiffViewer({
  result,
  loadPreview,
  initialPage,
  initialView = 'diff',
  initialMode = 'review',
  title = 'Document comparison',
  className,
}: PiffViewerProps) {
  const firstChangedPage = result.pages.findIndex((page) => page.status !== 'equal')
  const defaultPage = firstChangedPage >= 0 ? firstChangedPage : 0
  const [selectedPage, setSelectedPage] = useState(
    clampPage(initialPage ?? defaultPage, result.pages.length),
  )
  const [view, setView] = useState<PdfPagePreviewView>(initialView)
  const [mode, setMode] = useState<PiffViewerMode>(initialMode)
  const [selectedChangeKey, setSelectedChangeKey] = useState<string | undefined>()
  const [focusMode, setFocusMode] = useState(false)

  useEffect(() => {
    setSelectedPage(clampPage(initialPage ?? defaultPage, result.pages.length))
  }, [defaultPage, initialPage, result.pages.length])

  const changedPages = useMemo(
    () => result.pages.filter((page) => page.status !== 'equal'),
    [result.pages],
  )
  const changedPixels = useMemo(
    () => changedPages.reduce((total, page) => total + page.changedPixels, 0),
    [changedPages],
  )
  const selected = result.pages[selectedPage]
  const reviewItems = useMemo(
    () => result.pages.flatMap((page, pageIndex) => buildReviewOperations(buildReviewChanges(page)).map((operation) => ({
      key: `${pageIndex}:${operation.id}`,
      pageIndex,
      operation,
      change: operation.changes[0],
    }))),
    [result.pages],
  )
  const selectedChanges = selected === undefined ? [] : buildReviewChanges(selected)
  const selectedChange = selectedChanges.find((change) => `${selectedPage}:${change.id}` === selectedChangeKey)
    ?? selectedChanges[0]
  const selectedOperations = useMemo(
    () => buildReviewOperations(selectedChanges),
    [selectedChanges],
  )
  const selectedOperation = selectedChange === undefined
    ? undefined
    : selectedOperations.find((operation) => operation.changes.some((change) => change.id === selectedChange.id))
  const selectedReviewIndex = selectedChange === undefined
    ? -1
    : reviewItems.findIndex((item) => item.key === `${selectedPage}:${selectedOperation?.id}`)

  const selectPage = useCallback((pageIndex: number) => {
    setSelectedPage(pageIndex)
    const firstChange = reviewItems.find((item) => item.pageIndex === pageIndex)
    setSelectedChangeKey(firstChange?.key)
  }, [reviewItems])

  const selectChange = useCallback((pageIndex: number, changeId: string) => {
    setSelectedPage(pageIndex)
    setSelectedChangeKey(`${pageIndex}:${changeId}`)
  }, [])

  const selectAdjacentChange = useCallback((direction: number) => {
    if (reviewItems.length === 0) return
    const start = selectedReviewIndex >= 0 ? selectedReviewIndex : 0
    const next = Math.min(Math.max(start + direction, 0), reviewItems.length - 1)
    const item = reviewItems[next]
    selectChange(item.pageIndex, item.change.id)
  }, [reviewItems, selectedReviewIndex, selectChange])

  useEffect(() => {
    if (selectedChangeKey !== undefined && reviewItems.some((item) => item.key === selectedChangeKey)) return
    const firstChange = reviewItems.find((item) => item.pageIndex === selectedPage) ?? reviewItems[0]
    setSelectedChangeKey(firstChange?.key)
  }, [reviewItems, selectedChangeKey, selectedPage])

  return (
    <section
      className={joinClasses('piff-viewer', className)}
      data-piff-viewer="true"
      aria-label="PDF comparison viewer"
    >
      <header className="piff-viewer__header">
        <div>
          <div className="piff-viewer__kicker">
            <span>PDF / DIFF REGISTER</span>
            <span className="piff-viewer__kicker-rule" aria-hidden="true" />
            <span>{result.equal ? 'CLEAN' : 'MARKS DETECTED'}</span>
          </div>
          <h2>{title}</h2>
        </div>
        <div className={joinClasses('piff-viewer__verdict', result.equal ? 'is-clean' : 'is-changed')}>
          <span className="piff-viewer__verdict-dot" aria-hidden="true" />
          <span>{result.equal ? 'No visual changes' : `${changedPages.length} page${changedPages.length === 1 ? '' : 's'} changed`}</span>
        </div>
      </header>

      <div className="piff-viewer__toolbar">
        <div className="piff-viewer__toolbar-controls">
          <div className="piff-viewer__view-switcher" role="tablist" aria-label="Comparison mode">
            <button
              className={joinClasses('piff-viewer__view-button', mode === 'review' && 'is-active')}
              type="button"
              role="tab"
              aria-selected={mode === 'review'}
              onClick={() => setMode('review')}
            >
              Review
            </button>
            <button
              className={joinClasses('piff-viewer__view-button', mode === 'text' && 'is-active')}
              type="button"
              role="tab"
              aria-selected={mode === 'text'}
              onClick={() => setMode('text')}
            >
              Text details
            </button>
            <button
              className={joinClasses('piff-viewer__view-button', mode === 'visual' && 'is-active')}
              type="button"
              role="tab"
              aria-selected={mode === 'visual'}
              onClick={() => setMode('visual')}
            >
              Pixel proof
            </button>
          </div>
          {mode === 'visual' ? (
            <div className="piff-viewer__view-switcher" role="tablist" aria-label="Preview view">
              {(Object.keys(VIEW_LABELS) as PdfPagePreviewView[]).map((option) => (
                <button
                  key={option}
                  className={joinClasses('piff-viewer__view-button', view === option && 'is-active')}
                  type="button"
                  role="tab"
                  aria-selected={view === option}
                  onClick={() => setView(option)}
                >
                  {VIEW_LABELS[option]}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="piff-viewer__toolbar-meta">
          {mode === 'review' ? (
            <>
              <span>{reviewItems.length} review operation{reviewItems.length === 1 ? '' : 's'}</span>
              <span>{changedPages.length} changed page{changedPages.length === 1 ? '' : 's'}</span>
            </>
          ) : mode === 'text' ? (
            <>
              <span>{countTextPages(result)} text pages</span>
              <span>{countTextHunks(result)} hunks</span>
            </>
          ) : (
            <>
              <span>{result.pages.length} pages</span>
              <span>{formatNumber(changedPixels)} changed pixels</span>
            </>
          )}
        </div>
      </div>

      <div className="piff-viewer__layout">
        <nav className="piff-viewer__rail" aria-label="Pages">
          <div className="piff-viewer__rail-label">PAGES</div>
          <div className="piff-viewer__rail-list">
            {result.pages.map((page, index) => (
              <PageRailItem
                key={`${page.beforePage ?? 'x'}-${page.afterPage ?? 'x'}-${index}`}
                page={page}
                index={index}
                selected={selectedPage === index}
                operationCount={buildReviewOperations(buildReviewChanges(page)).length}
                onSelect={() => selectPage(index)}
                onKeyDown={(event) => handleRailKeyDown(event, index, result.pages.length, setSelectedPage)}
              />
            ))}
          </div>
        </nav>

        <main className="piff-viewer__stage">
          {mode === 'review' ? (
            <ReviewDocument
              page={selected}
              index={selectedPage}
              changes={selectedChanges}
              selectedChange={selectedChange}
              selectedReviewIndex={selectedReviewIndex}
              reviewCount={reviewItems.length}
              focusMode={focusMode}
              loadPreview={loadPreview}
              onSelectChange={(changeId) => selectChange(selectedPage, changeId)}
              onPrevious={() => selectAdjacentChange(-1)}
              onNext={() => selectAdjacentChange(1)}
              onToggleFocus={() => setFocusMode((active) => !active)}
            />
          ) : mode === 'text' ? (
            <PdfTextDiffDocument result={result} onSelectPage={setSelectedPage} />
          ) : result.pages.length === 0 ? (
            <div className="piff-viewer__empty">
              <span className="piff-viewer__empty-mark" aria-hidden="true">∅</span>
              <strong>No pages to compare</strong>
              <span>The two documents contain no renderable pages.</span>
            </div>
          ) : (
            <div className="piff-viewer__page-stack">
              {result.pages.map((page, index) => (
                <PageCard
                  key={`${page.beforePage ?? 'x'}-${page.afterPage ?? 'x'}-${index}`}
                  page={page}
                  index={index}
                  view={view}
                  selected={selectedPage === index}
                  loadPreview={loadPreview}
                  onSelect={() => setSelectedPage(index)}
                />
              ))}
            </div>
          )}
        </main>

        <aside className="piff-viewer__inspector" aria-label="Selected page details">
          {mode === 'review' && selected ? (
            <ReviewInspector
              page={selected}
              index={selectedPage}
              changes={selectedChanges}
              selectedChange={selectedChange}
              selectedOperation={selectedOperation}
              onSelectChange={(changeId) => selectChange(selectedPage, changeId)}
              onOpenText={() => setMode('text')}
            />
          ) : selected ? (
            <PageInspector page={selected} index={selectedPage} />
          ) : (
            <div className="piff-viewer__inspector-empty">Select a page to inspect its marks.</div>
          )}
        </aside>
      </div>
    </section>
  )
}

interface PageRailItemProps {
  page: PdfPageDiff
  index: number
  selected: boolean
  operationCount: number
  onSelect: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}

function PageRailItem({ page, index, selected, operationCount, onSelect, onKeyDown }: PageRailItemProps) {
  return (
    <button
      className={joinClasses('piff-viewer__rail-item', selected && 'is-selected', `is-${page.status}`)}
      type="button"
      aria-current={selected ? 'page' : undefined}
      aria-label={`Page ${index + 1}, ${statusLabel(page.status)}, ${operationCount} review operations`}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <span className="piff-viewer__rail-index">{String(index + 1).padStart(2, '0')}</span>
      <span className="piff-viewer__rail-status">{statusLabel(page.status)}</span>
      <span className="piff-viewer__rail-ratio">{operationCount > 0 ? `${operationCount} operation${operationCount === 1 ? '' : 's'}` : page.status === 'equal' ? 'unchanged' : formatRatio(page.changedRatio)}</span>
    </button>
  )
}

interface ReviewDocumentProps {
  page: PdfPageDiff | undefined
  index: number
  changes: PdfReviewChange[]
  selectedChange: PdfReviewChange | undefined
  selectedReviewIndex: number
  reviewCount: number
  focusMode: boolean
  loadPreview: PiffPreviewLoader
  onSelectChange: (changeId: string) => void
  onPrevious: () => void
  onNext: () => void
  onToggleFocus: () => void
}

function ReviewDocument({
  page,
  index,
  changes,
  selectedChange,
  selectedReviewIndex,
  reviewCount,
  focusMode,
  loadPreview,
  onSelectChange,
  onPrevious,
  onNext,
  onToggleFocus,
}: ReviewDocumentProps) {
  const beforePreview = usePagePreview(index, 'before', loadPreview, page !== undefined)
  const afterPreview = usePagePreview(index, 'after', loadPreview, page !== undefined)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const beforePaperRef = useRef<HTMLDivElement | null>(null)
  const afterPaperRef = useRef<HTMLDivElement | null>(null)
  const [relationshipLayer, setRelationshipLayer] = useState<ReviewRelationshipLayer | undefined>()
  const [layoutRevision, setLayoutRevision] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setLayoutRevision((revision) => revision + 1))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [page])

  useLayoutEffect(() => {
    if (page === undefined || typeof window === 'undefined') {
      setRelationshipLayer(undefined)
      return
    }
    const frame = window.requestAnimationFrame(() => {
      setRelationshipLayer(measureReviewRelationships(
        canvasRef.current,
        beforePaperRef.current,
        afterPaperRef.current,
        changes,
        selectedChange,
      ))
    })
    return () => window.cancelAnimationFrame(frame)
  }, [afterPreview.source, afterPreview.status, beforePreview.source, beforePreview.status, changes, focusMode, layoutRevision, page, selectedChange?.id])

  if (page === undefined) {
    return <div className="piff-viewer__empty"><strong>No pages to compare</strong><span>The two documents contain no renderable pages.</span></div>
  }

  const operations = buildReviewOperations(changes)
  const focusAvailable = selectedChange?.beforeBounds !== undefined || selectedChange?.afterBounds !== undefined
  const beforeFocusBounds = focusMode && selectedChange !== undefined
    ? focusCropFor(selectedChange.beforeBounds, pageGeometryFor(page, 'before'))
    : undefined
  const afterFocusBounds = focusMode && selectedChange !== undefined
    ? focusCropFor(selectedChange.afterBounds, pageGeometryFor(page, 'after'))
    : undefined

  return (
    <div className="piff-viewer__review-document">
      <div className="piff-viewer__review-topline">
        <div>
          <span className="piff-viewer__review-eyebrow">PAGE {String(index + 1).padStart(2, '0')}</span>
          <strong>{statusLabel(page.status)}</strong>
          <span>{operations.length === 0 ? 'No review operations' : `${operations.length} review operation${operations.length === 1 ? '' : 's'} on this page${changes.length !== operations.length ? ` · ${changes.length} linked marks` : ''}`}</span>
        </div>
        <div className="piff-viewer__review-actions">
          <button
            className={joinClasses('piff-viewer__focus-toggle', focusMode && 'is-active')}
            type="button"
            data-focus-toggle="true"
            aria-pressed={focusMode}
            disabled={!focusAvailable}
            onClick={onToggleFocus}
          >
            {focusMode ? 'Show full page' : 'Focus change'}
          </button>
          <div className="piff-viewer__change-nav" aria-label="Review change navigation">
            <button type="button" onClick={onPrevious} disabled={reviewCount === 0 || selectedReviewIndex <= 0} aria-label="Previous change">←</button>
            <span>{reviewCount === 0 || selectedReviewIndex < 0 ? 'No changes' : `${selectedReviewIndex + 1} / ${reviewCount}`}</span>
            <button type="button" onClick={onNext} disabled={reviewCount === 0 || selectedReviewIndex >= reviewCount - 1} aria-label="Next change">→</button>
          </div>
        </div>
      </div>
      <div ref={canvasRef} className="piff-viewer__review-canvas" data-status={page.status} data-focus-mode={focusMode ? 'true' : 'false'}>
        <ReviewPagePane
          page={page}
          side="before"
          preview={beforePreview}
          changes={changes}
          selectedChange={selectedChange}
          focusBounds={beforeFocusBounds}
          paperRef={beforePaperRef}
          onSelectChange={onSelectChange}
        />
        <div className="piff-viewer__review-divider" aria-hidden="true">
          <span>COMPARE</span>
        </div>
        <ReviewPagePane
          page={page}
          side="after"
          preview={afterPreview}
          changes={changes}
          selectedChange={selectedChange}
          focusBounds={afterFocusBounds}
          paperRef={afterPaperRef}
          onSelectChange={onSelectChange}
        />
        <ReviewRelationshipLayer layer={relationshipLayer} />
      </div>
      <div className="piff-viewer__review-caption">
        <span>{focusMode ? 'Focus view follows the selected operation. Switch back to the full page when context matters.' : 'Select a mark to trace its relationship across both pages. Focus change opens a synchronized crop.'}</span>
        <span>{formatRatio(page.changedRatio)} raster area</span>
      </div>
    </div>
  )
}

interface ReviewPagePaneProps {
  page: PdfPageDiff
  side: 'before' | 'after'
  preview: PreviewState
  changes: PdfReviewChange[]
  selectedChange: PdfReviewChange | undefined
  focusBounds: PiffBounds | undefined
  paperRef: RefObject<HTMLDivElement | null>
  onSelectChange: (changeId: string) => void
}

function ReviewPagePane({ page, side, preview, changes, selectedChange, focusBounds, paperRef, onSelectChange }: ReviewPagePaneProps) {
  const geometry = pageGeometryFor(page, side)
  const displayGeometry = focusBounds ?? geometry
  const pageNumber = side === 'before' ? page.beforePage : page.afterPage
  const hasPage = pageNumber !== undefined
  const visibleChanges = changes.filter((change) => (side === 'before' ? change.beforeBounds : change.afterBounds) !== undefined)

  return (
    <div className={joinClasses('piff-viewer__review-pane', `is-${side}`, !hasPage && 'is-empty')}>
      <div className="piff-viewer__review-pane-head">
        <span>{side === 'before' ? 'BEFORE' : 'AFTER'}</span>
        <strong>{hasPage ? `PAGE ${String(pageNumber + 1).padStart(2, '0')}` : side === 'before' ? 'NO PAGE' : 'NEW PAGE'}</strong>
      </div>
      <div
        ref={paperRef}
        className={joinClasses('piff-viewer__review-paper', focusBounds !== undefined && 'is-focused')}
        data-review-paper={side}
        style={{ '--pdf-review-page-ratio': `${Math.max(displayGeometry.width, 1)} / ${Math.max(displayGeometry.height, 1)}` } as CSSProperties}
      >
        {preview.status === 'ready' && preview.source && hasPage ? (
          <img className="piff-viewer__review-image" style={focusImageStyle(geometry, focusBounds)} src={preview.source} alt={`${side} page ${pageNumber + 1}`} />
        ) : (
          <div className={joinClasses('piff-viewer__review-placeholder', `is-${preview.status}`)}>
            <span aria-hidden="true">{hasPage ? (preview.status === 'error' ? '!' : preview.status === 'loading' ? '···' : '○') : '∅'}</span>
            <strong>{hasPage ? previewMessage(preview.status) : side === 'before' ? 'Page was deleted' : 'Page was inserted'}</strong>
          </div>
        )}
        <div className="piff-viewer__review-markers" aria-label={`${side} change markers`}>
          {visibleChanges.map((change, markerIndex) => {
            const bounds = side === 'before' ? change.beforeBounds : change.afterBounds
            if (bounds === undefined) return null
            const markerBounds = focusBounds === undefined
              ? bounds
              : offsetBounds(bounds, -focusBounds.x, -focusBounds.y)
            const selected = selectedChange?.id === change.id
            return (
              <button
                key={`${side}-${change.id}`}
                className={joinClasses('piff-viewer__review-marker', `is-${change.kind}`, selected && 'is-selected')}
                type="button"
                data-review-marker={change.id}
                style={boundsStyle(markerBounds, displayGeometry)}
                aria-label={`${change.label}, change ${markerIndex + 1}`}
                aria-pressed={selected}
                onClick={() => onSelectChange(change.id)}
              >
                <span>{markerIndex + 1}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

interface ReviewRelationship {
  id: string
  path: string
  start: { x: number; y: number }
  end: { x: number; y: number }
  selected: boolean
  related: boolean
}

interface ReviewRelationshipLayer {
  width: number
  height: number
  relationships: ReviewRelationship[]
}

function ReviewRelationshipLayer({ layer }: { layer: ReviewRelationshipLayer | undefined }) {
  if (layer === undefined || layer.relationships.length === 0) return null
  return (
    <svg
      className="piff-viewer__review-links"
      data-review-links="true"
      aria-hidden="true"
      viewBox={`0 0 ${layer.width} ${layer.height}`}
      preserveAspectRatio="none"
    >
      {layer.relationships.map((relationship) => (
        <g key={relationship.id} className={joinClasses(relationship.selected && 'is-selected', relationship.related && 'is-related')}>
          <path d={relationship.path} />
          <circle cx={relationship.start.x} cy={relationship.start.y} r={relationship.selected ? 4 : 3} />
          <circle cx={relationship.end.x} cy={relationship.end.y} r={relationship.selected ? 4 : 3} />
        </g>
      ))}
    </svg>
  )
}

function ReviewInspector({
  page,
  index,
  changes,
  selectedChange,
  selectedOperation,
  onSelectChange,
  onOpenText,
}: {
  page: PdfPageDiff
  index: number
  changes: PdfReviewChange[]
  selectedChange: PdfReviewChange | undefined
  selectedOperation: PdfReviewOperation | undefined
  onSelectChange: (changeId: string) => void
  onOpenText: () => void
}) {
  const operations = buildReviewOperations(changes)
  const selectedIndex = selectedOperation === undefined ? -1 : operations.findIndex((operation) => operation.id === selectedOperation.id)
  const semantic = page.semantic

  return (
    <div className="piff-viewer__inspector-content piff-viewer__review-inspector">
      <div className="piff-viewer__inspector-heading">
        <span className="piff-viewer__inspector-kicker">PAGE {String(index + 1).padStart(2, '0')}</span>
        <strong>{statusLabel(page.status)}</strong>
      </div>
      <div className="piff-viewer__review-inspector-count">
        <span>REVIEW OPERATIONS</span>
        <strong>{operations.length}</strong>
        {changes.length !== operations.length ? <small>{changes.length} linked marks</small> : null}
      </div>
      {selectedChange ? (
        <section className="piff-viewer__selected-change" aria-live="polite">
          <div className="piff-viewer__selected-change-meta">
            <span className={`is-${selectedChange.kind}`}>{selectedChange.type}</span>
            <span>{selectedIndex + 1} / {operations.length}</span>
          </div>
          <h3>{selectedOperation?.label ?? selectedChange.label}</h3>
          {selectedOperation && selectedOperation.changes.length > 1 ? (
            <p className="piff-viewer__operation-context">{selectedChange.label} · linked mark {selectedOperation.changes.findIndex((change) => change.id === selectedChange.id) + 1} of {selectedOperation.changes.length}</p>
          ) : null}
          {selectedChange.kind === 'text' && selectedChange.textHunks?.length ? (
            <div className="piff-viewer__local-text-diff">
              <div className="piff-viewer__local-text-diff-heading"><span>LOCAL GIT HUNK</span><span>{selectedChange.textHunks.length} hunk{selectedChange.textHunks.length === 1 ? '' : 's'}</span></div>
              {selectedChange.textHunks.map((hunk, hunkIndex) => <TextDiffHunkView key={`${hunk.beforeStart}-${hunk.afterStart}-${hunkIndex}`} hunk={hunk} />)}
            </div>
          ) : null}
          <div className="piff-viewer__evidence-pair">
            <div className="is-before">
              <span>BEFORE</span>
              <p>{selectedChange.beforeText ?? reviewTextFallback(selectedChange, 'before')}</p>
            </div>
            <div className="is-after">
              <span>AFTER</span>
              <p>{selectedChange.afterText ?? reviewTextFallback(selectedChange, 'after')}</p>
            </div>
          </div>
          {selectedChange.kind === 'text' ? (
            <button className="piff-viewer__detail-button" type="button" onClick={onOpenText}>Open text details</button>
          ) : null}
        </section>
      ) : (
        <p className="piff-viewer__regions-empty">This page has no reportable changes. Select another page or use Pixel proof for raster detail.</p>
      )}
      <dl className="piff-viewer__facts">
        <div><dt>Changed area</dt><dd>{formatRatio(page.changedRatio)}</dd></div>
        <div><dt>Raster marks</dt><dd>{formatNumber(page.regions.length)}</dd></div>
        {page.figures.length > 0 ? <div><dt>Figure evidence</dt><dd>{formatNumber(page.figures.length)}</dd></div> : null}
        {selectedChange?.confidence !== undefined ? <div><dt>Identity confidence</dt><dd>{formatRatio(selectedChange.confidence)}</dd></div> : null}
        <div><dt>Alignment</dt><dd>{formatOffset(page.alignment.offsetX, page.alignment.offsetY)}</dd></div>
        {semantic ? <div><dt>Text quality</dt><dd>{semantic.quality}</dd></div> : null}
      </dl>
      {changes.length > 0 ? (
        <div className="piff-viewer__change-list">
          <div className="piff-viewer__regions-heading"><span>ON THIS PAGE</span><span>{operations.length}</span></div>
          {operations.map((operation, operationIndex) => (
            <button
              key={operation.id}
              className={joinClasses('piff-viewer__change-list-item', selectedOperation?.id === operation.id && 'is-selected')}
              type="button"
              onClick={() => onSelectChange(operation.changes[0].id)}
            >
              <span>{String(operationIndex + 1).padStart(2, '0')}</span>
              <strong>{operation.label}</strong>
              <small>{operation.changes.length > 1 ? `${operation.changes.length} linked marks · select either page marker` : operation.changes[0].afterText ?? operation.changes[0].beforeText ?? 'Visual evidence only'}</small>
            </button>
          ))}
        </div>
      ) : null}
      <PageWarningNotice warnings={page.warnings} />
    </div>
  )
}

function PageWarningNotice({ warnings }: { warnings: PdfPageWarning[] }) {
  if (warnings.length === 0) return null
  return (
    <section className="piff-viewer__warning-notice" role="note" aria-label="Evidence cautions">
      <div className="piff-viewer__warning-heading">EVIDENCE CAUTIONS</div>
      <ul>
        {warnings.map((warning) => <li key={warning}>{pageWarningMessage(warning)}</li>)}
      </ul>
    </section>
  )
}

function pageWarningMessage(warning: PdfPageWarning): string {
  switch (warning) {
    case 'low-alignment-confidence':
      return 'Alignment confidence is low. Inspect Pixel proof before treating small visual differences as meaningful.'
    case 'content-reordered':
      return 'Content was reordered. Figure identity evidence is tracked separately from page alignment.'
    case 'text-unavailable':
      return 'No positioned text was extracted. Text details cannot explain this page.'
    case 'text-partial':
      return 'Text was extracted on only one side of this page.'
    case 'text-suspect':
      return 'Text extraction is suspect. Treat visual proof as authoritative.'
    case 'text-diff-truncated':
      return 'The bounded text diff omitted some hunks.'
    case 'text-changes-truncated':
      return 'The positioned-text change list was bounded.'
    case 'page-geometry-changed':
      return 'The PDF page dimensions changed between revisions.'
    case 'semantic-visual-disagreement':
      return 'Visual pixels align, but text extraction reports a difference. Treat the raster proof as authoritative.'
    case 'visual-not-computed':
      return 'This result contains semantic evidence only. Request a page preview when you need pixel proof.'
  }
}

interface PageCardProps {
  page: PdfPageDiff
  index: number
  view: PdfPagePreviewView
  selected: boolean
  loadPreview: PiffPreviewLoader
  onSelect: () => void
}

function PageCard({ page, index, view, selected, loadPreview, onSelect }: PageCardProps) {
  const [nearViewportRef, nearViewport] = useNearViewport<HTMLDivElement>()
  const preview = usePagePreview(index, view, loadPreview, selected || nearViewport)
  const ratio = page.width > 0 && page.height > 0 ? `${page.width} / ${page.height}` : '1 / 1.414'
  const pageStyle = { '--pdf-page-ratio': ratio } as CSSProperties

  return (
    <article
      ref={nearViewportRef}
      className={joinClasses('piff-page', selected && 'is-selected', `is-${page.status}`)}
      style={pageStyle}
      onClick={onSelect}
    >
      <div className="piff-page__header">
        <span className="piff-page__number">PAGE {String(index + 1).padStart(2, '0')}</span>
        <span className="piff-page__status">{statusLabel(page.status)}</span>
        <span className="piff-page__ratio">{formatRatio(page.changedRatio)} changed</span>
      </div>
      <div className="piff-page__paper">
        {preview.status === 'ready' && preview.source ? (
          <img
            className="piff-page__image"
            src={preview.source}
            alt={`${VIEW_LABELS[view]} preview for page ${index + 1}`}
            loading="lazy"
          />
        ) : (
          <div className={joinClasses('piff-page__placeholder', `is-${preview.status}`)}>
            <span className="piff-page__placeholder-mark" aria-hidden="true">
              {preview.status === 'error' ? '!' : preview.status === 'loading' ? '···' : '○'}
            </span>
            <span>
              {preview.status === 'error'
                ? 'Preview unavailable'
                : preview.status === 'loading'
                  ? 'Rendering page'
                  : 'Scroll to render'}
            </span>
          </div>
        )}
      </div>
    </article>
  )
}

function PageInspector({ page, index }: { page: PdfPageDiff; index: number }) {
  return (
    <div className="piff-viewer__inspector-content">
      <div className="piff-viewer__inspector-heading">
        <span className="piff-viewer__inspector-kicker">SELECTED PAGE</span>
        <strong>{String(index + 1).padStart(2, '0')}</strong>
      </div>
      <dl className="piff-viewer__facts">
        <div><dt>Status</dt><dd>{statusLabel(page.status)}</dd></div>
        <div><dt>Changed area</dt><dd>{formatRatio(page.changedRatio)}</dd></div>
        <div><dt>Changed pixels</dt><dd>{formatNumber(page.changedPixels)}</dd></div>
        <div><dt>Alignment</dt><dd>{formatOffset(page.alignment.offsetX, page.alignment.offsetY)}</dd></div>
        {page.semantic ? (
          <div><dt>Text changes</dt><dd>{formatNumber(page.semantic.changes.length)}</dd></div>
        ) : null}
      </dl>
      <PageWarningNotice warnings={page.warnings} />
      <div className="piff-viewer__regions">
        <div className="piff-viewer__regions-heading">
          <span>REGIONS</span>
          <span>{page.regions.length}</span>
        </div>
        {page.regions.length === 0 ? (
          <p className="piff-viewer__regions-empty">No reportable regions on this page.</p>
        ) : (
          <ol>
            {page.regions.slice(0, 24).map((region) => (
              <li key={region.id}>
                <span>{region.id.replace('region-', '#')}</span>
                <span>{formatBounds(region.bounds.x, region.bounds.y, region.bounds.width, region.bounds.height)}</span>
                <strong>{formatNumber(region.changedPixels)}</strong>
              </li>
            ))}
          </ol>
        )}
        {page.regions.length > 24 ? (
          <p className="piff-viewer__regions-more">+ {page.regions.length - 24} more regions</p>
        ) : null}
      </div>
      <div className="piff-viewer__semantic">
        <TextDiffPanel page={page} />
      </div>
    </div>
  )
}

function TextDiffPanel({ page }: { page: PdfPageDiff }) {
  const semantic = page.semantic
  const textDiff = semantic?.textDiff

  if (semantic === undefined) {
    return (
      <>
        <div className="piff-viewer__regions-heading">
          <span>GIT TEXT DIFF</span>
          <span>—</span>
        </div>
        <p className="piff-viewer__regions-empty">Run semantic mode to inspect document text changes.</p>
      </>
    )
  }

  if (textDiff !== undefined && textDiff.hunks.length > 0) {
    return (
      <>
        <div className="piff-viewer__regions-heading">
          <span>GIT TEXT DIFF</span>
          <span>{textDiff.hunks.length} hunk{textDiff.hunks.length === 1 ? '' : 's'}</span>
        </div>
        <div className="piff-viewer__text-diff" aria-label="Git-like text diff">
          {textDiff.hunks.map((hunk, hunkIndex) => (
            <div className="piff-viewer__text-diff-hunk" key={`${hunk.beforeStart}-${hunk.afterStart}-${hunkIndex}`}>
              <div className="piff-viewer__text-diff-header">
                {formatTextDiffHunk(hunk)}
              </div>
              <div className="piff-viewer__text-diff-lines">
                {hunk.lines.map((line, lineIndex) => (
                  <div className={joinClasses('piff-viewer__text-diff-line', `is-${line.kind}`)} key={`${line.kind}-${line.beforeLine ?? 'x'}-${line.afterLine ?? 'x'}-${lineIndex}`}>
                    <span className="piff-viewer__text-diff-number">{line.beforeLine ?? ''}</span>
                    <span className="piff-viewer__text-diff-number">{line.afterLine ?? ''}</span>
                    <span className="piff-viewer__text-diff-prefix" aria-hidden="true">{linePrefix(line.kind)}</span>
                    <span className="piff-viewer__text-diff-copy">
                      {line.spans.map((span, spanIndex) => (
                        <span className={`is-${span.kind}`} key={`${span.kind}-${spanIndex}`}>{span.text}</span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <TextExtractionNotice semantic={semantic} />
      </>
    )
  }

  return (
    <>
      <div className="piff-viewer__regions-heading">
        <span>TEXT REGISTER</span>
        <span>{semantic.changes.length || '—'}</span>
      </div>
      {semantic.changes.length === 0 ? (
        <>
          <TextExtractionNotice semantic={semantic} />
          <p className="piff-viewer__regions-empty">
            {semantic.quality === 'empty'
              ? 'No extractable text. This page may be scanned or visual-only.'
              : textDiff?.truncated
              ? 'The text diff was bounded before it could produce hunks. Review the page.'
                : 'No positioned text changes on this page.'}
          </p>
        </>
      ) : (
        <ol className="piff-viewer__semantic-list">
          {semantic.changes.slice(0, 16).map((change) => (
            <li key={change.id} className={`is-${change.kind}`}>
              <span className="piff-viewer__semantic-kind">{change.kind}</span>
              <div className="piff-viewer__semantic-copy">
                {change.beforeText ? <span>{change.beforeText}</span> : null}
                {change.beforeText && change.afterText ? <b aria-hidden="true">→</b> : null}
                {change.afterText ? <strong>{change.afterText}</strong> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
      {semantic.changes.length > 16 ? (
        <p className="piff-viewer__regions-more">+ {semantic.changes.length - 16} more text changes</p>
      ) : null}
      {semantic.changes.length > 0 ? <TextExtractionNotice semantic={semantic} /> : null}
    </>
  )
}

function TextExtractionNotice({
  semantic,
}: {
  semantic: NonNullable<PdfPageDiff['semantic']>
}) {
  const messages: string[] = []
  if (semantic.quality === 'partial') {
    messages.push('Text is present on only one side of this page.')
  } else if (semantic.quality === 'suspect') {
    messages.push(
      `Text extraction is suspect${semantic.beforeExtraction.replacementCharCount + semantic.afterExtraction.replacementCharCount > 0 ? ` (${semantic.beforeExtraction.replacementCharCount + semantic.afterExtraction.replacementCharCount} replacement characters)` : ''}.`,
    )
  }
  if (semantic.textDiff?.truncated === true) {
    messages.push('The bounded text diff omitted hunks for this page.')
  }
  if (semantic.changesTruncated) {
    messages.push('The positioned-text change list was bounded.')
  }
  if (messages.length === 0) return null
  return <p className="piff-viewer__text-notice">{messages.join(' ')} Review the page for authoritative visual evidence.</p>
}

function formatTextDiffHunk(hunk: PdfTextDiffHunk): string {
  const beforeCount = hunk.lines.filter((line) => line.kind !== 'added').length
  const afterCount = hunk.lines.filter((line) => line.kind !== 'removed').length
  return `@@ -${hunk.beforeStart},${beforeCount} +${hunk.afterStart},${afterCount} @@`
}

function linePrefix(kind: 'context' | 'added' | 'removed'): string {
  return kind === 'added' ? '+' : kind === 'removed' ? '−' : ' '
}

function PdfTextDiffDocument({
  result,
  onSelectPage,
}: {
  result: PiffResult
  onSelectPage: (index: number) => void
}) {
  const textPages = result.pages.flatMap((page, index) => {
    const textDiff = page.semantic?.textDiff
    return textDiff !== undefined && textDiff.hunks.length > 0
      ? [{ page, index, textDiff }]
      : []
  })
  const visualOnlyPages = result.pages.flatMap((page, index) => (
    page.status !== 'equal'
      && (page.semantic?.textDiff?.hunks.length ?? 0) === 0
      && page.semantic?.textDiff?.truncated !== true
      ? [index]
      : []
  ))
  const boundedPages = result.pages.flatMap((page, index) => (
    page.semantic?.textDiff?.truncated === true ? [index] : []
  ))
  const hunkCount = textPages.reduce((total, entry) => total + entry.textDiff.hunks.length, 0)
  const unchangedPages = result.pages.length
    - textPages.length
    - visualOnlyPages.length
    - boundedPages.length

  return (
    <div className="piff-viewer__text-document" data-piff-text="true">
      <header className="piff-viewer__text-document-head">
        <div>
          <div className="piff-viewer__text-document-kicker">DOCUMENT / UNIFIED DIFF</div>
          <h3>What changed in the document.</h3>
        </div>
        <div className="piff-viewer__text-document-summary">
          <strong>{textPages.length} text page{textPages.length === 1 ? '' : 's'}</strong>
          <span>{hunkCount} hunk{hunkCount === 1 ? '' : 's'} · inline word marks</span>
        </div>
      </header>
      <div className="piff-viewer__text-file-strip">
        <strong>BEFORE DOCUMENT</strong>
        <span aria-hidden="true">→</span>
        <strong>AFTER DOCUMENT</strong>
      </div>
      <div className="piff-viewer__text-legend">
        <span className="is-removed">removed</span>
        <span className="is-added">added</span>
        <span>context retained</span>
      </div>
      {textPages.length === 0 ? (
        <div className="piff-viewer__text-empty">
          {boundedPages.length > 0
            ? 'Text diff was bounded on one or more pages. Switch to Review for authoritative page evidence.'
            : 'No text changes. Switch to Review for visual-only marks.'}
        </div>
      ) : (
        textPages.map(({ page, index, textDiff }) => (
          <section className="piff-viewer__text-page" key={index}>
            <button className="piff-viewer__text-page-heading" type="button" onClick={() => onSelectPage(index)}>
              <strong>PAGE {String(index + 1).padStart(2, '0')}</strong>
              <span>{statusLabel(page.status)}</span>
              <span>{textDiff.hunks.length} hunk{textDiff.hunks.length === 1 ? '' : 's'}</span>
            </button>
            <div className="piff-viewer__text-hunks">
              {textDiff.hunks.map((hunk, hunkIndex) => (
                <TextDiffHunkView key={`${hunk.beforeStart}-${hunk.afterStart}-${hunkIndex}`} hunk={hunk} />
              ))}
            </div>
          </section>
        ))
      )}
      {visualOnlyPages.length > 0 ? (
        <div className="piff-viewer__text-foot">
          <span>Visual-only changes</span>
          <strong>{visualOnlyPages.map((index) => `page ${index + 1}`).join(', ')}</strong>
        </div>
      ) : null}
      {boundedPages.length > 0 ? (
        <div className="piff-viewer__text-foot">
          <span>Text diff bounded</span>
          <strong>{boundedPages.map((index) => `page ${index + 1}`).join(', ')}</strong>
        </div>
      ) : null}
      {unchangedPages > 0 ? (
        <div className="piff-viewer__text-foot">
          <span>Unchanged pages omitted from unified diff</span>
          <strong>{unchangedPages}</strong>
        </div>
      ) : null}
    </div>
  )
}

function TextDiffHunkView({ hunk }: { hunk: PdfTextDiffHunk }) {
  const beforeCount = hunk.lines.filter((line) => line.kind !== 'added').length
  const afterCount = hunk.lines.filter((line) => line.kind !== 'removed').length

  return (
    <div className="piff-viewer__text-hunk">
      <div className="piff-viewer__text-hunk-header">
        {`@@ -${hunk.beforeStart},${beforeCount} +${hunk.afterStart},${afterCount} @@`}
      </div>
      <div className="piff-viewer__text-lines">
        {hunk.lines.map((line, lineIndex) => (
          <TextDiffLineView key={`${line.kind}-${line.beforeLine ?? 'x'}-${line.afterLine ?? 'x'}-${lineIndex}`} line={line} />
        ))}
      </div>
    </div>
  )
}

function TextDiffLineView({ line }: { line: PdfTextDiffLine }) {
  return (
    <div className={joinClasses('piff-viewer__text-line', `is-${line.kind}`)}>
      <span className="piff-viewer__text-line-number">{line.beforeLine ?? ''}</span>
      <span className="piff-viewer__text-line-number">{line.afterLine ?? ''}</span>
      <span className="piff-viewer__text-line-prefix" aria-hidden="true">{linePrefix(line.kind)}</span>
      <span className="piff-viewer__text-line-copy">
        {line.spans.map((span, spanIndex) => (
          <span className={`is-${span.kind}`} key={`${span.kind}-${spanIndex}`}>{span.text}</span>
        ))}
      </span>
    </div>
  )
}

function usePagePreview(
  pageIndex: number,
  view: PdfPagePreviewView,
  loadPreview: PiffPreviewLoader,
  enabled: boolean,
): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: 'idle' })

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle' })
      return
    }

    let active = true
    let objectUrl: string | undefined
    setState({ status: 'loading' })
    loadPreview(pageIndex, { view })
      .then((preview) => {
        if (!active) return
        if (typeof preview === 'string') {
          setState({ status: 'ready', source: preview })
          return
        }
        if (typeof Blob === 'undefined') {
          setState({ status: 'error' })
          return
        }
        const blob = preview instanceof Blob
          ? preview
          : new Blob([copyBytes(preview)], { type: 'image/png' })
        objectUrl = URL.createObjectURL(blob)
        setState({ status: 'ready', source: objectUrl })
      })
      .catch(() => {
        if (active) setState({ status: 'error' })
      })

    return () => {
      active = false
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
    }
  }, [enabled, loadPreview, pageIndex, view])

  return state
}

function useNearViewport<T extends HTMLElement>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const [nearViewport, setNearViewport] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (node === null) return
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNearViewport(true)
      },
      { rootMargin: '900px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [ref, nearViewport]
}

function handleRailKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
  pageCount: number,
  setSelectedPage: (index: number) => void,
) {
  const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight'
    ? 1
    : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
      ? -1
      : 0
  if (direction === 0) return
  event.preventDefault()
  setSelectedPage(clampPage(index + direction, pageCount))
}

function clampPage(index: number, pageCount: number): number {
  if (pageCount === 0) return 0
  return Math.min(Math.max(index, 0), pageCount - 1)
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function statusLabel(status: PdfPageDiff['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function reviewTextFallback(change: PdfReviewChange, side: 'before' | 'after'): string {
  if (change.type === 'page') return 'No corresponding page'
  if (change.kind === 'visual') {
    if ((change.type === 'added' && side === 'before') || (change.type === 'removed' && side === 'after')) {
      return 'No visual content on this side'
    }
    if (change.type === 'swapped') return 'The same figure was found at the opposite position'
    if (change.type === 'moved') return 'The same figure moved to a new position'
    if (change.type === 'modified') return 'The image-backed figure changed'
    return 'Visual evidence only'
  }
  if ((change.type === 'added' && side === 'before') || (change.type === 'removed' && side === 'after')) {
    return 'No changed text on this side'
  }
  if (change.type === 'reflowed') return 'The same text was rewrapped on this side'
  return 'No extracted text'
}

function buildReviewChanges(page: PdfPageDiff): PdfReviewChange[] {
  if (page.status === 'inserted' || page.status === 'deleted') {
    const beforeSize = page.beforeSize ?? { width: page.width, height: page.height }
    const afterSize = page.afterSize ?? { width: page.width, height: page.height }
    return [{
      id: `page-${page.status}`,
      kind: 'page',
      type: 'page',
      label: page.status === 'inserted' ? 'Page inserted' : 'Page deleted',
      beforeBounds: page.status === 'deleted' ? { x: 0, y: 0, width: beforeSize.width, height: beforeSize.height } : undefined,
      afterBounds: page.status === 'inserted' ? { x: 0, y: 0, width: afterSize.width, height: afterSize.height } : undefined,
    }]
  }
  const semanticChanges = page.semantic?.changes ?? []
  const figureChanges = buildFigureChanges(page.figures)
  if (semanticChanges.length > 0) return [...groupSemanticChanges(semanticChanges, page.semantic?.textDiff), ...figureChanges]
  if (figureChanges.length > 0) return figureChanges
  if (page.status === 'equal') return []
  const visualChanges = clusterVisualRegions(
    page.regions,
    page.width,
    page.height,
    pageGeometryFor(page, 'before'),
    pageGeometryFor(page, 'after'),
  )
  if (visualChanges.length > 0) return visualChanges
  const beforeSize = pageGeometryFor(page, 'before')
  const afterSize = pageGeometryFor(page, 'after')
  const geometryChanged = beforeSize.width !== afterSize.width || beforeSize.height !== afterSize.height
  return [{
    id: 'page-change',
    kind: 'page',
    type: 'page',
    label: geometryChanged ? 'Page geometry changed' : 'Page-level change',
    beforeText: geometryChanged ? formatPageGeometry(beforeSize) : undefined,
    afterText: geometryChanged ? formatPageGeometry(afterSize) : undefined,
    beforeBounds: { x: 0, y: 0, width: beforeSize.width, height: beforeSize.height },
    afterBounds: { x: 0, y: 0, width: afterSize.width, height: afterSize.height },
  }]
}

function buildReviewOperations(changes: PdfReviewChange[]): PdfReviewOperation[] {
  const operations: PdfReviewOperation[] = []
  const seen = new Set<string>()

  for (const change of changes) {
    const operationId = change.operationId ?? change.id
    if (seen.has(operationId)) continue
    seen.add(operationId)
    const members = changes.filter((candidate) => (candidate.operationId ?? candidate.id) === operationId)
    operations.push({
      id: operationId,
      type: change.type,
      label: change.operationLabel ?? change.label,
      changes: members,
    })
  }

  return operations
}

function buildFigureChanges(figures: PdfFigureDiff[]): PdfReviewChange[] {
  const swapped = figures.filter((figure) => figure.status === 'swapped')
  const operationId = swapped.length > 1
    ? `figure-swap-${swapped.map((figure) => figure.id).sort().join('-')}`
    : undefined
  const operationLabel = swapped.length > 1 ? `${swapped.length} figures swapped` : undefined

  return figures.map((figure) => ({
    id: figure.id,
    kind: 'visual',
    type: figure.status,
    label: figureLabel(figure.status),
    operationId: figure.status === 'swapped' ? operationId : undefined,
    operationLabel: figure.status === 'swapped' ? operationLabel : undefined,
    beforeBounds: figure.beforeBounds,
    afterBounds: figure.afterBounds,
    confidence: figure.confidence,
  }))
}

function figureLabel(status: PdfFigureDiff['status']): string {
  switch (status) {
    case 'added': return 'Figure added'
    case 'removed': return 'Figure removed'
    case 'modified': return 'Figure changed'
    case 'moved': return 'Figure moved'
    case 'swapped': return 'Figure swapped'
  }
}

function groupSemanticChanges(changes: PdfSemanticTextChange[], textDiff?: NonNullable<PdfPageDiff['semantic']>['textDiff']): PdfReviewChange[] {
  const ordered = changes
    .map((change) => ({ change, bounds: reviewAnchorBounds(change) }))
    .sort((left, right) => (left.bounds?.y ?? 0) - (right.bounds?.y ?? 0) || (left.bounds?.x ?? 0) - (right.bounds?.x ?? 0))
  const groups: Array<{ changes: PdfSemanticTextChange[]; bounds?: PiffBounds; lineBounds?: PiffBounds }> = []

  for (const entry of ordered) {
    const previous = groups[groups.length - 1]
    if (previous && entry.bounds !== undefined && previous.lineBounds !== undefined && sameTextLine(previous.lineBounds, entry.bounds)) {
      previous.changes.push(entry.change)
      previous.bounds = unionBounds(previous.bounds, entry.bounds)
    } else {
      groups.push({ changes: [entry.change], bounds: entry.bounds, lineBounds: entry.bounds })
    }
  }

  return groups.map((group, groupIndex) => {
    const types = group.changes.map((change) => change.kind)
    const type = types.includes('modified') || (types.includes('added') && types.includes('removed'))
      ? 'modified'
      : types[0] ?? 'modified'
    const beforeBounds = unionMany(group.changes.map((change) => reviewSideBounds(change, 'before')))
    const afterBounds = unionMany(group.changes.map((change) => reviewSideBounds(change, 'after')))
    return {
      id: group.changes[0]?.id ?? `text-${groupIndex + 1}`,
      kind: 'text',
      type,
      label: type === 'moved'
        ? 'Text moved'
        : type === 'reflowed'
          ? 'Text reflowed'
          : type === 'added'
            ? 'Text added'
            : type === 'removed'
              ? 'Text removed'
              : 'Text changed',
      beforeText: joinReviewText(group.changes.map((change) => change.beforeText)),
      afterText: joinReviewText(group.changes.map((change) => change.afterText)),
      beforeBounds,
      afterBounds,
      textHunks: findTextHunksForChanges(group.changes, textDiff),
    }
  })
}

function findTextHunksForChanges(
  changes: PdfSemanticTextChange[],
  textDiff: NonNullable<PdfPageDiff['semantic']>['textDiff'] | undefined,
): PdfTextDiffHunk[] | undefined {
  if (textDiff === undefined || textDiff.hunks.length === 0) return undefined
  const targets = changes
    .flatMap((change) => [change.beforeText, change.afterText])
    .filter((value): value is string => value !== undefined && value.trim().length >= 3)
    .map(normalizeDiffText)
  if (targets.length === 0) return undefined
  const hunks = textDiff.hunks.filter((hunk) => {
    const changedLines = hunk.lines
      .filter((line) => line.kind !== 'context')
      .map((line) => normalizeDiffText(line.text))
    return targets.some((target) => changedLines.some((line) => line.includes(target) || target.includes(line)))
  })
  return hunks.length === 0 ? undefined : hunks
}

function normalizeDiffText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function clusterVisualRegions(
  regions: PiffResult['pages'][number]['regions'],
  renderWidth: number,
  renderHeight: number,
  beforeGeometry: PdfPageGeometry,
  afterGeometry: PdfPageGeometry,
): PdfReviewChange[] {
  const groups: Array<{
    bounds: PiffBounds
    changedPixels: number
    beforeContentPixels?: number
    afterContentPixels?: number
  }> = []
  for (const region of [...regions].sort((left, right) => left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x)) {
    const target = groups.find((group) => nearbyBounds(group.bounds, region.bounds, 18))
    if (target) {
      target.bounds = unionBounds(target.bounds, region.bounds) ?? target.bounds
      target.changedPixels += region.changedPixels
      target.beforeContentPixels = addContentCounts(target.beforeContentPixels, region.beforeContentPixels)
      target.afterContentPixels = addContentCounts(target.afterContentPixels, region.afterContentPixels)
    } else {
      groups.push({
        bounds: region.bounds,
        changedPixels: region.changedPixels,
        beforeContentPixels: region.beforeContentPixels,
        afterContentPixels: region.afterContentPixels,
      })
    }
  }
  return groups
    .sort((left, right) => right.changedPixels - left.changedPixels)
    .slice(0, 24)
    .map((group, index) => {
      const fullPage = group.bounds.width > renderWidth * 0.96 && group.bounds.height > renderHeight * 0.96
      const type = visualChangeType(group)
      return {
        id: `visual-${index + 1}`,
        kind: 'visual',
        type,
        label: type === 'added' ? 'Visual addition' : type === 'removed' ? 'Visual removal' : 'Visual change',
        beforeBounds: type === 'added' || fullPage ? undefined : scalePixelBounds(group.bounds, renderWidth, renderHeight, beforeGeometry),
        afterBounds: type === 'removed' || fullPage ? undefined : scalePixelBounds(group.bounds, renderWidth, renderHeight, afterGeometry),
        changedPixels: group.changedPixels,
      }
    })
}

function addContentCounts(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined || right === undefined ? undefined : left + right
}

function visualChangeType(group: {
  beforeContentPixels?: number
  afterContentPixels?: number
}): Extract<PdfReviewChangeType, 'added' | 'removed' | 'modified' | 'visual'> {
  if (group.beforeContentPixels === undefined || group.afterContentPixels === undefined) return 'visual'
  if (group.beforeContentPixels === 0 && group.afterContentPixels > 0) return 'added'
  if (group.afterContentPixels === 0 && group.beforeContentPixels > 0) return 'removed'
  return 'modified'
}

function scalePixelBounds(
  bounds: PiffBounds,
  renderWidth: number,
  renderHeight: number,
  geometry: PdfPageGeometry,
): PiffBounds {
  const scaleX = geometry.width / Math.max(renderWidth, 1)
  const scaleY = geometry.height / Math.max(renderHeight, 1)
  const x = Math.min(Math.max(bounds.x * scaleX, 0), geometry.width)
  const y = Math.min(Math.max(bounds.y * scaleY, 0), geometry.height)
  const right = Math.min(Math.max((bounds.x + bounds.width) * scaleX, x), geometry.width)
  const bottom = Math.min(Math.max((bounds.y + bounds.height) * scaleY, y), geometry.height)
  return { x, y, width: right - x, height: bottom - y }
}

function pageGeometryFor(page: PdfPageDiff, side: 'before' | 'after'): PdfPageGeometry {
  const size = side === 'before' ? page.beforeSize : page.afterSize
  return size ?? { width: page.width, height: page.height }
}

function formatPageGeometry(size: PdfPageGeometry): string {
  return `${formatNumber(size.width)} × ${formatNumber(size.height)} pt`
}

function boundsStyle(bounds: PiffBounds, geometry: PdfPageGeometry): CSSProperties {
  return {
    left: `${(bounds.x / Math.max(geometry.width, 1)) * 100}%`,
    top: `${(bounds.y / Math.max(geometry.height, 1)) * 100}%`,
    width: `${Math.max((bounds.width / Math.max(geometry.width, 1)) * 100, 0.8)}%`,
    height: `${Math.max((bounds.height / Math.max(geometry.height, 1)) * 100, 0.8)}%`,
  }
}

function offsetBounds(bounds: PiffBounds, offsetX: number, offsetY: number): PiffBounds {
  return {
    x: bounds.x + offsetX,
    y: bounds.y + offsetY,
    width: bounds.width,
    height: bounds.height,
  }
}

function focusCropFor(bounds: PiffBounds | undefined, geometry: PdfPageGeometry): PiffBounds | undefined {
  if (bounds === undefined || bounds.width <= 0 || bounds.height <= 0) return undefined
  const paddingX = Math.max(32, Math.min(96, geometry.width * 0.08))
  const paddingY = Math.max(32, Math.min(96, geometry.height * 0.08))
  const x = Math.max(bounds.x - paddingX, 0)
  const y = Math.max(bounds.y - paddingY, 0)
  const right = Math.min(bounds.x + bounds.width + paddingX, geometry.width)
  const bottom = Math.min(bounds.y + bounds.height + paddingY, geometry.height)
  return { x, y, width: Math.max(right - x, 1), height: Math.max(bottom - y, 1) }
}

function focusImageStyle(geometry: PdfPageGeometry, focusBounds: PiffBounds | undefined): CSSProperties {
  if (focusBounds === undefined) return {}
  return {
    position: 'absolute',
    left: `${(-focusBounds.x / Math.max(focusBounds.width, 1)) * 100}%`,
    top: `${(-focusBounds.y / Math.max(focusBounds.height, 1)) * 100}%`,
    width: `${(geometry.width / Math.max(focusBounds.width, 1)) * 100}%`,
    height: `${(geometry.height / Math.max(focusBounds.height, 1)) * 100}%`,
    maxWidth: 'none',
    objectFit: 'fill',
  }
}

function measureReviewRelationships(
  canvas: HTMLDivElement | null,
  beforePaper: HTMLDivElement | null,
  afterPaper: HTMLDivElement | null,
  changes: PdfReviewChange[],
  selectedChange: PdfReviewChange | undefined,
): ReviewRelationshipLayer | undefined {
  if (canvas === null || beforePaper === null || afterPaper === null) return undefined
  const canvasRect = canvas.getBoundingClientRect()
  if (canvasRect.width <= 0 || canvasRect.height <= 0) return undefined

  const markerFor = (paper: HTMLDivElement, changeId: string): HTMLElement | undefined => Array.from(
    paper.querySelectorAll<HTMLElement>('[data-review-marker]'),
  ).find((marker) => marker.dataset.reviewMarker === changeId)

  const selectedOperationId = selectedChange?.operationId ?? selectedChange?.id
  const relationships = changes.flatMap<ReviewRelationship>((change, relationshipIndex) => {
    if (change.beforeBounds === undefined || change.afterBounds === undefined) return []
    const beforeMarker = markerFor(beforePaper, change.id)
    const afterMarker = markerFor(afterPaper, change.id)
    if (beforeMarker === undefined || afterMarker === undefined) return []
    const beforeRect = beforeMarker.getBoundingClientRect()
    const afterRect = afterMarker.getBoundingClientRect()
    const start = {
      x: beforeRect.right - canvasRect.left,
      y: beforeRect.top + beforeRect.height / 2 - canvasRect.top,
    }
    const end = {
      x: afterRect.left - canvasRect.left,
      y: afterRect.top + afterRect.height / 2 - canvasRect.top,
    }
    const direction = end.x >= start.x ? 1 : -1
    const bend = Math.max(24, Math.abs(end.x - start.x) * 0.36)
    const laneOffset = Math.abs(end.y - start.y) < 18
      ? (relationshipIndex % 2 === 0 ? -1 : 1) * Math.min(28, Math.max(12, Math.abs(end.x - start.x) * 0.06))
      : 0
    const selected = change.id === selectedChange?.id
    const related = !selected && change.operationId !== undefined && change.operationId === selectedOperationId
    return [{
      id: change.id,
      path: `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} C ${(start.x + bend * direction).toFixed(2)} ${(start.y + laneOffset).toFixed(2)}, ${(end.x - bend * direction).toFixed(2)} ${(end.y + laneOffset).toFixed(2)}, ${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
      start,
      end,
      selected,
      related,
    }]
  })

  return { width: canvasRect.width, height: canvasRect.height, relationships }
}

function unionMany(bounds: Array<PiffBounds | undefined>): PiffBounds | undefined {
  return bounds.reduce<PiffBounds | undefined>((current, next) => unionBounds(current, next), undefined)
}

function reviewAnchorBounds(change: PdfSemanticTextChange): PiffBounds | undefined {
  return change.afterFocusBounds
    ?? change.afterBounds
    ?? change.beforeFocusBounds
    ?? change.beforeBounds
}

function reviewSideBounds(change: PdfSemanticTextChange, side: 'before' | 'after'): PiffBounds | undefined {
  if (change.kind === 'added') {
    return side === 'after' ? change.afterFocusBounds ?? change.afterBounds : undefined
  }
  if (change.kind === 'removed') {
    return side === 'before' ? change.beforeFocusBounds ?? change.beforeBounds : undefined
  }
  return side === 'before'
    ? change.beforeFocusBounds ?? change.beforeBounds
    : change.afterFocusBounds ?? change.afterBounds
}

function unionBounds(left: PiffBounds | undefined, right: PiffBounds | undefined): PiffBounds | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  const x = Math.min(left.x, right.x)
  const y = Math.min(left.y, right.y)
  const rightEdge = Math.max(left.x + left.width, right.x + right.width)
  const bottomEdge = Math.max(left.y + left.height, right.y + right.height)
  return { x, y, width: rightEdge - x, height: bottomEdge - y }
}

function sameTextLine(left: PiffBounds, right: PiffBounds): boolean {
  const leftCenter = left.y + left.height / 2
  const rightCenter = right.y + right.height / 2
  return Math.abs(leftCenter - rightCenter) <= Math.max(left.height, right.height, 10) * 1.6
}

function nearbyBounds(left: PiffBounds, right: PiffBounds, gap: number): boolean {
  return left.x <= right.x + right.width + gap
    && right.x <= left.x + left.width + gap
    && left.y <= right.y + right.height + gap
    && right.y <= left.y + left.height + gap
}

function joinReviewText(values: Array<string | undefined>): string | undefined {
  const text = values.filter((value): value is string => value !== undefined && value.trim().length > 0)
  return text.length === 0 ? undefined : text.join(' ')
}

function previewMessage(status: PreviewState['status']): string {
  if (status === 'error') return 'Preview unavailable'
  if (status === 'loading') return 'Rendering page'
  if (status === 'idle') return 'Waiting for page'
  return 'Preview unavailable'
}

function formatRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio === 0 ? 0 : 2)}%`
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

function countTextPages(result: PiffResult): number {
  return result.pages.filter((page) => (page.semantic?.textDiff?.hunks.length ?? 0) > 0).length
}

function countTextHunks(result: PiffResult): number {
  return result.pages.reduce((total, page) => total + (page.semantic?.textDiff?.hunks.length ?? 0), 0)
}

function formatOffset(x: number, y: number): string {
  return `${x >= 0 ? '+' : ''}${x}, ${y >= 0 ? '+' : ''}${y}px`
}

function formatBounds(x: number, y: number, width: number, height: number): string {
  return `${x},${y} · ${width}×${height}`
}

function joinClasses(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ')
}
