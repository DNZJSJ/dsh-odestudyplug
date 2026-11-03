/**
 * dsh-ode-lab — host half.
 *
 * The panel lives in the browser (see client.js). This half is the bridge the
 * conversation can see:
 *
 *   panel --POST /ode-lab/state-->   last snapshot of what the user is looking at
 *   panel <--GET /ode-lab/command--  queued "do this in the panel" commands
 *
 * On top of that it registers agent tools:
 *   ode_lab_snapshot  read the panel (equations, initial state, horizon, whether
 *                     the solution diverged, value ranges)
 *   ode_lab_set       drive the panel (replace equations / initial state / horizon /
 *                     view), so a teaching answer can *show* the case it describes
 *   ode_lab_presets   list the built-in systems
 *
 * Everything is defensive: a host half that throws fails its Loader entry, and a
 * failed entry in the web boot manifest takes the whole window down with it.
 */

// '@deepseek-ai/dsh-tools' lives in the host runtime, not in this package, and
// a linked (file:) install cannot always resolve it. Load it lazily: a missing
// tools package must degrade to "no agent tools", never to a failed entry —
// a failed entry in the web boot manifest takes the whole window down.
let defineToolPromise = null
function loadDefineTool() {
  if (!defineToolPromise) {
    defineToolPromise = import('@deepseek-ai/dsh-tools')
      .then((mod) => (mod && typeof mod.defineTool === 'function' ? mod.defineTool : null))
      .catch(() => null)
  }
  return defineToolPromise
}

// Declaring the services here makes the Loader apply() us only once they are
// ACTIVE. Both are required: `ctx.tools` throws "cannot get property ... without
// inject" when the entry did not declare it, and probing at apply-time is not
// enough because services come up asynchronously.
export const inject = ['webServer', 'tools']

const ROUTE = '/ode-lab'
const STATE_PATH = ROUTE + '/state'
const COMMAND_PATH = ROUTE + '/command'
const MAX_BODY = 128 * 1024
const MAX_COMMANDS = 32
const LIVE_MS = 8000
const COMMAND_TTL_MS = 5 * 60 * 1000

const PRESETS = [
  { id: 'lorenz', title: '洛伦兹吸引子', system: 's = 10\nr = 28\nb = 8/3\n\ndx/dt = s*(y - x)\ndy/dt = x*(r - z) - y\ndz/dt = x*y - b*z' },
  { id: 'rossler', title: '罗斯勒吸引子', system: 'a = 0.2\nb = 0.2\nc = 5.7\n\ndx/dt = -(y + z)\ndy/dt = x + a*y\ndz/dt = b + z*(x - c)' },
  { id: 'lotka', title: '洛特卡–沃尔泰拉', system: 'alpha = 1.1\nbeta = 0.4\ngamma = 0.4\ndelta = 0.1\n\ndx/dt = alpha*x - beta*x*y\ndy/dt = delta*x*y - gamma*y' },
  { id: 'pendulum', title: '阻尼摆', system: 'k = 0.3\n\ndtheta/dt = omega\ndomega/dt = -k*omega - sin(theta)' },
  { id: 'oscillator', title: '谐振子', system: 'k = 1\nc = 0\n\ndx/dt = y\ndy/dt = -k*x - c*y' },
  { id: 'vanDerPol', title: '范德波尔振子', system: 'mu = 1.5\n\ndx/dt = y\ndy/dt = mu*(1 - x*x)*y - x' },
]

function log(ctx, level, message) {
  const text = '[dsh-ode-lab] ' + message
  try {
    if (ctx && ctx.logger && typeof ctx.logger[level] === 'function') ctx.logger[level](text)
    else console[level === 'error' ? 'error' : 'log'](text)
  } catch (err) { /* logging must never be the thing that breaks the plugin */ }
}

