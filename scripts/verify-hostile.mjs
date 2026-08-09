import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createTextPdf } from './pdf-fixtures.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
process.env.PIFF_NATIVE_MODULE = resolve(
  process.env.PIFF_NATIVE_MODULE ?? join(projectRoot, 'artifacts/piff.linux-x64-gnu.node'),
)
process.env.PDFIUM_LIBRARY_PATH = resolve(
  process.env.PDFIUM_LIBRARY_PATH ?? join(projectRoot, 'artifacts/pdfium/linux-x64/lib/libpdfium.so'),
)

const { PiffError, PiffSession, piff } = await import('../packages/piff/dist/index.js')
const binary = process.env.PIFF_BIN ?? join(projectRoot, 'target/debug/piff')
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'piff-hostile-'))
const semanticOptions = { dpi: 72, mode: 'semantic', pageMatching: 'index' }
const visualOptions = { dpi: 288, mode: 'visual', pageMatching: 'index' }
const stablePdf = createTextPdf([['Stable hostile-input fixture.']])
const stressBefore = createStressPdf(false)
const stressAfter = createStressPdf(true)
const report = []

try {
  await verifySdkErrorBoundaries()
  await verifyProgressAndCancellation()
  await verifyFreshProcessDeterminism()
  await verifyCliBoundaries()
  console.log(`hostile verification passed: ${report.length} checks`)
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}

async function verifySdkErrorBoundaries() {
  const malformed = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%EOF\n',
    'binary',
  )
  const malformedFirst = await expectPiffError(
    'sdk-malformed-input',
    () => piff(malformed, stablePdf, semanticOptions),
    'pdfium',
  )
  const malformedSecond = await expectPiffError(
    'sdk-malformed-input-repeat',
    () => piff(malformed, stablePdf, semanticOptions),
    'pdfium',
  )
  assert.deepEqual(malformedSecond, malformedFirst)

  await expectPiffError(
    'sdk-input-limit',
    () => piff(stablePdf, stablePdf, { ...semanticOptions, limits: { maxInputBytes: 1 } }),
    'input-too-large',
  )
  await expectPiffError(
    'sdk-page-limit',
    () => piff(stressBefore, stressAfter, { ...visualOptions, limits: { maxPages: 1 } }),
    'page-limit-exceeded',
  )
  await expectPiffError(
    'sdk-pixel-limit',
    () => piff(stablePdf, stablePdf, { ...semanticOptions, limits: { maxPagePixels: 1 } }),
    'page-pixels-exceeded',
  )
  await expectPiffError(
    'sdk-invalid-limit',
    () => piff(stablePdf, stablePdf, { ...semanticOptions, limits: { maxPages: 0 } }),
    'invalid-options',
  )
  await expectPiffError(
    'sdk-invalid-dpi',
    () => piff(stablePdf, stablePdf, { ...semanticOptions, dpi: 0 }),
    'invalid-options',
  )
  report.push('sdk-error-boundaries')
}

async function verifyProgressAndCancellation() {
  const progressSession = await PiffSession.open(stressBefore, stressAfter, visualOptions)
  const progressEvents = []
  try {
    const result = await progressSession.compare({
      onProgress(event) {
        progressEvents.push(event.phase)
      },
    })
    await flushCallbacks()
    assert.equal(result.equal, false)
    assert.deepEqual([...new Set(progressEvents)], ['loading', 'rendering', 'comparing'])
  } finally {
    await progressSession.close()
  }

  const fingerprintSession = await PiffSession.open(
    stressBefore,
    stressAfter,
    { ...visualOptions, pageMatching: 'sequence' },
  )
  const fingerprintEvents = []
  try {
    const result = await fingerprintSession.compare({
      onProgress(event) {
        fingerprintEvents.push(event.phase)
      },
    })
    await flushCallbacks()
    assert.equal(result.equal, false)
    assert.ok(fingerprintEvents.includes('fingerprinting'))
  } finally {
    await fingerprintSession.close()
  }

  const preCancelled = new AbortController()
  preCancelled.abort()
  const preCancelledSession = await PiffSession.open(stablePdf, stablePdf, semanticOptions)
  try {
    await expectPiffError(
      'sdk-pre-cancelled-compare',
      () => preCancelledSession.compare({ signal: preCancelled.signal }),
      'cancelled',
    )
    await expectPiffError(
      'sdk-pre-cancelled-equality',
      () => preCancelledSession.isEqual({ signal: preCancelled.signal }),
      'cancelled',
    )
    await expectPiffError(
      'sdk-pre-cancelled-preview',
      () => preCancelledSession.renderPageDiff(0, { signal: preCancelled.signal }),
      'cancelled',
    )
  } finally {
    await preCancelledSession.close()
  }

  const inFlightSession = await PiffSession.open(stressBefore, stressAfter, visualOptions)
  const inFlightController = new AbortController()
  const inFlight = inFlightSession.compare({ signal: inFlightController.signal })
  setTimeout(() => inFlightController.abort(), 1)
  try {
    await expectPiffError('sdk-in-flight-cancelled-compare', () => inFlight, 'cancelled')
  } finally {
    await inFlightSession.close()
  }

  for (const [phase, options] of [
    ['loading', visualOptions],
    ['fingerprinting', { ...visualOptions, pageMatching: 'sequence' }],
    ['rendering', visualOptions],
    ['comparing', visualOptions],
  ]) {
    const session = await PiffSession.open(stressBefore, stressAfter, options)
    const controller = new AbortController()
    const seen = []
    try {
      const pending = session.compare({
        signal: controller.signal,
        onProgress(event) {
          seen.push(event.phase)
          if (event.phase === phase) controller.abort()
        },
      })
      await expectPiffError(`sdk-phase-cancelled-${phase}`, () => pending, 'cancelled')
      assert.ok(seen.includes(phase), `${phase} progress event was not observed before cancellation`)
    } finally {
      await session.close()
    }
  }
  report.push('sdk-progress-and-cancellation')
}

