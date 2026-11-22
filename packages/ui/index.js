/**
 * Host half of the ScreenPower UI bundle.
 *
 * The Client half renders the panel; this half owns the single implementation
 * of every blackout operation and exposes it twice, as required by the
 * "one operation, two callers" rule:
 *
 * 1. an agent tool (`screenpower`), and
 * 2. a local HTTP route the Client panel calls.
 *
 * Both paths run the same `perform()` function, so the UI and the agent can
 * never drift apart. `perform()` returns stable machine codes; the Client maps
 * them to localized text, and the agent tool maps them to English text.
 *
 * @module
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'

import {
  BLACKOUT_MODES,
  describeCommand,
  findExecutable,
  normalizeTime,
  readState,
  runCli,
} from '../../shared/screenpower-core.js'

export const inject = ['tools', 'webServer']

/**
 * Stable result codes returned by `perform()`. The Client half maps these to
 * localized strings; the agent tool maps them to English strings. No user
 * facing text is hardcoded in `perform()` itself.
 */
export const RESULT_CODES = Object.freeze({
  OK: 'OK',
  NOT_INSTALLED: 'NOT_INSTALLED',
  INVALID_TIME: 'INVALID_TIME',
  CLI_FAILED: 'CLI_FAILED',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  SERVICE_ALREADY_RUNNING: 'SERVICE_ALREADY_RUNNING',
})

/** English messages for the agent-facing tool, keyed by result code. */
const AGENT_MESSAGES = Object.freeze({
  OK: 'ScreenPower operation completed.',
  NOT_INSTALLED: 'ScreenPower is not installed. Run install.ps1 or set the executablePath plugin config.',
  INVALID_TIME: 'Unrecognized wake time. Use HH:mm (00:00-23:59), for example 07:00.',
  CLI_FAILED: 'ScreenPower command failed. Check C:\\ProgramData\\ScreenPower\\screenpower.log.',
  UNKNOWN_ACTION: 'Unknown action. Use one of: status, blackout, wake, sleep-guard, start-service.',
  SERVICE_ALREADY_RUNNING: 'The ScreenPower guard service is already running.',
})

/**
 * Route the Client panel uses on the Harness web server.
 *
 * The route lives on the same origin as the Web GUI, so the browser treats the
 * request as same-origin: no CORS preflight, no Private Network Access
 * prompt, and no guessing which loopback port the Host happens to use. That
 * matters because the Harness host rebinds a fresh port on every restart.
 */
export const WEB_ROUTE_PATH = '/plugins/screenpower'

/**
 * Fixed loopback port for the Client -> Host bridge.
 *
 * The Client half runs inside the browser and cannot read the endpoint file
 * the Host writes, so both halves agree on a fixed port. It is deliberately
 * unusual to avoid collisions, and the server binds to 127.0.0.1 only.
 *
 * This standalone bridge is the fallback for clients that cannot reach the
 * Harness web server route.
 *
 * @type {number}
 */
export const BRIDGE_PORT = 18765

/**
 * Executable path override, taken from the plugin configuration when present.
 *
 * @type {string | undefined}
 */
let executableOverride

/**
 * Start a long-running ScreenPower command without waiting for it to exit.
 *
 * Used for `sleep-guard`, whose process lives on for as long as the guard
 * runs. Awaiting it would hold the HTTP response open forever, so the command
 * is spawned detached and the caller is told as soon as it started.
 *
 * @param {string[]} args CLI arguments.
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<{ ok: boolean, code: number, message: string }>}
 */
function startDetached(args, options = {}) {
  const executable = findExecutable(options)
  if (!executable) {
    return Promise.resolve({
      ok: false,
      code: 127,
      message: 'ScreenPower 未安装。Windows 用户请先运行 install.ps1；或用 SCREENPOWER_HOME 指定安装目录。',
    })
  }
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(executable, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, code: 1, message: String(error?.message ?? error) })
      return
    }
    child.once('error', (error) => {
      resolve({ ok: false, code: 1, message: String(error?.message ?? error) })
    })
    child.once('spawn', () => {
      // Let the guard outlive this process.
      child.unref()
      resolve({ ok: true, code: 0, message: '' })
    })
  })
}

