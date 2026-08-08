/**
 * Generates small, ordinary PDFs with embedded RGB figure images.
 *
 * The fixtures deliberately keep the text identical in most cases so the comparison
 * can be inspected as visual evidence rather than accidentally becoming a text test.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const outputDir = join(projectRoot, 'artifacts', 'figure-scenarios')

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const FIGURE_WIDTH = 260
const FIGURE_HEIGHT = 160

await mkdir(outputDir, { recursive: true })

const cases = {
  'figure-edit': [
    page({ image: plotImage('line-before'), title: 'Quarterly results' }),
    page({ image: plotImage('line-after'), title: 'Quarterly results' }),
  ],
  'figure-added': [
    page({ title: 'Quarterly results' }),
    page({ image: plotImage('line-before'), title: 'Quarterly results' }),
  ],
  'figure-removed': [
    page({ image: plotImage('line-before'), title: 'Quarterly results' }),
    page({ title: 'Quarterly results' }),
  ],
  'figure-moved': [
    page({ image: plotImage('line-before'), title: 'Quarterly results', imageX: 72, imageY: 420 }),
    page({ image: plotImage('line-before'), title: 'Quarterly results', imageX: 112, imageY: 392 }),
  ],
  'figure-replaced': [
    page({ image: plotImage('line-before'), title: 'Quarterly results' }),
    page({ image: plotImage('bars-after'), title: 'Quarterly results' }),
  ],
  'two-figures-one-changed': [
    page({
      title: 'Regional breakdown',
      images: [
        { name: 'left', image: plotImage('line-before'), x: 56, y: 446 },
        { name: 'right', image: plotImage('bars-before'), x: 328, y: 446 },
      ],
    }),
    page({
      title: 'Regional breakdown',
      images: [
        { name: 'left', image: plotImage('line-before'), x: 56, y: 446 },
        { name: 'right', image: plotImage('bars-after'), x: 328, y: 446 },
      ],
    }),
  ],
  'two-figures-one-replaced': [
    page({
      title: 'Regional breakdown',
      images: [
        { name: 'left', image: plotImage('line-before'), x: 56, y: 446 },
        { name: 'right', image: plotImage('bars-before'), x: 328, y: 446 },
      ],
    }),
    page({
      title: 'Regional breakdown',
      images: [
        { name: 'left', image: plotImage('line-before'), x: 56, y: 446 },
        { name: 'right', image: plotImage('line-after'), x: 328, y: 446 },
      ],
    }),
  ],
  'two-figures-swapped': [
    page({
      title: 'Regional breakdown',
      images: [
        { name: 'left', image: plotImage('line-before'), x: 56, y: 446 },
        { name: 'right', image: plotImage('bars-before'), x: 328, y: 446 },
      ],
    }),
    page({
      title: 'Regional breakdown',
      images: [
        { name: 'left', image: plotImage('bars-before'), x: 56, y: 446 },
        { name: 'right', image: plotImage('line-before'), x: 328, y: 446 },
      ],
    }),
  ],
  'figure-text-edit': [
    page({ image: plotImage('line-before'), title: 'Regional breakdown' }),
    page({ image: plotImage('bars-after'), title: 'Regional results' }),
  ],
}

const manifest = {}
for (const [name, [before, after]] of Object.entries(cases)) {
  const beforePath = join(outputDir, `${name}-before.pdf`)
  const afterPath = join(outputDir, `${name}-after.pdf`)
  await writeFile(beforePath, createPdf(before))
  await writeFile(afterPath, createPdf(after))
  manifest[name] = { before: beforePath, after: afterPath }
}
await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

function page({ title, image, images, imageX = 72, imageY = 420 }) {
  return {
    title,
    images: images ?? (image ? [{ name: 'figure', image, x: imageX, y: imageY }] : []),
  }
}

function createPdf(pageDefinition) {
  const images = pageDefinition.images ?? []
  const fontObject = 5
  const pageObject = 3
  const imageObjects = images.map((_, index) => 6 + index)
  const contentObject = 6 + images.length
  const imageResources = images
    .map((entry, index) => `/${entry.name === 'figure' ? 'Im1' : entry.name} ${imageObjects[index]} 0 R`)
    .join(' ')
  const pageObjectBody = [
    '<<',
    '/Type /Page',
    '/Parent 2 0 R',
    `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]`,
    `/Resources << /Font << /F1 ${fontObject} 0 R >>${images.length > 0 ? ` /XObject << ${imageResources} >>` : ''} >>`,
    `/Contents ${contentObject} 0 R`,
    '>>',
  ].join('\n')
  const content = [
    'BT',
    '/F1 18 Tf',
    '72 710 Td',
    `(${escapePdfText(pageDefinition.title)}) Tj`,
    'ET',
    ...images.flatMap((entry) => [
      'q',
      `${entry.width ?? FIGURE_WIDTH} 0 0 ${entry.height ?? FIGURE_HEIGHT} ${entry.x} ${entry.y} cm`,
      `/${entry.name === 'figure' ? 'Im1' : entry.name} Do`,
      'Q',
    ]),
    '',
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    pageObjectBody,
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...images.map((entry) => imageObject(entry.image)),
    streamObject(Buffer.from(content, 'binary')),
  ]
  return serializePdf(objects)
}

function imageObject(image) {
  const dictionary = [
    '<<',
    '/Type /XObject',
    '/Subtype /Image',
    `/Width ${image.width}`,
    `/Height ${image.height}`,
    '/ColorSpace /DeviceRGB',
    '/BitsPerComponent 8',
    `/Length ${image.data.length}`,
    '>>',
  ].join('\n')
  return Buffer.concat([
    Buffer.from(`${dictionary}\nstream\n`, 'binary'),
    image.data,
    Buffer.from('\nendstream', 'binary'),
  ])
}

function streamObject(data) {
  return Buffer.concat([
    Buffer.from(`<< /Length ${data.length} >>\nstream\n`, 'binary'),
    data,
    Buffer.from('endstream', 'binary'),
  ])
}

function serializePdf(objects) {
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')]
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.concat(chunks).length)
    const body = Buffer.isBuffer(objects[index]) ? objects[index] : Buffer.from(objects[index], 'binary')
    chunks.push(Buffer.from(`${index + 1} 0 obj\n`, 'binary'), body, Buffer.from('\nendobj\n', 'binary'))
  }
  const xrefOffset = Buffer.concat(chunks).length
  const xref = [
    `xref\n0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    `startxref\n${xrefOffset}`,
    '%%EOF',
    '',
  ].join('\n')
  chunks.push(Buffer.from(xref, 'binary'))
  return Buffer.concat(chunks)
}

function plotImage(kind) {
  const width = 260
  const height = 160
  const data = Buffer.alloc(width * height * 3, 255)
  const pixel = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const index = (y * width + x) * 3
    data[index] = color[0]
    data[index + 1] = color[1]
    data[index + 2] = color[2]
  }
  const line = (x0, y0, x1, y1, color, thickness = 1) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    for (let step = 0; step <= steps; step += 1) {
      const t = steps === 0 ? 0 : step / steps
      const x = Math.round(x0 + (x1 - x0) * t)
      const y = Math.round(y0 + (y1 - y0) * t)
      for (let dx = -thickness + 1; dx < thickness; dx += 1) {
        for (let dy = -thickness + 1; dy < thickness; dy += 1) pixel(x + dx, y + dy, color)
      }
    }
  }
  const rect = (x, y, w, h, color) => {
    for (let yy = y; yy < y + h; yy += 1) {
      for (let xx = x; xx < x + w; xx += 1) pixel(xx, yy, color)
    }
  }

  rect(0, 0, width, height, [250, 251, 253])
  for (let y = 20; y < 140; y += 24) line(25, y, 246, y, [226, 230, 236])
  for (let x = 25; x < 250; x += 44) line(x, 14, x, 140, [226, 230, 236])
  line(25, 140, 248, 140, [46, 56, 70], 2)
  line(25, 14, 25, 140, [46, 56, 70], 2)

  if (kind.startsWith('line')) {
    const points = kind === 'line-after'
      ? [[28, 127], [58, 113], [88, 105], [118, 82], [148, 75], [178, 65], [208, 52], [240, 44]]
      : [[28, 127], [58, 113], [88, 105], [118, 90], [148, 75], [178, 65], [208, 52], [240, 44]]
    for (let index = 1; index < points.length; index += 1) line(...points[index - 1], ...points[index], [35, 104, 190], 2)
    points.forEach(([x, y]) => rect(x - 3, y - 3, 7, 7, [35, 104, 190]))
    if (kind === 'line-after') {
      line(118, 90, 118, 82, [224, 91, 72], 2)
      rect(115, 79, 7, 7, [224, 91, 72])
    }
  } else {
    const values = kind === 'bars-after' ? [45, 72, 56, 94, 66] : [45, 62, 56, 80, 66]
    const colors = [[38, 125, 161], [83, 151, 99], [233, 156, 52], [193, 83, 79], [116, 92, 169]]
    values.forEach((value, index) => {
      const x = 38 + index * 40
      rect(x, 140 - value, 24, value, colors[index])
      line(x, 140 - value, x + 23, 140 - value, [31, 42, 55], 1)
    })
  }
  return { width, height, data }
}

function escapePdfText(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}
