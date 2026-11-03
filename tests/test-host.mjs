// Host-half test: exercises index.js (routes + tools) with a fake ctx.
// The plugin imports '@deepseek-ai/dsh-tools', so the plugin is copied into a
// scratch dir next to a stub of that package — no profile is touched.
import { mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const scratch = join(root, '.tmp', 'ode-host')
const stubDir = join(scratch, 'node_modules', '@deepseek-ai', 'dsh-tools')

const fail = []
const log = []
async function check(name, fn) {
  try {
    await fn()
    log.push('PASS ' + name)
  } catch (e) {
    fail.push('FAIL ' + name + ': ' + ((e && e.message) || e))
  }
}

rmSync(scratch, { recursive: true, force: true })
mkdirSync(stubDir, { recursive: true })
writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', main: 'index.js' }))
writeFileSync(join(stubDir, 'index.js'), 'export function defineTool(def) { return def }\n')
copyFileSync(join(root, 'index.js'), join(scratch, 'index.js'))

const plugin = await import(new URL('file://' + join(scratch, 'index.js').replace(/\\/g, '/')))
if (typeof plugin.apply !== 'function') throw new Error('index.js must export apply')

// ---------- fake ctx ----------
const registeredTools = []
const disposers = []
let routeHandler = null

const ctx = {
  logger: { log() {}, warn() {}, error() {} },
  effect(fn) {
    const off = fn()
    if (typeof off === 'function') disposers.push(off)
    return () => {}
  },
  get(name) {
    if (name !== 'webServer') return undefined
    return {
      register(route) {
        if (route.path === '/ode-lab') routeHandler = route.handler
        return () => { routeHandler = null }
      },
    }
  },
  inject(_names, fn) { fn() },
  tools: {
    register(tool) {
      registeredTools.push(tool)
      return () => {}
    },
  },
}

plugin.apply(ctx)
// tools arrive after the lazy '@deepseek-ai/dsh-tools' import resolves
await new Promise((resolve) => setTimeout(resolve, 60))

// ---------- fake http ----------
function makeReq({ method = 'GET', url = '/ode-lab/state', body = '', address = '127.0.0.1' }) {
  const stream = Readable.from(body ? [Buffer.from(body)] : [])
  stream.method = method
  stream.url = url
  stream.socket = { remoteAddress: address }
  stream.destroy = () => {}
  return stream
}
function makeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { res.status = status; res.headers = headers },
    end(chunk) { if (chunk) res.body += chunk },
  }
  return res
}
function call(reqOpts) {
  const res = makeRes()
  routeHandler(makeReq(reqOpts), res)
  return res
}
function callAsync(reqOpts) {
  const res = makeRes()
  routeHandler(makeReq(reqOpts), res)
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      if (res.body || Date.now() - started > 2000) resolve(res)
      else setTimeout(tick, 5)
    }
    tick()
  })
}
const parse = (res) => JSON.parse(res.body)

await check('registers the http bridge', () => { if (!routeHandler) throw new Error('no /ode-lab route registered') })
await check('registers three agent tools', () => {
  const names = registeredTools.map((t) => t.name).sort()
  const want = ['ode_lab_presets', 'ode_lab_set', 'ode_lab_snapshot']
  if (names.join(',') !== want.join(',')) throw new Error('tools=' + names.join(','))
})

await check('state starts empty', () => {
  const res = call({ url: '/ode-lab/state' })
  const value = parse(res)
  if (value.connected !== false) throw new Error('expected connected:false, got ' + JSON.stringify(value))
})

await check('snapshot tool explains an unwritten panel', async () => {
  const tool = registeredTools.find((t) => t.name === 'ode_lab_snapshot')
  const out = await tool.execute({})
  if (out.connected !== false) throw new Error('connected=' + out.connected)
  if (!/没有打开/.test(out.text)) throw new Error('text=' + out.text)
})

// The panel posts a snapshot -> the tool must read it back as Chinese prose.
const snapshot = {
  equations: 's = 10\ndx/dt = s*(y - x)',
  init: 'x = 1, y = 1',
  tMax: 40,
  samples: 2600,
  mode: '3d',
  axes: [0, 1, 2],
  vars: ['x', 'y', 'z'],
  independent: 't',
  diverged: true,
  stopAt: '1.723',
  error: null,
  stats: { ranges: { x: ['-18.5', '19.2'], y: ['-25.1', '27.3'], z: ['0.9', '48.1'] }, points: 2601 },
}

