/**
 * Client half of the ScreenPower UI bundle.
 *
 * The panel renders the blackout modes and their configuration and drives the
 * Host half through a loopback HTTP bridge. Every visible string goes through
 * the `screenpower` locale namespace so the panel follows the app language.
 *
 * @module
 */

const PANEL_ID = 'screenpower'
const LOCALE_NS = 'screenpower'

/**
 * Mode identities. Titles and descriptions are NOT stored here: they come from
 * the locale keys `mode<Id>` / `mode<Id>Desc` so non-Chinese users never see
 * hardcoded Chinese text.
 *
 * @type {ReadonlyArray<{ id: string, needsUntil: boolean, defaultUntil?: string }>}
 */
const MODES = Object.freeze([
  { id: 'until', needsUntil: true, defaultUntil: '07:00' },
  { id: 'manual', needsUntil: false },
  { id: 'sleeptimer', needsUntil: false },
])

/** All locale keys used by the panel, in Chinese (also the runtime fallback). */
const ZH = Object.freeze({
  title: '快捷黑屏',
  subtitle: '电脑继续运行，屏幕可以单独熄灭。',
  modes: '黑屏方式',
  wakeTime: '自动亮屏时间',
  wakeTimeHint: '24 小时制，00:00–23:59，例如 07:00。',
  wakeTimeInvalid: '请输入有效的 HH:mm 时间（00:00–23:59），例如 07:00。',
  applyUntil: '开始定时黑屏',
  applyManual: '开始手动黑屏',
  applySleeptimer: '开启睡眠保护',
  wake: '立即亮屏',
  refresh: '刷新状态',
  refreshConnection: '刷新连接',
  refreshing: '连接中…',
  startService: '启动服务',
  startingService: '启动中…',
  serviceStarted: 'ScreenPower 服务已启动。',
  serviceAlreadyRunning: 'ScreenPower 服务已在运行。',
  cancel: '取消',
  confirmApply: '确认继续',
  confirmHint: '这会立即熄灭屏幕，电脑仍会继续运行。按任意键或点击鼠标即可唤醒。',
  confirmSleepHint: '这将阻止电脑进入睡眠或休眠，屏幕会保持正常。',
  wakeHint: '提示：黑屏后按任意键或点击鼠标即可唤醒。',
  status: '当前状态',
  statusIdle: '屏幕正常，未处于黑屏状态。',
  statusOff: '屏幕已黑屏，等待按键或点击唤醒。',
  statusScheduled: '屏幕已黑屏，将于 {time} 自动亮屏；按键可提前唤醒。',
  statusUntilUnknown: '屏幕已黑屏，等待按键或点击唤醒。',
  notInstalled: '未检测到 ScreenPower。请先运行 install.ps1 安装后再试。',
  notConnected: '无法连接本机 ScreenPower 服务，请稍后刷新重试。',
  busy: '处理中…',
  failed: '操作失败，请查看 ScreenPower 日志。',
  runFailed: 'ScreenPower 执行失败：{message}',
  connected: '服务已连接',
  disconnected: '服务未连接',
  notInstalledShort: '未安装',
  modeUntil: '定时黑屏',
  modeManual: '手动黑屏',
  modeSleeptimer: '仅防休眠',
  modeUntilDesc: '立刻黑屏，到设定时间自动亮屏；按任意键可提前唤醒。',
  modeManualDesc: '立刻黑屏并保持，直到你按任意键或点击鼠标才亮屏。',
  modeSleeptimerDesc: '屏幕保持正常，只阻止电脑进入睡眠或休眠。',
  panelLabel: '快捷黑屏',
})

