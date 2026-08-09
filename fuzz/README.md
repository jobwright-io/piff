# Piff fuzz targets

The fuzz package is intentionally outside the root Cargo workspace. It uses
`cargo-fuzz` and keeps generated corpora and crash artifacts out of normal
builds.

Checked-in seeds live under `fuzz/seeds/`. The workspace runner copies them into
a temporary corpus, adds a deterministic valid PDF seed for the loading target,
and writes crash artifacts under `artifacts/fuzz/`:

```sh
pnpm fuzz -- --target all --seconds 30
```

The runner requires a nightly Rust toolchain and `cargo-fuzz`. The `pdf_loading`
target also requires PDFium. From the repository root, point it at the same
library used by the native runtime:

```sh
PDFIUM_LIBRARY_PATH=artifacts/pdfium/linux-x64/lib/libpdfium.so \
  pnpm fuzz -- --target pdf_loading --seconds 30
```

Use `--target semantic_normalization` or `--target pdf_loading` to run one
target. The scheduled GitHub Actions campaign runs both targets and retains
libFuzzer artifacts for triage.

## Semantic normalization

This target exercises the renderer-independent boundary that turns positioned
text segments into reading-order lines:

```sh
cargo +nightly fuzz run semantic_normalization
```

The input is converted into bounded, finite `TextRun` values before it reaches
the normalizer. That keeps failures attributable to normalization rather than
unbounded fuzz input allocation.

## PDF loading

This target sends arbitrary bounded byte strings through the PDFium loading
boundary. It needs the same PDFium library used by the native runtime:

```sh
PDFIUM_LIBRARY_PATH=/path/to/libpdfium.so \
  cargo +nightly fuzz run pdf_loading
```

The target uses strict page, input, and pixel limits. It is still an integration
campaign against PDFium, so run it in an isolated process and keep corpus files
under the fuzz directory.

For reproducible triage, retain the target name, PDFium artifact/version, Rust
toolchain, and the crashing input. Do not add private documents or crash inputs
containing sensitive content to the repository.

After fixing and reviewing a minimized PDF loading failure, promote it into the
deterministic golden corpus:

```sh
pnpm promote:fuzz -- \
  --target pdf_loading \
  --id issue-123 \
  --input artifacts/fuzz/pdf_loading/crash-... \
  --expect-error pdfium
```

Promotion copies the bytes into `fixtures/golden/promoted/`, records their
length and SHA-256, and makes `pnpm verify:golden` check repeatability. Keep
semantic-normalization failures in the fuzz corpus because they are not PDF
inputs and cannot be represented by the PDF golden runner.
