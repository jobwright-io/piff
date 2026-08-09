import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
process.env.PIFF_NATIVE_MODULE ??= join(projectRoot, 'artifacts/piff.linux-x64-gnu.node')
process.env.PDFIUM_LIBRARY_PATH ??= join(projectRoot, 'artifacts/pdfium/linux-x64/lib/libpdfium.so')

const { PiffDocumentSet, PiffError, PiffSession, piff, piffSet } = await import('../packages/piff/dist/index.js')
const { createTextPdf } = await import('./pdf-fixtures.mjs')

const semanticOptions = {
  dpi: 144,
  mode: 'semantic',
  pageMatching: 'sequence',
  readingOrder: 'auto',
  maxShiftPx: 12,
  alignmentSampleStep: 2,
  channelTolerance: 10,
  changedPixelRatio: 0.0002,
  minRegionArea: 12,
}

const cases = [
  {
    name: 'identical-document',
    before: createTextPdf([['Stable title.', 'The body is unchanged.']]),
    after: undefined,
    verify(result) {
      assert.equal(result.equal, true)
      assert.deepEqual(statuses(result), ['equal'])
      assert.equal(result.pages[0].semantic?.quality, 'text')
      assert.equal(result.pages[0].semantic?.changes.length, 0)
    },
    verifyFastEqual: true,
  },
  {
    name: 'single-word-replacement',
    before: createTextPdf([['Quarterly release review.', 'The contract is ready for review.']]),
    after: createTextPdf([['Quarterly release review.', 'The contract is ready for release.']]),
    verify(result) {
      assert.equal(result.equal, false)
      assert.deepEqual(statuses(result), ['modified'])
      assert.equal(result.textDiff?.changedLines, 2)
      assert.equal(result.textDiff?.pages.length, 1)
      assert.equal(result.textDiff?.pages[0].status, 'modified')
      const page = result.pages[0]
      assert.equal(page.semantic?.textDiff?.hunks.length, 1)
      assert.equal(page.semantic?.changes.length, 1)
      const change = page.semantic.changes[0]
      assert.match(change.beforeText ?? '', /review/)
      assert.match(change.afterText ?? '', /release/)
      assert.ok(change.beforeFocusBounds.width < change.beforeBounds.width)
      assert.ok(change.afterFocusBounds.width < change.afterBounds.width)
      assert.equal(page.semantic.blocks.length, 1)
      assert.equal(page.semantic.blocks[0].kind, 'modified')
      assert.ok(page.semantic.blocks[0].beforeBounds)
      assert.ok(page.semantic.blocks[0].afterBounds)
      assert.equal(page.semantic.blocks[0].textDiff.hunks.length, 1)
      assert.equal(result.textDiff?.pages[0].blocks.length, 1)
      assert.equal(result.textDiff?.stream.length, 1)
      assert.equal(result.textDiff?.stream[0].blockId, result.textDiff.pages[0].blocks[0].id)
      assert.equal(result.textDiff?.stream[0].pageIndex, 0)
      assert.equal(result.textDiff?.stream[0].beforePage, 0)
      assert.equal(result.textDiff?.stream[0].afterPage, 0)
      assert.ok(page.regions.length > 0)
    },
  },
  {
    name: 'inserted-cover-preserves-following-pages',
    before: createTextPdf([
      ['Q3 platform release.', 'The original cover remains.'],
      ['Scope and requirements.', 'The runtime compares PDF documents.'],
    ]),
    after: createTextPdf([
      ['Internal review copy.', 'Prepared for document systems.'],
      ['Q3 platform release.', 'The original cover remains.'],
      ['Scope and requirements.', 'The runtime compares PDF documents.'],
    ]),
    verify(result) {
      assert.equal(result.equal, false)
      assert.deepEqual(statuses(result), ['inserted', 'equal', 'equal'])
      assert.equal(result.pages[0].beforePage, undefined)
      assert.equal(result.pages[0].afterPage, 0)
      assert.equal(result.pages[1].beforePage, 0)
      assert.equal(result.pages[1].afterPage, 1)
      assert.ok(result.textDiff?.stream.some((item) => (
        item.pageStatus === 'inserted'
        && item.beforePage === undefined
        && item.afterPage === 0
      )))
    },
  },
  {
    name: 'deleted-appendix-preserves-leading-pages',
    before: createTextPdf([
      ['Q3 platform release.', 'The cover remains.'],
      ['Scope and requirements.', 'The runtime compares PDF documents.'],
      ['Appendix.', 'This page is removed in the revision.'],
    ]),
    after: createTextPdf([
      ['Q3 platform release.', 'The cover remains.'],
      ['Scope and requirements.', 'The runtime compares PDF documents.'],
    ]),
    verify(result) {
      assert.deepEqual(statuses(result), ['equal', 'equal', 'deleted'])
      assert.equal(result.pages[2].beforePage, 2)
      assert.equal(result.pages[2].afterPage, undefined)
      assert.ok(result.textDiff?.stream.some((item) => (
        item.pageStatus === 'deleted'
        && item.beforePage === 2
        && item.afterPage === undefined
      )))
    },
  },
  {
    name: 'reordered-pages-are-moved',
    before: createTextPdf([
      { rectangles: [{ x: 0, y: 0, width: 612, height: 792, fill: [0.85, 0.12, 0.12] }] },
      { rectangles: [{ x: 0, y: 0, width: 612, height: 792, fill: [0.12, 0.25, 0.85] }] },
    ]),
    after: createTextPdf([
      { rectangles: [{ x: 0, y: 0, width: 612, height: 792, fill: [0.12, 0.25, 0.85] }] },
      { rectangles: [{ x: 0, y: 0, width: 612, height: 792, fill: [0.85, 0.12, 0.12] }] },
    ]),
    verify(result) {
      assert.equal(result.pages.length, 2)
      assert.deepEqual(statuses(result), ['moved', 'moved'])
      assert.ok(result.pages.every((page) => page.semantic?.equal === true))
    },
  },
  {
    name: 'translation-is-semantic-movement',
    before: createTextPdf([
      [{ text: 'The page is shifted.', x: 72, y: 700 }],
    ]),
    after: createTextPdf([
      [{ text: 'The page is shifted.', x: 76, y: 700 }],
    ]),
    verify(result) {
      assert.deepEqual(statuses(result), ['modified'])
      assert.ok(result.pages[0].semantic?.changes.some((change) => change.kind === 'moved'))
      assert.ok(result.pages[0].warnings.includes('semantic-visual-disagreement'))
      assert.ok(result.pages[0].alignment.confidence >= 0)
    },
  },
  {
    name: 'visual-only-vector-change',
    before: createTextPdf([
      { rectangles: [{ x: 100, y: 500, width: 160, height: 70, fill: [0.1, 0.2, 0.8] }] },
    ]),
    after: createTextPdf([
      { rectangles: [{ x: 108, y: 500, width: 160, height: 70, fill: [0.1, 0.2, 0.8] }] },
    ]),
    verify(result) {
      assert.deepEqual(statuses(result), ['modified'])
      assert.equal(result.pages[0].semantic?.quality, 'empty')
      assert.equal(result.pages[0].semantic?.changes.length, 0)
      assert.ok(result.pages[0].regions.length > 0)
      assert.ok(result.pages[0].warnings.includes('text-unavailable'))
    },
  },
  {
    name: 'font-change-is-visual-evidence',
    before: createTextPdf([[{ text: 'The same words use a regular font.' }]]),
    after: createTextPdf([[{ text: 'The same words use a regular font.', font: 'F2' }]]),
    verify(result) {
      assert.deepEqual(statuses(result), ['modified'])
      assert.equal(result.pages[0].semantic?.changes[0].kind, 'moved')
      assert.equal(result.pages[0].semantic?.changes[0].beforeText, result.pages[0].semantic?.changes[0].afterText)
      assert.ok(result.pages[0].changedPixels > 0)
    },
  },
  {
    name: 'page-geometry-change-is-explicit',
    before: createTextPdf([{ width: 612, height: 792, lines: ['Geometry is part of the evidence.'] }]),
    after: createTextPdf([{ width: 720, height: 792, lines: ['Geometry is part of the evidence.'] }]),
    verify(result) {
      assert.deepEqual(statuses(result), ['modified'])
      assert.equal(result.pages[0].beforeSize.width, 612)
      assert.equal(result.pages[0].afterSize.width, 720)
      assert.deepEqual(result.pages[0].warnings, ['page-geometry-changed'])
    },
    verifyFastEqual: false,
  },
  {
    name: 'line-insertion-keeps-unified-context',
    before: createTextPdf([['Heading.', 'First paragraph.', 'Second paragraph.', 'Closing note.']]),
    after: createTextPdf([['Heading.', 'First paragraph.', 'Inserted paragraph.', 'Second paragraph.', 'Closing note.']]),
    verify(result) {
      assert.deepEqual(statuses(result), ['modified'])
      const textDiff = result.pages[0].semantic?.textDiff
      assert.equal(textDiff?.truncated, false)
      assert.ok(textDiff?.hunks.some((hunk) => hunk.lines.some((line) => line.kind === 'added' && line.text.includes('Inserted paragraph'))))
      assert.ok(result.pages[0].semantic?.changes.some((change) => change.kind === 'added'))
      assert.equal(result.textDiff?.pages[0].textDiff?.changedLines, 1)
    },
  },
  {
    name: 'repeated-edge-text-gets-document-roles',
    before: createTextPdf([
      [
        { text: 'Quarterly Business Report', x: 72, y: 750, font: 'F2' },
        { text: 'The first page body remains stable.', x: 72, y: 500 },
        { text: 'Page 1 of 2', x: 72, y: 35 },
      ],
      [
        { text: 'Quarterly Business Report', x: 72, y: 750, font: 'F2' },
        { text: 'The second page body remains stable.', x: 72, y: 500 },
        { text: 'Page 2 of 2', x: 72, y: 35 },
      ],
    ]),
    after: createTextPdf([
      [
        { text: 'Quarterly Business Summary', x: 72, y: 750, font: 'F2' },
        { text: 'The first page body remains stable.', x: 72, y: 500 },
        { text: 'Page 1 of 3', x: 72, y: 35 },
      ],
      [
        { text: 'Quarterly Business Summary', x: 72, y: 750, font: 'F2' },
        { text: 'The second page body remains stable.', x: 72, y: 500 },
        { text: 'Page 2 of 3', x: 72, y: 35 },
      ],
    ]),
    verify(result) {
      assert.deepEqual(statuses(result), ['modified', 'modified'])
      const blocks = result.pages.flatMap((page) => page.semantic?.blocks ?? [])
      const headers = blocks.filter((block) => block.beforeRole === 'header' && block.afterRole === 'header')
      const footers = blocks.filter((block) => block.beforeRole === 'footer' && block.afterRole === 'footer')
      assert.equal(headers.length, 2)
      assert.equal(footers.length, 2)
      assert.ok(headers.every((block) => block.beforeBounds && block.afterBounds))
      assert.ok(footers.every((block) => block.beforeBounds && block.afterBounds))
    },
  },
]

