# @jobwright-io/piff-wasm

This package adapts the generated `piff-wasm` wasm-bindgen module. It does not ship PDFium.

The host must load an Emscripten PDFium WASM build, initialize the generated local module, and call:

```ts
const runtime = new PiffWasmRuntime(generatedModule, { localModule })
runtime.initializePdfium(pdfiumModule)
```

Use `PiffWasmWorkerClient` with a dedicated worker when comparisons should not block the browser event loop. The worker entrypoint can initialize a `PiffWasmRuntime` and install `createPiffWasmWorkerHandler(runtime, self)`.

The same bounded resource defaults and semantic text-quality metadata as the native runtime are
returned in WASM results. Pass `limits: {}` to an explicit comparison when those defaults should
be disabled. Rust panics at the WASM boundary are converted into rejected calls.
