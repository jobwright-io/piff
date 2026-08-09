import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parsePdfiumVersion } from './pdfium-version.mjs'

const TARGETS = new Set([
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64-msvc',
])

const args = parseArgs(process.argv.slice(2))
const target = required(args, 'target')
const nativePath = resolve(required(args, 'native'))
const pdfiumPath = resolve(required(args, 'pdfium'))
const outputPath = resolve(required(args, 'output'))
const packageVersion = args.version ?? '0.1.1'

if (!TARGETS.has(target)) {
  throw new Error(`unsupported target "${target}"; expected one of ${[...TARGETS].join(', ')}`)
}

await assertFile(nativePath, 'native module')
await assertFile(pdfiumPath, 'PDFium library')

const packageName = `@jobwright-io/piffjs-${target}`
const nativeFile = `piff_napi.${target}.node`
const pdfiumFile = basename(pdfiumPath)
const packagePdfiumPath = join(outputPath, 'pdfium', pdfiumFile)
const pdfiumRoot = args['pdfium-root'] === undefined
  ? dirname(dirname(pdfiumPath))
  : resolve(args['pdfium-root'])
const platform = platformMetadata(target)
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

await mkdir(outputPath, { recursive: true })
await mkdir(join(outputPath, 'pdfium'), { recursive: true })
await mkdir(join(outputPath, 'licenses'), { recursive: true })
await cp(nativePath, join(outputPath, nativeFile))
await cp(pdfiumPath, packagePdfiumPath)
await cp(pdfiumVersionPath, join(outputPath, 'pdfium', 'VERSION'))
await copyIfPresent(join(pdfiumRoot, 'LICENSE'), join(outputPath, 'licenses', 'PDFIUM-LICENSE'))
await copyIfPresent(join(pdfiumRoot, 'VERSION'), join(outputPath, 'licenses', 'PDFIUM-VERSION'))
await copyDirectory(join(pdfiumRoot, 'licenses'), join(outputPath, 'licenses', 'third-party'))

await writeFile(
  join(outputPath, 'index.js'),
  `'use strict'\n\nconst path = require('node:path')\n\nif (process.env.PDFIUM_LIBRARY_PATH === undefined) {\n  process.env.PDFIUM_LIBRARY_PATH = path.join(__dirname, 'pdfium', ${JSON.stringify(pdfiumFile)})\n}\n\nmodule.exports = require(path.join(__dirname, ${JSON.stringify(nativeFile)}))\n`,
)

await writeFile(
  join(outputPath, 'package.json'),
  `${JSON.stringify({
    name: packageName,
    version: packageVersion,
    description: `Native @jobwright-io/piffjs runtime for ${target}`,
    license: 'MIT',
    repository: {
      type: 'git',
      url: 'https://github.com/jobwright-io/piffjs.git',
    },
    type: 'commonjs',
    main: 'index.js',
    os: platform.os,
    cpu: platform.cpu,
    ...(platform.libc === undefined ? {} : { libc: platform.libc }),
    files: [
      'index.js',
      nativeFile,
      'pdfium',
      'licenses',
      'artifact-manifest.json',
    ],
    publishConfig: {
      access: 'public',
      registry: 'https://npm.pkg.github.com',
    },
  }, null, 2)}\n`,
)

const files = await listFiles(outputPath)
await writeFile(
  join(outputPath, 'artifact-manifest.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    package: {
      name: packageName,
      version: packageVersion,
      target,
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

console.log(`staged ${packageName} at ${outputPath}`)

function parseArgs(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--') {
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

function required(values, key) {
  const value = values[key]
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required argument --${key}`)
  }
  return value
}

function platformMetadata(target) {
  if (target.startsWith('linux-x64')) {
    return {
      os: ['linux'],
      cpu: ['x64'],
      libc: target.endsWith('-musl') ? ['musl'] : ['glibc'],
    }
  }
  if (target.startsWith('linux-arm64')) {
    return {
      os: ['linux'],
      cpu: ['arm64'],
      libc: target.endsWith('-musl') ? ['musl'] : ['glibc'],
    }
  }
  if (target === 'darwin-x64') {
    return { os: ['darwin'], cpu: ['x64'] }
  }
  if (target === 'darwin-arm64') {
    return { os: ['darwin'], cpu: ['arm64'] }
  }
  return { os: ['win32'], cpu: ['x64'] }
}

async function assertFile(path, label) {
  const details = await stat(path).catch(() => undefined)
  if (details?.isFile() !== true) {
    throw new Error(`${label} does not exist as a file: ${path}`)
  }
}

async function copyIfPresent(source, destination) {
  const details = await stat(source).catch(() => undefined)
  if (details?.isFile() === true) {
    await cp(source, destination)
  }
}

async function copyDirectory(source, destination) {
  const details = await stat(source).catch(() => undefined)
  if (details?.isDirectory() !== true) {
    return
  }
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isFile()) {
      await cp(join(source, entry.name), join(destination, entry.name))
    }
  }
}

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
  return files.sort(comparePaths)
}

async function fileMetadata(root, path) {
  const bytes = await readFile(path)
  return {
    path: relative(root, path).replaceAll('\\', '/'),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
