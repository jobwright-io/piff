# piff-react

React presentation for the serializable `piff` result. The viewer keeps the native layer out of React: callers provide a preview loader, and page images are requested only as cards approach the viewport.

```tsx
import { PiffSession } from 'piffjs'
import { PiffViewer } from 'piff-react'
import 'piff-react/style.css'

const session = await PiffSession.open(beforePdf, afterPdf, { dpi: 144 })
const result = await session.compare()

<PiffViewer
  result={result}
  loadPreview={(pageIndex, request) =>
    session.renderPageDiff(pageIndex, { view: request.view })
  }
/>
```

The viewer's preview modes are `before`, `diff`, and `after`. Its default `Review` surface shows synchronized before and after pages with anchored change markers. It does not own document bytes, PDFium, or native resources; close the session from the application lifecycle.

Pass `{ mode: 'semantic' }` when opening the session to populate the inspector's text register with positioned additions, removals, modifications, and moves.

The viewer opens in spatial review mode by default. Pages without extractable text, suspect font
decoding, or bounded text results remain reviewable because visual evidence is authoritative. The
`Text details` mode is a secondary, copyable view for extracted hunks and inline word changes.

For long comparisons, pass `{ signal, onProgress }` as the second argument to `session.compare()` or `session.isEqual()`.
