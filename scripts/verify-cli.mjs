import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createTextPdf } from './pdf-fixtures.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const binary = process.env.PIFF_BIN ?? process.env.PDF_DIFF_BIN ?? join(projectRoot, 'target/debug/piff')
const pdfium = process.env.PDFIUM_LIBRARY_PATH ?? join(projectRoot, 'artifacts/pdfium/linux-x64/lib/libpdfium.so')
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'pdf-differ-cli-'))

try {
  const beforePath = join(temporaryDirectory, 'before.pdf')
  const afterPath = join(temporaryDirectory, 'after.pdf')
  const reportPath = join(temporaryDirectory, 'report.json')
  await writeFile(beforePath, createTextPdf([['CLI contract.', 'The release is ready for review.']]))
  await writeFile(afterPath, createTextPdf([['CLI contract.', 'The release is ready for release.']]))

  const doctor = await run(['doctor', '--compact'])
  assert.equal(doctor.status, 0)
  assert.deepEqual(JSON.parse(doctor.stdout), {
    schema_version: 1,
    ok: true,
    engine: {
      name: 'pdf-differ',
      version: '0.1.0',
      renderer: 'pdfium',
      binding: 'pdfium-render',
    },
    library: pdfium,
  })

  const equal = await run(['equal', beforePath, beforePath, '--compact'])
  assert.equal(equal.status, 0)
  assert.equal(JSON.parse(equal.stdout).equal, true)

  const report = await run([
    'compare',
    beforePath,
    afterPath,
    '--mode',
    'semantic',
    '--reading-order',
    'rows',
    '--compact',
    '--fail-on-diff',
    '--output',
    reportPath,
  ])
  assert.equal(report.status, 1)
  assert.equal(report.stdout, '')
  const reportJson = JSON.parse(await readFile(reportPath, 'utf8'))
  assert.equal(reportJson.schema_version, 1)
  assert.equal(reportJson.equal, false)
  assert.equal(reportJson.pages[0].semantic.changes.length, 1)

  const unequal = await run(['equal', beforePath, afterPath, '--compact'])
  assert.equal(unequal.status, 1)
  assert.equal(JSON.parse(unequal.stdout).equal, false)

  const humanDiff = await run(['diff', beforePath, afterPath])
  assert.equal(humanDiff.status, 1)
  assert.match(humanDiff.stdout, /^--- /m)
  assert.match(humanDiff.stdout, /^\+\+\+ /m)
  assert.match(humanDiff.stdout, /^@@ -\d+ \+\d+ @@$/m)
  assert.match(humanDiff.stdout, /\[-review-\]/)
  assert.match(humanDiff.stdout, /\{\+release\+\}/)

  const machineDiff = await run([
    'diff',
    beforePath,
    afterPath,
    '--format',
    'json',
    '--compact',
    '--context-lines',
    '0',
  ])
  assert.equal(machineDiff.status, 1)
  const machineJson = JSON.parse(machineDiff.stdout)
  assert.equal(machineJson.changed_lines, 2)
  assert.equal(machineJson.pages.length, 1)
  assert.equal(machineJson.pages[0].before_page, 0)
  assert.equal(machineJson.pages[0].after_page, 0)
  assert.equal(machineJson.stream.length, 1)
  assert.equal(machineJson.stream[0].page_index, 0)
  assert.equal(machineJson.stream[0].block_id, machineJson.pages[0].blocks[0].id)
  assert.ok(machineJson.pages[0].text_diff.hunks[0].lines.every((line) => line.kind !== 'context'))

  const humanEqual = await run(['diff', beforePath, beforePath])
  assert.equal(humanEqual.status, 0)
  assert.equal(humanEqual.stdout, '')

  const limited = await run(['compare', beforePath, afterPath, '--max-input-bytes', '1'])
  assert.equal(limited.status, 2)
  assert.equal(JSON.parse(limited.stderr).error.code, 'input-too-large')

  const missing = await run(['compare', join(temporaryDirectory, 'missing.pdf'), afterPath])
  assert.equal(missing.status, 2)
  assert.equal(JSON.parse(missing.stderr).error.code, 'input-metadata')

  const protectedPath = join(
    projectRoot,
    'references/hayro/hayro-tests/pdfs/custom/password_encrypted_aes_128.pdf',
  )
  if (existsSync(protectedPath)) {
    const protectedWithoutPassword = await run(['equal', protectedPath, protectedPath, '--compact'])
    assert.equal(protectedWithoutPassword.status, 2)
    assert.equal(JSON.parse(protectedWithoutPassword.stderr).error.code, 'password-required')

    const protectedWithWrongPassword = await run([
      'equal',
      protectedPath,
      protectedPath,
      '--password',
      'wrong-password',
      '--compact',
    ])
    assert.equal(protectedWithWrongPassword.status, 2)
    assert.equal(JSON.parse(protectedWithWrongPassword.stderr).error.code, 'password-required')

    const protectedWithSeparatePasswords = await run([
      'equal',
      protectedPath,
      protectedPath,
      '--before-password',
      'testpw',
      '--after-password',
      'testpw',
      '--compact',
    ])
    assert.equal(protectedWithSeparatePasswords.status, 0)
    assert.equal(JSON.parse(protectedWithSeparatePasswords.stdout).equal, true)
  }

  console.log('CLI verification passed: doctor, equal, compare, diff, passwords, exit codes, output files, and errors')
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}

async function run(args) {
  try {
    const result = await execFileAsync(binary, args, {
      cwd: projectRoot,
      env: { ...process.env, PDFIUM_LIBRARY_PATH: pdfium },
      maxBuffer: 16_000_000,
    })
    return { status: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return {
      status: typeof error.code === 'number' ? error.code : Number(error.code ?? 2),
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }
  }
}
