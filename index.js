/**
 * dsh-relaunch — Host half.
 *
 * Exposes one authenticated HTTP route that restarts the DeepSeek Harness
 * desktop application. The restart cannot be done from inside this process:
 * this process *is* the thing being restarted, so the route only launches a
 * detached worker and returns immediately.
 *
 * Why a detached worker rather than an in-process call:
 *   - Neither the Client nor the Host Service directory ships any
 *     restart/relaunch/quit capability, so a plugin has no API to call.
 *   - Killing this process from within itself would race the HTTP response and
 *     would take any plain child down with it, so the relaunch would never
 *     happen.
 *
 * The worker is started through the WMI provider host (Win32_Process.Create),
 * which puts it under WmiPrvSE.exe instead of this process tree, so killing
 * Harness does not kill the restart. It is launched by wscript.exe because the
 * restart must not flash a console window (see launch-hidden.vbs).
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const ROUTE_PATH = '/dsh-relaunch/restart'
/** Where the detached script records each restart attempt. */
const LOG_PATH = join(here, 'restart.log')

/** The PowerShell that owns the detached restart. */
const POWERSHELL = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'

/**
 * The installed application executable, derived from the running process.
 * `process.execPath` is the Electron binary that is currently running, which is
 * exactly the file to relaunch.
 */
const APP_EXE = process.execPath

/**
 * Launch the restart script so it outlives this process.
 *
 * Uses WMI (Win32_Process.Create) because it reliably detaches: the child's
 * parent is WmiPrvSE.exe rather than this process, so killing this process tree
 * does not take the script with it. Falls back to a detached spawn when WMI is
 * unavailable.
 *
 * @param {number} delaySeconds - grace period before the app is touched.
 * @returns {Promise<{pid: number|undefined, method: string}>} launch facts.
 */
async function launchRestart(delaySeconds) {
  // Launch through wscript -> a hidden Electron Node-mode worker.
  //
  // Why not PowerShell: powershell.exe is a CONSOLE-subsystem program, and
  // WMI's Win32_Process.Create exposes no STARTUPINFO, so CREATE_NO_WINDOW
  // cannot be requested -- a console window (conhost/Windows Terminal) appears
  // during the restart. The Harness executable is GUI-subsystem, so running the
  // worker through it in Node mode produces no window at all. wscript.exe is
  // also GUI-subsystem and adds none either.
  const launcher = join(here, 'launch-hidden.vbs')
  const worker = join(here, 'restart-harness.mjs')

  // Refuse on any platform without the Windows facilities this restart is built
  // on. Without this guard the failure is incidental and late -- wscript.exe does
  // not exist elsewhere, so the WMI attempt throws, the fallback spawn fails too,
  // and the caller gets a generic "restart-failed" instead of a statement of the
  // actual limitation. The README promises a clean refusal, so it has to be one.
  if (process.platform !== 'win32') {
    throw new Error(
      `restarting Harness is supported on Windows only (this is ${process.platform})`,
    )
  }

  if (!existsSync(launcher)) throw new Error(`hidden launcher is missing: ${launcher}`)
  if (!existsSync(worker)) throw new Error(`restart worker is missing: ${worker}`)

  // wscript <launcher> <exePath> <workerPath> <logPath> <delaySeconds>
  const launchArgs = [APP_EXE, worker, LOG_PATH, String(delaySeconds)]

  const WSCRIPT = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'wscript.exe')
    : 'wscript.exe'

  // WMI detaches the launcher from this process tree, so killing Harness does
  // not kill the restart.
  try {
    const { execFile } = await import('node:child_process')
    const q = (v) => v.replace(/'/g, "''")
    const wmi = `
      $w = '${q(WSCRIPT)}'
      $cmd = ('"{0}" "${q(launcher)}" "${q(APP_EXE)}" "${q(worker)}" "${q(LOG_PATH)}" "${q(String(delaySeconds))}"') -f $w
      $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
      [pscustomobject]@{ ReturnValue = $r.ReturnValue; ProcessId = $r.ProcessId } | ConvertTo-Json -Compress
    `
    const out = await new Promise((resolve, reject) => {
      execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', wmi],
        { windowsHide: true, timeout: 15000 },
        (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(String(stdout))))
    })
    const parsed = JSON.parse(out.trim() || '{}')
    if (parsed.ReturnValue === 0) return { pid: parsed.ProcessId, method: 'wmi-detached-windowless' }
    throw new Error(`WMI returned ${String(parsed.ReturnValue)}`)
  } catch (error) {
    // Fallback: detached + unref. windowsHide here does pass CREATE_NO_WINDOW,
    // and the VBS launcher keeps the worker windowless regardless.
    const child = spawn(WSCRIPT, [launcher, ...launchArgs], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return { pid: child.pid, method: 'detached-windowless-spawn', warning: String(error?.message ?? error) }
  }
}

/**
 * Read a small JSON request body.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<Record<string, unknown>>} parsed body, or an empty object.
 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 64 * 1024) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Register the restart route for this plugin's lifetime.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const disposers = []

  const register = (server) => {
    if (server === undefined || server === null) return
    const stop = server.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        const send = (status, body) => {
          const text = JSON.stringify(body)
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(text)
        }

        try {
          if (req.method !== 'POST') {
            send(405, { ok: false, error: 'method-not-allowed', message: 'Use POST.' })
            return
          }
          const body = await readJsonBody(req)
          const delay = Number.isFinite(Number(body.delaySeconds))
            ? Math.min(Math.max(Math.trunc(Number(body.delaySeconds)), 1), 30)
            : 3

          const launch = await launchRestart(delay)
          // Answer before the script touches anything: the app must survive long
          // enough for this response to reach the browser.
          send(200, {
            ok: true,
            method: launch.method,
            launcherPid: launch.pid ?? null,
            delaySeconds: delay,
            executable: APP_EXE,
            warning: launch.warning,
          })
        } catch (error) {
          send(500, {
            ok: false,
            error: 'restart-failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    })
    if (typeof stop === 'function') disposers.push(stop)
  }

  // `webServer` is optional: a desktop composition without it simply has no
  // route, and the plugin stays inert instead of throwing.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (inner) => {
      const server = inner.webServer
      if (server === undefined || server === null) {
        console.warn('dsh-relaunch: this composition has no webServer; the route stays unmounted')
        return
      }
      try {
        register(server)
      } catch (error) {
        console.error('dsh-relaunch: registering the restart route failed', error)
      }
      return () => {
        for (const dispose of disposers.splice(0)) {
          try { dispose() } catch (error) { console.error('dsh-relaunch: route disposal failed', error) }
        }
      }
    })
  }
}

export const name = 'dsh-restart-app'
