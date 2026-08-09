import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  PiffOptions,
  PiffProgressPhase,
  PiffRunOptions,
  PdfPagePreviewView,
  PdfReadingOrder,
} from './types.js'

type NativeProgressCallback = (
  payload: [string, number, number],
) => void

interface NativeDiffOptions {
  dpi?: number
  pageMatching?: 'index' | 'sequence'
  mode?: 'visual' | 'semantic'
  readingOrder?: PdfReadingOrder
  contextLines?: number
  password?: string
  beforePassword?: string
  afterPassword?: string
  limits?: {
    maxInputBytes?: number
    maxPages?: number
    maxPagePixels?: number
  }
  channelTolerance?: number
  changedPixelRatio?: number
  maxShiftPx?: number
  alignmentSampleStep?: number
  minRegionArea?: number
}

interface NativeBinding {
  piff(
    before: Buffer,
    after: Buffer,
    options?: NativeDiffOptions,
    progress?: NativeProgressCallback,
    signal?: AbortSignal,
    cancellationToken?: number,
  ): Promise<string>
  isEqual(
    before: Buffer,
    after: Buffer,
    options?: NativeDiffOptions,
    progress?: NativeProgressCallback,
    signal?: AbortSignal,
    cancellationToken?: number,
  ): Promise<boolean>
  renderPageDiff(
    before: Buffer,
    after: Buffer,
    pageIndex: number,
    options?: NativeDiffOptions,
    view?: PdfPagePreviewView,
    signal?: AbortSignal,
    cancellationToken?: number,
  ): Promise<Buffer>
  renderPageDiffWithTiming(
    before: Buffer,
    after: Buffer,
    pageIndex: number,
    options?: NativeDiffOptions,
    view?: PdfPagePreviewView,
    signal?: AbortSignal,
    cancellationToken?: number,
  ): Promise<{ bytes: Buffer; encodeMs: number }>
  createCancellationToken(): number
  cancelCancellationToken(token: number): void
  releaseCancellationToken(token: number): void
}

const require = createRequire(import.meta.url)
let cachedBinding: NativeBinding | undefined

export function loadNativeBinding(): NativeBinding {
  if (cachedBinding !== undefined) {
    return cachedBinding
  }

  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const override = process.env.PIFF_NATIVE_MODULE
  const localModule = resolve(
    projectRoot,
    'artifacts/piff.linux-x64-gnu.node',
  )
  const packageNames = [
    runtimePackageName(),
    '@jobwright-io/piffjs-linux-x64-gnu',
    '@jobwright-io/piffjs-linux-arm64-gnu',
    '@jobwright-io/piffjs-darwin-x64',
    '@jobwright-io/piffjs-darwin-arm64',
    '@jobwright-io/piffjs-win32-x64-msvc',
  ].filter((name, index, names): name is string =>
    name !== undefined && names.indexOf(name) === index,
  )

  const candidates = [
    ...(override === undefined ? [] : [override]),
    ...(existsSync(localModule) ? [localModule] : []),
    ...packageNames,
  ]

  for (const candidate of candidates) {
    try {
      cachedBinding = require(candidate) as NativeBinding
      return cachedBinding
    } catch {
      // Keep trying platform candidates so a missing optional package has a useful final error.
    }
  }

  throw new Error(
    `Could not load the piff native module for ${runtimeTargetLabel()}. Set PIFF_NATIVE_MODULE or install a platform package.`,
  )
}

function runtimePackageName(): string | undefined {
  const target = runtimeTarget()
  return target === undefined ? undefined : `@jobwright-io/piffjs-${target}`
}

function runtimeTarget(): string | undefined {
  const arch = process.arch === 'x64'
    ? 'x64'
    : process.arch === 'arm64'
      ? 'arm64'
      : undefined
  if (arch === undefined) {
    return undefined
  }
  if (process.platform === 'darwin') {
    return `darwin-${arch}`
  }
  if (process.platform === 'win32' && arch === 'x64') {
    return 'win32-x64-msvc'
  }
  if (process.platform === 'linux') {
    return `linux-${arch}-${isMuslRuntime() ? 'musl' : 'gnu'}`
  }
  return undefined
}

function runtimeTargetLabel(): string {
  return runtimeTarget() ?? `${process.platform}-${process.arch}`
}

function isMuslRuntime(): boolean {
  try {
    const report = process.report?.getReport?.() as {
      header?: { glibcVersionRuntime?: string }
    } | undefined
    return report !== undefined && report.header?.glibcVersionRuntime === undefined
  } catch {
    return false
  }
}

export function toNativeOptions(
  options: PiffOptions | undefined,
): NativeDiffOptions | undefined {
  if (options === undefined) {
    return undefined
  }

  return {
    dpi: options.dpi,
    pageMatching: options.pageMatching,
    mode: options.mode,
    readingOrder: options.readingOrder,
    contextLines: options.contextLines,
    password: options.password,
    beforePassword: options.beforePassword,
    afterPassword: options.afterPassword,
    limits: options.limits === undefined
      ? undefined
      : {
          maxInputBytes: options.limits.maxInputBytes,
          maxPages: options.limits.maxPages,
          maxPagePixels: options.limits.maxPagePixels,
        },
    channelTolerance: options.channelTolerance,
    changedPixelRatio: options.changedPixelRatio,
    maxShiftPx: options.maxShiftPx,
    alignmentSampleStep: options.alignmentSampleStep,
    minRegionArea: options.minRegionArea,
  }
}

export function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

export function toNativeProgress(
  options: PiffRunOptions | undefined,
): NativeProgressCallback | undefined {
  if (options?.onProgress === undefined) {
    return undefined
  }
  return (payload) => {
    const [phase, completed, total] = payload
    if (!isProgressPhase(phase)) {
      return
    }
    options.onProgress?.({ phase, completed, total })
  }
}

export async function runWithNativeCancellation<T>(
  signal: AbortSignal | undefined,
  operation: (cancellationToken?: number) => Promise<T>,
): Promise<T> {
  if (signal?.aborted === true) {
    throw createAbortError()
  }

  const binding = loadNativeBinding()
  const cancellationToken = signal === undefined
    ? undefined
    : binding.createCancellationToken()
  const onAbort = () => {
    if (cancellationToken !== undefined) {
      binding.cancelCancellationToken(cancellationToken)
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    return await operation(cancellationToken)
  } catch (error) {
    if (signal?.aborted) {
      throw createAbortError()
    }
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (cancellationToken !== undefined) {
      binding.releaseCancellationToken(cancellationToken)
    }
  }
}

export function createAbortError(): Error {
  const error = new Error('PDF comparison aborted')
  error.name = 'AbortError'
  return error
}

function isProgressPhase(phase: string): phase is PiffProgressPhase {
  return (
    phase === 'loading' ||
    phase === 'fingerprinting' ||
    phase === 'rendering' ||
    phase === 'comparing'
  )
}
