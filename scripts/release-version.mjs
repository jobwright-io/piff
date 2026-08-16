import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const javascriptPackages = [
  'packages/piff/package.json',
  'packages/piff-react/package.json',
  'packages/piff-wasm/package.json',
]
const rustPackages = [
  'crates/piff-cli/Cargo.toml',
  'crates/piff-core/Cargo.toml',
  'crates/piff-napi/Cargo.toml',
  'crates/piff-pdfium/Cargo.toml',
  'crates/piff-semantic/Cargo.toml',
  'crates/piff-wasm/Cargo.toml',
]

export async function readReleaseVersion() {
  const versions = []

  for (const relativePath of javascriptPackages) {
    const packageJson = JSON.parse(await readFile(join(projectRoot, relativePath), 'utf8'))
    versions.push({ path: relativePath, version: packageJson.version })
  }

  for (const relativePath of rustPackages) {
    const manifest = await readFile(join(projectRoot, relativePath), 'utf8')
    const packageVersion = manifest.match(/^version = "([^"]+)"\r?$/m)?.[1]
    versions.push({ path: relativePath, version: packageVersion })

    for (const dependency of manifest.matchAll(/^piff-[a-z-]+ = \{[^}]*\bversion = "([^"]+)"[^}]*\}\r?$/gm)) {
      versions.push({ path: `${relativePath} dependency`, version: dependency[1] })
    }
  }

  const releaseVersion = versions[0]?.version
  assert.match(releaseVersion ?? '', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'release version is not valid semver')
  for (const entry of versions) {
    assert.equal(entry.version, releaseVersion, `${entry.path} has release version ${entry.version ?? 'missing'}; expected ${releaseVersion}`)
  }

  if (process.env.PIFF_REQUIRE_RELEASE_TAG === 'true' || process.env.GITHUB_EVENT_NAME === 'release') {
    assert.equal(process.env.GITHUB_REF_TYPE, 'tag', 'publishing requires a tag ref')
    assert.equal(process.env.GITHUB_REF_NAME, `v${releaseVersion}`, 'GitHub release tag does not match package versions')
  }

  return releaseVersion
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  console.log(`release version verified: ${await readReleaseVersion()}`)
}
