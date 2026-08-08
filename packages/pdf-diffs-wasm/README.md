# @pdf-differ/wasm

This package adapts the generated `pdf-diff-wasm` wasm-bindgen module. It does not ship PDFium.

The host must load an Emscripten PDFium WASM build, initialize the generated local module, and call:

```ts
const runtime = new PdfDiffWasmRuntime(generatedModule, { localModule })
runtime.initializePdfium(pdfiumModule)
```

Use `PdfDiffWasmWorkerClient` with a dedicated worker when comparisons should not block the browser event loop. The worker entrypoint can initialize a `PdfDiffWasmRuntime` and install `createPdfDiffWasmWorkerHandler(runtime, self)`.

The same bounded resource defaults and semantic text-quality metadata as the native runtime are
returned in WASM results. Pass `limits: {}` to an explicit comparison when those defaults should
be disabled. Rust panics at the WASM boundary are converted into rejected calls.
