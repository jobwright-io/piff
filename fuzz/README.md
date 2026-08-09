# Piff fuzz targets

The fuzz package is intentionally outside the root Cargo workspace. It uses
`cargo-fuzz` and keeps generated corpora and crash artifacts out of normal
builds.

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