/**
 * Check whether the ScreenPower guard service is already running.
 *
 * The guard writes its process id into `guard.pid` next to the executable, so
 * the pid file is the cheapest reliable signal. A stale file (the process died
 * without cleaning up) is treated as "not running" by verifying the pid.
 *
 * @param {Record<string, unknown>} [options]
 * @returns {boolean}
 */
function isServiceRunning(options = {}) {
  const executable = findExecutable(options)
  if (!executable) return false
  const pidFile = join(dirname(executable), 'guard.pid')
  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    if (!Number.isInteger(pid) || pid <= 0) return false
    // Signal 0 probes for existence without touching the process.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Perform one blackout operation and report the resulting state.
 *
 * @param {'status' | 'blackout' | 'wake' | 'sleep-guard' | 'start-service'} action
 * @param {{ until?: string }} [options]
 * @returns {Promise<{ ok: boolean, action: string, code: string, detail: string, state: Record<string, unknown> | null }>}
 */
async function perform(action, options = {}) {
  const cliOptions = executableOverride ? { executablePath: executableOverride } : {}

  if (action === 'status') {
    const executable = findExecutable(cliOptions)
    if (!executable) {
      return { ok: false, action: 'status', code: RESULT_CODES.NOT_INSTALLED, detail: '', state: null }
    }
    return { ok: true, action: 'status', code: RESULT_CODES.OK, detail: '', state: await readState(cliOptions) }
  }

  if (action === 'start-service') {
    // Start the guard daemon the same way the scheduled "ScreenPower-Guard"
    // task does, so the service behaves identically whether the user starts
    // it from the panel or Windows starts it at logon.
    if (!findExecutable(cliOptions)) {
      return { ok: false, action: 'start-service', code: RESULT_CODES.NOT_INSTALLED, detail: '', state: null }
    }
    if (isServiceRunning(cliOptions)) {
      return {
        ok: true,
        action: 'start-service',
        code: RESULT_CODES.SERVICE_ALREADY_RUNNING,
        detail: '',
        state: await readState(cliOptions),
      }
    }
    const { args, summary } = describeCommand('sleep-guard')
    const started = await startDetached(args, cliOptions)
    if (!started.ok) {
      return { ok: false, action: summary, code: RESULT_CODES.CLI_FAILED, detail: started.message, state: null }
    }
    return { ok: true, action: summary, code: RESULT_CODES.OK, detail: '', state: await readState(cliOptions) }
  }

  if (action === 'wake') {
    const { args, summary } = describeCommand('on')
    const result = await runCli(args, cliOptions)
    if (!result.ok) {
      return { ok: false, action: summary, code: RESULT_CODES.CLI_FAILED, detail: result.message, state: null }
    }
    return { ok: true, action: summary, code: RESULT_CODES.OK, detail: '', state: await readState(cliOptions) }
  }

  if (action === 'sleep-guard') {
    // `sleep-guard` is a foreground process that stays alive for as long as
    // the guard runs, so awaiting it would hang the request forever. Start it
    // detached instead and answer as soon as it is running.
    const { args, summary } = describeCommand('sleep-guard')
    const started = await startDetached(args, cliOptions)
    if (!started.ok) {
      return { ok: false, action: summary, code: RESULT_CODES.CLI_FAILED, detail: started.message, state: null }
    }
    return { ok: true, action: summary, code: RESULT_CODES.OK, detail: '', state: await readState(cliOptions) }
  }

  if (action === 'blackout') {
    const rawUntil = typeof options.until === 'string' ? options.until.trim() : ''
    if (rawUntil && !normalizeTime(rawUntil)) {
      return { ok: false, action: 'blackout', code: RESULT_CODES.INVALID_TIME, detail: rawUntil, state: null }
    }
    const { args, summary } = describeCommand('off', rawUntil || undefined)
    const result = await runCli(args, cliOptions)
    if (!result.ok) {
      return { ok: false, action: summary, code: RESULT_CODES.CLI_FAILED, detail: result.message, state: null }
    }
    return { ok: true, action: summary, code: RESULT_CODES.OK, detail: '', state: await readState(cliOptions) }
  }

  return { ok: false, action: String(action), code: RESULT_CODES.UNKNOWN_ACTION, detail: String(action), state: null }
}

/**
 * Build the agent-facing tool definition.
 *
 * This is a plain registry-ready definition rather than a call to
 * `@deepseek-ai/dsh-tools`'s `defineTool`: a locally linked bundle resolves its
 * imports from the workspace, which has no Harness packages installed. The
 * shape below mirrors what `defineTool` compiles to, so the tool behaves
 * identically while keeping the bundle self-contained.
 *
 * @returns {object}
 */
function buildTool() {
  return {
    name: 'screenpower',
    description:
      'Control the Windows screen blackout helper. Use action "status" to check whether the screen is blacked out and when it wakes automatically, action "blackout" to turn the screen off while the computer keeps running, action "wake" to restore the screen immediately, action "sleep-guard" to keep the computer awake without touching the screen, and action "start-service" to start the ScreenPower guard service if it is not running yet. Any key press or mouse click wakes a blacked-out screen.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'One of "status", "blackout", "wake", "sleep-guard", "start-service".',
          enum: ['status', 'blackout', 'wake', 'sleep-guard', 'start-service'],
        },
        until: {
          type: 'string',
          description:
            'Optional wall-clock wake time in HH:mm form for action "blackout", for example 07:00. Omit it to wake only on a key press or mouse click.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
          state: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const result = await perform(args.action, { until: args.until })
      const message = AGENT_MESSAGES[result.code] ?? AGENT_MESSAGES[RESULT_CODES.UNKNOWN_ACTION]
      if (!result.ok) throw new Error(message)
      return {
        ok: result.ok,
        action: result.action,
        code: result.code,
        message,
        state: result.state ?? {},
      }
    },
  }
}

