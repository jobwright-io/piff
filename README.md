<div align="center">
  <h1>Piff</h1>
  <p>A Rust PDF comparison runtime with a typed TypeScript SDK and Git-like semantic evidence.</p>
  <p>
    <a href="ROADMAP.md">Roadmap</a>
    ·
    <a href="https://github.com/jobwright-io/piffjs">Repository</a>
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

The binary has five commands:

```sh
piff compare before.pdf after.pdf --mode semantic --output report.json
piff diff before.pdf after.pdf
piff diff before.pdf after.pdf --format inline
piff diff before.pdf after.pdf --format json --context-lines 2 --compact
piff equal before.pdf after.pdf
piff series baseline.pdf candidate-a.pdf candidate-b.pdf --format inline
piff series baseline.pdf candidate-a.pdf candidate-b.pdf --format json --compact
piff doctor --pdfium /path/to/libpdfium.so
```

`compare` produces the complete visual and semantic report. `diff` defaults to semantic-only
comparison, so it skips full-page rasterization; use `--render full` when the text diff also needs
pixel evidence. `--format inline` prints a unified document stream with `[before]`, `[after]`, or
`[both]` ownership. `--format json` returns the same block-scoped stream as the machine-readable
`text_diff` object. `equal` stops at the first difference and is suitable for CI. `doctor` verifies
the configured PDFium backend. `series` compares an ordered set of revisions. It uses the first
PDF as the baseline by default; pass `--strategy adjacent` to compare each revision to its
predecessor. Its inline output labels every line with a revision ID instead of inventing a global
before/after side.

All commands support page matching, DPI, alignment, reading order, passwords, and bounded resource
flags. Encrypted files can use `--password`, `--before-password`, or `--after-password`. Errors
are structured JSON on stderr. Exit status `1` means the documents differ, `2` means execution
failed, and `130` means cancellation.

## TypeScript SDK

The core package is `@jobwright-io/piffjs`:

Configure the `@jobwright-io` scope to use GitHub Packages, then install it:

```sh
npm config set @jobwright-io:registry https://npm.pkg.github.com
npm install @jobwright-io/piffjs
```

```ts
import { piff } from '@jobwright-io/piffjs'

const result = await piff(beforePdf, afterPdf, {
  mode: 'semantic',
  render: 'none',
  pageMatching: 'sequence',
  readingOrder: 'auto',
  contextLines: 2,
})

for (const operation of result.textDiff?.stream ?? []) {
  console.log(operation.kind, operation.side, operation.beforeText, operation.afterText)
}
```

For candidate generation, use the revision-neutral document-set primitive:

```ts
import { piffSet } from '@jobwright-io/piffjs'

const result = await piffSet([
  { id: 'baseline', label: 'Baseline CV', bytes: baselinePdf },
  { id: 'candidate-a', label: 'Candidate A', bytes: candidateA },
  { id: 'candidate-b', label: 'Candidate B', bytes: candidateB },
], {
  strategy: 'baseline',
  mode: 'semantic',
  render: 'none',
})

for (const change of result.changes) {
  console.log(change.kind, change.anchors.map((anchor) => anchor.revisionId))
  for (const variant of change.variants) {
    console.log(variant.revisionIds, variant.text)
  }
}
```

`PdfChangeOperation` is the multi-document primitive. It has revision-keyed `anchors`, grouped
content `variants`, and optional pair-specific hunks in `comparisons`. A baseline block changed
differently by two candidates is one operation with three revision anchors and three content
variants; a candidate-only block has one `introduced` anchor. Figure, page, and visual-only changes
use the same shape. `PiffDocumentSet` creates pair sessions on demand so a page preview can be
requested lazily with `renderPageDiff(fromRevisionId, toRevisionId, pageIndex)`.

In Node and Bun, the native document-set path loads each revision once when the password policy
allows the handles to be shared. That avoids reparsing a baseline for every candidate and keeps
adjacent intermediate revisions alive across their two edges. The browser/WASM fallback keeps the
same result and preview API, but evaluates its edges through the existing pair calls.

