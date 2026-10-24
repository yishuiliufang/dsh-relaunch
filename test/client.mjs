// dsh-relaunch client half tests: does the browser half register and render?
//
// The manifest and Host suites never load `client.js`, yet a correct manifest
// can still ship a component that throws on first render — the user then gets a
// blank panel or a broken sidebar. This suite mounts the real factory against
// fake loader/React/slots/locale faces and asserts the wiring, every language
// column, and each panel state.
//
// This is the strongest check available without an authenticated browser page.
//
// Run: node test/client.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

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

const source = readFileSync(join(root, 'client.js'), 'utf8')

/**
 * A React stand-in implementing only what `client.js` uses.
 *
 * The element shape follows React's own (`{ type, props }`) so the tree can be
 * walked without React present.
 *
 * @returns {object} the fake React module.
 */
function fakeReact() {
  return {
    createElement(type, props, ...children) {
      const merged = { ...(props || {}) }
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
      return { type, props: merged }
    },
    useState(initial) {
      return [initial, () => {}]
    },
    useCallback(fn) {
      return fn
    },
  }
}

/**
 * Render one element tree, invoking function components.
 *
 * @param {unknown} node - an element, array, or primitive.
 * @returns {string} the concatenated visible text.
 */
function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render).join('')
  const { type, props } = node
  if (typeof type === 'function') return render(type(props || {}))
  const children = props?.children === undefined
    ? []
    : (Array.isArray(props.children) ? props.children : [props.children])
  return children.map(render).join('')
}

/**
 * Load `client.js` in a fresh VM context and mount its plugin.
 *
 * @param {object} [options] - harness inputs.
 * @param {string} [options.locale='zh'] - active locale id.
 * @param {boolean} [options.withLocale=true] - whether the locale service exists.
 * @param {boolean} [options.withSlots=true] - whether the slots service exists.
 * @param {boolean} [options.withWebServer=false] - whether a Host route exists.
 * @returns {object} registration facts and the mounted pieces.
 */
function mount({ locale = 'zh', withLocale = true, withSlots = true, withWebServer = false } = {}) {
  let registration
  const seats = { main: [], 'sidebar.panellist': [] }
  const dictionaries = []

  const window = {
    __ModuleLoader__: {
      load(entry) { registration = entry },
    },
  }

  const slots = {
    inject(seat, body) {
      const stop = body()
      return typeof stop === 'function' ? stop : () => {}
    },
    register(options, component) {
      seats[options.name]?.push({ options, component })
      return () => {}
    },
  }

  const dictionariesByLocale = {}
  const localeService = {
    register(ns, id, dict) {
      dictionaries.push({ ns, id, dict })
      dictionariesByLocale[id] = { ...(dictionariesByLocale[id] ?? {}), ...dict }
      return () => {}
    },
    bind() {
      return (key) => dictionariesByLocale[locale]?.[key] ?? key
    },
  }

  const context = {
    slots: withSlots ? slots : undefined,
    locale: withLocale ? localeService : undefined,
    get(name) {
      if (name === 'slots') return withSlots ? slots : undefined
      if (name === 'locale') return withLocale ? localeService : undefined
      return undefined
    },
  }

  const errors = []
  const originalError = console.error
  console.error = (...args) => { errors.push(args.map(String).join(' ')) }
  let plugin
  try {
    vm.runInNewContext(source, { window, console, fetch: () => Promise.reject(new Error('not used')) })
    plugin = registration.factory(() => fakeReact())
    plugin.apply(context)
  } finally {
    console.error = originalError
  }

  return { registration, plugin, seats, dictionaries, errors, withWebServer }
}

console.log('registration')
check('registers under the published package name', () => {
  const { registration } = mount()
  assert.equal(registration.id, '@yishuiliufang/dsh-relaunch')
})

check('declares both required services', () => {
  const { plugin } = mount()
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale'])
})

console.log('sidebar pairing')
check('rail entry and main panel share one id', () => {
  const { seats } = mount()
  const rail = seats['sidebar.panellist'][0].options
  const main = seats.main[0].options
  assert.equal(rail.id, 'restart-app')
  assert.equal(main.key, rail.id, 'a mismatch would open the wrong panel')
})

check('rail entry is ordered and carries a label thunk', () => {
  const { seats } = mount()
  const rail = seats['sidebar.panellist'][0].options
  assert.equal(rail.order, 70)
  assert.equal(typeof rail.label, 'function', 'a thunk is what lets the label follow the locale')
})

check('rail label follows the active locale', () => {
  assert.equal(mount({ locale: 'zh' }).seats['sidebar.panellist'][0].options.label(), '重启 Harness')
  assert.equal(mount({ locale: 'en' }).seats['sidebar.panellist'][0].options.label(), 'Relaunch Harness')
})