for (const fixture of cases) {
  fixture.after ??= fixture.before
}

const report = []
let reportEngine
const { writeFigureScenarios } = await import('./figure-scenarios.mjs')
await writeFigureScenarios()
const figureScenarioDirectory = join(projectRoot, 'artifacts/figure-scenarios')
const figureCases = [
  {
    name: 'image-figure-swap',
    files: 'two-figures-swapped',
    statuses: ['swapped', 'swapped'],
    warnings: ['content-reordered'],
  },
  {
    name: 'image-figure-replacement',
    files: 'two-figures-one-replaced',
    statuses: ['modified'],
  },
  {
    name: 'image-figure-and-text-edit',
    files: 'figure-text-edit',
    statuses: ['modified'],
    textChanges: true,
  },
  {
    name: 'image-figure-addition',
    files: 'figure-added',
    statuses: ['added'],
  },
  {
    name: 'image-figure-movement',
    files: 'figure-moved',
    statuses: ['moved'],
  },
]
for (const fixture of figureCases) {
  const result = await piff(
    await readFile(join(figureScenarioDirectory, `${fixture.files}-before.pdf`)),
    await readFile(join(figureScenarioDirectory, `${fixture.files}-after.pdf`)),
    { ...semanticOptions, pageMatching: 'index' },
  )
  assert.deepEqual(result.pages[0].figures.map((figure) => figure.status), fixture.statuses)
  assert.ok(result.pages[0].figures.every((figure) => figure.confidence >= 0.8))
  if (fixture.warnings !== undefined) {
    assert.deepEqual(result.pages[0].warnings.filter((warning) => fixture.warnings.includes(warning)), fixture.warnings)
    assert.ok(!result.pages[0].warnings.includes('low-alignment-confidence'))
  }
  if (fixture.textChanges) {
    assert.ok((result.pages[0].semantic?.changes.length ?? 0) > 0)
    assert.ok((result.pages[0].semantic?.textDiff?.hunks.length ?? 0) > 0)
  }
  report.push({
    name: fixture.name,
    equal: result.equal,
    figureStatuses: result.pages[0].figures.map((figure) => figure.status),
    regions: result.pages[0].regions.length,
  })
}

