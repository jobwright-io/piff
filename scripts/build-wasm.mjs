import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const args = parseArgs(process.argv.slice(2))
const output = resolve(args.output ?? 'artifacts/wasm')
const target = 'wasm32-unknown-unknown'
const wasmPath = resolve('target', target, 'release', 'piff_wasm.wasm')

await mkdir(output, { recursive: true })
await execFileAsync('cargo', [
  'build',
  '--locked',
  '--release',
  '--package',
  'piff-wasm',
  '--target',
  target,
], { stdio: 'inherit' })
await execFileAsync('wasm-bindgen', [
  wasmPath,
  '--target',
  'web',
  '--out-dir',
  output,
], { stdio: 'inherit' })
console.log(`built browser WASM bindings in ${join(output, 'piff_wasm.js')}`)

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
