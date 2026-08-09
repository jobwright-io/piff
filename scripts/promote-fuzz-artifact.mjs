import { createHash } from 'node:crypto'
import { access, copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const promotedRoot = join(projectRoot, 'fixtures/golden/promoted')
const manifestPath = join(promotedRoot, 'manifest.json')
const maxInputBytes = 4 * 1024 * 1024
const args = parseArgs(process.argv.slice(2))
const target = requiredArg(args, 'target')
const id = requiredArg(args, 'id')
const input = resolve(process.cwd(), requiredArg(args, 'input'))

if (target !== 'pdf_loading') {
  throw new Error('only the pdf_loading target can be promoted into the PDF golden corpus')
}
if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
  throw new Error('id must start with a lowercase letter or number and contain only a-z, 0-9, ., _, or -')
}
if ((await lstat(input).catch(() => undefined))?.isFile() !== true) {
  throw new Error(`fuzz artifact does not exist: ${input}`)
}

const bytes = await readFile(input)
if (bytes.length === 0 || bytes.length > maxInputBytes) {
  throw new Error(`fuzz artifact must contain between 1 and ${maxInputBytes} bytes`)
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.fixtures)) {
  throw new Error(`unsupported promoted corpus manifest: ${manifestPath}`)
}
if (manifest.fixtures.some((fixture) => fixture.id === id)) {
  throw new Error(`promoted fuzz fixture already exists: ${id}`)
}

const destination = join(promotedRoot, `${id}.pdf`)
if (await fileExists(destination)) {
  throw new Error(`promoted fuzz file already exists: ${destination}`)
}

const fixture = {
  id,
  target,
  path: `${id}.pdf`,
  bytes: bytes.length,
  sha256: sha256(bytes),
}
if (args['expect-error'] !== undefined) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(args['expect-error'])) {
    throw new Error('expect-error must be a lowercase error code')
  }
  fixture.expectError = args['expect-error']
}

await mkdir(promotedRoot, { recursive: true })
await copyFile(input, destination)
manifest.fixtures.push(fixture)
manifest.fixtures.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`promoted ${input}`)
console.log(`  fixture: fixtures/golden/promoted/${fixture.path}`)
console.log(`  sha256:  ${fixture.sha256}`)
console.log('Review the copied bytes for sensitive content before committing the fixture.')

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

function requiredArg(values, name) {
  const value = values[name]
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`)
  return value
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
