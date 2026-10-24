// dsh-relaunch manifest tests: does the package declare a loadable bundle?
//
// A plugin can be perfectly written and still never load, because the loader
// reads these declarations before it runs any code. So they are asserted
// directly rather than inferred from "the plugin worked on my machine".
//
// Run: node test/manifest.mjs

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let passed = 0
let failed = 0

/**
 * Run one named check, reporting rather than throwing so a failure does not
 * hide the checks after it.
 * @param {string} label - the check name.
 * @param {() => void} body - the check.
 */
function check(label, body) {
  try {
    body()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    for (const line of String(error.message).split('\n')) console.log(`       ${line}`)
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(root, 'dsh-plugin.json'), 'utf8'))

console.log('package.json')
check('is a scoped, public package', () => {
  assert.match(pkg.name, /^@[a-z0-9-]+\/[a-z0-9-]+$/)
  assert.equal(pkg.publishConfig?.access, 'public')
})
check('declares dsh.bundle.patch', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
})
check('the patch file exists', () => {
  assert.ok(existsSync(join(root, pkg.dsh.bundle.patch)))
})
check('declares the client half', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.dsh?.client?.immediately, true)
})
check('exports ./client at the file that exists', () => {
  assert.equal(pkg.exports?.['./client'], './client.js')
  assert.ok(existsSync(join(root, 'client.js')))
})
check('exports the host entry at the file that exists', () => {
  assert.equal(pkg.exports?.['.'], './index.js')
  assert.ok(existsSync(join(root, 'index.js')))
})
check('exports locale and icon so the manager can read them', () => {
  assert.equal(pkg.exports?.['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports?.['./icon'], './icon.svg')
  assert.ok(existsSync(join(root, 'icon.svg')))
})
check('declares engines.dsh', () => {
  assert.equal(typeof pkg.engines?.dsh, 'string')
  assert.match(pkg.engines.dsh, /^>=/)
})
check('carries repository, homepage and license for the market listing', () => {
  assert.equal(pkg.license, 'MIT')
  assert.match(pkg.repository?.url ?? '', /^git\+https:\/\//)
  assert.match(pkg.homepage ?? '', /^https:\/\//)
})

console.log('files list')
const requiredInTarball = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'restart-harness.mjs',
  'launch-hidden.vbs',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
  'dsh-plugin.json',
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'LICENSE',
]
check('every runtime file appears in files', () => {
  const declared = new Set(pkg.files)
  const missing = requiredInTarball.filter((p) => !declared.has(p) && !declared.has(p.replace(/^locale\/[a-z]+\.json$/, 'locale/*.json')))
  assert.deepEqual(missing, [], `files is missing: ${missing.join(', ')}`)
})
check('tests and CI are not published', () => {
  const leaked = pkg.files.filter((p) => p.startsWith('test') || p.startsWith('.github'))
  assert.deepEqual(leaked, [])
})

console.log('dsh-plugin.json')
check('declares both facets and their entries exist', () => {
  assert.equal(manifest.facets?.host?.entry, 'index.js')
  assert.equal(manifest.facets?.client?.entry, 'client.js')
  for (const facet of ['host', 'client']) {
    assert.ok(existsSync(join(root, manifest.facets[facet].entry)), `${facet} entry missing`)
  }
})
check('manifest version matches package.json', () => {
  assert.equal(manifest.version, pkg.version, `manifest ${manifest.version} vs package ${pkg.version}`)
})
check('carries display metadata for the plugin list', () => {
  const display = manifest.contributes?.['x-display']
  assert.ok(Array.isArray(display) && display.length >= 1)
  assert.equal(typeof display[0].title, 'string')
  assert.ok(display[0].description.length > 20, 'description is not meaningful')
})

console.log('locale resources')
for (const [file, title] of [['en.json', 'Relaunch'], ['zh.json', '重启']]) {
  check(`locale/${file} carries meta.title and meta.description`, () => {
    const dict = JSON.parse(readFileSync(join(root, 'locale', file), 'utf8'))
    assert.equal(typeof dict.meta?.title, 'string')
    assert.equal(typeof dict.meta?.description, 'string')
    assert.ok(dict.meta.title.length > 0 && dict.meta.description.length > 10)
    assert.ok(dict.meta.title.includes(title), `title does not mention ${title}`)
  })
}

console.log(`\n==== ${passed} passed, ${failed} failed ====`)
process.exit(failed === 0 ? 0 : 1)
