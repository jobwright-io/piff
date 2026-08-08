import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const execFileAsync = promisify(execFile)
const TARGETS = {
  'linux-x64-gnu': ['pdfium-linux-x64.tgz', 'lib/libpdfium.so'],
  'linux-x64-musl': ['pdfium-linux-musl-x64.tgz', 'lib/libpdfium.so'],
  'linux-arm64-gnu': ['pdfium-linux-arm64.tgz', 'lib/libpdfium.so'],
  'linux-arm64-musl': ['pdfium-linux-musl-arm64.tgz', 'lib/libpdfium.so'],
  'darwin-x64': ['pdfium-mac-x64.tgz', 'lib/libpdfium.dylib'],
  'darwin-arm64': ['pdfium-mac-arm64.tgz', 'lib/libpdfium.dylib'],
  'win32-x64-msvc': ['pdfium-win-x64.tgz', 'bin/pdfium.dll'],
}
const PINNED_DIGESTS = {
  'pdfium-linux-x64.tgz': 'sha256:1470e21b8b4a3b4ad7f85684e2da11d94f3b69a86d81dee11b9b6709d927ac1d',
  'pdfium-linux-musl-x64.tgz': 'sha256:8a8cdfc6c79865269f74bf0e9ca476cdd8a9908ea7e0b0abcfc1525d59fb7257',
  'pdfium-linux-arm64.tgz': 'sha256:ee7f7b7d5468958336a818c1cd580bdd20972846b7377b13f9a923d92d1d4674',
  'pdfium-linux-musl-arm64.tgz': 'sha256:4c6e678e820c390c3ffc1f720a25386e3b637aa42ecf99446672146d793dac46',
  'pdfium-mac-x64.tgz': 'sha256:6dedf83990e0e3d6b7c93c9e7589c5a126b0ae14b7464d76120cff7a26afb18b',
  'pdfium-mac-arm64.tgz': 'sha256:52e94ca5aa8847934330daf3f8150c190682c5ca93831468794f8b90d4392e40',
  'pdfium-win-x64.tgz': 'sha256:73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08',
}

const args = parseArgs(process.argv.slice(2))
const target = required(args, 'target')
const outputPath = resolve(required(args, 'output'))
const releaseTag = args.tag ?? '7881'
const targetInfo = TARGETS[target]

if (targetInfo === undefined) {
  throw new Error(`unsupported target "${target}"; expected one of ${Object.keys(TARGETS).join(', ')}`)
}

const [asset, runtimePath] = targetInfo
const archiveUrl = `https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/${releaseTag}/${asset}`
const temporaryRoot = await mkdtemp(join(tmpdir(), 'piff-pdfium-'))
const archivePath = join(temporaryRoot, asset)
const extractPath = join(temporaryRoot, 'extract')

try {
  await mkdir(extractPath, { recursive: true })
  const response = await fetch(archiveUrl)
  if (!response.ok || response.body === null) {
    throw new Error(`could not download PDFium ${archiveUrl}: HTTP ${response.status}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath))
  const expectedDigest = releaseTag === '7881'
    ? PINNED_DIGESTS[asset]
    : await lookupAssetDigest(releaseTag, asset)
  const actualDigest = `sha256:${createHash('sha256').update(await readFile(archivePath)).digest('hex')}`
  if (actualDigest !== expectedDigest) {
    throw new Error(`PDFium archive digest mismatch for ${asset}: expected ${expectedDigest}, got ${actualDigest}`)
  }
  await execFileAsync('tar', ['-xzf', archivePath, '-C', extractPath])

  const sourceRuntime = join(extractPath, runtimePath)
  await mkdir(outputPath, { recursive: true })
  await mkdir(join(outputPath, 'lib'), { recursive: true })
  await mkdir(join(outputPath, 'bin'), { recursive: true })
  await mkdir(join(outputPath, 'licenses'), { recursive: true })
  await cp(sourceRuntime, join(outputPath, runtimePath))
  await copyFileIfPresent(join(extractPath, 'LICENSE'), join(outputPath, 'LICENSE'))
  await copyFileIfPresent(join(extractPath, 'VERSION'), join(outputPath, 'VERSION'))
  await copyDirectory(join(extractPath, 'licenses'), join(outputPath, 'licenses'))
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

console.log(`downloaded PDFium ${releaseTag} for ${target} into ${outputPath}`)

async function lookupAssetDigest(tag, assetName) {
  const response = await fetch(`https://api.github.com/repos/bblanchon/pdfium-binaries/releases/tags/chromium/${tag}`, {
    headers: { accept: 'application/vnd.github+json' },
  })
  if (!response.ok) {
    throw new Error(`could not inspect PDFium release chromium/${tag}: HTTP ${response.status}`)
  }
  const release = await response.json()
  const asset = release.assets?.find((candidate) => candidate.name === assetName)
  if (asset?.digest === undefined) {
    throw new Error(`PDFium release chromium/${tag} does not publish a digest for ${assetName}`)
  }
  return asset.digest
}

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

async function copyFileIfPresent(source, destination) {
  if ((await stat(source).catch(() => undefined))?.isFile() === true) {
    await cp(source, destination)
  }
}

async function copyDirectory(source, destination) {
  if ((await stat(source).catch(() => undefined))?.isDirectory() !== true) {
    return
  }
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isFile()) {
      await cp(join(source, entry.name), join(destination, entry.name))
    }
  }
}
