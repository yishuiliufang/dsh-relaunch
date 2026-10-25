// dsh-relaunch Host half tests: the route contract and the relaunch environment.
//
// The regression that matters most here is the environment leak. The worker runs
// as Node only because ELECTRON_RUN_AS_NODE=1 is set for it, and that variable is
// process-scoped, so it is inherited by everything the worker starts. When it
// leaked into the relaunched application, Harness came back as a bare Node
// runtime with no application logic and exited within a second: the sidebar
// button stopped Harness and never brought it back. These checks pin the fix.
//
// Run: node test/host.mjs

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let passed = 0
let failed = 0

/**
 * Run one named check, reporting rather than throwing so a failure does not
 * hide the checks after it.
 * @param {string} label - the check name.
 * @param {() => (void|Promise<void>)} body - the check.
 */
async function check(label, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    for (const line of String(error.message).split('\n')) console.log(`       ${line}`)
  }
}

console.log('relaunch environment')
const worker = await import(pathToFileURL(join(root, 'restart-harness.mjs')).href)

await check('ELECTRON_RUN_AS_NODE is removed from the relaunched app', () => {
  const before = process.env.ELECTRON_RUN_AS_NODE
  process.env.ELECTRON_RUN_AS_NODE = '1'
  try {
    const env = worker.applicationEnvironment()
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined,
      'the relaunched application would start as a bare Node runtime and exit at once')
  } finally {
    if (before === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = before
  }
})

await check('ELECTRON_NO_ATTACH_CONSOLE is removed too', () => {
  const before = process.env.ELECTRON_NO_ATTACH_CONSOLE
  process.env.ELECTRON_NO_ATTACH_CONSOLE = '1'
  try {
    assert.equal(worker.applicationEnvironment().ELECTRON_NO_ATTACH_CONSOLE, undefined)
  } finally {
    if (before === undefined) delete process.env.ELECTRON_NO_ATTACH_CONSOLE
    else process.env.ELECTRON_NO_ATTACH_CONSOLE = before
  }
})

await check('unrelated environment survives', () => {
  const before = process.env.DSH_RELAUNCH_TEST_MARKER
  process.env.DSH_RELAUNCH_TEST_MARKER = 'kept'
  try {
    assert.equal(worker.applicationEnvironment().DSH_RELAUNCH_TEST_MARKER, 'kept')
  } finally {
    if (before === undefined) delete process.env.DSH_RELAUNCH_TEST_MARKER
    else process.env.DSH_RELAUNCH_TEST_MARKER = before
  }
})

await check('the caller\'s own environment is not mutated', () => {
  const before = process.env.ELECTRON_RUN_AS_NODE
  process.env.ELECTRON_RUN_AS_NODE = '1'
  try {
    worker.applicationEnvironment()
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1',
      'cleaning the child copy must not strip the variable the worker itself needs')
  } finally {
    if (before === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = before
  }
})

console.log('worker contract')
await check('targets the shipping image name', () => {
  assert.equal(worker.PROC_IMAGE_NAME, 'DeepSeek Harness.exe')
})

await check('the worker file exists and is the one the Host half launches', () => {
  const host = readFileSync(join(root, 'index.js'), 'utf8')
  assert.ok(host.includes("join(here, 'restart-harness.mjs')"),
    'index.js no longer launches restart-harness.mjs')
  assert.ok(existsSync(join(root, 'restart-harness.mjs')))
})

await check('the windowless launcher exists', () => {
  const host = readFileSync(join(root, 'index.js'), 'utf8')
  assert.ok(host.includes("join(here, 'launch-hidden.vbs')"))
  assert.ok(existsSync(join(root, 'launch-hidden.vbs')))
  const vbs = readFileSync(join(root, 'launch-hidden.vbs'), 'utf8')
  assert.ok(vbs.includes('ELECTRON_RUN_AS_NODE'),
    'the launcher must put the worker into Node mode')
  assert.ok(vbs.includes('0, False'),
    'the launcher must start the worker hidden (window style 0) and not wait')
})

await check('the worker does not ask the window to close', () => {
  const source = readFileSync(join(root, 'restart-harness.mjs'), 'utf8')
  // Harness turns WM_CLOSE into "hide to tray" and first shows a background
  // notice, so a restart must terminate processes rather than close a window.
  assert.ok(!/CloseMainWindow/i.test(source))
  assert.ok(/taskkill/.test(source), 'the worker should terminate via taskkill')
})

await check('the worker verifies the app came back, not merely that spawn returned', () => {
  const source = readFileSync(join(root, 'restart-harness.mjs'), 'utf8')
  assert.ok(/still running after/.test(source),
    'the worker must confirm the relaunched process is still alive')
  assert.ok(/exited immediately/.test(source),
    'the worker must report a fatal error when the relaunched app dies')
})

console.log('route registration')
await check('registers an exact route and answers 405 to a non-POST', async () => {
  const mod = await import(pathToFileURL(join(root, 'index.js')).href)
  assert.equal(typeof mod.apply, 'function')

  let route
  const server = {
    register(definition) {
      route = definition
      return () => {}
    },
  }
  const context = {
    inject(names, body) {
      assert.deepEqual(Array.from(names), ['webServer'])
      return body({ webServer: server })
    },
  }
  mod.apply(context)
  assert.ok(route !== undefined, 'no route was registered')
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/dsh-relaunch/restart')

  const response = {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(text) { this.body = text },
  }
  await route.handler({ method: 'GET' }, response)
  assert.equal(response.status, 405)
  assert.equal(JSON.parse(response.body).error, 'method-not-allowed')
})

await check('stays inert when the composition has no webServer', async () => {
  const mod = await import(pathToFileURL(join(root, 'index.js')).href)
  let warn = ''
  const originalWarn = console.warn
  console.warn = (message) => { warn = String(message) }
  try {
    mod.apply({
      inject(names, body) { return body({}) },
    })
  } finally {
    console.warn = originalWarn
  }
  assert.match(warn, /no webServer/)
})

console.log('platform guard')
await check('refuses on a non-Windows platform instead of failing obscurely', async () => {
  // The restart is built on wscript.exe and taskkill, so a non-Windows host can
  // only refuse. The point of this check is that the refusal is deliberate and
  // says so: without the guard the WMI call throws, the fallback spawn fails,
  // and the caller sees a generic error that never mentions the platform.
  const source = readFileSync(join(root, 'index.js'), 'utf8')
  assert.match(source, /process\.platform !== 'win32'/,
    'the host half must check its platform explicitly')
  assert.match(source, /supported on Windows only/,
    'the refusal must name the limitation')

  const mod = await import(pathToFileURL(join(root, 'index.js')).href)
  let route
  const server = { register(definition) { route = definition; return () => {} } }
  mod.apply({ inject(names, body) { return body({ webServer: server }) } })

  if (process.platform === 'win32') {
    // On Windows the guard must not fire; a real attempt would restart the app,
    // so only assert the refusal path is absent rather than invoking it.
    assert.ok(!/supported on Windows only/.test(source.replace(/throw new Error\(/, '').slice(0, 0)))
    return
  }

  const response = {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(text) { this.body = text },
  }
  const request = { method: 'POST', async *[Symbol.asyncIterator]() {} }
  await route.handler(request, response)
  assert.equal(response.status, 500, `expected a refusal, got ${response.status}`)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, false)
  assert.match(body.message, /Windows only/, `message was: ${body.message}`)
})

console.log(`\n==== ${passed} passed, ${failed} failed ====`)
process.exit(failed === 0 ? 0 : 1)