async function verifyFreshProcessDeterminism() {
  const beforePath = join(temporaryDirectory, 'determinism-before.pdf')
  const afterPath = join(temporaryDirectory, 'determinism-after.pdf')
  await writeFile(beforePath, stressBefore)
  await writeFile(afterPath, stressAfter)
  const childScript = `
    import { createHash } from 'node:crypto'
    import { readFile } from 'node:fs/promises'
    import { piff } from './packages/piff/dist/index.js'

    const result = await piff(
      await readFile(process.env.PIFF_HOSTILE_BEFORE),
      await readFile(process.env.PIFF_HOSTILE_AFTER),
      JSON.parse(process.env.PIFF_HOSTILE_OPTIONS),
    )
    const stable = {
      schemaVersion: result.schemaVersion,
      engine: result.engine,
      equal: result.equal,
      before: result.before,
      after: result.after,
      pages: result.pages,
      textDiff: result.textDiff,
    }
    process.stdout.write(createHash('sha256').update(JSON.stringify(stable)).digest('hex'))
  `
  const environment = {
    ...process.env,
    PIFF_HOSTILE_BEFORE: beforePath,
    PIFF_HOSTILE_AFTER: afterPath,
    PIFF_HOSTILE_OPTIONS: JSON.stringify(visualOptions),
  }
  const first = await runNode(childScript, environment)
  const second = await runNode(childScript, environment)
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(second, first)
  report.push('fresh-process-determinism')
}

async function verifyCliBoundaries() {
  const beforePath = join(temporaryDirectory, 'cli-before.pdf')
  const afterPath = join(temporaryDirectory, 'cli-after.pdf')
  const malformedPath = join(temporaryDirectory, 'cli-malformed.pdf')
  await writeFile(beforePath, stressBefore)
  await writeFile(afterPath, stressAfter)
  await writeFile(malformedPath, Buffer.from('%PDF-1.4\n% malformed hostile fixture\n', 'binary'))

  assert.equal((await runCli(['compare', beforePath, afterPath, '--max-input-bytes', '1'])).errorCode, 'input-too-large')
  assert.equal((await runCli(['compare', beforePath, afterPath, '--max-pages', '1'])).errorCode, 'page-limit-exceeded')
  assert.equal((await runCli(['compare', beforePath, afterPath, '--max-page-pixels', '1'])).errorCode, 'page-pixels-exceeded')
  assert.equal((await runCli(['compare', malformedPath, afterPath])).errorCode, 'pdfium')

  const firstDiff = await runCli([
    'diff',
    beforePath,
    afterPath,
    '--format',
    'json',
    '--compact',
  ])
  const secondDiff = await runCli([
    'diff',
    beforePath,
    afterPath,
    '--format',
    'json',
    '--compact',
  ])
  assert.equal(firstDiff.status, 1)
  assert.equal(secondDiff.status, 1)
  assert.deepEqual(JSON.parse(secondDiff.stdout), JSON.parse(firstDiff.stdout))
  report.push('cli-limits-errors-and-determinism')
}

async function expectPiffError(name, operation, code) {
  let error
  try {
    await operation()
  } catch (candidate) {
    error = candidate
  }
  assert.ok(error instanceof PiffError, `${name} did not throw PiffError`)
  assert.equal(error.code, code, `${name} error code`)
  return { code: error.code, message: error.message }
}

async function runCli(args) {
  try {
    const result = await execFileAsync(binary, args, {
      cwd: projectRoot,
      env: { ...process.env, PDFIUM_LIBRARY_PATH: process.env.PDFIUM_LIBRARY_PATH },
      maxBuffer: 16_000_000,
    })
    return { status: 0, stdout: result.stdout, stderr: result.stderr, errorCode: undefined }
  } catch (error) {
    const stderr = error.stderr ?? ''
    const status = typeof error.code === 'number' ? error.code : Number(error.code ?? 2)
    const parsed = status === 2 && stderr.length > 0 ? JSON.parse(stderr) : undefined
    return {
      status,
      stdout: error.stdout ?? '',
      stderr,
      errorCode: parsed?.error?.code,
    }
  }
}

async function runNode(script, env) {
  const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: projectRoot,
    env,
    maxBuffer: 16_000_000,
  })
  return result.stdout.trim()
}

async function flushCallbacks() {
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
}

function createStressPdf(changed) {
  const pages = Array.from({ length: 6 }, (_, pageIndex) => Array.from({ length: 12 }, (_, lineIndex) => ({
    text: `Stress page ${pageIndex + 1} line ${lineIndex + 1} ${
      changed && pageIndex === 5 && lineIndex === 11 ? 'CHANGED ' : ''
    }${'stable content '.repeat(12)}`,
    x: 48,
    y: 740 - lineIndex * 52,
    size: 16,
  })))
  return createTextPdf(pages)
}