/**
 * Read a JSON request body with a size cap.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  return JSON.parse(text)
}

/**
 * Publish the bridge endpoint so the Client half can find it.
 *
 * The Client runs in the browser and cannot read the Host process, so the
 * Host writes the endpoint into a small JSON file next to the bundle's own
 * runtime state. The Client polls that file through the workspace file API
 * only if it can; in practice the bundle ships the endpoint through the
 * `window.__DSH_BOOT__` payload instead, and this file is the fallback for
 * the packaged (npm) build.
 *
 * @param {number} port
 */
function publishEndpoint(port) {
  const target = join(tmpdir(), 'screenpower-dsh-bridge.json')
  try {
    writeFileSync(target, JSON.stringify({ port, origin: `http://127.0.0.1:${port}` }), 'utf8')
  } catch (error) {
    console.error('[screenpower] could not publish the bridge endpoint:', error)
  }
  return () => {
    try {
      unlinkSync(target)
    } catch {
      /* the file may already be gone */
    }
  }
}

/**
 * Handle one bridge request.
 *
 * Shared by the Harness web server route and the standalone loopback bridge,
 * so both entry points answer with exactly the same payload.
 *
 * @param {{ method?: string }} request
 * @param {{ writeHead: (status: number, headers?: Record<string, string>) => unknown, end: (body?: string) => unknown }} response
 * @param {Record<string, string>} [headers]
 */
async function handleBridgeRequest(request, response, headers = {}) {
  const method = String(request.method ?? 'GET').toUpperCase()
  if (method === 'OPTIONS') {
    response.writeHead(204, headers)
    response.end()
    return
  }
  if (method !== 'POST') {
    response.writeHead(405, headers)
    response.end(JSON.stringify({ ok: false, code: 'METHOD_NOT_ALLOWED', detail: 'POST only', state: null }))
    return
  }
  try {
    const body = await readJsonBody(request)
    const action = String(body.action ?? 'status')
    const result = await perform(action, { until: body.until })
    response.writeHead(200, headers)
    response.end(JSON.stringify(result))
  } catch (error) {
    response.writeHead(400, headers)
    response.end(
      JSON.stringify({
        ok: false,
        code: 'BAD_REQUEST',
        detail: String(error?.message ?? error),
        state: null,
      }),
    )
  }
}

