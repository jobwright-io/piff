export function parsePdfiumVersion(contents) {
  const fields = Object.fromEntries(
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const separator = line.indexOf('=')
        return separator === -1
          ? []
          : [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]]
      }),
  )
  const components = ['MAJOR', 'MINOR', 'BUILD', 'PATCH'].map((key) => fields[key])
  const version = components.every((value) => /^\d+$/.test(value ?? ''))
    ? components.join('.')
    : contents.trim()
  if (version.length === 0) {
    throw new Error('PDFium VERSION is empty')
  }
  return {
    version,
    build: fields.BUILD,
    raw: contents.trim(),
  }
}
