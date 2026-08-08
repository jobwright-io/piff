import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const args = parseArgs(process.argv.slice(2))
const targetDirectory = resolve(required(args, 'target-dir'))
const outputPath = resolve(required(args, 'output'))

const candidates = (await readdir(targetDirectory))
  .filter((name) =>
    name === 'pdf_diff_napi.dll' ||
    name === 'libpdf_diff_napi.so' ||
    name === 'libpdf_diff_napi.dylib',
  )

if (candidates.length !== 1 || (await stat(join(targetDirectory, candidates[0]))).isFile() !== true) {
  throw new Error(`expected exactly one native N-API module in ${targetDirectory}`)
}

await mkdir(resolve(outputPath, '..'), { recursive: true })
await copyFile(join(targetDirectory, candidates[0]), outputPath)
console.log(`copied ${candidates[0]} to ${outputPath}`)

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