/** English copy, same keys as ZH. */
const EN = Object.freeze({
  title: 'Quick blackout',
  subtitle: 'The computer keeps running while the screen can go dark on its own.',
  modes: 'Blackout mode',
  wakeTime: 'Automatic wake time',
  wakeTimeHint: '24-hour clock, 00:00–23:59, for example 07:00.',
  wakeTimeInvalid: 'Enter a valid HH:mm time (00:00–23:59), for example 07:00.',
  applyUntil: 'Start scheduled blackout',
  applyManual: 'Start manual blackout',
  applySleeptimer: 'Enable sleep guard',
  wake: 'Turn screen on',
  refresh: 'Refresh status',
  refreshConnection: 'Reconnect',
  refreshing: 'Connecting…',
  startService: 'Start service',
  startingService: 'Starting…',
  serviceStarted: 'The ScreenPower service has started.',
  serviceAlreadyRunning: 'The ScreenPower service is already running.',
  cancel: 'Cancel',
  confirmApply: 'Confirm',
  confirmHint: 'This will blank the screen immediately while the computer keeps running. Press any key or click to wake it.',
  confirmSleepHint: 'This keeps the computer awake without touching the screen.',
  wakeHint: 'Tip: after blackout, press any key or click to wake the screen.',
  status: 'Status',
  statusIdle: 'The screen is normal; no blackout is active.',
  statusOff: 'The screen is blanked until a key press or a click.',
  statusScheduled: 'The screen is blanked and wakes automatically at {time}; press a key to wake sooner.',
  statusUntilUnknown: 'The screen is blanked until a key press or a click.',
  notInstalled: 'ScreenPower was not found. Run install.ps1 first.',
  notConnected: 'Cannot reach the local ScreenPower service. Refresh to retry.',
  busy: 'Working…',
  failed: 'Operation failed. Check the ScreenPower log.',
  runFailed: 'ScreenPower failed: {message}',
  connected: 'Service connected',
  disconnected: 'Service disconnected',
  notInstalledShort: 'Not installed',
  modeUntil: 'Scheduled blackout',
  modeManual: 'Manual blackout',
  modeSleeptimer: 'Sleep guard only',
  modeUntilDesc: 'Blank the screen now and wake it automatically at the chosen time; a key press wakes it sooner.',
  modeManualDesc: 'Blank the screen now and keep it dark until you press a key or click.',
  modeSleeptimerDesc: 'Keep the screen normal and only stop the computer from sleeping.',
  panelLabel: 'Quick blackout',
})

/** Stable bridge port range, mirrored from the Host half. */
const BRIDGE_PORT = 18765

/** Route the Host half serves on the Harness web server, same origin as this page. */
const WEB_ROUTE_PATH = '/plugins/screenpower'

/**
 * Strict HH:mm parser mirroring the Host half's `normalizeTime` ranges.
 * Accepts ':' '：' '.' as separators but validates 00:00-23:59.
 *
 * @param {string} value
 * @returns {string | null} Normalized 'HH:mm' or null.
 */
