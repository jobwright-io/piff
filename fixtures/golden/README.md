# Golden PDF corpus

The manifest in this directory points at files from the cloned reference repositories under
`references/`. Piff does not redistribute those PDFs. The manifest records the source commit,
license, and SHA-256 hash so a local run can prove that it used the intended fixture.

Clone the sources when you want to run the corpus from a fresh checkout:

```sh
git clone --depth 1 https://github.com/ajrcarey/pdfium-render.git references/pdfium-render
git clone --depth 1 https://github.com/firecrawl/pdf-inspector.git references/pdf-inspector
git clone --depth 1 https://github.com/LaurenzV/hayro.git references/hayro
```

Run the corpus with the local PDFium artifact:

```sh
PIFF_GOLDEN_REQUIRED=1 \
  PIFF_NATIVE_MODULE=artifacts/piff.linux-x64-gnu.node \
  PDFIUM_LIBRARY_PATH=artifacts/pdfium/linux-x64/lib/libpdfium.so \
  pnpm verify:golden
```

Without `PIFF_GOLDEN_REQUIRED=1`, missing reference checkouts are reported as skipped. That keeps
the ordinary CI path independent of third-party corpora while making an explicit corpus run fail
closed when a source is unavailable or has changed.

The encrypted fixture performs one warm-up comparison because the current PDFium build can return
slightly different text segmentation on its first encrypted-document pass. The runner requires
the next two passes to match and records `warmupChanged` in `artifacts/golden-report.json` when the
renderer shows that behavior.

The source repositories are used under their own licenses. `pdfium-render` and Hayro are
MIT/Apache-2.0 dual licensed. PDF Inspector is MIT licensed. Check the source checkout before
redistributing any fixture outside this local regression workflow.
