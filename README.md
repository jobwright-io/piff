<div align="center">
  <h1>Piff</h1>
  <p>A Rust PDF comparison runtime with a typed TypeScript SDK and Git-like semantic evidence.</p>
  <p>
    <a href="ROADMAP.md">Roadmap</a>
    ·
    <a href="https://github.com/jobwright-io/piff">Repository</a>
  </p>
</div>

## Getting started

Piff compares PDF documents through a Rust pipeline. PDFium renders pages; Piff owns page pairing,
alignment, visual comparison, semantic text evidence, resource limits, bindings, and CLI behavior.

Install the workspace dependencies and build the packages:

```sh
pnpm install
pnpm build
```

Build the CLI:

```sh
cargo build --locked -p piff --release
```

Local CLI runs need a PDFium library. Download or provide one, then pass its path explicitly:

```sh
./target/release/piff doctor \
  --pdfium artifacts/pdfium/linux-x64/lib/libpdfium.so
```

## CLI

The binary has four commands:

```sh
piff compare before.pdf after.pdf --mode semantic --output report.json
piff diff before.pdf after.pdf
piff diff before.pdf after.pdf --format json --context-lines 2 --compact
piff equal before.pdf after.pdf
piff doctor --pdfium /path/to/libpdfium.so
```

`compare` produces the complete visual and semantic report. `diff` produces block-scoped unified
text hunks or the machine-readable `text_diff` object. `equal` stops at the first difference and
is suitable for CI. `doctor` verifies the configured PDFium backend.

All commands support page matching, DPI, alignment, reading order, passwords, and bounded resource
flags. Encrypted files can use `--password`, `--before-password`, or `--after-password`. Errors
are structured JSON on stderr. Exit status `1` means the documents differ, `2` means execution
failed, and `130` means cancellation.

## TypeScript SDK

The core package is `piffjs`:

```ts
import { piff } from 'piffjs'

const result = await piff(beforePdf, afterPdf, {
  mode: 'semantic',
  pageMatching: 'sequence',
  readingOrder: 'auto',
  contextLines: 2,
})

for (const operation of result.textDiff?.stream ?? []) {
  console.log(operation.kind, operation.beforeText, operation.afterText)
}
```

The result is compact and serializable. `semantic.blocks` and `textDiff.pages[].blocks` are the
canonical page-aware review units. `textDiff.stream` is the flattened document-order projection
for inline consumers. Every operation carries explicit `beforePage` and `afterPage` ownership,
PDF-point bounds, block-scoped line and word hunks, and a deterministic ID.

Additions are anchored only to the after side. Removals are anchored only to the before side.
Modifications, moves, and reflows carry both sides when both documents contain the block. Repeated
edge-positioned text can be labeled `header` or `footer`; a single-page heading remains `body`.

Use `PiffSession` when previews should be rendered lazily:

```ts
const session = await PiffSession.open(beforePdf, afterPdf, { mode: 'semantic' })
try {
  const result = await session.compare({
    signal: abortController.signal,
    onProgress(event) {
      console.log(event.phase, event.completed, event.total)
    },
  })
  const png = await session.renderPageDiff(0, { view: 'diff' })
} finally {
  await session.close()
}
```

## Workspace

- `crates/piff-core/` contains raster comparison, alignment, regions, and page fingerprints.
- `crates/piff-pdfium/` owns PDF loading, rendering, page pairing, figures, and the public
  native result model.
- `crates/piff-semantic/` owns positioned text normalization, structure, matching, roles, and
  Git-like hunks.
- `crates/piff-napi/` exposes the asynchronous Node and Bun boundary.
- `crates/piff-wasm/` exposes the browser runtime boundary.
- `crates/piff-cli/` builds the `piff` binary.
- `packages/piff/` contains the typed Node and Bun SDK.
- `packages/piff-wasm/` contains the synchronous WASM adapter and worker boundary.
- `packages/piff-react/` is an optional consumer-facing React adapter.
- `scripts/` contains fixture generation, native staging, and regression checks.

## Development

Run the repository checks:

```sh
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
pnpm typecheck
pnpm build
pnpm verify:regressions
pnpm verify:cli
```

The regression suite uses ordinary PDF bytes and covers wording changes, additions and removals,
page insertion, deletion and movement, translation, figures, repeated headers and footers, list
and table blocks, malformed inputs, encrypted inputs, deterministic output, and resource limits.

## Release deployment

The `Release packages` workflow publishes `piffjs`, its platform native NPM packages, and the Rust
crates. It runs for a published GitHub release or an explicit `workflow_dispatch` run with `publish`
enabled. Repository Actions secrets named `NPM_TOKEN` and `CARGO_REGISTRY_TOKEN` are required. The
React and browser adapter packages remain private until they have their own release contract.

## Runtime boundary

Piff is generic. It does not embed CV-specific concepts, OCR policy, document editing, or an
accept/reject workflow. Those belong in applications built on the SDK result.

PDFium is the default renderer and remains an internal backend behind the Rust runtime. Native
distribution must preserve PDFium and third-party license notices. A pure-Rust renderer is not
required for the current Node, Bun, CLI, and native artifact path.

See [ROADMAP.md](ROADMAP.md) for the remaining renderer, fuzzing, benchmark, and distribution work.
