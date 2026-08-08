import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const args = parseArgs(process.argv.slice(2))
const root = resolve(required(args, 'root'))

const packageDirectories = []
for (const artifact of await readdir(root, { withFileTypes: true })) {
  if (!artifact.isDirectory()) {
    continue
  }
  const packageDirectory = join(root, artifact.name)
  if ((await stat(join(packageDirectory, 'package.json')).catch(() => undefined))?.isFile() === true) {
    packageDirectories.push(packageDirectory)
  }
}

if (packageDirectories.length === 0) {
  throw new Error(`no staged native packages found under ${root}`)
}

for (const packageDirectory of packageDirectories.sort()) {
  console.log(`publishing ${packageDirectory}`)
  await execFileAsync('npm', ['publish', packageDirectory, '--access', 'public'], {
    stdio: 'inherit',
  })
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