await check('panel snapshot round-trips', async () => {
  const post = await callAsync({ method: 'POST', url: '/ode-lab/state', body: JSON.stringify(snapshot) })
  if (post.status !== 200) throw new Error('status=' + post.status)
  const read = call({ url: '/ode-lab/state' })
  const value = parse(read)
  if (value.connected !== true) throw new Error('connected=' + value.connected)
  if (value.vars.join(',') !== 'x,y,z') throw new Error('vars lost')
  const tool = registeredTools.find((t) => t.name === 'ode_lab_snapshot')
  const out = await tool.execute({})
  if (out.connected !== true) throw new Error('tool saw connected=false')
  if (!out.text.includes('dx/dt = s*(y - x)')) throw new Error('equations missing from text')
  if (!out.text.includes('解已发散')) throw new Error('divergence missing from text')
  if (!out.text.includes('1.723')) throw new Error('stop value missing from text')
  if (!out.text.includes('采样点：2600')) throw new Error('samples missing from text')
})

await check('ode_lab_set queues a command', async () => {
  const tool = registeredTools.find((t) => t.name === 'ode_lab_set')
  const out = await tool.execute({ equations: 'dx/dt = -x', tMax: 12, mode: '2d', axes: [0, 1] })
  if (!out.queued) throw new Error('not queued: ' + out.text)
  const list = call({ url: '/ode-lab/command?since=0' })
  const body = parse(list)
  if (!Array.isArray(body.commands) || !body.commands.length) throw new Error('no commands queued')
  const patch = body.commands[body.commands.length - 1].patch
  if (patch.equations !== 'dx/dt = -x') throw new Error('equations=' + patch.equations)
  if (patch.tMax !== 12) throw new Error('tMax=' + patch.tMax)
  if (patch.mode !== '2d') throw new Error('mode=' + patch.mode)
  if (patch.axes.join(',') !== '0,1') throw new Error('axes=' + patch.axes.join(','))
  // since must filter old commands out
  const after = parse(call({ url: '/ode-lab/command?since=' + body.seq }))
  if (after.commands.length !== 0) throw new Error('since filter failed')
})

await check('ode_lab_set rejects an empty patch', async () => {
  const tool = registeredTools.find((t) => t.name === 'ode_lab_set')
  const out = await tool.execute({})
  if (out.queued) throw new Error('empty patch was queued')
  if (!/至少给一项/.test(out.text)) throw new Error('text=' + out.text)
})

await check('ode_lab_set clamps absurd numbers', async () => {
  const tool = registeredTools.find((t) => t.name === 'ode_lab_set')
  await tool.execute({ tMax: 1e9, samples: 5 })
  const body = parse(call({ url: '/ode-lab/command?since=0' }))
  const patch = body.commands[body.commands.length - 1].patch
  if (patch.tMax !== 5000) throw new Error('tMax=' + patch.tMax)
  if (patch.samples !== 64) throw new Error('samples=' + patch.samples)
})

await check('ode_lab_presets lists every system', async () => {
  const tool = registeredTools.find((t) => t.name === 'ode_lab_presets')
  const out = await tool.execute({})
  if (out.presets.length !== 6) throw new Error('presets=' + out.presets.length)
  if (!out.text.includes('洛伦兹')) throw new Error('missing Lorenz')
})

await check('non-loopback callers are refused', () => {
  const res = call({ url: '/ode-lab/state', address: '10.0.0.9' })
  if (res.status !== 403) throw new Error('status=' + res.status)
})

await check('unknown paths 404 instead of throwing', () => {
  const res = call({ url: '/ode-lab/nope' })
  if (res.status !== 404) throw new Error('status=' + res.status)
})

await check('malformed json is rejected', async () => {
  const res = await callAsync({ method: 'POST', url: '/ode-lab/state', body: '{oops' })
  if (res.status !== 400) throw new Error('status=' + res.status)
})

rmSync(scratch, { recursive: true, force: true })

console.log(log.join('\n'))
if (fail.length) {
  console.log('\n' + fail.join('\n'))
  console.log(`\n${fail.length} FAILED / ${log.length + fail.length} checks`)
  process.exitCode = 1
} else {
  console.log(`\nall ${log.length} checks passed`)
}
