# Promoted fuzz corpus

This directory contains minimized PDFium failures that have been reviewed and promoted into the
deterministic golden checks. Do not add private documents or crash inputs containing sensitive
content. Keep the original fuzz artifact outside the repository and review the minimized bytes
before committing the copied fixture.

Promote a reviewed PDF loading artifact with:

```sh
node scripts/promote-fuzz-artifact.mjs \
  --target pdf_loading \
  --id issue-123 \
  --input artifacts/fuzz/pdf_loading/crash-... \
  --expect-error pdfium
```

`--expect-error` is optional. Without it, the golden runner requires the promoted input to compare
with itself successfully and deterministically. The manifest records the byte count and SHA-256
so accidental edits fail verification.