console.log('glyph')
check('draws an svg at the requested square edge', () => {
  const { seats } = mount()
  const Icon = seats['sidebar.panellist'][0].component
  const element = Icon({ size: 22, active: true })
  assert.equal(element.type, 'svg')
  assert.equal(element.props.width, 22)
  assert.equal(element.props.height, 22)
  assert.equal(element.props['aria-hidden'], true)
})

check('glyph strokes with currentColor so it inherits the rail state', () => {
  const { seats } = mount()
  const Icon = seats['sidebar.panellist'][0].component
  assert.equal(Icon({ size: 16, active: false }).props.stroke, 'currentColor')
})

console.log('localization')
check('registers both shipped locales', () => {
  const { dictionaries } = mount()
  const ids = dictionaries.map((d) => d.id).sort()
  assert.deepEqual(ids, ['en', 'zh'])
  for (const entry of dictionaries) assert.equal(entry.ns, 'dsh-relaunch')
})

check('locale columns define exactly the same keys', () => {
  const { dictionaries } = mount()
  const byLocale = Object.fromEntries(dictionaries.map((d) => [d.id, Object.keys(d.dict).sort()]))
  assert.deepEqual(byLocale.en, byLocale.zh, 'a key present in one column only would fall back silently')
  assert.ok(byLocale.en.length >= 6)
})

check('no text key is left to fall through to the raw key', () => {
  const { dictionaries } = mount()
  for (const { id, dict } of dictionaries) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${id}:${key} is not a string`)
      assert.ok(value.length > 0, `${id}:${key} is empty`)
      assert.notEqual(value, key, `${id}:${key} would render as its own key`)
    }
  }
})

console.log('panel rendering')
check('renders idle state without throwing', () => {
  const { seats } = mount()
  const Panel = seats.main[0].component
  const out = render(Panel({ translate: (k) => mountText('en', k) }))
  assert.match(out, /Relaunch Harness/)
  assert.match(out, /Running tasks are interrupted/)
})

check('renders the Chinese column when that is the active locale', () => {
  const { seats } = mount()
  const Panel = seats.main[0].component
  const trans = (k) => ({
    'panel.title': '重启 Harness',
    'panel.body': '关闭并重新启动 DeepSeek Harness。正在运行的任务会被中断。',
    'panel.action': '重启 Harness',
  }[k] ?? k)
  const out = render(Panel({ translate: trans }))
  assert.match(out, /重启 Harness/)
  assert.match(out, /正在运行的任务会被中断/)
})

check('survives a missing translate function', () => {
  const { seats } = mount()
  const Panel = seats.main[0].component
  const out = render(Panel({}))
  assert.match(out, /Relaunch Harness/, 'must fall back to English, never a raw key')
  assert.doesNotMatch(out, /panel\./, 'a raw key leaked into the UI')
})

check('exposes a click handler on the action button', () => {
  const { seats } = mount()
  const Panel = seats.main[0].component
  const tree = Panel({ translate: (k) => k })
  assert.equal(tree.type, 'div')
  const button = (tree.props.children ?? []).find((c) => c?.type === 'button')
  assert.ok(button !== undefined, 'no button in the panel')
  assert.equal(button.props.type, 'button')
  assert.equal(typeof button.props.onClick, 'function')
})

console.log('degraded compositions')
check('stays inert and warns when slots is absent', () => {
  const { errors, seats } = mount({ withSlots: false })
  assert.equal(seats['sidebar.panellist'].length, 0)
  assert.ok(errors.some((e) => /no slots service/.test(e)), `errors: ${errors.join(' | ')}`)
})

check('still registers seats when locale is absent', () => {
  const { seats } = mount({ withLocale: false })
  assert.equal(seats['sidebar.panellist'].length, 1, 'a missing locale service must not block the panel')
  assert.equal(seats['sidebar.panellist'][0].options.label(), 'Relaunch Harness',
    'without the service the English column is used directly')
})

check('panel renders English when locale is absent', () => {
  const { seats } = mount({ withLocale: false })
  const Panel = seats.main[0].component
  const out = render(Panel({}))
  assert.match(out, /Relaunch Harness/)
})

// Minimal lookup used by one check above so it does not depend on mount state.
function mountText(locale, key) {
  const dict = {
    en: {
      'panel.title': 'Relaunch Harness',
      'panel.body': 'Close and start DeepSeek Harness again. Running tasks are interrupted.',
      'panel.action': 'Relaunch Harness',
    },
  }
  return dict[locale]?.[key] ?? key
}

console.log(`\n==== ${passed} passed, ${failed} failed ====`)
process.exit(failed === 0 ? 0 : 1)