for (const fixture of cases) {
  const result = await piff(fixture.before, fixture.after, semanticOptions)
  assert.equal(result.schemaVersion, 1)
  assert.deepEqual(result.engine, {
    name: 'piff',
    version: '0.2.0',
    renderer: 'pdfium',
    binding: 'pdfium-render',
    pdfiumApi: '7881',
    pdfiumVersion: '151.0.7881.0',
  })
  reportEngine ??= result.engine
  fixture.verify(result)
  for (const key of [
    'loadMs',
    'fingerprintMs',
    'matchingMs',
    'renderMs',
    'compareMs',
    'regionMs',
    'semanticMs',
    'totalMs',
  ]) {
    assert.equal(typeof result.stats[key], 'number')
    assert.ok(Number.isFinite(result.stats[key]))
    assert.ok(result.stats[key] >= 0)
  }
  if (fixture.verifyFastEqual !== undefined) {
    const equalitySession = await PiffSession.open(fixture.before, fixture.after, semanticOptions)
    try {
      assert.equal(await equalitySession.isEqual(), fixture.verifyFastEqual)
    } finally {
      await equalitySession.close()
    }
  }
  const session = await PiffSession.open(fixture.before, fixture.after, semanticOptions)
  try {
    const preview = await session.renderPageDiff(0, { view: 'diff' })
    assert.equal(preview[0], 0x89)
    assert.equal(preview[1], 0x50)
    assert.equal(preview[2], 0x4e)
    assert.equal(preview[3], 0x47)
    const cachedPreview = await session.renderPageDiff(0, { view: 'diff' })
    assert.deepEqual(cachedPreview, preview)
    const cacheDiagnostics = session.cacheDiagnostics()
    assert.equal(cacheDiagnostics.previewCacheHits, 1)
    assert.equal(cacheDiagnostics.previewCacheMisses, 1)
    assert.equal(cacheDiagnostics.previewCacheEntries, 1)
    assert.equal(cacheDiagnostics.previewCacheBytes, preview.byteLength)
    report.push({
      name: fixture.name,
      equal: result.equal,
      statuses: statuses(result),
      pageCount: result.pages.length,
      semanticChanges: result.pages.reduce((total, page) => total + (page.semantic?.changes.length ?? 0), 0),
      regions: result.pages.reduce((total, page) => total + page.regions.length, 0),
      warnings: [...new Set(result.pages.flatMap((page) => page.warnings))],
      previewBytes: preview.byteLength,
      previewSha256: createHash('sha256').update(preview).digest('hex'),
    })
  } finally {
    await session.close()
  }
}

