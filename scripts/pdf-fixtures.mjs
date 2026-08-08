/**
 * Small, dependency-free PDF fixtures used by the regression harness.
 *
 * These are deliberately ordinary PDF files, not mocks of the diff engine. PDFium parses,
 * renders, and extracts text from the bytes produced here exactly as it does for user input.
 */
export function createTextPdf(pages, options = {}) {
  const defaultWidth = options.width ?? 612
  const defaultHeight = options.height ?? 792
  const fontNames = ['Helvetica', 'Helvetica-Bold']
  const fontObjectStart = 3 + pages.length
  const contentObjectStart = fontObjectStart + fontNames.length
  const pageObjects = pages.map((page, pageIndex) => {
    const width = page.width ?? defaultWidth
    const height = page.height ?? defaultHeight
    const resources = fontNames
      .map((fontName, fontIndex) => `/F${fontIndex + 1} ${fontObjectStart + fontIndex} 0 R`)
      .join(' ')
    return `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${format(width)} ${format(height)}] /Resources << /Font << ${resources} >> >> /Contents ${contentObjectStart + pageIndex} 0 R >>`
  })
  const fontObjects = fontNames.map(
    (fontName) => `<< /Type /Font /Subtype /Type1 /BaseFont /${fontName} >>`,
  )
  const contentObjects = pages.map((page) => {
    const width = page.width ?? defaultWidth
    const height = page.height ?? defaultHeight
    const offsetX = page.offsetX ?? 0
    const offsetY = page.offsetY ?? 0
    const lines = normalizeLines(Array.isArray(page) ? page : (page.lines ?? []), height)
    const operations = [
      ...lines.map((line) => renderTextLine(line, offsetX, offsetY)),
      ...(page.rectangles ?? []).map((rectangle) => renderRectangle(rectangle, offsetX, offsetY)),
    ]
    const stream = operations.length === 0 ? '\n' : `${operations.join('\n')}\n`
    return `<< /Length ${Buffer.byteLength(stream, 'binary')} >>\nstream\n${stream}endstream`
  })
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    ...pageObjects,
    ...fontObjects,
    ...contentObjects,
  ]
  return serializePdf(objects)
}

function normalizeLines(lines, pageHeight) {
  return lines.map((line, index) => {
    if (typeof line === 'string') {
      return {
        text: line,
        x: 72,
        y: pageHeight - 92 - index * 36,
        size: 18,
        font: 'F1',
      }
    }
    return {
      text: line.text,
      x: line.x ?? 72,
      y: line.y ?? pageHeight - 92 - index * 36,
      size: line.size ?? 18,
      font: line.font ?? 'F1',
    }
  })
}

function renderTextLine(line, offsetX, offsetY) {
  const font = line.font === 'Helvetica-Bold' ? 'F2' : line.font
  return [
    'BT',
    `/${font} ${format(line.size)} Tf`,
    `${format(line.x + offsetX)} ${format(line.y + offsetY)} Td`,
    `(${escapePdfText(line.text)}) Tj`,
    'ET',
  ].join('\n')
}

function renderRectangle(rectangle, offsetX, offsetY) {
  const [red, green, blue] = rectangle.fill ?? [0, 0, 0]
  return [
    'q',
    `${format(red)} ${format(green)} ${format(blue)} rg`,
    `${format(rectangle.x + offsetX)} ${format(rectangle.y + offsetY)} ${format(rectangle.width)} ${format(rectangle.height)} re`,
    'f',
    'Q',
  ].join('\n')
}

function serializePdf(objects) {
  const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
  let output = header
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output, 'binary'))
    output += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(output, 'binary')
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.slice(1).forEach((offset) => {
    output += `${String(offset).padStart(10, '0')} 00000 n \n`
  })
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(output, 'binary')
}

function escapePdfText(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

function format(value) {
  return String(Number(value.toFixed(3)))
}
