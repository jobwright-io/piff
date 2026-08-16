import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { parsePdfiumVersion } from './pdfium-version.mjs'

const args = parseArgs(process.argv.slice(2))
const packageRoot = resolve(required(args, 'package'))
const target = required(args, 'target')
const expectedPdfiumTag = args['pdfium-tag']
const manifestPath = join(packageRoot, 'artifact-manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))

assert.equal(manifest.schemaVersion, 1, 'unsupported native artifact manifest schema')
assert.equal(manifest.package.target, target, 'native artifact target mismatch')
assert.equal(manifest.package.name, `@jobwright-io/piffjs-${target}`, 'native artifact package name mismatch')
assert.equal(manifest.package.version, packageJson.version, 'native artifact package version mismatch')
assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'native artifact file manifest is empty')
assert.ok(packageJson.files?.includes('artifact-manifest.json'), 'package.json does not include artifact-manifest.json')
assert.ok(packageJson.files?.includes('LICENSE'), 'package.json does not include the project license')
assert.equal(packageJson.publishConfig?.access, 'public', 'native package must publish publicly')
assert.equal(packageJson.publishConfig?.registry, undefined, 'native package must not pin a registry')
assert.equal(packageJson.repository?.url, 'git+https://github.com/jobwright-io/piffjs.git', 'repository URL mismatch')

const versionText = await readFile(join(packageRoot, 'pdfium/VERSION'), 'utf8')
const pdfiumVersion = parsePdfiumVersion(versionText)
assert.equal(manifest.renderer.name, 'pdfium', 'native artifact renderer mismatch')
assert.equal(manifest.renderer.version, pdfiumVersion.version, 'native artifact PDFium version mismatch')
assert.equal(manifest.renderer.build ?? undefined, pdfiumVersion.build, 'native artifact PDFium build mismatch')
assert.equal(manifest.renderer.versionFile, 'pdfium/VERSION', 'native artifact version file mismatch')
if (expectedPdfiumTag !== undefined) {
  assert.equal(pdfiumVersion.build, expectedPdfiumTag, 'native artifact PDFium tag mismatch')
}

const expectedFiles = [...manifest.files].sort((left, right) => comparePaths(left.path, right.path))
assert.equal(new Set(expectedFiles.map((file) => file.path)).size, expectedFiles.length, 'native artifact file paths are duplicated')
const actualFiles = (await listFiles(packageRoot))
  .filter((path) => path !== manifestPath)
  .map((path) => relative(packageRoot, path).replaceAll('\\', '/'))
  .sort(comparePaths)
assert.deepEqual(expectedFiles.map((file) => file.path), actualFiles, 'native artifact file set changed')

for (const file of expectedFiles) {
  const bytes = await readFile(join(packageRoot, file.path))
  assert.equal(bytes.length, file.bytes, `${file.path} byte count changed`)
  assert.equal(sha256(bytes), file.sha256, `${file.path} SHA-256 changed`)
}

console.log(
  `native package verified: ${packageJson.name}@${packageJson.version} ${target}, PDFium ${pdfiumVersion.version}`,
)

async function listFiles(root, current = root) {
  const files = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, path))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }
  return files
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
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

function required(values, key) {
  const value = values[key]
  if (value === undefined || value.length === 0) throw new Error(`--${key} is required`)
  return value
}
