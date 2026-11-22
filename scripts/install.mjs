#!/usr/bin/env node
/**
 * ScreenPower for DeepSeek Harness — one-shot installer.
 *
 * What it does:
 *   1. Stages the native Windows helper (ScreenPower.exe + scripts) into a
 *      writable directory, then runs its install.ps1 (needs Administrator).
 *   2. install.ps1 copies the helper into the RUNTIME directory (default:
 *      %ProgramData%\ScreenPower), registers the scheduled tasks and creates
 *      the desktop shortcuts. state.txt / the log and the tasks all live there.
 *   3. Prints the exact paths you need to wire up the two DSH integration
 *      pieces: the MCP server entry and the UI bundle directory.
 *
 * Usage:
 *   node scripts/install.mjs                       # full install
 *   node scripts/install.mjs --wake 06:30 --sleep 00:30
 *   node scripts/install.mjs --install-dir D:\Tools\ScreenPower
 *   node scripts/install.mjs --skip-native         # only print DSH wiring paths
 *
 * This script is safe to re-run.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const VENDOR_DIR = join(PKG_ROOT, 'vendor', 'screenpower')

const VENDOR_FILES = [
  'ScreenPower.exe',
  'ScreenPower.cs',
  'build.ps1',
  'install.ps1',
  'uninstall.ps1',
  'README.md',
]

/** Minimal argument parser: --key value / --flag. */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i += 1
    } else {
      out[key] = true
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

function fail(message) {
  console.error(`[screenpower] 错误：${message}`)
  process.exitCode = 1
}

/**
 * Print the DSH wiring info. `runtimeDir` is where install.ps1 actually put
 * the executable, state.txt and the scheduled tasks; only a non-default dir
 * needs SCREENPOWER_HOME because the default is auto-detected.
 */
function printDshWiring(runtimeDir, isDefaultDir) {
  const mcpServer = join(PKG_ROOT, 'packages', 'mcp', 'server.js').replace(/\\/g, '\\\\')
  const uiBundle = join(PKG_ROOT, 'packages', 'ui')
  const nodeBin = process.execPath.replace(/\\/g, '\\\\')

  console.log('')
  console.log('============================================================')
  console.log(' DSH 集成配置（把下面信息填到 DeepSeek Harness）')
  console.log('============================================================')
  console.log('')
  console.log(' 1) MCP 连接器 —— 新增一个 stdio 连接：')
  console.log(`    命令       : ${nodeBin}`)
  console.log(`    参数       : ${mcpServer}`)
  console.log('    连接后会出现 4 个工具：')
  console.log('      mcp__screenpower__screenpower_status')
  console.log('      mcp__screenpower__screenpower_blackout')
  console.log('      mcp__screenpower__screenpower_wake')
  console.log('      mcp__screenpower__screenpower_modes')
  console.log('')
  console.log(' 2) UI 插件 —— 作为本地 bundle 安装：')
  console.log(`    目录       : ${uiBundle}`)
  console.log('    安装后左侧栏出现「快捷黑屏」入口。')
  console.log('')
  if (runtimeDir) {
    console.log(` 原生工具目录 : ${runtimeDir}`)
    if (isDefaultDir) {
      console.log(' 该目录为默认位置，MCP/UI 会自动识别，无需设置 SCREENPOWER_HOME。')
    } else {
      console.log(' 这是自定义目录，请设置用户环境变量 SCREENPOWER_HOME 指向它，')
      console.log(' 否则 screenpower_status 可能提示未安装或读不到状态。')
    }
  }
  console.log('============================================================')
}

function main() {
  if (process.platform !== 'win32') {
    fail('本工具仅支持 Windows（当前平台：' + process.platform + '）。')
    return
  }

  if (!existsSync(VENDOR_DIR)) {
    fail(`找不到随包附带的原生工具目录：${VENDOR_DIR}`)
    return
  }

  const programData = process.env.ProgramData || 'C:\\ProgramData'
  const defaultRuntimeDir = join(programData, 'ScreenPower')
  const customDir = args['install-dir'] ? resolve(String(args['install-dir'])) : null
  const runtimeDir = customDir || defaultRuntimeDir

  if (!args['skip-native']) {
    // Staging dir must be writable without elevation; install.ps1 elevates and
    // copies from here into runtimeDir. Keep it separate from runtimeDir.
    const localAppData = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Local')
    const stagingDir = join(localAppData, 'ScreenPower')

    mkdirSync(stagingDir, { recursive: true })
    for (const name of VENDOR_FILES) {
      const src = join(VENDOR_DIR, name)
      if (!existsSync(src)) {
        fail(`缺少文件：${src}`)
        return
      }
      copyFileSync(src, join(stagingDir, name))
    }
    console.log(`[screenpower] 已暂存安装源到：${stagingDir}`)

    const installPs1 = join(stagingDir, 'install.ps1')
    const psArgs = ['-ExecutionPolicy', 'Bypass', '-File', installPs1, '-InstallDir', runtimeDir]
    if (args.wake) psArgs.push('-WakeTime', String(args.wake))
    if (args.sleep !== undefined) psArgs.push('-SleepTime', String(args.sleep))

    console.log('[screenpower] 正在运行 install.ps1（若弹出 UAC 请允许；需要管理员权限）…')
    const result = spawnSync('powershell', psArgs, { stdio: 'inherit', windowsHide: true })
    if (result.error) {
      console.error(`[screenpower] 无法启动 PowerShell：${result.error.message}`)
      process.exitCode = 1
    } else if (result.status !== 0) {
      console.error(`[screenpower] install.ps1 返回码 ${result.status}。请检查是否已用管理员身份运行。`)
      process.exitCode = 1
    } else {
      console.log(`[screenpower] 原生工具安装完成，运行目录：${runtimeDir}`)
    }
  } else {
    console.log('[screenpower] 已跳过原生工具安装（--skip-native）。')
  }

  printDshWiring(runtimeDir, customDir === null)
}

main()