const deterministicFirst = await piff(cases[1].before, cases[1].after, semanticOptions)
const deterministicSecond = await piff(cases[1].before, cases[1].after, semanticOptions)
const comparableResult = (result) => ({
  equal: result.equal,
  before: result.before,
  after: result.after,
  pages: result.pages,
  textDiff: result.textDiff,
})
assert.deepEqual(comparableResult(deterministicFirst), comparableResult(deterministicSecond))
report.push({ name: 'sdk-deterministic-semantic-output', passed: true })

const contextResult = await piff(
  createTextPdf([['Stable heading.', 'The original sentence.', 'Stable closing note.']]),
  createTextPdf([['Stable heading.', 'The revised sentence.', 'Stable closing note.']]),
  { ...semanticOptions, contextLines: 0 },
)
const contextHunkLines = contextResult.textDiff?.pages[0]?.textDiff?.hunks[0]?.lines ?? []
assert.ok(contextHunkLines.length > 0)
assert.ok(contextHunkLines.every((line) => line.kind !== 'context'))
report.push({ name: 'sdk-context-lines-option', passed: true })

const reflowResult = await piff(
  createTextPdf([[
    { text: 'Experienced engineer with ten', x: 72, y: 700 },
    { text: 'years building reliable systems.', x: 72, y: 680 },
    { text: 'Education', x: 72, y: 646 },
  ]]),
  createTextPdf([[
    { text: 'Experienced engineer with', x: 72, y: 700 },
    { text: 'ten years building reliable systems.', x: 72, y: 680 },
    { text: 'Education', x: 72, y: 646 },
  ]]),
  semanticOptions,
)
assert.equal(reflowResult.pages[0].semantic?.changes.length, 1)
assert.equal(reflowResult.pages[0].semantic?.changes[0].kind, 'reflowed')
assert.equal(reflowResult.pages[0].semantic?.textDiff?.changedLines, 0)
assert.equal(reflowResult.textDiff?.pages[0].textDiff?.hunks.length, 0)
report.push({ name: 'sdk-reflow-aware-text-matching', passed: true })

