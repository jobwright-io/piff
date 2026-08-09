import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const referenceRoot = resolve(process.env.PIFF_REFERENCE_ROOT ?? join(projectRoot, 'references'))
const required = process.env.PIFF_GOLDEN_REQUIRED === '1'
process.env.PIFF_NATIVE_MODULE ??= join(projectRoot, 'artifacts/piff.linux-x64-gnu.node')
process.env.PDFIUM_LIBRARY_PATH ??= join(projectRoot, 'artifacts/pdfium/linux-x64/lib/libpdfium.so')

const { PiffError, PiffSession, piff } = await import('../packages/piff/dist/index.js')
const { createLocalGoldenFixture } = await import('./local-golden-fixtures.mjs')
const manifest = JSON.parse(await readFile(join(projectRoot, 'fixtures/golden/manifest.json'), 'utf8'))
const localManifest = JSON.parse(await readFile(join(projectRoot, 'fixtures/golden/local-manifest.json'), 'utf8'))
const promotedRoot = join(projectRoot, 'fixtures/golden/promoted')
const promotedManifest = JSON.parse(await readFile(join(promotedRoot, 'manifest.json'), 'utf8'))
assert.equal(promotedManifest.schemaVersion, 1, 'unsupported promoted corpus manifest schema')
assert.ok(Array.isArray(promotedManifest.fixtures), 'promoted corpus fixtures must be an array')
const report = []

for (const fixture of manifest.fixtures) {
  const source = manifest.sources[fixture.source]
  assert.ok(source, `unknown golden fixture source: ${fixture.source}`)
  const sourceRoot = join(referenceRoot, source.directory)
  const beforePath = join(sourceRoot, fixture.before)
  const afterPath = join(sourceRoot, fixture.after)
  if (!(await fileExists(beforePath)) || !(await fileExists(afterPath))) {
    const entry = { id: fixture.id, source: fixture.source, skipped: true }
    if (required) {
      throw new Error(`missing required golden fixture ${fixture.id}: ${beforePath}`)
    }
    report.push(entry)
    continue
  }

  const before = await readFile(beforePath)
  const after = await readFile(afterPath)
  assert.equal(sha256(before), fixture.beforeSha256, `${fixture.id} before fixture hash changed`)
  assert.equal(sha256(after), fixture.afterSha256, `${fixture.id} after fixture hash changed`)

  const options = {
    dpi: 72,
    ...fixture.options,
    ...(fixture.password === undefined ? {} : { password: fixture.password }),
  }
  const first = await piff(before, after, options)
  const second = await piff(before, after, options)
  assert.deepEqual(stableResult(first), stableResult(second), `${fixture.id} output is not deterministic`)
  assert.equal(first.before.pageCount, fixture.expect.beforePages, `${fixture.id} before page count`)
  assert.equal(first.after.pageCount, fixture.expect.afterPages, `${fixture.id} after page count`)
  assert.equal(first.equal, fixture.expect.equal, `${fixture.id} equality`)

  assertComparisonExpectations(fixture, first)

  let previewBytes
  if (fixture.expect.preview === true) {
    const session = await PiffSession.open(before, after, options)
    try {
      previewBytes = await session.renderPageDiff(0, { view: 'diff' })
      const cached = await session.renderPageDiff(0, { view: 'diff' })
      assert.deepEqual(cached, previewBytes, `${fixture.id} preview changed between requests`)
      assert.equal(session.cacheDiagnostics().previewCacheHits, 1, `${fixture.id} preview cache hit`)
    } finally {
      await session.close()
    }
  }

  report.push({
    id: fixture.id,
    source: fixture.source,
    beforePages: first.before.pageCount,
    afterPages: first.after.pageCount,
    equal: first.equal,
    statuses: statusCounts(first),
    previewBytes: previewBytes?.byteLength,
    previewSha256: previewBytes === undefined ? undefined : sha256(previewBytes),
  })
}

