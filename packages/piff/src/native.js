import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let cachedBinding;
export function loadNativeBinding() {
    if (cachedBinding !== undefined) {
        return cachedBinding;
    }
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const override = process.env.PIFF_NATIVE_MODULE;
    const localModule = resolve(projectRoot, 'artifacts/piff.linux-x64-gnu.node');
    const packageNames = [
        runtimePackageName(),
        'piffjs-linux-x64-gnu',
        'piffjs-linux-arm64-gnu',
        'piffjs-darwin-x64',
        'piffjs-darwin-arm64',
        'piffjs-win32-x64-msvc',
    ].filter((name, index, names) => name !== undefined && names.indexOf(name) === index);
    const candidates = [
        ...(override === undefined ? [] : [override]),
        ...(existsSync(localModule) ? [localModule] : []),
        ...packageNames,
    ];
    for (const candidate of candidates) {
        try {
            cachedBinding = require(candidate);
            return cachedBinding;
        }
        catch {
            // Keep trying platform candidates so a missing optional package has a useful final error.
        }
    }
    throw new Error(`Could not load the piff native module for ${runtimeTargetLabel()}. Set PIFF_NATIVE_MODULE or install a platform package.`);
}
function runtimePackageName() {
    const target = runtimeTarget();
    return target === undefined ? undefined : `piffjs-${target}`;
}
function runtimeTarget() {
    const arch = process.arch === 'x64'
        ? 'x64'
        : process.arch === 'arm64'
            ? 'arm64'
            : undefined;
    if (arch === undefined) {
        return undefined;
    }
    if (process.platform === 'darwin') {
        return `darwin-${arch}`;
    }
    if (process.platform === 'win32' && arch === 'x64') {
        return 'win32-x64-msvc';
    }
    if (process.platform === 'linux') {
        return `linux-${arch}-${isMuslRuntime() ? 'musl' : 'gnu'}`;
    }
    return undefined;
}
function runtimeTargetLabel() {
    return runtimeTarget() ?? `${process.platform}-${process.arch}`;
}
function isMuslRuntime() {
    try {
        const report = process.report?.getReport?.();
        return report !== undefined && report.header?.glibcVersionRuntime === undefined;
    }
    catch {
        return false;
    }
}
export function toNativeOptions(options) {
    if (options === undefined) {
        return undefined;
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
    };
}
export function asBuffer(bytes) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
export function toNativeProgress(options) {
    if (options?.onProgress === undefined) {
        return undefined;
    }
    return (payload) => {
        const [phase, completed, total] = payload;
        if (!isProgressPhase(phase)) {
            return;
        }
        options.onProgress?.({ phase, completed, total });
    };
}
export async function runWithNativeCancellation(signal, operation) {
    if (signal?.aborted === true) {
        throw createAbortError();
    }
    const binding = loadNativeBinding();
    const cancellationToken = signal === undefined
        ? undefined
        : binding.createCancellationToken();
    const onAbort = () => {
        if (cancellationToken !== undefined) {
            binding.cancelCancellationToken(cancellationToken);
        }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        return await operation(cancellationToken);
    }
    catch (error) {
        if (signal?.aborted) {
            throw createAbortError();
        }
        throw error;
    }
    finally {
        signal?.removeEventListener('abort', onAbort);
        if (cancellationToken !== undefined) {
            binding.releaseCancellationToken(cancellationToken);
        }
    }
}
export function createAbortError() {
    const error = new Error('PDF comparison aborted');
    error.name = 'AbortError';
    return error;
}
function isProgressPhase(phase) {
    return (phase === 'loading' ||
        phase === 'fingerprinting' ||
        phase === 'rendering' ||
        phase === 'comparing');
}