const blockInsertionResult = await piff(
  createTextPdf([['Stable heading.', 'Stable closing note.']]),
  createTextPdf([[
    'Stable heading.',
    'Inserted paragraph one.',
    'Inserted paragraph two.',
    'Stable closing note.',
  ]]),
  semanticOptions,
)
const insertedBlock = blockInsertionResult.pages[0].semantic?.blocks.find(
  (block) => block.kind === 'added',
)
assert.ok(insertedBlock)
assert.equal(insertedBlock.beforeText, undefined)
assert.match(insertedBlock.afterText ?? '', /Inserted paragraph one/)
assert.equal(insertedBlock.beforeBounds, undefined)
assert.ok(insertedBlock.afterBounds)
assert.ok(insertedBlock.textDiff.hunks.length > 0)
assert.ok(blockInsertionResult.textDiff?.pages[0].blocks.some((block) => block.id === insertedBlock.id))
report.push({ name: 'sdk-side-aware-block-insertion', passed: true })

const semanticOnlyBefore = createTextPdf([['Profile summary.', 'The original document contains stable text.']])
const semanticOnlyAfter = createTextPdf([['Profile summary.', 'The revised document contains stable text.']])
const semanticOnlyResult = await piff(
  semanticOnlyBefore,
  semanticOnlyAfter,
  { ...semanticOptions, pageMatching: 'index', render: 'none' },
)
assert.equal(semanticOnlyResult.equal, false)
assert.equal(semanticOnlyResult.renderMode, 'none')
assert.equal(semanticOnlyResult.pages[0].visualComputed, false)
assert.equal(semanticOnlyResult.pages[0].changedPixels, 0)
assert.equal(semanticOnlyResult.pages[0].regions.length, 0)
assert.equal(semanticOnlyResult.pages[0].warnings.includes('visual-not-computed'), true)
assert.equal(semanticOnlyResult.stats.renderMs, 0)
assert.equal(semanticOnlyResult.textDiff?.stream[0]?.side, 'both')
const semanticOnlySession = await PiffSession.open(
  semanticOnlyBefore,
  semanticOnlyAfter,
  { ...semanticOptions, pageMatching: 'index', render: 'none' },
)
try {
  assert.equal(await semanticOnlySession.isEqual(), false)
} finally {
  await semanticOnlySession.close()
}
report.push({
  name: 'sdk-semantic-only-inline-fast-path',
  passed: true,
  totalMs: semanticOnlyResult.stats.totalMs,
})

