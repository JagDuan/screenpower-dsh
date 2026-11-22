/**
 * ScreenPower MCP server.
 *
 * Exposes the Windows blackout helper as MCP tools so the agent can turn the
 * screen off, bring it back, or inspect the current state. The server speaks
 * newline-delimited JSON-RPC over stdio, which is what `dsh-mcp-client`
 * expects for `transport: stdio`.
 *
 * @module
 */

import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

import {
  BLACKOUT_MODES,
  describeCommand,
  findExecutable,
  normalizeTime,
  readState,
  runCli,
} from '../../shared/screenpower-core.js'

const server = new McpServer(
  { name: 'screenpower', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

/**
 * Render a tool result with plain text content.
 *
 * @param {string} text
 * @returns {{ content: Array<{ type: 'text', text: string }> }}
 */
function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

/**
 * Render a tool result whose payload is JSON.
 *
 * @param {unknown} payload
 * @returns {{ content: Array<{ type: 'text', text: string }>, structuredContent: Record<string, unknown> }}
 */
function jsonResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  }
}

server.registerTool(
  'screenpower_status',
  {
    title: 'Blackout status',
    description:
      'Report whether the screen is currently blacked out, when it will wake up automatically, and where the ScreenPower state file lives. Use this before turning the screen off to confirm the current state.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const executable = findExecutable()
    if (!executable) {
      return server.createToolError(
        'ScreenPower 未安装。Windows 用户请先运行 install.ps1 安装，或设置 SCREENPOWER_HOME 指向安装目录。',
      )
    }
    const state = await readState()
    return jsonResult({ installed: true, executable, ...state })
  },
)

server.registerTool(
  'screenpower_blackout',
  {
    title: 'Turn the screen off',
    description:
      'Black out the screen while the computer keeps running. Pass an "until" wall-clock time (HH:mm) to wake up automatically at that time; omit it to wake only on a key press or mouse click. Wakes on any key press because the helper listens for input while the panel is powered down.',
    inputSchema: {
      until: z
        .string()
        .optional()
        .describe('Optional wall-clock wake time in HH:mm form, for example 07:00. Omit for manual wake.'),
    },
    annotations: { destructiveHint: false },
  },
  async ({ until } = {}) => {
    const time = until ? normalizeTime(until) : null
    if (until && !time) {
      return server.createToolError(`无法识别时间 "${until}"，请使用 HH:mm 格式，例如 07:00。`)
    }
    const { args, summary } = describeCommand('off', time ?? undefined)
    const result = await runCli(args)
    if (!result.ok) return server.createToolError(result.message)
    const state = await readState()
    return jsonResult({ ok: true, action: summary, ...state })
  },
)

server.registerTool(
  'screenpower_wake',
  {
    title: 'Turn the screen back on',
    description:
      'Restore the screen and the original power settings immediately, ending an active blackout.',
    inputSchema: {},
    annotations: {},
  },
  async () => {
    const { args, summary } = describeCommand('on')
    const result = await runCli(args)
    if (!result.ok) return server.createToolError(result.message)
    const state = await readState()
    return jsonResult({ ok: true, action: summary, ...state })
  },
)

server.registerTool(
  'screenpower_modes',
  {
    title: 'List blackout modes',
    description:
      'List the available blackout modes and their configuration options, so the user can pick one in a conversation.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => jsonResult({ modes: BLACKOUT_MODES }),
)

await server.connect(new StdioServerTransport())