The result is compact and serializable. `semantic.blocks` and `textDiff.pages[].blocks` are the
canonical page-aware review units. `textDiff.stream` is the flattened document-order projection
for inline consumers. Every operation carries explicit `beforePage` and `afterPage` ownership,
PDF-point bounds, block-scoped line and word hunks, and a deterministic ID.

Additions are anchored only to the after side. Removals are anchored only to the before side.
Modifications, moves, and reflows carry both sides when both documents contain the block. The
result's `renderMode` and each page's `visualComputed` flag make the absence of raster evidence
explicit. Repeated edge-positioned text can be labeled `header` or `footer`; a single-page heading
remains `body`.

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

`result.stats` reports fractional millisecond timings for loading, page fingerprinting, page
matching, raster rendering, pixel and figure comparison, region detection, semantic extraction,
and the complete comparison. `result.engine` identifies the Piff runtime, the compiled PDFium API,
and the exact PDFium artifact version when the loaded library ships a `VERSION` sidecar. Run the
local benchmark with `pnpm benchmark -- --json`; its report separates preview wall time from native
PNG encoding time.

Preview bytes stay in a bounded least-recently-used cache. Set the limit to suit the host and read
its counters without exposing the cached image buffers:

```ts
const session = await PiffSession.open(
  beforePdf,
  afterPdf,
  { mode: 'semantic' },
  { maxPreviewCacheBytes: 32 * 1024 * 1024 },
)
const preview = await session.renderPageDiff(0)
console.log(session.cacheDiagnostics())
```

Benchmark and diagnostics integrations can request a preview with native PNG encoding timing:

```ts
const timedPreview = await session.renderPageDiffWithTiming(0, { view: 'diff' })
console.log(timedPreview.bytes.byteLength, timedPreview.encodeMs)
```

The current PDFium binding serializes PDFium work inside a process. Reuse a session for related
requests, but use independent worker processes when throughput requires parallel document
comparisons. Each worker should have its own memory budget and PDFium library instance.

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
pnpm verify:golden
pnpm verify:hostile
pnpm verify:fuzz
pnpm benchmark -- --json
```

The regression suite uses ordinary PDF bytes and covers wording changes, additions and removals,
page insertion, deletion and movement, translation, figures, repeated headers and footers, list
and table blocks, malformed inputs, encrypted inputs, deterministic output, and resource limits.
`pnpm verify:golden` always runs a generated local golden manifest for table rows, repeated roles,
figure swaps, ligature text encoding, malformed input classification, repeatability, and preview
caching. It can additionally check the pinned external corpus under `references/`.
`pnpm verify:hostile` exercises SDK progress and cancellation at each pipeline phase, resource
limits, malformed-input error stability, fresh-process determinism, and equivalent CLI failures.
The fuzz targets under `fuzz/` cover semantic normalization and the PDFium loading boundary; the
PDF loading target requires `PDFIUM_LIBRARY_PATH` and should run in an isolated process. Run a
bounded local campaign with `pnpm fuzz -- --target all --seconds 30`; it requires nightly Rust and
`cargo-fuzz`. The scheduled fuzz workflow retains crash artifacts, and reviewed minimized PDF
loading failures can be promoted with `pnpm promote:fuzz` into the golden corpus.
The optional golden corpus under `fixtures/golden/` checks real PDFs from pinned reference
checkouts. Set `PIFF_GOLDEN_REQUIRED=1` when a missing or changed fixture should fail the command.

## Release deployment

The `Release packages` workflow publishes `@jobwright-io/piffjs`, its platform native packages to
GitHub Packages, and the Rust crates. It runs for a published GitHub release or an explicit
`workflow_dispatch` run with `publish` enabled. GitHub Packages publishing uses the workflow's
scoped `GITHUB_TOKEN`; only the crates.io registry secret is needed. The
React and browser adapter packages remain private until they have their own release contract. The
initial native release targets glibc Linux, macOS, and Windows; musl Linux support remains a separate
cross-compilation task. Native packages include PDFium and third-party license notices under
`licenses/`. Each staged native package also includes `pdfium/VERSION` and a deterministic
`artifact-manifest.json` containing file sizes and SHA-256 checksums; release CI verifies the
manifest against the pinned PDFium build before publication.

See [ROADMAP.md](ROADMAP.md) for the completed milestones and deliberate non-goals.