const structuralResult = await piff(
  createTextPdf([[
    { text: '- Rust and TypeScript', x: 72, y: 700 },
    { text: '| Skill | Level |', x: 72, y: 640 },
    { text: '| Rust | Expert |', x: 72, y: 610 },
  ]]),
  createTextPdf([[
    { text: '- Rust, TypeScript, and PDFium', x: 72, y: 700 },
    { text: '| Skill | Level |', x: 72, y: 640 },
    { text: '| Rust | Advanced |', x: 72, y: 610 },
  ]]),
  semanticOptions,
)
const structuralKinds = new Set(
  structuralResult.pages[0].semantic?.blocks.map((block) => block.structure),
)
assert.ok(structuralKinds.has('list-item'))
assert.ok(structuralKinds.has('table-row'))
report.push({ name: 'sdk-structural-list-and-table-blocks', passed: true })

const singlePageHeadingResult = await piff(
  createTextPdf([[{ text: 'Single page heading', x: 72, y: 750 }]]),
  createTextPdf([[{ text: 'Single page heading revised', x: 72, y: 750 }]]),
  semanticOptions,
)
const singlePageHeadingBlocks = singlePageHeadingResult.pages[0].semantic?.blocks ?? []
assert.ok(singlePageHeadingBlocks.length > 0)
assert.ok(singlePageHeadingBlocks.every((block) => block.beforeRole === undefined || block.beforeRole === 'body'))
assert.ok(singlePageHeadingBlocks.every((block) => block.afterRole === undefined || block.afterRole === 'body'))
report.push({ name: 'sdk-single-page-edge-text-stays-body', passed: true })

const readingOrderPdf = createTextPdf([[
  { text: 'Left one', x: 72, y: 700 },
  { text: 'Right one', x: 320, y: 700 },
  { text: 'Left two', x: 72, y: 670 },
  { text: 'Right two', x: 320, y: 670 },
]])
for (const readingOrder of ['auto', 'rows', 'columns']) {
  const readingOrderResult = await piff(
    readingOrderPdf,
    readingOrderPdf,
    { ...semanticOptions, readingOrder },
  )
  assert.equal(readingOrderResult.equal, true)
}
report.push({ name: 'sdk-reading-order-options', passed: true })

await assert.rejects(
  () => piff(
    createTextPdf([['Invalid options.']]),
    createTextPdf([['Invalid options.']]),
    { ...semanticOptions, dpi: 0 },
  ),
  (error) => error instanceof PiffError && error.code === 'invalid-options',
)
await assert.rejects(
  () => piff(
    createTextPdf([['Invalid reading order.']]),
    createTextPdf([['Invalid reading order.']]),
    { ...semanticOptions, readingOrder: 'diagonal' },
  ),
  (error) => error instanceof PiffError
    && error.code === 'invalid-options'
    && /readingOrder/.test(error.message),
)
await assert.rejects(
  () => piff(
    createTextPdf([['Invalid context.']]),
    createTextPdf([['Invalid context.']]),
    { ...semanticOptions, contextLines: 101 },
  ),
  (error) => error instanceof PiffError && error.code === 'invalid-options',
)

const stablePdf = cases[0].before
await assert.rejects(
  () => piff(Buffer.from('%PDF-1.4\n% malformed fixture'), stablePdf, semanticOptions),
  /Pdfium|PDF|inspect/i,
)
await assert.rejects(
  () => piff(stablePdf, stablePdf, { ...semanticOptions, limits: { maxInputBytes: 1 } }),
  /exceeding.*input limit/i,
)
await assert.rejects(
  () => piff(cases[2].before, cases[2].before, { ...semanticOptions, pageMatching: 'index', limits: { maxPages: 1 } }),
  /pages.*limit/i,
)
await assert.rejects(
  () => piff(stablePdf, stablePdf, { ...semanticOptions, pageMatching: 'index', limits: { maxPagePixels: 1 } }),
  /pixels.*limit/i,
)
report.push({ name: 'malformed-and-resource-limits', passed: true })

const boundedCacheSession = await PiffSession.open(
  stablePdf,
  stablePdf,
  semanticOptions,
  { maxPreviewCacheBytes: 1 },
)
try {
  await boundedCacheSession.renderPageDiff(0, { view: 'diff' })
  const boundedCache = boundedCacheSession.cacheDiagnostics()
  assert.equal(boundedCache.maxPreviewCacheBytes, 1)
  assert.equal(boundedCache.previewCacheBytes, 0)
  assert.equal(boundedCache.previewCacheEntries, 0)
} finally {
  await boundedCacheSession.close()
}