function isLoopback(req) {
  const address = String((req.socket && req.socket.remoteAddress) || '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === ''
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        try { req.destroy() } catch (err) { /* noop */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function formatState(state, live) {
  if (!state) {
    return '微分方程演化面板当前没有打开。请用户先在左侧栏点「微分方程演化」，面板打开后会自动同步状态；也可以用 ode_lab_set 推一组方程过去，等面板打开后生效。'
  }
  const lines = []
  if (!live) {
    const age = Math.max(0, Math.round((Date.now() - Number(state.at || 0)) / 1000))
    lines.push('注意：面板现在没有打开，下面是它 ' + age + ' 秒前的样子，可能已经不是你眼前的画面。')
    lines.push('')
  }
  lines.push('面板当前状态（' + new Date(state.at).toLocaleTimeString('zh-CN') + ' 同步' + (live ? '，面板正在前台' : '') + '）：')
  lines.push('')
  lines.push('方程组：')
  lines.push(String(state.equations || '').trim())
  lines.push('')
  if (state.init) lines.push('初始状态：' + state.init)
  if (state.vars && state.vars.length) lines.push('状态变量：' + state.vars.join(', ') + '（' + state.vars.length + ' 维）')
  if (state.independent) lines.push('自变量：' + state.independent)
  if (state.tMax != null) lines.push('积分跨度：' + (state.independent || 't') + ' ∈ [0, ' + state.tMax + ']')
  if (state.samples != null) lines.push('采样点：' + state.samples)
  if (state.mode) lines.push('视图：' + (state.mode === '3d' ? '三维相空间' : '二维相图'))
  if (state.error) {
    lines.push('')
    lines.push('⚠ 当前有报错：' + state.error)
  }
  if (state.diverged) {
    lines.push('')
    lines.push('⚠ 解已发散：轨迹在 ' + (state.independent || 't') + ' ≈ ' + state.stopAt + ' 处提前截断（解真的跑到无穷大，不是算错）。')
  }
  if (state.stats && state.stats.ranges) {
    lines.push('')
    lines.push('数值范围：')
    Object.keys(state.stats.ranges).forEach((name) => {
      const item = state.stats.ranges[name]
      lines.push('  ' + name + ' ∈ [' + item[0] + ', ' + item[1] + ']')
    })
  }
  if (state.stats && state.stats.points != null) {
    lines.push('')
    lines.push('记录点数：' + state.stats.points + (state.stats.ms != null ? '（积分耗时 ' + state.stats.ms + ' ms）' : ''))
  }
  return lines.join('\n')
}

function clampNumber(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}

export function apply(ctx) {
  const diag = {
    webServer: false,
    toolsService: false,
    injectCalled: false,
    injectFired: false,
    defineTool: 'pending',
    registered: [],
    errors: [],
    steps: [],
  }
  try {
    diag.steps.push('start')
    let state = null
    let seq = 0
    const commands = []

    const isLive = () => !!(state && Date.now() - Number(state.at || 0) < LIVE_MS)

    const pruneCommands = () => {
      const cutoff = Date.now() - COMMAND_TTL_MS
      while (commands.length && Number(commands[0].at || 0) < cutoff) commands.shift()
      while (commands.length > MAX_COMMANDS) commands.shift()
    }

    const pushCommand = (patch) => {
      seq += 1
      const entry = { seq, action: 'set', patch, at: Date.now() }
      commands.push(entry)
      pruneCommands()
      return entry
    }

    // ---- HTTP bridge -----------------------------------------------------
    let webServer = null
    try {
      webServer = (ctx && typeof ctx.get === 'function' && ctx.get('webServer')) || (ctx && ctx.webServer) || null
    } catch (err) {
      webServer = null
    }
    diag.webServer = !!(webServer && typeof webServer.register === 'function')
    if (webServer && typeof webServer.register === 'function') {
      try {
        ctx.effect(() => webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler(req, res) {
            try {
              if (!isLoopback(req)) {
                sendJson(res, 403, { error: 'loopback only' })
                return
              }
              const url = String(req.url || '')
              const path = url.split('?')[0]
              const query = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '')

              if (path === STATE_PATH && (req.method === 'POST' || req.method === 'PUT')) {
                readBody(req).then((text) => {
                  let payload
                  try {
                    payload = JSON.parse(text || '{}')
                  } catch (err) {
                    sendJson(res, 400, { error: 'invalid json' })
                    return
                  }
                  state = Object.assign({}, payload, { connected: true, at: Date.now() })
                  sendJson(res, 200, { ok: true })
                }).catch((err) => {
                  sendJson(res, 400, { error: String((err && err.message) || err) })
                })
                return
              }

              if (path === STATE_PATH && req.method === 'GET') {
                sendJson(res, 200, state || { connected: false })
                return
              }

              if (path === COMMAND_PATH && req.method === 'GET') {
                const since = Number(query.get('since') || 0) || 0
                pruneCommands()
                sendJson(res, 200, { seq, live: isLive(), commands: commands.filter((item) => item.seq > since) })
                return
              }

              if (path === COMMAND_PATH && req.method === 'POST') {
                // Test/debug door: pushes the same commands the tools push.
                readBody(req).then((text) => {
                  let payload
                  try {
                    payload = JSON.parse(text || '{}')
                  } catch (err) {
                    sendJson(res, 400, { error: 'invalid json' })
                    return
                  }
                  const entry = pushCommand(payload && typeof payload === 'object' ? payload : {})
                  sendJson(res, 200, { ok: true, command: entry })
                }).catch((err) => {
                  sendJson(res, 400, { error: String((err && err.message) || err) })
                })
                return
              }

              if (path === ROUTE + '/diag' && req.method === 'GET') {
                sendJson(res, 200, diag)
                return
              }

              sendJson(res, 404, { error: 'not found' })
            } catch (err) {
              try { sendJson(res, 500, { error: String((err && err.message) || err) }) } catch (e) { /* noop */ }
            }
          },
        }), 'dsh-ode-lab: /ode-lab routes')
      } catch (err) {
        log(ctx, 'error', 'failed to register the web bridge: ' + ((err && err.message) || err))
      }
    } else {
      log(ctx, 'error', 'no webServer service — the panel cannot sync its state')
    }

    diag.steps.push('bridge-ok')
    // ---- Agent tools -----------------------------------------------------
    const registerTools = () => {
      diag.injectFired = true
      const tools = ctx.tools
      diag.toolsService = !!(tools && typeof tools.register === 'function')
      if (!tools || typeof tools.register !== 'function') return
      loadDefineTool().then((defineTool) => {
        diag.defineTool = typeof defineTool
        if (typeof defineTool !== 'function') {
          diag.errors.push('defineTool unavailable')
          log(ctx, 'error', '@deepseek-ai/dsh-tools is unavailable — agent tools are skipped, the panel still works')
          return
        }

      try {
        diag.registered.push('ode_lab_snapshot')
        ctx.effect(() => tools.register(defineTool({
          name: 'ode_lab_snapshot',
          description: '读取「微分方程演化」面板此刻的内容：方程组原文、初始状态、自变量与积分跨度、视图模式、数值范围，以及解是否发散。' +
            '当用户提到「面板里这个」「现在这个系统」「我调的这个吸引子」，或者让你讲解/教学/分析他正在看的系统时，先用它把真实状态读回来，不要凭记忆猜参数。',
          parameters: {},
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: value.text }],
          },
          async execute() {
            const live = isLive()
            const text = formatState(state, live)
            return { connected: live, stale: !!state && !live, state: state || null, text }
          },
        })), 'dsh-ode-lab: ode_lab_snapshot')
      } catch (err) {
        log(ctx, 'error', 'failed to register ode_lab_snapshot: ' + ((err && err.message) || err))
      }

      try {
        diag.registered.push('ode_lab_set')
        ctx.effect(() => tools.register(defineTool({
          name: 'ode_lab_set',
          description: '把面板改成指定内容（用户在侧栏「微分方程演化」看到的那个面板）。可以只传要改的字段：equations 换方程组、init 换初始状态、tMax 换积分跨度、samples 换采样点、mode 切二维/三维、axes 选投影轴。' +
            '用于教学演示——比如「把 r 改成 99 给他看」「换成指数增长」——改完在回答里说明你改了什么即可，面板会在约 1.5 秒内自己更新。' +
            '只需要讲解、不需要动面板时不要调用它。',
          parameters: {
            equations: { type: 'string', description: '完整方程组文本（每行一个方程，参数行写在前面）。三种写法都认：dx/dt = ...、dy/dx = ...、y\' = ...' },
            init: { type: 'string', description: '初始状态，如 "x = 1, y = 0" 或 "1, 0"。换方程组时留空会自动对齐。' },
            tMax: { type: 'number', description: '积分跨度上限（自变量从 0 积到它）' },
            samples: { type: 'number', description: '采样点数，64..12000' },
            mode: { type: 'string', enum: ['2d', '3d'], description: '视图模式：二维相图 / 三维相空间' },
            axes: { type: 'array', description: '投影轴（状态变量下标），如 [0, 2] 用 vars[0] 当横轴、vars[2] 当纵轴', items: { type: 'number' } },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: value.text }],
          },
          async execute(args) {
            const patch = {}
            if (args && typeof args.equations === 'string' && args.equations.trim()) patch.equations = args.equations
            if (args && typeof args.init === 'string' && args.init.trim()) patch.init = args.init
            const tMax = args ? clampNumber(args.tMax, 0.001, 5000) : null
            if (tMax != null) patch.tMax = tMax
            const samples = args ? clampNumber(args.samples, 64, 12000) : null
            if (samples != null) patch.samples = Math.round(samples)
            if (args && (args.mode === '2d' || args.mode === '3d')) patch.mode = args.mode
            if (args && Array.isArray(args.axes) && args.axes.length) {
              const axes = args.axes.map((item) => Math.round(Number(item))).filter((item) => Number.isFinite(item) && item >= 0).slice(0, 3)
              if (axes.length) patch.axes = axes
            }
            if (!Object.keys(patch).length) {
              return { queued: false, text: '没有可应用的改动：equations / init / tMax / samples / mode / axes 至少给一项。' }
            }
            const entry = pushCommand(patch)
            const parts = []
            if (patch.equations) parts.push('方程组')
            if (patch.init) parts.push('初始状态')
            if (patch.tMax != null) parts.push('跨度=' + patch.tMax)
            if (patch.samples != null) parts.push('采样点=' + patch.samples)
            if (patch.mode) parts.push('视图=' + patch.mode)
            if (patch.axes) parts.push('投影轴=' + patch.axes.join(','))
            return {
              queued: true,
              command: entry,
              text: '已排入面板队列（#' + entry.seq + '）：' + parts.join('、') + '。' +
                (isLive() ? '面板会在约 1.5 秒内应用。' : '注意面板当前没打开——命令会保留 5 分钟，等你打开面板时立刻生效。'),
            }
          },
        })), 'dsh-ode-lab: ode_lab_set')
      } catch (err) {
        log(ctx, 'error', 'failed to register ode_lab_set: ' + ((err && err.message) || err))
      }

      try {
        diag.registered.push('ode_lab_presets')
        ctx.effect(() => tools.register(defineTool({
          name: 'ode_lab_presets',
          description: '列出「微分方程演化」面板自带的预设方程组（洛伦兹、罗斯勒、洛特卡–沃尔泰拉、阻尼摆、谐振子、范德波尔）。教学时想举个例子，先看这份清单再决定换哪个。',
          parameters: {},
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: value.text }],
          },
          async execute() {
            const text = PRESETS.map((item) => '- ' + item.title + '（' + item.id + '）\n' + item.system.split('\n').filter(Boolean).map((line) => '  ' + line).join('\n')).join('\n')
            return { presets: PRESETS, text: '内置预设：\n' + text }
          },
        })), 'dsh-ode-lab: ode_lab_presets')
      } catch (err) {
        log(ctx, 'error', 'failed to register ode_lab_presets: ' + ((err && err.message) || err))
      }
      }).catch((err) => {
        log(ctx, 'error', 'tool registration failed: ' + ((err && err.message) || err))
      })
    }

    diag.steps.push('tools-defined')
    // `inject` above guarantees the tools service is active, so register right
    // away; if this host still refuses, retry through ctx.inject instead of
    // taking the entry down.
    diag.injectCalled = true
    try {
      registerTools()
    } catch (err) {
      diag.errors.push('register threw: ' + ((err && err.message) || err))
      try {
        if (typeof ctx.inject === 'function') ctx.inject(['tools'], () => registerTools())
      } catch (retryErr) {
        diag.errors.push('retry failed: ' + ((retryErr && retryErr.message) || retryErr))
        log(ctx, 'error', 'agent tools unavailable: ' + ((err && err.message) || err))
      }
    }
  } catch (err) {
    diag.errors.push('apply threw: ' + ((err && err.message) || err))
    log(ctx, 'error', 'apply failed: ' + ((err && err.message) || err))
  }
}
