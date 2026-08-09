/**
 * Deterministic, dependency-free golden inputs for the core verification path.
 *
 * The fixture bytes are generated instead of checked in so the golden suite can run in a
 * fresh checkout without a reference repository or binary fixture download.
 */
import { createFigureScenario } from './figure-scenarios.mjs'
import { createTextPdf, serializePdf } from './pdf-fixtures.mjs'

const localFixtureFactories = {
  'table-row-change': () => ({
    before: createTextPdf([[
      { text: 'Skills and experience', x: 72, y: 720, size: 18, font: 'F2' },
      { text: '| Skill | Level |', x: 72, y: 660, size: 14 },
      { text: '| Rust | Expert |', x: 72, y: 632, size: 14 },
      { text: '| TypeScript | Advanced |', x: 72, y: 604, size: 14 },
      { text: 'The table is followed by stable body text.', x: 72, y: 540, size: 14 },
    ]]),
    after: createTextPdf([[
      { text: 'Skills and experience', x: 72, y: 720, size: 18, font: 'F2' },
      { text: '| Skill | Level |', x: 72, y: 660, size: 14 },
      { text: '| Rust | Advanced |', x: 72, y: 632, size: 14 },
      { text: '| TypeScript | Advanced |', x: 72, y: 604, size: 14 },
      { text: 'The table is followed by stable body text.', x: 72, y: 540, size: 14 },
    ]]),
  }),

  'repeated-header-change': () => ({
    before: createTextPdf([
      [
        { text: 'Quarterly Business Report', x: 72, y: 750, font: 'F2' },
        { text: 'The first page body remains stable.', x: 72, y: 500 },
        { text: 'Page 1 of 2', x: 72, y: 35 },
      ],
      [
        { text: 'Quarterly Business Report', x: 72, y: 750, font: 'F2' },
        { text: 'The second page body remains stable.', x: 72, y: 500 },
        { text: 'Page 2 of 2', x: 72, y: 35 },
      ],
    ]),
    after: createTextPdf([
      [
        { text: 'Quarterly Business Summary', x: 72, y: 750, font: 'F2' },
        { text: 'The first page body remains stable.', x: 72, y: 500 },
        { text: 'Page 1 of 3', x: 72, y: 35 },
      ],
      [
        { text: 'Quarterly Business Summary', x: 72, y: 750, font: 'F2' },
        { text: 'The second page body remains stable.', x: 72, y: 500 },
        { text: 'Page 2 of 3', x: 72, y: 35 },
      ],
    ]),
  }),

  'figure-swap': () => createFigureScenario('two-figures-swapped'),

  'ligature-text-encoding': () => ({
    before: createLigaturePdf('<FB01>'),
    after: createLigaturePdf('<0066 0069>'),
  }),

  'malformed-object': () => ({
    before: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%EOF\n', 'binary'),
    after: createTextPdf([['A valid comparison partner.']]),
  }),
}

export function createLocalGoldenFixture(name) {
  const factory = localFixtureFactories[name]
  if (factory === undefined) {
    throw new Error(`unknown local golden fixture: ${name}`)
  }
  return factory()
}

function createLigaturePdf(toUnicodeMapping) {
  const ligature = String.fromCharCode(0x80)
  const text = `Office workflow: Of${ligature}ce`
  const content = [
    'BT',
    '/F1 24 Tf',
    '72 680 Td',
    `(${escapePdfText(text)}) Tj`,
    'ET',
    '',
  ].join('\n')
  const toUnicode = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    '1 beginbfchar',
    `<80> ${toUnicodeMapping}`,
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
    '',
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 5 0 R /ToUnicode 6 0 R >>',
    '<< /Type /Encoding /Differences [128 /fi] >>',
    `<< /Length ${Buffer.byteLength(toUnicode, 'binary')} >>\nstream\n${toUnicode}endstream`,
    `<< /Length ${Buffer.byteLength(content, 'binary')} >>\nstream\n${content}endstream`,
  ]
  return serializePdf(objects)
}

function escapePdfText(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}
