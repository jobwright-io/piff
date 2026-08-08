# Piff roadmap

Piff is a generic PDF comparison runtime. It owns comparison, semantic evidence, alignment,
resource limits, bindings, and CLI behavior; PDFium remains the rendering backend. Downstream
applications may use the result for document review, generated documents, regression testing, or
other workflows, but those product domains do not belong in the engine.

## Status

### Foundation — complete

- Rust comparison core with PDFium rendering.
- Visual pixel comparison with tolerances, alignment, regions, and lazy PNG previews.
- Index and conservative sequence page matching.
- Figure identity evidence for image-backed page objects.
- Semantic text extraction with configurable `auto`, `rows`, and `columns` reading order.
- Reflow-aware text comparison and Git-like line/word hunks.
- Password-protected inputs, resource limits, cancellation, progress, N-API, WASM, SDK, and CLI.
- Linux native artifact and real-PDF regression corpus.

### Canonical semantic evidence — complete

- Group changed lines into review-oriented text blocks.
- Keep additions anchored only to the after side and removals only to the before side.
- Keep modifications, moves, and reflows anchored to both sides when both sides exist.
- Attach a block-scoped inline hunk so consumers do not have to reconstruct pairing from a page-wide
  diff.
- Preserve the existing positioned-run `changes` field as a compatibility/detail view.
- Infer paragraph, list-item, and table-row structure with bounded confidence.
- Align exact and similar blocks using token similarity plus geometry.
- Recognize split/merged line flow as reflow instead of unrelated additions and removals.

The new public fields are `semantic.blocks` and `textDiff.pages[].blocks`.

## Next milestones

### 1. Structural role refinement — repeated roles complete

The runtime now recognizes repeated headers and footers conservatively from edge-positioned text,
including page-number normalization and side-aware role carry-over for a changed repeated label.
Nested list and table-row structure remain explicit in canonical blocks. Remaining refinement is
optional font-transition and cell-level evidence when the renderer exposes it reliably. The current
implementation intentionally does not label a single-page heading as a header or a visually
ambiguous row as a table.

Acceptance criteria:

- repeated headers and footers can be recognized without becoming body changes;
- nested lists and table rows remain distinguishable;
- every match has deterministic IDs and bounded confidence.

### 2. Document review stream — complete

Added `textDiff.stream`, a flattened, page-aware review stream derived from canonical blocks. It
supports unified consumers without requiring a viewer to understand PDF coordinates, while
retaining page and PDF-point anchors for spatial consumers.

Acceptance criteria:

- stable document order across inserted, deleted, and moved pages;
- explicit before/after ownership for every review operation;
- line hunks remain a derived compatibility representation;
- JSON remains compact and serializable.

### 3. Reliability and adversarial coverage

- Golden fixtures for columns, tables, forms, repeated headers, ligatures, missing fonts, scans,
  malformed objects, encrypted files, and figure changes.
- Fuzz the PDF loading and semantic normalization boundaries.
- Verify cancellation, memory limits, and deterministic output under hostile inputs.
- Add renderer/version metadata to benchmark and regression records.

### 4. Performance and distribution

- Benchmark rendering, extraction, matching, region detection, and encoding separately.
- Bound cache memory and expose cache diagnostics.
- Add process-level parallelism guidance for PDFium workloads.
- Expand reproducible native artifacts only after the compatibility corpus is stable.

## Deliberate non-goals

Piff will not embed CV-specific concepts, OCR policy, document editing, accept/reject workflows,
or a mandatory React viewer. Those belong in consumers built on the stable SDK result.
