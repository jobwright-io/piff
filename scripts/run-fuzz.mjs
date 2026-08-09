import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createTextPdf } from './pdf-fixtures.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fuzzRoot = join(projectRoot, 'fuzz')
const targetNames = ['semantic_normalization', 'pdf_loading']
const args = parseArgs(process.argv.slice(2))
const requestedTarget = args.target ?? 'all'
const seconds = positiveInteger(args.seconds ?? '30', 'seconds')
const artifactRoot = resolve(args.artifacts ?? join(projectRoot, 'artifacts/fuzz'))
const targets = requestedTarget === 'all' ? targetNames : [requestedTarget]

for (const target of targets) {
  if (!targetNames.includes(target)) {
    throw new Error(`unknown fuzz target "${target}"; expected ${targetNames.join(', ')} or all`)
  }
}

await assertCargoFuzz()
await mkdir(artifactRoot, { recursive: true })
const runRoot = await mkdtemp(join(tmpdir(), 'piff-fuzz-'))

try {
  for (const target of targets) {
    const corpus = join(runRoot, target)
    const targetArtifacts = join(artifactRoot, target)
    await mkdir(targetArtifacts, { recursive: true })
    await cp(join(fuzzRoot, 'seeds', target), corpus, { recursive: true })
    if (target === 'pdf_loading') {
      await writeFile(
        join(corpus, 'generated-basic.pdf'),
        createTextPdf([
          ['Fuzz seed document.', 'This page exercises the PDFium loading path.'],
          ['Second page.', 'The generated seed stays small and deterministic.'],
        ]),
      )
    }

    const commandArgs = [
      '+nightly',
      'fuzz',
      'run',
      target,
      corpus,
      '--',
      `-max_total_time=${seconds}`,
      '-timeout=10',
      '-rss_limit_mb=1024',
      '-max_len=65536',
      '-verbosity=0',
      '-print_final_stats=1',
      `-artifact_prefix=${targetArtifacts}${process.platform === 'win32' ? '\\' : '/'}`,
    ]
    console.log(`fuzzing ${target} for ${seconds}s`)
    await runProcess('cargo', commandArgs, {
      cwd: fuzzRoot,
      env: {
        ...process.env,
        ...(process.env.PDFIUM_LIBRARY_PATH === undefined
          ? {}
          : { PDFIUM_LIBRARY_PATH: resolve(projectRoot, process.env.PDFIUM_LIBRARY_PATH) }),
      },
    })
  }
} finally {
  await rm(runRoot, { recursive: true, force: true })
}

async function assertCargoFuzz() {
  try {
    await execFileAsync('cargo', ['+nightly', 'fuzz', '--help'], { cwd: fuzzRoot })
  } catch {
    throw new Error(
      'cargo-fuzz and the nightly Rust toolchain are required. Install cargo-fuzz, then run `pnpm fuzz -- --seconds 30`.',
    )
  }
}

function runProcess(command, commandArgs, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, { ...options, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${command} fuzz process exited with ${signal ?? `status ${code}`}`))
    })
  })
}

function parseArgs(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--') continue
    if (!value.startsWith('--')) throw new Error(`unexpected argument ${value}`)
    const key = value.slice(2)
    const next = values[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`missing value for --${key}`)
    result[key] = next
    index += 1
  }
  return result
}

function positiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}