/**
 * Register the bridge route on the Harness web server.
 *
 * Serving the panel bridge from the GUI's own origin removes every
 * cross-origin failure mode at once: no CORS preflight, no Private Network
 * Access prompt, no fixed-port guessing, and no breakage when the Harness
 * host restarts on a different port.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {() => void} Cleanup.
 */
function registerWebServerRoute(ctx) {
  return ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: WEB_ROUTE_PATH,
      handler: (request, response) => {
        const headers = { 'content-type': 'application/json' }
        return handleBridgeRequest(request, response, headers)
      },
    })
    return () => {
      dispose()
    }
  }, 'screenpower: web panel bridge route')
}

/**
 * Register the HTTP bridge the Client panel uses.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {() => void} Cleanup.
 */
function registerHttpBridge(ctx) {
  const server = createServer((request, response) => {
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : ''
    // Empty origin (same-origin / non-browser) and Electron's "null" origin are
    // both local here; the server only ever binds to 127.0.0.1.
    const allowed = origin === '' || origin === 'null' || isAllowedOrigin(origin)

    // Common headers: reflect the requesting loopback origin so the browser
    // accepts the cross-port response, and keep the bridge loopback-only.
    const corsHeaders = {
      'access-control-allow-origin': allowed && origin ? origin : 'http://127.0.0.1',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'content-type': 'application/json',
    }

    if (!allowed) {
      response.writeHead(403, corsHeaders)
      response.end(JSON.stringify({ ok: false, code: 'FORBIDDEN', detail: 'origin not allowed', state: null }))
      return
    }

    return handleBridgeRequest(request, response, corsHeaders)
  })

  const dispose = ctx.effect(() => {
    server.close()
    server.unref()
  })

  // Try a small, fixed range of loopback ports. The Client half probes the
  // same range because it cannot read the endpoint file the Host writes.
  let port = BRIDGE_PORT
  let attempts = 0
  const tryListen = () => {
    server.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE' && attempts < 4) {
        attempts += 1
        port = BRIDGE_PORT + attempts
        setTimeout(tryListen, 50)
      } else {
        console.error('[screenpower] local bridge failed to start:', error)
      }
    })
    server.listen(port, '127.0.0.1', () => {
      server.removeAllListeners('error')
      server.on('error', (error) => {
        console.error('[screenpower] local bridge error:', error)
      })
      publishEndpoint(port)
      console.log(`[screenpower] local bridge listening on http://127.0.0.1:${port}`)
    })
  }
  tryListen()

  return dispose
}

/**
 * Decide whether a browser origin may call the local bridge.
 *
 * Only loopback origins are allowed, which keeps the bridge unreachable from
 * the network.
 *
 * @param {string} origin
 * @returns {boolean}
 */
function isAllowedOrigin(origin) {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * Host plugin entry point.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ executablePath?: string }} [config]
 */
export function apply(ctx, config = {}) {
  executableOverride = typeof config?.executablePath === 'string' ? config.executablePath : undefined

  ctx.tools.register(buildTool())

  // Primary path: the Harness web server, so the panel calls its own origin.
  const disposeRoute = registerWebServerRoute(ctx)
  // Fallback path: a standalone loopback bridge for clients that cannot
  // reach the Harness web server.
  const disposeBridge = registerHttpBridge(ctx)
  return () => {
    disposeRoute()
    disposeBridge()
    executableOverride = undefined
  }
}

/**
 * Modes the panel renders; exported for tests and for the Client half.
 *
 * @returns {typeof BLACKOUT_MODES}
 */
export function modes() {
  return BLACKOUT_MODES
}
