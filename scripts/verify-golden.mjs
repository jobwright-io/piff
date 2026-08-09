import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const referenceRoot = resolve(process.env.PIFF_REFERENCE_ROOT ?? join(projectRoot, 'references'))
const required = process.env.PIFF_GOLDEN_REQUIRED === '1'
process.env.PIFF_NATIVE_MODULE ??= join(projectRoot, 'artifacts/piff.linux-x64-gnu.node')
process.env.PDFIUM_LIBRARY_PATH ??= join(projectRoot, 'artifacts/pdfium/linux-x64/lib/libpdfium.so')

const { PiffSession, piff } = await import('../packages/piff/dist/index.js')
const manifest = JSON.parse(await readFile(join(projectRoot, 'fixtures/golden/manifest.json'), 'utf8'))
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
  const warmup = fixture.expect.warmup === true ? await piff(before, after, options) : undefined
  const first = await piff(before, after, options)
  const second = await piff(before, after, options)
  assert.deepEqual(stableResult(first), stableResult(second), `${fixture.id} output is not deterministic`)
  assert.equal(first.before.pageCount, fixture.expect.beforePages, `${fixture.id} before page count`)
  assert.equal(first.after.pageCount, fixture.expect.afterPages, `${fixture.id} after page count`)
  assert.equal(first.equal, fixture.expect.equal, `${fixture.id} equality`)

  if (fixture.expect.semanticQuality !== undefined) {
    assert.ok(
      first.pages
        .filter((page) => page.beforePage !== undefined && page.afterPage !== undefined)
        .every((page) => page.semantic?.quality === fixture.expect.semanticQuality),
      `${fixture.id} semantic quality`,
    )
  }
  if (fixture.expect.statusCounts !== undefined) {
    assert.deepEqual(statusCounts(first), fixture.expect.statusCounts, `${fixture.id} page statuses`)
  }

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
    warmupChanged: warmup === undefined ? undefined : !deepEqual(stableResult(warmup), stableResult(first)),
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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function deepEqual(left, right) {
  try {
    assert.deepEqual(left, right)
    return true
  } catch {
    return false
  }
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
