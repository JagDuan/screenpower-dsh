/**
 * Shared core for the ScreenPower DSH integration.
 *
 * Locates the ScreenPower executable, runs its CLI, and parses its state.
 * The executable itself lives outside this package (it is installed into
 * ProgramData by the Windows installer), so every entry point degrades to a
 * readable message instead of throwing when it is missing.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Default install locations, most specific first. */
const DEFAULT_EXE_PATHS = [
  path.join(process.env.ProgramData || 'C:\\ProgramData', 'ScreenPower', 'ScreenPower.exe'),
  path.join(os.homedir(), 'AppData', 'Local', 'ScreenPower', 'ScreenPower.exe'),
]

/** State file locations that mirror the executable search. */
const DEFAULT_STATE_PATHS = DEFAULT_EXE_PATHS.map((exe) => path.join(path.dirname(exe), 'state.txt'))

/**
 * Resolve the ScreenPower executable.
 *
 * @param {Record<string, unknown>} [options]
 * @param {string} [options.executablePath] Explicit override.
 * @param {string} [options.envHome] Value of `SCREENPOWER_HOME`.
 * @returns {string | null} Absolute path, or null when nothing was found.
 */
export function findExecutable(options = {}) {
  const explicit = typeof options.executablePath === 'string' ? options.executablePath.trim() : ''
  if (explicit) return existsSync(explicit) ? explicit : null

  const fromEnv = (options.envHome ?? process.env.SCREENPOWER_HOME ?? '').trim()
  if (fromEnv) {
    const candidate = path.join(fromEnv, 'ScreenPower.exe')
    if (existsSync(candidate)) return candidate
  }

  for (const candidate of DEFAULT_EXE_PATHS) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Resolve the directory that holds state.txt, guard.pid and the log.
 *
 * @param {Record<string, unknown>} [options]
 * @returns {string} Directory path (may not exist yet).
 */
export function findDataDir(options = {}) {
  const fromEnv = (options.envHome ?? process.env.SCREENPOWER_HOME ?? '').trim()
  if (fromEnv) return fromEnv
  const executable = findExecutable(options)
  if (executable) return path.dirname(executable)
  return path.join(process.env.ProgramData || 'C:\\ProgramData', 'ScreenPower')
}

/**
 * Parse the flat `key=value` state file written by ScreenPower.
 *
 * @param {string} text
 * @returns {Record<string, string>} Parsed pairs; unknown lines are ignored.
 */
export function parseState(text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

/**
 * Read the current ScreenPower state.
 *
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<Record<string, unknown>>} Normalized state snapshot.
 */
export async function readState(options = {}) {
  const dir = findDataDir(options)
  const statePath = path.join(dir, 'state.txt')
  const raw = existsSync(statePath) ? readFileSync(statePath, 'utf8') : ''
  const parsed = parseState(raw)
  const untilTime = parsed.UntilTime && parsed.UntilTime !== '0001-01-01 00:00:00'
    ? parsed.UntilTime
    : ''
  return {
    installed: findExecutable(options) !== null,
    dataDir: dir,
    statePath,
    mode: parsed.Mode || 'unknown',
    until: parsed.Until || '',
    untilTime,
    hasUntil: parsed.HasUntil === '1' || parsed.HasUntil === 'True',
    savedInternalBrightness: Number.parseInt(parsed.SavedInternalBrightness ?? '', 10) || -1,
    savedPowerCfg: parsed.SavedPowerCfg === '1' || parsed.SavedPowerCfg === 'True',
    savedStandbyAc: parsed.SavedStandbyAc || '',
    savedStandbyDc: parsed.SavedStandbyDc || '',
    savedHibernateAc: parsed.SavedHibernateAc || '',
    savedHibernateDc: parsed.SavedHibernateDc || '',
    savedScheme: parsed.SavedScheme || '',
    guardPid: parsed.GuardPid || '',
  }
}

/**
 * Run one ScreenPower CLI command.
 *
 * @param {string[]} args CLI arguments, e.g. `['off', '--until', '07:00']`.
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<{ ok: boolean, code: number, stdout: string, stderr: string, message: string }>}
 */
export async function runCli(args, options = {}) {
  const executable = findExecutable(options)
  if (!executable) {
    return {
      ok: false,
      code: 127,
      stdout: '',
      stderr: '',
      message: 'ScreenPower 未安装。Windows 用户请先运行 install.ps1；或用 SCREENPOWER_HOME 指定安装目录。',
    }
  }
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, code: 0, stdout, stderr, message: '' }
  } catch (error) {
    const code = typeof error?.code === 'number' ? error.code : 1
    const stdout = String(error?.stdout ?? '')
    const stderr = String(error?.stderr ?? '')
    const detail = (stderr || stdout || error?.message || '').trim()
    return {
      ok: false,
      code,
      stdout,
      stderr,
      message: detail || `ScreenPower 执行失败（退出码 ${code}）`,
    }
  }
}

/**
 * Blackout modes exposed to the UI and to the agent.
 *
 * `duration` is in minutes; `until` is a wall-clock time for the scheduled
 * mode. `keepComputerAwake` maps to the guard process that disables sleep.
 *
 * @type {ReadonlyArray<{ id: string, title: string, description: string, until: string, keepComputerAwake: boolean }>}
 */
export const BLACKOUT_MODES = Object.freeze([
  {
    id: 'manual',
    title: '手动黑屏（不自动亮屏）',
    description: '立刻黑屏，电脑保持运行，按任意键或点击鼠标即可唤醒。',
    until: '',
    keepComputerAwake: true,
  },
  {
    id: 'until',
    title: '定时黑屏（到点自动亮屏）',
    description: '立刻黑屏，并在指定时间自动亮屏，同时会禁用睡眠与休眠。',
    until: '07:00',
    keepComputerAwake: true,
  },
  {
    id: 'sleeptimer',
    title: '睡眠保护（只防休眠，不黑屏）',
    description: '保持屏幕正常，只阻止电脑进入睡眠或休眠，适合长时间下载或跑任务。',
    until: '',
    keepComputerAwake: true,
  },
])

/**
 * Normalize a wall-clock time to `HH:mm`.
 *
 * @param {unknown} value
 * @returns {string | null} Normalized time, or null when the input is unusable.
 */
export function normalizeTime(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const match = /^(\d{1,2})\s*[:：.]\s*(\d{1,2})$/.exec(text)
  if (!match) return null
  const hours = Number.parseInt(match[1], 10)
  const minutes = Number.parseInt(match[2], 10)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/**
 * Describe what a ScreenPower command will do, for the agent and the UI.
 *
 * @param {string} mode One of `off`, `on`, `status`, `sleep-guard`.
 * @param {string | undefined} until Wall-clock time for the `off` mode.
 * @returns {{ args: string[], summary: string }}
 */
export function describeCommand(mode, until) {
  switch (mode) {
    case 'off': {
      const time = normalizeTime(until)
      if (time) {
        return { args: ['off', '--until', time], summary: `黑屏，并在 ${time} 自动亮屏` }
      }
      return { args: ['off'], summary: '黑屏，手动唤醒' }
    }
    case 'on':
      return { args: ['on'], summary: '立即亮屏并恢复电源设置' }
    case 'sleep-guard':
      return { args: ['sleep-guard'], summary: '仅保护睡眠/休眠，不黑屏' }
    case 'status':
      return { args: ['status', '--quiet'], summary: '查询当前黑屏状态' }
    default:
      return { args: [], summary: `未知操作：${mode}` }
  }
}
