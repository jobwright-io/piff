# Golden PDF corpus

The local manifest is the default golden path. It generates ordinary PDF bytes from
`scripts/local-golden-fixtures.mjs`, verifies their SHA-256 hashes, and runs without cloned
reference repositories. It covers table-row edits, repeated header and footer changes, figure
swaps, ligature text encoding, malformed input classification, deterministic results, and lazy
preview caching.

Run it with the local PDFium artifact:

```sh
pnpm verify:golden
```

The external manifest in this directory points at files from the cloned reference repositories
under `references/`. Piff does not redistribute those PDFs. That manifest records the source
commit, license, and SHA-256 hash so a local run can prove that it used the intended fixture.

Clone the sources when you want to run the corpus from a fresh checkout:

```sh
git clone --depth 1 https://github.com/ajrcarey/pdfium-render.git references/pdfium-render
git clone --depth 1 https://github.com/firecrawl/pdf-inspector.git references/pdf-inspector
git clone --depth 1 https://github.com/LaurenzV/hayro.git references/hayro
```

Run the local and external corpus with the local PDFium artifact:

```sh
PIFF_GOLDEN_REQUIRED=1 \
  PIFF_NATIVE_MODULE=artifacts/piff.linux-x64-gnu.node \
  PDFIUM_LIBRARY_PATH=artifacts/pdfium/linux-x64/lib/libpdfium.so \
  pnpm verify:golden
```

Without `PIFF_GOLDEN_REQUIRED=1`, missing external reference checkouts are reported as skipped.
The generated local fixtures are never skipped. This keeps the ordinary CI path independent of
third-party corpora while making an explicit external corpus run fail closed when a source is
unavailable or has changed.

The encrypted fixture is intentionally first in the manifest. The runner compares it twice from a
fresh process and requires both results to match, covering PDFium's lazy encrypted-document state
before the rest of the corpus runs.

The source repositories are used under their own licenses. `pdfium-render` and Hayro are
MIT/Apache-2.0 dual licensed. PDF Inspector is MIT licensed. Check the source checkout before
redistributing any fixture outside this local regression workflow.

## Promoted fuzz failures

`promoted/` is a checked-in corpus for reviewed, minimized PDF loading failures. The manifest pins
each copied input by byte count and SHA-256, and `pnpm verify:golden` checks either deterministic
self-comparison or the explicitly recorded stable error code. Promote only after the underlying
failure has been fixed or reduced to a supported, repeatable result. Never promote a private PDF.

```sh
pnpm promote:fuzz -- \
  --target pdf_loading \
  --id issue-123 \
  --input artifacts/fuzz/pdf_loading/crash-... \
  --expect-error pdfium
```
