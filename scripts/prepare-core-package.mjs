import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readReleaseVersion } from './release-version.mjs'

const TARGETS = [
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64-msvc',
]

const args = parseArgs(process.argv.slice(2))
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(required(args, 'source'))
const output = resolve(required(args, 'output'))
const packageJson = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
const releaseVersion = await readReleaseVersion()

if (packageJson.version !== releaseVersion) {
  throw new Error(`core package version ${packageJson.version} does not match release version ${releaseVersion}`)
}

await mkdir(output, { recursive: true })
await cp(join(source, 'dist'), join(output, 'dist'), { recursive: true })
await cp(join(projectRoot, 'README.md'), join(output, 'README.md'))
await cp(join(projectRoot, 'LICENSE'), join(output, 'LICENSE'))

packageJson.private = false
packageJson.files = [...new Set([...(packageJson.files ?? []), 'README.md', 'LICENSE'])]
packageJson.optionalDependencies = Object.fromEntries(
  TARGETS.map((target) => [`@jobwright-io/piffjs-${target}`, packageJson.version]),
)
packageJson.publishConfig = {
  ...(packageJson.publishConfig ?? {}),
  access: 'public',
}
delete packageJson.publishConfig.registry

await writeFile(join(output, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
console.log(`prepared publishable ${packageJson.name}@${packageJson.version} at ${output}`)

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
