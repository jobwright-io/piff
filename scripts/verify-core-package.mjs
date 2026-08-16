import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const TARGETS = [
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64-msvc',
]

const args = parseArgs(process.argv.slice(2))
const packageRoot = resolve(required(args, 'package'))
const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))

assert.equal(packageJson.name, '@jobwright-io/piffjs', 'core package name mismatch')
assert.equal(packageJson.private, false, 'core package must be publishable')
assert.equal(packageJson.publishConfig?.access, 'public', 'core package must publish publicly')
assert.equal(packageJson.publishConfig?.registry, undefined, 'core package must not pin a registry')
assert.equal(packageJson.repository?.url, 'git+https://github.com/jobwright-io/piffjs.git', 'repository URL mismatch')
assert.ok(packageJson.description, 'core package description is missing')
assert.ok(packageJson.engines?.node, 'core package Node.js support is missing')

const expectedOptionalDependencies = Object.fromEntries(
  TARGETS.map((target) => [`@jobwright-io/piffjs-${target}`, packageJson.version]),
)
assert.deepEqual(packageJson.optionalDependencies, expectedOptionalDependencies, 'native optional dependencies mismatch')

for (const path of ['LICENSE', 'README.md', 'dist/index.js', 'dist/index.d.ts']) {
  assert.equal((await stat(join(packageRoot, path)).catch(() => undefined))?.isFile(), true, `${path} is missing from the core package`)
}

for (const path of ['LICENSE', 'README.md', 'dist']) {
  assert.ok(packageJson.files?.includes(path), `${path} is missing from package.json files`)
}

console.log(`core package verified: ${packageJson.name}@${packageJson.version}`)

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
