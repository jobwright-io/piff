import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parsePdfiumVersion } from './pdfium-version.mjs'
import { readReleaseVersion } from './release-version.mjs'

const TARGETS = new Set([
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64-msvc',
])

const args = parseArgs(process.argv.slice(2))
const target = required(args, 'target')
const binaryPath = resolve(required(args, 'binary'))
const pdfiumPath = resolve(required(args, 'pdfium'))
const outputPath = resolve(required(args, 'output'))
const releaseVersion = await readReleaseVersion()
const packageVersion = args.version ?? releaseVersion

if (packageVersion !== releaseVersion) {
  throw new Error(`CLI package version ${packageVersion} does not match release version ${releaseVersion}`)
}

if (!TARGETS.has(target)) {
  throw new Error(`unsupported target "${target}"; expected one of ${[...TARGETS].join(', ')}`)
}

await assertFile(binaryPath, 'piff binary')
await assertFile(pdfiumPath, 'PDFium library')

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pdfiumRoot = args['pdfium-root'] === undefined
  ? dirname(dirname(pdfiumPath))
  : resolve(args['pdfium-root'])
const pdfiumVersionPath = join(pdfiumRoot, 'VERSION')
const pdfiumVersionText = await readFile(pdfiumVersionPath, 'utf8').catch(() => undefined)
if (pdfiumVersionText === undefined) {
  throw new Error(`PDFium VERSION file is required for reproducible packaging: ${pdfiumVersionPath}`)
}
const pdfiumVersion = parsePdfiumVersion(pdfiumVersionText)
if (args['pdfium-tag'] !== undefined && pdfiumVersion.build !== args['pdfium-tag']) {
  throw new Error(
    `PDFium VERSION build ${pdfiumVersion.build ?? 'unknown'} does not match requested tag ${args['pdfium-tag']}`,
  )
}

const binaryFile = target === 'win32-x64-msvc' ? 'piff.exe' : 'piff'
const pdfiumFile = basename(pdfiumPath)

await mkdir(outputPath, { recursive: true })
await mkdir(join(outputPath, 'pdfium'), { recursive: true })
await mkdir(join(outputPath, 'licenses'), { recursive: true })
await cp(binaryPath, join(outputPath, binaryFile))
await cp(pdfiumPath, join(outputPath, 'pdfium', pdfiumFile))
await cp(pdfiumVersionPath, join(outputPath, 'pdfium', 'VERSION'))
await cp(join(projectRoot, 'LICENSE'), join(outputPath, 'LICENSE'))
await copyIfPresent(join(pdfiumRoot, 'LICENSE'), join(outputPath, 'licenses', 'PDFIUM-LICENSE'))
await copyIfPresent(join(pdfiumRoot, 'VERSION'), join(outputPath, 'licenses', 'PDFIUM-VERSION'))
await copyDirectory(join(pdfiumRoot, 'licenses'), join(outputPath, 'licenses', 'third-party'))

await writeFile(
  join(outputPath, 'README.txt'),
  `Piff ${packageVersion} CLI\n\n` +
    `Run piff --help for usage. This archive bundles PDFium ${pdfiumVersion.version}.\n` +
    `The binary discovers the PDFium library in the adjacent pdfium directory.\n`,
)

const files = await listFiles(outputPath)
await writeFile(
  join(outputPath, 'artifact-manifest.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    package: {
      name: 'piff',
      version: packageVersion,
      target,
      binary: binaryFile,
    },
    renderer: {
      name: 'pdfium',
      api: args['pdfium-api'] ?? '7881',
      version: pdfiumVersion.version,
      build: pdfiumVersion.build ?? null,
      versionFile: 'pdfium/VERSION',
    },
    files: await Promise.all(files.map((path) => fileMetadata(outputPath, path))),
  }, null, 2)}\n`,
)

console.log(`staged piff CLI ${packageVersion} for ${target} at ${outputPath}`)

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
  if (value === undefined || value.length === 0) throw new Error(`missing required argument --${key}`)
  return value
}

async function assertFile(path, label) {
  const details = await stat(path).catch(() => undefined)
  if (details?.isFile() !== true) throw new Error(`${label} does not exist as a file: ${path}`)
}

async function copyIfPresent(source, destination) {
  if ((await stat(source).catch(() => undefined))?.isFile() === true) {
    await cp(source, destination)
  }
}

async function copyDirectory(source, destination) {
  if ((await stat(source).catch(() => undefined))?.isDirectory() !== true) return
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const destinationPath = join(destination, entry.name)
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath)
    } else if (entry.isFile()) {
      await cp(sourcePath, destinationPath)
    }
  }
}

async function listFiles(root, current = root) {
  const files = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(root, path))
    else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'))
  }
  return files.sort()
}

async function fileMetadata(root, path) {
  const bytes = await readFile(join(root, path))
  return {
    path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
