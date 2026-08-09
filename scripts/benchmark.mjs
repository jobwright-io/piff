import { performance } from 'node:perf_hooks'

import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
process.env.PIFF_NATIVE_MODULE ??= join(projectRoot, 'artifacts/piff.linux-x64-gnu.node')
process.env.PDFIUM_LIBRARY_PATH ??= join(projectRoot, 'artifacts/pdfium/linux-x64/lib/libpdfium.so')

const { PiffSession } = await import('../packages/piff/dist/index.js')
const { createTextPdf } = await import('./pdf-fixtures.mjs')
const args = parseArgs(process.argv.slice(2))
const iterations = positiveInteger(args.iterations ?? '3', '--iterations')
const warmup = nonNegativeInteger(args.warmup ?? '1', '--warmup')

const cases = [
  {
    name: 'semantic-text',
    before: createTextPdf([
      ['Profile summary.', 'The original document contains stable text.', 'Experience.'],
      ['Education.', 'The candidate has a computer science degree.'],
    ]),
    after: createTextPdf([
      ['Profile summary.', 'The revised document contains stable text.', 'Experience.'],
      ['Education.', 'The candidate has a computer science degree.'],
    ]),
    options: {
      dpi: 144,
      mode: 'semantic',
      pageMatching: 'sequence',
      readingOrder: 'auto',
    },
  },
  {
    name: 'semantic-text-only',
    before: createTextPdf([
      ['Profile summary.', 'The original document contains stable text.', 'Experience.'],
      ['Education.', 'The candidate has a computer science degree.'],
    ]),
    after: createTextPdf([
      ['Profile summary.', 'The revised document contains stable text.', 'Experience.'],
      ['Education.', 'The candidate has a computer science degree.'],
    ]),
    options: {
      mode: 'semantic',
      render: 'none',
      pageMatching: 'index',
      readingOrder: 'auto',
    },
  },
  {
    name: 'visual-regions',
    before: createTextPdf([{
      rectangles: [
        { x: 72, y: 420, width: 220, height: 140, fill: [0.12, 0.3, 0.82] },
        { x: 340, y: 420, width: 180, height: 90, fill: [0.8, 0.24, 0.18] },
      ],
    }]),
    after: createTextPdf([{
      rectangles: [
        { x: 82, y: 420, width: 220, height: 140, fill: [0.12, 0.3, 0.82] },
        { x: 340, y: 420, width: 180, height: 110, fill: [0.8, 0.24, 0.18] },
      ],
    }]),
    options: {
      dpi: 144,
      mode: 'visual',
      pageMatching: 'index',
    },
  },
]

const selectedCases = args.case === undefined
  ? cases
  : cases.filter((fixture) => fixture.name === args.case)
if (selectedCases.length === 0) {
  throw new Error(`unknown benchmark case "${args.case}"; expected ${cases.map((fixture) => fixture.name).join(', ')}`)
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  engine: undefined,
  iterations,
  warmup,
  cases: [],
}

for (const fixture of selectedCases) {
  for (let index = 0; index < warmup; index += 1) {
    await runCase(fixture)
  }

  const samples = []
  for (let index = 0; index < iterations; index += 1) {
    const sample = await runCase(fixture)
    report.engine ??= sample.engine
    samples.push(sample)
  }

  const phaseNames = Object.keys(samples[0].stats)
  report.cases.push({
    name: fixture.name,
    options: fixture.options,
    phasesMs: Object.fromEntries(phaseNames.map((phase) => [phase, summarize(samples.map((sample) => sample.stats[phase]))])),
    comparisonWallMs: summarize(samples.map((sample) => sample.comparisonWallMs)),
    previewWallMs: summarize(samples.map((sample) => sample.previewWallMs)),
    previewEncodeMs: summarize(samples.map((sample) => sample.previewEncodeMs)),
    previewBytes: summarize(samples.map((sample) => sample.previewBytes)),
    equal: samples[0].equal,
  })
}

if (args.json === true) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`piff benchmark ${report.engine?.version ?? 'unknown'} (${iterations} iterations, ${warmup} warmup)`)
  for (const benchmark of report.cases) {
    console.log(`\n${benchmark.name}`)
    for (const [phase, values] of Object.entries(benchmark.phasesMs)) {
      console.log(`  ${phase}: p50 ${values.p50.toFixed(2)} ms, mean ${values.mean.toFixed(2)} ms`)
    }
    console.log(`  comparison wall: p50 ${benchmark.comparisonWallMs.p50.toFixed(2)} ms`)
    console.log(`  preview wall: p50 ${benchmark.previewWallMs.p50.toFixed(2)} ms`)
    console.log(`  preview PNG encode: p50 ${benchmark.previewEncodeMs.p50.toFixed(2)} ms`)
  }
}

async function runCase(fixture) {
  const session = await PiffSession.open(
    fixture.before,
    fixture.after,
    fixture.options,
    { maxPreviewCacheBytes: 0 },
  )
  try {
    const comparisonStarted = performance.now()
    const result = await session.compare()
    const comparisonWallMs = performance.now() - comparisonStarted
    let previewWallMs = 0
    let previewEncodeMs = 0
    let previewBytes = 0
    if (fixture.options.render !== 'none') {
      const previewStarted = performance.now()
      const preview = await session.renderPageDiffWithTiming(0, { view: 'diff' })
      previewWallMs = performance.now() - previewStarted
      previewEncodeMs = preview.encodeMs
      previewBytes = preview.bytes.byteLength
    }
    return {
      engine: result.engine,
      equal: result.equal,
      stats: result.stats,
      comparisonWallMs,
      previewWallMs,
      previewEncodeMs,
      previewBytes,
    }
  } finally {
    await session.close()
  }
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const p50 = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
  return {
    min: sorted[0],
    p50,
    mean: values.reduce((total, value) => total + value, 0) / values.length,
    max: sorted.at(-1),
  }
}

function parseArgs(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--') {
      continue
    }
    if (value === '--json') {
      result.json = true
      continue
    }
    if (!value.startsWith('--')) {
      throw new Error(`unexpected argument ${value}`)
    }
    const key = value.slice(2)
    const next = values[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`missing value for --${key}`)
    }
    result[key] = next
    index += 1
  }
  return result
}

function positiveInteger(value, flag) {
  const parsed = nonNegativeInteger(value, flag)
  if (parsed === 0) {
    throw new Error(`${flag} must be greater than zero`)
  }
  return parsed
}

function nonNegativeInteger(value, flag) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`)
  }
  return parsed
}
