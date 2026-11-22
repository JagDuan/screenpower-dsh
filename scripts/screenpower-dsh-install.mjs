#!/usr/bin/env node
/**
 * `screenpower-dsh-install` — thin npm bin wrapper around scripts/install.mjs.
 *
 * Installs the native Windows helper (ScreenPower.exe + scheduled tasks +
 * desktop shortcuts). Needs Administrator; it will ask for UAC.
 *
 * Usage:
 *   screenpower-dsh-install
 *   screenpower-dsh-install --wake 06:30 --sleep 00:30
 *   screenpower-dsh-install --install-dir D:\Tools\ScreenPower
 *   screenpower-dsh-install --skip-native
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALLER = resolve(HERE, 'install.mjs')

const result = spawnSync(process.execPath, [INSTALLER, ...process.argv.slice(2)], {
  stdio: 'inherit',
})

if (result.error) {
  console.error('[screenpower-dsh] failed to start installer:', result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 0)