function normalizeUntil(value) {
  const text = String(value ?? '').trim()
  const match = /^(\d{1,2})\s*[:：.]\s*(\d{1,2})$/.exec(text)
  if (!match) return null
  const hours = Number.parseInt(match[1], 10)
  const minutes = Number.parseInt(match[2], 10)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

window.__ModuleLoader__.load({
  id: 'screenpower-dsh-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Resolve a locale key, falling back to the bundled Chinese copy. */
    function makeTranslate(t) {
      return (key, params) => {
        try {
          const value = t(key, params)
          if (typeof value === 'string' && value !== key && value.length > 0) return value
        } catch {
          /* fall through to bundle copy */
        }
        const fallback = ZH[key]
        if (typeof fallback !== 'string') return key
        if (!params) return fallback
        return fallback.replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? ''))
      }
    }

    /** Discover and call the Host bridge. */
    function createBridge() {
      const candidates = []
      // The Harness web server route first: it lives on this page's own
      // origin, so the request is same-origin and cannot fail on CORS, on a
      // Private Network Access prompt, or on a stale loopback port.
      candidates.push(WEB_ROUTE_PATH)
      const boot = typeof window !== 'undefined' ? window.__DSH_BOOT__ : undefined
      const bootEndpoint = boot && typeof boot === 'object' ? boot.screenpowerBridge : undefined
      if (typeof bootEndpoint === 'string') candidates.push(bootEndpoint)
      for (let port = BRIDGE_PORT; port <= BRIDGE_PORT + 4; port += 1) {
        candidates.push(`http://127.0.0.1:${port}`)
      }

      let resolved = null

      async function probe(origin) {
        try {
          const response = await fetch(origin, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'status' }),
          })
          if (!response.ok) return false
          const payload = await response.json()
          return Boolean(payload && typeof payload === 'object' && 'ok' in payload)
        } catch {
          return false
        }
      }

      async function resolve() {
        if (resolved !== null) return resolved
        for (const candidate of candidates) {
          if (await probe(candidate)) {
            resolved = candidate
            return resolved
          }
        }
        return null
      }

      /**
       * @param {string} action
       * @param {{ until?: string }} [payload]
       * @returns {Promise<{ ok: boolean, code: string, detail: string, state: object | null }>}
       */
      async function call(action, payload = {}) {
        const origin = await resolve()
        if (origin === null) return { ok: false, code: 'NOT_CONNECTED', detail: '', state: null }
        try {
          const response = await fetch(origin, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, ...payload }),
          })
          const result = await response.json()
          return {
            ok: Boolean(result && result.ok),
            code: String(result?.code ?? (result?.ok ? 'OK' : 'FAILED')),
            detail: String(result?.detail ?? ''),
            state: result && result.state ? result.state : null,
          }
        } catch (error) {
          resolved = null
          return {
            ok: false,
            code: 'BRIDGE_ERROR',
            detail: String(error?.message ?? error),
            state: null,
          }
        }
      }

      /** Forget the cached origin so the next call probes every candidate again. */
      function reset() {
        resolved = null
      }

      return { call, resolve, reset }
    }

    const bridge = createBridge()

    /** Theme-token-only styles. Literal colors appear only in artwork, not here. */
    const PANEL_CSS = `
.sp-panel {
  display: flex; flex-direction: column; gap: 20px; padding: 24px; max-width: 720px;
  color: var(--dsw-alias-label-primary, inherit);
}
.sp-panel__header { display: flex; flex-direction: column; gap: 6px; }
.sp-panel__title {
  margin: 0; font-size: 20px; font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
}
.sp-panel__subtitle {
  margin: 0; font-size: 13px; color: var(--dsw-alias-label-secondary, inherit);
}
.sp-panel__body { display: flex; flex-direction: column; gap: 20px; }
.sp-field { display: flex; flex-direction: column; gap: 8px; }
.sp-field__label { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-secondary, inherit); }
.sp-modes { display: flex; flex-direction: column; gap: 8px; }
.sp-mode {
  display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; text-align: left;
  border: 1px solid var(--dsw-alias-border-l1, currentColor); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit); cursor: pointer;
}
.sp-mode:hover { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.sp-mode--active { border-color: var(--dsw-alias-brand-primary, currentColor); }
.sp-mode__title { font-size: 14px; font-weight: 600; }
.sp-mode__desc { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
.sp-input {
  padding: 8px 10px; font-size: 14px; color: var(--dsw-alias-label-primary, inherit);
  border: 1px solid var(--dsw-alias-border-l1, currentColor); border-radius: 8px;
  background: var(--dsw-alias-bg-base, transparent);
}
.sp-field__hint { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
.sp-field__hint--error { color: var(--dsw-alias-state-error-primary, currentColor); }
.sp-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.sp-button {
  padding: 8px 14px; font-size: 13px; cursor: pointer; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}
.sp-button:hover { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.sp-button:disabled { opacity: 0.6; cursor: default; }
.sp-button--primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, currentColor);
  color: var(--dsw-alias-brand-text, inherit);
}
.sp-button--quiet { background: transparent; }
.sp-confirm {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 10px 12px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-state-warn-primary, currentColor);
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.sp-confirm__text { flex: 1 1 220px; font-size: 13px; color: var(--dsw-alias-label-primary, inherit); }
.sp-hint { margin: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary, inherit); }
.sp-status { display: flex; flex-direction: column; gap: 4px; }
.sp-status__top { display: flex; align-items: center; gap: 8px; }
.sp-status__label { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
.sp-badge {
  padding: 1px 8px; font-size: 11px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  color: var(--dsw-alias-label-secondary, inherit);
}
.sp-badge--error { color: var(--dsw-alias-state-error-primary, currentColor); }
.sp-status__reconnect { padding: 2px 8px; font-size: 11px; margin-left: auto; }
.sp-status__start { padding: 2px 8px; font-size: 11px; }
.sp-status__value { font-size: 13px; color: var(--dsw-alias-label-primary, inherit); }
.sp-status__value--error { color: var(--dsw-alias-state-error-primary, currentColor); }
.sp-mode:focus-visible, .sp-button:focus-visible, .sp-input:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, currentColor);
  outline-offset: 2px;
}
`

    /** Blackout panel. */
    function ScreenPowerPanel(props) {
      const t = useMemo(() => makeTranslate(props.t), [props.t])
      const [mode, setMode] = useState('until')
      const [until, setUntil] = useState('07:00')
      const [status, setStatus] = useState(null)
      const [message, setMessage] = useState('')
      const [failed, setFailed] = useState(false)
      const [connected, setConnected] = useState(false)
      const [busy, setBusy] = useState(false)
      const [reconnecting, setReconnecting] = useState(false)
      const [startingService, setStartingService] = useState(false)
      const [confirming, setConfirming] = useState(false)
      const mounted = useRef(true)
      const modeRefs = useRef({})

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      const refresh = useCallback(
        async (force = false) => {
          if (force) bridge.reset()
          const result = await bridge.call('status')
          if (!mounted.current) return
          setConnected(result.code !== 'NOT_CONNECTED' && result.code !== 'BRIDGE_ERROR')
          if (!result.ok) {
            setFailed(true)
            setStatus(null)
            setMessage(result.code === 'NOT_INSTALLED' ? t('notInstalled') : t('notConnected'))
            return
          }
          setFailed(false)
          setMessage('')
          if (result.state) {
            setStatus(result.state)
            const nextMode =
              result.state.mode === 'scheduled' ? 'until' : result.state.mode === 'off' ? 'manual' : null
            if (nextMode !== null) setMode(nextMode)
            if (typeof result.state.until === 'string' && result.state.until.length > 0) {
              setUntil(result.state.until)
            }
          }
        },
        [t],
      )

      /** Force a full bridge re-probe, used by the status-area reconnect button. */
      const reconnect = useCallback(async () => {
        setReconnecting(true)
        await refresh(true)
        if (mounted.current) setReconnecting(false)
      }, [refresh])

      // Initial load.
      useEffect(() => {
        void refresh()
      }, [refresh])

      // Auto-retry while disconnected. A DSH host restart tears down the local
      // HTTP bridge and the page keeps running against the dead origin; without
      // this the panel sticks on "cannot connect" until the user reloads. Once
      // the bridge comes back (possibly on a different port), resolve() reprobes
      // every candidate, connected flips true, and this timer stops itself.
      useEffect(() => {
        if (connected) return undefined
        const timer = setInterval(() => {
          if (mounted.current) void refresh()
        }, 5000)
        return () => clearInterval(timer)
      }, [connected, refresh])

      /** Map a Host result code to a localized message; success has no message. */
      const describeFailure = useCallback(
        (result) => {
          switch (result.code) {
            case 'NOT_INSTALLED':
              return t('notInstalled')
            case 'INVALID_TIME':
              return t('wakeTimeInvalid')
            case 'CLI_FAILED':
              return t('runFailed', { message: result.detail })
            case 'NOT_CONNECTED':
            case 'BRIDGE_ERROR':
              return t('notConnected')
            case 'SERVICE_ALREADY_RUNNING':
              return t('serviceAlreadyRunning')
            default:
              return t('failed')
          }
        },
        [t],
      )

      /**
       * Start the ScreenPower guard service.
       *
       * The Host runs the guard as a detached process, so this returns as soon
       * as the process is up. A short settle delay lets the guard write its
       * pid file before the panel asks for the status again.
       */
      const startService = useCallback(async () => {
        setStartingService(true)
        const result = await bridge.call('start-service', {})
        if (!mounted.current) return
        setStartingService(false)
        if (!result.ok) {
          setFailed(true)
          setMessage(describeFailure(result))
          return
        }
        setFailed(false)
        setMessage(
          result.code === 'SERVICE_ALREADY_RUNNING'
            ? t('serviceAlreadyRunning')
            : t('serviceStarted'),
        )
        await new Promise((resolve) => setTimeout(resolve, 400))
        await refresh(true)
      }, [refresh, describeFailure, t])

      const run = useCallback(
        async (action, payload = {}) => {
          setBusy(true)
          setFailed(false)
          setMessage('')
          const result = await bridge.call(action, payload)
          if (!mounted.current) return
          setBusy(false)
          setConnected(result.code !== 'NOT_CONNECTED' && result.code !== 'BRIDGE_ERROR')
          if (!result.ok) {
            setFailed(true)
            setMessage(describeFailure(result))
          } else if (result.state) {
            setStatus(result.state)
          }
          setConfirming(false)
        },
        [describeFailure],
      )

      /** Route the selected mode to the correct Host action. */
      const applyMode = useCallback(() => {
        if (mode === 'sleeptimer') {
          void run('sleep-guard', {})
        } else if (mode === 'manual') {
          void run('blackout', { until: '' })
        } else {
          void run('blackout', { until: normalizeUntil(until) ?? until })
        }
      }, [mode, until, run])

      const onModeKeyDown = useCallback(
        (event) => {
          const index = MODES.findIndex((item) => item.id === mode)
          let next = index
          switch (event.key) {
            case 'ArrowDown':
            case 'ArrowRight':
              next = (index + 1) % MODES.length
              break
            case 'ArrowUp':
            case 'ArrowLeft':
              next = (index - 1 + MODES.length) % MODES.length
              break
            case 'Home':
              next = 0
              break
            case 'End':
              next = MODES.length - 1
              break
            default:
              return
          }
          event.preventDefault()
          const nextId = MODES[next].id
          setMode(nextId)
          setConfirming(false)
          const node = modeRefs.current[nextId]
          if (node && typeof node.focus === 'function') node.focus()
        },
        [mode],
      )

      const selected = MODES.find((item) => item.id === mode) ?? MODES[0]
      const normalizedUntil = normalizeUntil(until)
      const untilInvalid = selected.needsUntil && normalizedUntil === null
      const cap = (id) => id.charAt(0).toUpperCase() + id.slice(1)

      const statusText = useMemo(() => {
        if (!status) return ''
        const stateMode = String(status.mode ?? '')
        if (stateMode === 'scheduled') {
          const time = String(status.until ?? '')
          return time ? t('statusScheduled', { time }) : t('statusUntilUnknown')
        }
        if (stateMode === 'off') return t('statusOff')
        return t('statusIdle')
      }, [status, t])

      const badgeLabel = !connected ? t('disconnected') : status && status.installed === false ? t('notInstalledShort') : t('connected')

      return h(
        'section',
        { className: 'sp-panel', 'data-screenpower-panel': 'true' },
        h(
          'header',
          { className: 'sp-panel__header' },
          h('h2', { className: 'sp-panel__title' }, t('title')),
          h('p', { className: 'sp-panel__subtitle' }, t('subtitle')),
        ),
        h(
          'div',
          { className: 'sp-panel__body' },
          h(
            'div',
            { className: 'sp-field' },
            h('span', { className: 'sp-field__label' }, t('modes')),
            h(
              'div',
              {
                className: 'sp-modes',
                role: 'radiogroup',
                'aria-label': t('modes'),
                onKeyDown: onModeKeyDown,
              },
              MODES.map((item) =>
                h(
                  'button',
                  {
                    key: item.id,
                    ref: (node) => {
                      modeRefs.current[item.id] = node
                    },
                    type: 'button',
                    role: 'radio',
                    tabIndex: item.id === mode ? 0 : -1,
                    'aria-checked': item.id === mode ? 'true' : 'false',
                    className: item.id === mode ? 'sp-mode sp-mode--active' : 'sp-mode',
                    onClick: () => {
                      setMode(item.id)
                      setConfirming(false)
                    },
                  },
                  h('span', { className: 'sp-mode__title' }, t(`mode${cap(item.id)}`)),
                  h('span', { className: 'sp-mode__desc' }, t(`mode${cap(item.id)}Desc`)),
                ),
              ),
            ),
          ),
          selected.needsUntil
            ? h(
                'div',
                { className: 'sp-field' },
                h('label', { className: 'sp-field__label', htmlFor: 'sp-until' }, t('wakeTime')),
                h('input', {
                  id: 'sp-until',
                  className: 'sp-input',
                  type: 'text',
                  inputMode: 'numeric',
                  placeholder: '07:00',
                  value: until,
                  onChange: (event) => {
                    setUntil(event.target.value)
                    setConfirming(false)
                  },
                }),
                h(
                  'p',
                  { className: untilInvalid ? 'sp-field__hint sp-field__hint--error' : 'sp-field__hint' },
                  untilInvalid ? t('wakeTimeInvalid') : t('wakeTimeHint'),
                ),
              )
            : null,
          confirming
            ? h(
                'div',
                { className: 'sp-confirm' },
                h(
                  'span',
                  { className: 'sp-confirm__text' },
                  mode === 'sleeptimer' ? t('confirmSleepHint') : t('confirmHint'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'sp-button sp-button--primary',
                    disabled: busy || untilInvalid,
                    onClick: applyMode,
                  },
                  busy ? t('busy') : t('confirmApply'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'sp-button sp-button--quiet',
                    disabled: busy,
                    onClick: () => setConfirming(false),
                  },
                  t('cancel'),
                ),
              )
            : h(
                'div',
                { className: 'sp-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'sp-button sp-button--primary',
                    disabled: busy || untilInvalid,
                    onClick: () => setConfirming(true),
                  },
                  t(`apply${cap(mode)}`),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'sp-button',
                    disabled: busy,
                    onClick: () => void run('wake', {}),
                  },
                  t('wake'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'sp-button sp-button--quiet',
                    disabled: busy,
                    onClick: () => void refresh(),
                  },
                  t('refresh'),
                ),
              ),
          mode === 'sleeptimer' ? null : h('p', { className: 'sp-hint' }, t('wakeHint')),
          h(
            'div',
            { className: 'sp-status' },
            h(
              'div',
              { className: 'sp-status__top' },
              h('span', { className: 'sp-status__label' }, t('status')),
              h(
                'span',
                {
                  className:
                    !connected || (status && status.installed === false)
                      ? 'sp-badge sp-badge--error'
                      : 'sp-badge',
                },
                badgeLabel,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sp-button sp-button--quiet sp-status__reconnect',
                  disabled: reconnecting,
                  title: t('refreshConnection'),
                  onClick: () => void reconnect(),
                },
                reconnecting ? t('refreshing') : t('refreshConnection'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sp-button sp-button--quiet sp-status__start',
                  disabled: startingService || busy,
                  title: t('startService'),
                  onClick: () => void startService(),
                },
                startingService ? t('startingService') : t('startService'),
              ),
            ),
            h(
              'span',
              { className: failed ? 'sp-status__value sp-status__value--error' : 'sp-status__value' },
              message.length > 0 ? message : statusText,
            ),
          ),
        ),
      )
    }

    /** Sidebar icon. */
    function ScreenPowerIcon() {
      return h(
        'svg',
        {
          width: 18,
          height: 18,
          viewBox: '0 0 36 36',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', { x: 5, y: 9, width: 26, height: 18, rx: 3, fill: 'currentColor', opacity: 0.18 }),
        h('rect', { x: 5, y: 9, width: 26, height: 18, rx: 3, stroke: 'currentColor', strokeWidth: 2 }),
        h('path', { d: 'M12 4 L12 9 M24 4 L24 9', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
        h('path', {
          d: 'M13 18 L16.5 21.5 L23 14.5',
          stroke: 'currentColor',
          strokeWidth: 2.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const dictionaries = { zh: ZH, en: EN }
        for (const locale of ['ja', 'es', 'fr', 'de', 'ru', 'pt']) dictionaries[locale] = {}
        ctx.locale.register(LOCALE_NS, dictionaries)
        const t = ctx.locale.bind(LOCALE_NS)

        // Inject the stylesheet at materialization time. The Client module
        // system claims newly added, untagged <style> tags for this plugin and
        // removes them on dispose/rebuild (see dsh-client-modules system.ts).
        if (typeof document !== 'undefined') {
          const styleEl = document.createElement('style')
          styleEl.setAttribute('data-plugin', 'screenpower-dsh-ui')
          styleEl.textContent = PANEL_CSS
          document.head.append(styleEl)
        }

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              locale: LOCALE_NS,
              label: () => t('panelLabel'),
            },
            ScreenPowerIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: LOCALE_NS }, ScreenPowerPanel),
        )
      },
    }
  },
})