const cacheProbeSession = await PiffSession.open(stablePdf, stablePdf, semanticOptions)
let diffPreviewBytes
let beforePreviewBytes
try {
  diffPreviewBytes = await cacheProbeSession.renderPageDiff(0, { view: 'diff' })
  beforePreviewBytes = await cacheProbeSession.renderPageDiff(0, { view: 'before' })
} finally {
  await cacheProbeSession.close()
}
const evictionSession = await PiffSession.open(
  stablePdf,
  stablePdf,
  semanticOptions,
  { maxPreviewCacheBytes: Math.max(diffPreviewBytes.byteLength, beforePreviewBytes.byteLength) },
)
try {
  await evictionSession.renderPageDiff(0, { view: 'diff' })
  await evictionSession.renderPageDiff(0, { view: 'before' })
  const evictedCache = evictionSession.cacheDiagnostics()
  assert.ok(evictedCache.previewCacheEvictions >= 1)
  assert.ok(evictedCache.previewCacheBytes <= evictedCache.maxPreviewCacheBytes)
  assert.ok(evictedCache.previewCacheEntries <= 1)
} finally {
  await evictionSession.close()
}
await assert.rejects(
  () => PiffSession.open(stablePdf, stablePdf, semanticOptions, { maxPreviewCacheBytes: -1 }),
  (error) => error instanceof PiffError && error.code === 'invalid-options',
)
report.push({ name: 'bounded-preview-cache-diagnostics-and-eviction', passed: true })

const referenceBeforePath = join(projectRoot, 'references/pdfium-render/test/text-test.pdf')
const referenceAfterPath = join(projectRoot, 'references/pdfium-render/test/export-test.pdf')
if (await fileExists(referenceBeforePath) && await fileExists(referenceAfterPath)) {
  const referenceResult = await piff(
    await readFile(referenceBeforePath),
    await readFile(referenceAfterPath),
    semanticOptions,
  )
  assert.equal(referenceResult.before.pageCount, 5)
  assert.equal(referenceResult.after.pageCount, 7)
  assert.equal(referenceResult.pages.filter((page) => page.status === 'inserted').length, 7)
  assert.equal(referenceResult.pages.filter((page) => page.status === 'deleted').length, 5)
  assert.ok(referenceResult.pages.every((page) => page.semantic?.changesTruncated !== true))
  report.push({
    name: 'pdfium-reference-pair',
    equal: referenceResult.equal,
    statuses: statuses(referenceResult),
    pageCount: referenceResult.pages.length,
    semanticChanges: referenceResult.pages.reduce((total, page) => total + (page.semantic?.changes.length ?? 0), 0),
    regions: referenceResult.pages.reduce((total, page) => total + page.regions.length, 0),
    warnings: [...new Set(referenceResult.pages.flatMap((page) => page.warnings))],
  })
} else {
  report.push({ name: 'pdfium-reference-pair', skipped: true })
}

const encryptedPath = join(projectRoot, 'references/pdf-inspector/tests/fixtures/encrypted-secret123.pdf')
if (await fileExists(encryptedPath)) {
  const encrypted = await readFile(encryptedPath)
  await assert.rejects(
    () => piff(encrypted, encrypted, { ...semanticOptions, password: 'wrong' }),
    (error) => error instanceof PiffError && error.code === 'password-required',
  )
  const decrypted = await piff(encrypted, encrypted, { ...semanticOptions, password: 'secret123' })
  assert.equal(decrypted.equal, true)
  const decryptedWithSeparatePasswords = await piff(encrypted, encrypted, {
    ...semanticOptions,
    beforePassword: 'secret123',
    afterPassword: 'secret123',
  })
  assert.equal(decryptedWithSeparatePasswords.equal, true)
  report.push({ name: 'encrypted-pdf-password-boundary', passed: true, pageCount: decrypted.before.pageCount })
} else {
  report.push({ name: 'encrypted-pdf-password-boundary', skipped: true })
}

