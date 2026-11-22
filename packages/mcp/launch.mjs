/**
 * Launcher for the ScreenPower MCP server.
 *
 * `dsh-mcp-client` spawns stdio servers with the literal strings from its
 * config, so the server entry has to be a concrete path on this machine.
 * This launcher resolves its own directory at runtime and hands control to
 * `server.js`, which keeps the bundle installable from any location without
 * a machine-specific absolute path in the Cordis patch.
 *
 * @module
 */

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Windows absolute paths must become file:// URLs before `import()` accepts them.
await import(pathToFileURL(join(here, 'server.js')).href)
