/**
 * dsh-restart-app: restart the DeepSeek Harness desktop application.
 *
 * Run by the Harness Electron binary in Node mode (ELECTRON_RUN_AS_NODE=1),
 * detached, with stdio ignored. Why Node mode rather than a PowerShell script:
 * powershell.exe is a CONSOLE-subsystem program, and the WMI route used to
 * detach it exposes no STARTUPINFO, so CREATE_NO_WINDOW cannot be requested and
 * a console window flashes during the restart. The Harness executable is
 * GUI-subsystem, so running this worker through it creates no window at all.
 *
 * CRITICAL — ELECTRON_RUN_AS_NODE MUST NOT REACH THE RELAUNCHED APPLICATION.
 * This worker only runs as Node because that variable is set in its own
 * environment, and the launcher sets it on the process environment, so it is
 * inherited by every descendant. An Electron binary that inherits it starts as
 * a bare Node runtime with no application logic and exits within a second:
 * the restart then stops the app and never brings it back. The relaunch
 * therefore spawns with the variable explicitly removed, and verifies the new
 * process is still alive several seconds later instead of trusting the spawn.
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)

/** Read a `-Name value` pair from argv. */
function arg(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}

const EXE = arg('-ExePath', process.execPath)
const PROC_NAME = arg('-ProcName', 'DeepSeek Harness.exe')
const DELAY = Number(arg('-DelaySeconds', '2'))
const LOG = arg('-LogPath', '')

function log(message) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const line = `${stamp}  ${message}`
  console.log(line)
  if (LOG !== '') {
    try { appendFileSync(LOG, line + '\r\n', 'utf8') } catch { /* logging must never break the restart */ }
  }
}

export const PROC_IMAGE_NAME = 'DeepSeek Harness.exe'
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Environment for the relaunched desktop application.
 *
 * ELECTRON_RUN_AS_NODE is removed because this worker exists only through it,
 * and an Electron binary inheriting it runs as Node instead of the application.
 * The other two are removed because they only alter a Node-mode runtime and
 * would make the GUI process misbehave if it were somehow read as such.
 *
 * @returns {NodeJS.ProcessEnv} a copy safe for a GUI Electron launch.
 */
export function applicationEnvironment() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return env
}

/**
 * List PIDs of the named image using tasklist.
 *
 * tasklist is a console program, but windowsHide:true makes Node pass
 * CREATE_NO_WINDOW, so no console appears.
 *
 * @param {string} name - image name including its extension.
 * @returns {Promise<number[]>} matching process ids.
 */
export async function listPids(name) {
  return new Promise((resolve) => {
    const ps = spawn('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    ps.stdout?.setEncoding('utf8')
    ps.stdout?.on('data', (chunk) => { out += chunk })
    ps.on('close', () => {
      const pids = []
      for (const line of out.split(/\r?\n/)) {
        // "DeepSeek Harness.exe","1234","Console","1","123,456 K"
        const m = line.match(/^"[^"]+","(\d+)"/)
        if (m) pids.push(Number(m[1]))
      }
      resolve(pids)
    })
    ps.on('error', () => resolve([]))
  })
}

/**
 * Whether the named image currently has a process with this pid.
 *
 * @returns {Promise<boolean>} true when the pid is still running.
 */
async function isRunning(name, pid) {
  const pids = await listPids(name)
  return pids.includes(pid)
}

/**
 * Terminate one pid with taskkill /F /T.
 *
 * Killing the parent also takes its children down, so a later kill in the same
 * sweep can legitimately find the process already gone. That is success, not
 * failure: reporting it as a failure would hide the real outcome.
 *
 * @returns {Promise<'killed'|'already-gone'|'failed'>} the outcome.
 */
async function kill(name, pid) {
  if (!(await isRunning(name, pid))) return 'already-gone'
  return new Promise((resolve) => {
    const ps = spawn('taskkill', ['/PID', String(pid), '/F', '/T'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let err = ''
    ps.stderr?.setEncoding('utf8')
    ps.stderr?.on('data', (chunk) => { err += chunk })
    ps.on('close', async (code) => {
      if (code === 0) return resolve('killed')
      // taskkill also refuses when the process died while the command ran.
      if (!(await isRunning(name, pid))) return resolve('already-gone')
      log(`    taskkill refused pid ${pid}: ${err.trim() || `exit ${String(code)}`}`)
      resolve('failed')
    })
    ps.on('error', () => resolve('failed'))
  })
}

export async function main() {
  log(`=== restart requested (delay ${DELAY}s, restarter pid ${process.pid}) ===`)
  log(`target     : ${PROC_NAME}`)
  log(`exe        : ${EXE}`)

  // Let the HTTP response that asked for the restart reach the browser first.
  await sleep(Math.max(0, DELAY) * 1000)

  const self = process.pid
  let targets = (await listPids(PROC_NAME)).filter((pid) => pid !== self)
  log(`before     : ${targets.join(', ') || '(none)'}`)

  if (targets.length > 0) {
    log('step 1: terminating')
    for (const pid of targets) {
      log(`    pid ${pid}: ${await kill(PROC_NAME, pid)}`)
    }
  } else {
    log('step 1: nothing to terminate')
  }

  // Wait for the process tree to drain.
  const deadline = Date.now() + 20000
  for (;;) {
    targets = (await listPids(PROC_NAME)).filter((pid) => pid !== self)
    if (targets.length === 0) break
    if (Date.now() > deadline) {
      log(`step 2: still alive after wait: ${targets.join(', ')}`)
      for (const pid of targets) log(`    retry pid ${pid}: ${await kill(PROC_NAME, pid)}`)
      await sleep(2000)
      break
    }
    await sleep(300)
  }
  log('step 2: all processes exited')

  log('step 3: relaunching')
  const child = spawn(EXE, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: applicationEnvironment(),
  })
  child.unref()
  log(`step 3: relaunched pid ${child.pid}`)

  // Verify the application actually stays up. Spawning successfully proves
  // nothing: in Node mode it starts and exits at once. This loop is what
  // distinguishes a real restart from one that leaves the user with nothing.
  let observed = []
  for (let waited = 1; waited <= 10; waited += 1) {
    await sleep(1000)
    observed = (await listPids(PROC_NAME)).filter((pid) => pid !== self)
    if (observed.length > 0) {
      log(`after      : ${observed.join(', ')}  (still running after ${waited}s)`)
      log('=== restart finished ===')
      return
    }
  }

  log('FATAL: the relaunched application exited immediately — nothing is running now')
  log('FATAL: this usually means ELECTRON_RUN_AS_NODE leaked into the new process')
  process.exitCode = 1
}

// Run only when executed directly. Importing the module (as the test suite
// does) must not start a restart.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((error) => {
    log(`FATAL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exitCode = 1
  })
}