const baselineDocument = createTextPdf([
  ['Candidate profile.', 'The platform engineer owns reliable systems.'],
])
const candidateADocument = createTextPdf([
  ['Candidate profile.', 'The platform engineer designs reliable systems.'],
])
const candidateBDocument = createTextPdf([
  ['Candidate profile.', 'The platform engineer builds resilient systems.'],
  ['Additional evidence.', 'Reduced deployment time by 30 percent.'],
])
const documentSetResult = await piffSet([
  { id: 'baseline', label: 'Baseline CV', bytes: baselineDocument },
  { id: 'candidate-a', label: 'Candidate A', bytes: candidateADocument },
  { id: 'candidate-b', label: 'Candidate B', bytes: candidateBDocument },
], {
  mode: 'semantic',
  render: 'none',
  strategy: 'baseline',
})
assert.equal(documentSetResult.primitive, 'document-set')
assert.equal(documentSetResult.strategy, 'baseline')
assert.deepEqual(documentSetResult.comparisons.map((comparison) => [
  comparison.fromRevisionId,
  comparison.toRevisionId,
]), [
  ['baseline', 'candidate-a'],
  ['baseline', 'candidate-b'],
])
const mergedTextChange = documentSetResult.changes.find((change) => (
  change.source === 'text'
  && change.anchors.some((anchor) => anchor.revisionId === 'baseline')
  && change.anchors.some((anchor) => anchor.revisionId === 'candidate-a')
  && change.anchors.some((anchor) => anchor.revisionId === 'candidate-b')
))
assert.ok(mergedTextChange)
assert.equal(mergedTextChange.kind, 'modified')
assert.equal(mergedTextChange.variants.length, 3)
assert.ok(documentSetResult.changes.some((change) => (
  change.source === 'text'
  && change.anchors.length === 1
  && change.anchors[0]?.revisionId === 'candidate-b'
  && change.anchors[0]?.state === 'introduced'
)))
assert.equal(documentSetResult.revisions[0].pageCount, 1)
assert.equal(documentSetResult.revisions[2].pageCount, 2)
const adjacentSet = await PiffDocumentSet.open([
  { id: 'baseline', bytes: baselineDocument },
  { id: 'candidate-a', bytes: candidateADocument },
  { id: 'candidate-b', bytes: candidateBDocument },
], {
  mode: 'semantic',
  render: 'none',
  pageMatching: 'sequence',
  strategy: 'adjacent',
})
try {
  const progressEvents = []
  const adjacentResult = await adjacentSet.compare({
    onProgress(event) {
      progressEvents.push(event)
    },
  })
  assert.deepEqual(adjacentResult.comparisons.map((comparison) => [
    comparison.fromRevisionId,
    comparison.toRevisionId,
  ]), [
    ['baseline', 'candidate-a'],
    ['candidate-a', 'candidate-b'],
  ])
  assert.ok(progressEvents.some((event) => event.phase === 'loading'))
  assert.ok(progressEvents.some((event) => event.phase === 'fingerprinting'))
  assert.ok(progressEvents.some((event) => event.phase === 'comparing'))
  assert.ok(progressEvents.every((event) => event.comparisonTotal === 2))
  assert.ok(progressEvents.some((event) => (
    event.fromRevisionId === 'candidate-a'
    && event.toRevisionId === 'candidate-b'
    && event.comparisonIndex === 2
  )))
  const setPreview = await adjacentSet.renderPageDiff('baseline', 'candidate-a', 0)
  assert.ok(setPreview.byteLength > 8)
} finally {
  await adjacentSet.close()
}
report.push({
  name: 'multi-document-revision-neutral-change-set',
  passed: true,
  comparisons: documentSetResult.comparisons.length,
  changes: documentSetResult.changes.length,
})

await mkdir(join(projectRoot, 'artifacts'), { recursive: true })
await writeFile(
  join(projectRoot, 'artifacts/regression-report.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    engine: reportEngine,
    cases: report,
  }, null, 2)}\n`,
)
console.log(`regression verification passed: ${report.filter((entry) => !entry.skipped).length} cases`)
if (report.some((entry) => entry.skipped)) {
  console.log('reference PDF pair skipped because the local reference checkout is unavailable')
}

function statuses(result) {
  return result.pages.map((page) => page.status)
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