for (const fixture of promotedManifest.fixtures) {
  assert.equal(fixture.target, 'pdf_loading', `${fixture.id} promoted target`)
  assert.match(fixture.id, /^[a-z0-9][a-z0-9._-]*$/, `${fixture.id} promoted ID`)
  assert.equal(typeof fixture.path, 'string', `${fixture.id} promoted path`)
  assert.ok(Number.isSafeInteger(fixture.bytes) && fixture.bytes > 0, `${fixture.id} promoted byte count`)
  assert.match(fixture.sha256, /^[a-f0-9]{64}$/, `${fixture.id} promoted SHA-256`)
  const fixturePath = resolve(promotedRoot, fixture.path)
  const relativePath = relative(promotedRoot, fixturePath)
  assert.ok(
    relativePath !== '' && !isAbsolute(relativePath) && !relativePath.startsWith('..'),
    `${fixture.id} promoted path escapes corpus directory`,
  )
  const bytes = await readFile(fixturePath)
  assert.equal(bytes.length, fixture.bytes, `${fixture.id} promoted byte count changed`)
  assert.equal(sha256(bytes), fixture.sha256, `${fixture.id} promoted fixture hash changed`)

  const options = { dpi: 72, mode: 'semantic', pageMatching: 'index' }
  if (fixture.expectError !== undefined) {
    const firstError = await capturePiffError(bytes, bytes, options, fixture.id)
    const secondError = await capturePiffError(bytes, bytes, options, fixture.id)
    assert.deepEqual(secondError, firstError, `${fixture.id} promoted error is not deterministic`)
    assert.equal(firstError.code, fixture.expectError, `${fixture.id} promoted error code`)
    report.push({ id: fixture.id, source: 'promoted', bytes: bytes.length, errorCode: firstError.code })
    continue
  }

  const first = await piff(bytes, bytes, options)
  const second = await piff(bytes, bytes, options)
  assert.deepEqual(stableResult(first), stableResult(second), `${fixture.id} promoted output is not deterministic`)
  assert.equal(first.equal, true, `${fixture.id} promoted self-comparison`)
  report.push({
    id: fixture.id,
    source: 'promoted',
    bytes: bytes.length,
    equal: first.equal,
    statuses: statusCounts(first),
  })
}

for (const fixture of localManifest.fixtures) {
  const generated = createLocalGoldenFixture(fixture.generator)
  assert.equal(sha256(generated.before), fixture.beforeSha256, `${fixture.id} before fixture hash changed`)
  assert.equal(sha256(generated.after), fixture.afterSha256, `${fixture.id} after fixture hash changed`)

  const options = { dpi: 72, ...fixture.options }
  if (fixture.kind === 'error') {
    const firstError = await capturePiffError(generated.before, generated.after, options, fixture.id)
    const secondError = await capturePiffError(generated.before, generated.after, options, fixture.id)
    assert.deepEqual(secondError, firstError, `${fixture.id} error classification is not deterministic`)
    assert.equal(firstError.code, fixture.expect.errorCode, `${fixture.id} error code`)
    report.push({ id: fixture.id, source: 'local', errorCode: firstError.code })
    continue
  }

  const first = await piff(generated.before, generated.after, options)
  const second = await piff(generated.before, generated.after, options)
  assert.deepEqual(stableResult(first), stableResult(second), `${fixture.id} output is not deterministic`)
  assert.equal(first.before.pageCount, fixture.expect.beforePages, `${fixture.id} before page count`)
  assert.equal(first.after.pageCount, fixture.expect.afterPages, `${fixture.id} after page count`)
  assert.equal(first.equal, fixture.expect.equal, `${fixture.id} equality`)
  assertComparisonExpectations(fixture, first)

  let previewBytes
  if (fixture.expect.preview === true) {
    const session = await PiffSession.open(generated.before, generated.after, options)
    try {
      previewBytes = await session.renderPageDiff(0, { view: 'diff' })
      const cached = await session.renderPageDiff(0, { view: 'diff' })
      assert.deepEqual(cached, previewBytes, `${fixture.id} preview changed between requests`)
      assert.equal(session.cacheDiagnostics().previewCacheHits, 1, `${fixture.id} preview cache hit`)
    } finally {
      await session.close()
    }
  }

  report.push({
    id: fixture.id,
    source: 'local',
    beforePages: first.before.pageCount,
    afterPages: first.after.pageCount,
    equal: first.equal,
    statuses: statusCounts(first),
    figureStatuses: first.pages.flatMap((page) => page.figures.map((figure) => figure.status)),
    previewBytes: previewBytes?.byteLength,
    previewSha256: previewBytes === undefined ? undefined : sha256(previewBytes),
  })
}

await mkdir(join(projectRoot, 'artifacts'), { recursive: true })
await writeFile(
  join(projectRoot, 'artifacts/golden-report.json'),
  `${JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    generatedAt: new Date().toISOString(),
    referenceRoot,
    sources: manifest.sources,
    localManifest: 'fixtures/golden/local-manifest.json',
    promotedManifest: 'fixtures/golden/promoted/manifest.json',
    cases: report,
  }, null, 2)}\n`,
)

const verified = report.filter((entry) => !entry.skipped)
const skipped = report.filter((entry) => entry.skipped)
console.log(`golden verification passed: ${verified.length} fixtures`)
if (skipped.length > 0) {
  console.log(`golden fixtures skipped: ${skipped.map((entry) => entry.id).join(', ')}`)
}

function stableResult(result) {
  return {
    schemaVersion: result.schemaVersion,
    engine: result.engine,
    equal: result.equal,
    before: result.before,
    after: result.after,
    pages: result.pages,
    textDiff: result.textDiff,
  }
}

function statusCounts(result) {
  return Object.fromEntries(
    [...new Set(result.pages.map((page) => page.status))]
      .sort()
      .map((status) => [status, result.pages.filter((page) => page.status === status).length]),
  )
}

function assertComparisonExpectations(fixture, result) {
  if (fixture.expect.semanticQuality !== undefined) {
    assert.ok(
      result.pages
        .filter((page) => page.beforePage !== undefined && page.afterPage !== undefined)
        .every((page) => page.semantic?.quality === fixture.expect.semanticQuality),
      `${fixture.id} semantic quality`,
    )
  }
  if (fixture.expect.statusCounts !== undefined) {
    assert.deepEqual(statusCounts(result), fixture.expect.statusCounts, `${fixture.id} page statuses`)
  }
  const blocks = result.pages.flatMap((page) => page.semantic?.blocks ?? [])
  for (const structure of fixture.expect.requiredStructures ?? []) {
    assert.ok(blocks.some((block) => block.structure === structure), `${fixture.id} missing structure ${structure}`)
  }
  for (const kind of fixture.expect.requiredBlockKinds ?? []) {
    assert.ok(blocks.some((block) => block.kind === kind), `${fixture.id} missing block kind ${kind}`)
  }
  const roles = new Set(blocks.flatMap((block) => [block.beforeRole, block.afterRole].filter(Boolean)))
  for (const role of fixture.expect.requiredRoles ?? []) {
    assert.ok(roles.has(role), `${fixture.id} missing role ${role}`)
  }
  if (fixture.expect.requiredFigureStatuses !== undefined) {
    assert.deepEqual(
      result.pages.flatMap((page) => page.figures.map((figure) => figure.status)),
      fixture.expect.requiredFigureStatuses,
      `${fixture.id} figure statuses`,
    )
  }
  const warnings = new Set(result.pages.flatMap((page) => page.warnings))
  for (const warning of fixture.expect.requiredWarnings ?? []) {
    assert.ok(warnings.has(warning), `${fixture.id} missing warning ${warning}`)
  }
  const serialized = JSON.stringify(result)
  for (const text of fixture.expect.requiredText ?? []) {
    assert.ok(serialized.includes(text), `${fixture.id} missing text evidence ${text}`)
  }
}

async function capturePiffError(before, after, options, fixtureId) {
  try {
    await piff(before, after, options)
  } catch (error) {
    assert.ok(error instanceof PiffError, `${fixtureId} did not return a PiffError`)
    return { code: error.code, message: error.message }
  }
  throw new Error(`${fixtureId} unexpectedly succeeded`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
