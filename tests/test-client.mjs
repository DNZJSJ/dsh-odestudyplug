import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const log = []
const fail = []
function check(name, fn) {
  try {
    fn()
    log.push('PASS ' + name)
  } catch (e) {
    const nl = String.fromCharCode(10)
    const stack = e && e.stack ? nl + e.stack : ''
    const why = (e && e.message) || String(e)
    fail.push('FAIL ' + name + ': ' + why + (process.env.ODE_TEST_TRACE ? stack : ''))
  }
}

// ---------- fake browser ----------
const rafQueue = []
let rafId = 1
const timers = []
const cleanupsPass = []

function fakeCtx2d() {
  const ops = []
  const rec = (name) => (...args) => { ops.push([name, ...args]) }
  const g = {
    ops,
    canvas: { width: 800, height: 600 },
    setTransform: rec('setTransform'), save: rec('save'), restore: rec('restore'),
    clearRect: rec('clearRect'), fillRect: rec('fillRect'), strokeRect: rec('strokeRect'),
    beginPath: rec('beginPath'), closePath: rec('closePath'), moveTo: rec('moveTo'),
    lineTo: rec('lineTo'), arc: rec('arc'), fill: rec('fill'), stroke: rec('stroke'),
    fillText: rec('fillText'), measureText: (s) => ({ width: String(s).length * 6 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    setLineDash: rec('setLineDash'), rect: rec('rect'), clip: rec('clip'),
    quadraticCurveTo: rec('quadraticCurveTo'), bezierCurveTo: rec('bezierCurveTo'),
    shadowBlur: 0, shadowColor: '', globalAlpha: 1, lineWidth: 1,
    fillStyle: '#000', strokeStyle: '#000', font: '12px sans-serif',
  }
  return g
}

function fakeElement(tag) {
  const ctx2d = fakeCtx2d()
  const el = {
    tagName: tag, style: {}, dataset: {}, children: [],
    clientWidth: 980, clientHeight: 620, width: 980, height: 620,
    className: '', textContent: '',
    appendChild(c) { el.children.push(c); return c },
    removeChild() {}, remove() {}, setAttribute() {}, getAttribute() { return null },
    addEventListener() {}, removeEventListener() {},
    getContext() { return ctx2d },
    getBoundingClientRect() { return { left: 0, top: 0, width: 980, height: 620, right: 980, bottom: 620, x: 0, y: 0 } },
    querySelector() { return null }, querySelectorAll() { return [] },
    __ctx2d: ctx2d,
  }
  return el
}

const doc = {
  documentElement: fakeElement('html'),
  body: fakeElement('body'),
  head: fakeElement('head'),
  createElement: (t) => fakeElement(t),
  querySelector: () => null,
  addEventListener() {}, removeEventListener() {},
  readyState: 'complete',
}
const win = {
  document: doc,
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2,
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: (k) => (k.includes('brand') ? '#4dd0c1' : '#888888') }),
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafId++ },
  cancelAnimationFrame() {},
  setTimeout: (fn, ms) => { const t = setTimeout(fn, 0); timers.push(t); return t },
  clearTimeout: (t) => clearTimeout(t),
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
  ResizeObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} disconnect() {} },
  location: { href: 'dsh-app://app/', reload() {} },
  navigator: { userAgent: 'node-test', language: 'zh-CN' },
  console,
}
win.window = win
win.self = win
win.globalThis = win

let captured = null
win.__ModuleLoader__ = { load: (def) => { captured = def } }

// ---------- fake React with a minimal hooks runtime ----------
function depsEqual(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}
let buckets = [[]]
let hookIndex = 0
let pending = []
const curBucket = () => buckets[buckets.length - 1]
let rerenderBudget = 12
let rerenderFn = () => {}

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Fragment: 'Fragment',
  useRef(value) { const i = hookIndex++; if (!curBucket()[i]) curBucket()[i] = { current: value }; return curBucket()[i] },
  useState(value) {
    const i = hookIndex++
    const bucket = curBucket()
    if (!(i in bucket)) bucket[i] = typeof value === 'function' ? value() : value
    const set = (next) => {
      const v = typeof next === 'function' ? next(bucket[i]) : next
      if (Object.is(v, bucket[i])) return
      bucket[i] = v
      rerenderFn()
    }
    return [bucket[i], set]
  },
  useMemo(fn, deps) {
    const i = hookIndex++
    const prev = curBucket()[i]
    if (prev && depsEqual(prev.deps, deps)) return prev.value
    const value = fn()
    curBucket()[i] = { value, deps }
    return value
  },
  useEffect(fn, deps) {
    const i = hookIndex++
    const prev = curBucket()[i]
    if (prev && depsEqual(prev.deps, deps)) return
    curBucket()[i] = { deps }
    pending.push(fn)
  },
  useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
  useLayoutEffect(fn, deps) { return React.useEffect(fn, deps) },
  useReducer(reducer, init) { const [s, set] = React.useState(init); return [s, (a) => set(reducer(s, a))] },
  memo: (c) => c,
}
const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
}

// ---------- load the module ----------
globalThis.window = win
globalThis.document = doc
globalThis.requestAnimationFrame = win.requestAnimationFrame
globalThis.cancelAnimationFrame = win.cancelAnimationFrame
globalThis.devicePixelRatio = win.devicePixelRatio
globalThis.getComputedStyle = win.getComputedStyle
globalThis.MutationObserver = win.MutationObserver
globalThis.ResizeObserver = win.ResizeObserver
globalThis.IntersectionObserver = win.IntersectionObserver
globalThis.self = win

const boot = new Function('window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', src)
boot(win, doc, win.requestAnimationFrame, win.cancelAnimationFrame, win.getComputedStyle, win.MutationObserver, win.ResizeObserver, win.IntersectionObserver)

check('module loader captured factory', () => { if (!captured) throw new Error('loader never called') })
check('module id is dsh-ode-lab', () => { if (captured.id !== 'dsh-ode-lab') throw new Error('id=' + captured.id) })

const mod = captured.factory(requireStub)
check('exports inject is service names', () => {
  const want = ['slots', 'locale']
  if (JSON.stringify(mod.inject) !== JSON.stringify(want)) throw new Error('got ' + JSON.stringify(mod.inject))
})
check('exports apply function', () => { if (typeof mod.apply !== 'function') throw new Error('missing apply') })

// ---------- apply with a fake cordis ctx ----------
const registered = []
const injected = []
const localeDb = {}
const effects = []
const ctx = {
  slots: {
    inject(name, cb) { injected.push(name); const off = cb(); return () => { if (typeof off === 'function') off() } },
    register(reg, component) { registered.push({ reg, component }); return () => { const i = registered.findIndex((r) => r.reg === reg); if (i >= 0) registered.splice(i, 1) } },
  },
  locale: {
    register(ns, a, b) {
      if (typeof a === 'string') { (localeDb[ns] = localeDb[ns] || {})[a] = b; return }
      localeDb[ns] = Object.assign(localeDb[ns] || {}, a)
    },
    bind(ns) { return (key) => { const row = localeDb[ns] || {}; const zh = row.zh || {}; return zh[key] != null ? zh[key] : key } },
  },
  effect(fn) { const off = fn(); effects.push(typeof off === 'function' ? off : () => {}) },
  on() { return () => {} },
  logger: { warn() {}, info() {}, error() {} },
  console,
}

check('apply() runs without throwing', () => { mod.apply(ctx) })
check('registers sidebar.panellist via slots.inject', () => {
  if (!injected.includes('sidebar.panellist')) throw new Error('inject targets: ' + injected.join(','))
})
check('registers main + sidebar + teaching dock', () => {
  const names = registered.map((r) => r.reg.name).sort().join(',')
  if (names !== 'main,shell.overlay,sidebar.panellist') throw new Error('slots=' + names)
})

const mainSlot = registered.find((r) => r.reg.name === 'main')
const sideSlot = registered.find((r) => r.reg.name === 'sidebar.panellist')
check('main slot keyed by panel id', () => { if (!mainSlot || mainSlot.reg.key !== 'ode-lab') throw new Error('bad main slot') })
check('sidebar slot metadata', () => {
  if (!sideSlot) throw new Error('missing sidebar slot')
  if (sideSlot.reg.id !== 'ode-lab') throw new Error('id=' + sideSlot.reg.id)
  if (typeof sideSlot.reg.label !== 'function') throw new Error('label must be a function')
})
const dockSlot = registered.find((r) => r.reg.name === 'shell.overlay')
check('dock slot metadata', () => {
  if (!dockSlot) throw new Error('missing shell.overlay slot')
  if (dockSlot.reg.id !== 'ode-lab-dock') throw new Error('id=' + dockSlot.reg.id)
  if (typeof dockSlot.component !== 'function') throw new Error('dock needs a component')
})
check('locale has zh/en dictionaries', () => {
  const row = localeDb['dsh-ode-lab']
  if (!row || !row.zh || !row.en) throw new Error('locale keys: ' + Object.keys(row || {}).join(','))
  if (!row.zh.title) throw new Error('zh.title missing')
})

// ---------- render the panel once ----------
function expand(node) {
  if (!node) return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    buckets.push([])
    const savedIndex = hookIndex
    const savedPending = pending
    hookIndex = 0
    pending = []
    const out = node.type(node.props)
    const effectsHere = pending
    pending = savedPending
    hookIndex = savedIndex
    buckets.pop()
    const child = expand(out)
    return { type: node.type.name || 'Component', props: node.props, children: [child], __effects: effectsHere }
  }
  if (node.props && node.props.ref && typeof node.props.ref === 'object' && 'current' in node.props.ref) {
    if (!node.props.ref.current) node.props.ref.current = fakeElement(node.type)
  }
  return { type: node.type, props: node.props, children: (node.children || []).map(expand) }
}

function collectEffects(node, out) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => collectEffects(n, out)); return out }
  ;(node.children || []).forEach((n) => collectEffects(n, out))
  if (node.__effects) out.push(...node.__effects)
  return out
}

function renderOnce(props) {
  const element = mainSlot.component ? mainSlot.component(props) : null
  const expanded = expand(element)
  const effects = collectEffects(expanded, [])
  const cleanups = []
  for (const fn of effects) {
    const c = fn()
    if (typeof c === 'function') cleanups.push(c)
  }
  return { el: expanded, cleanups }
}

let tree = null
let cleanups = []
check('panel renders without throwing', () => {
  const out = renderOnce({ t: ctx.locale.bind('dsh-ode-lab'), size: 1, active: true })
  tree = out.el
  cleanups = out.cleanups
  if (!tree) throw new Error('null tree')
})
check('panel tree has controls + canvas', () => {
  const flat = []
  const walk = (n) => {
    if (!n) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n !== 'object') return
    flat.push(n)
    ;(n.children || []).forEach(walk)
  }
  walk(tree)
  const tags = flat.map((n) => (typeof n.type === 'string' ? n.type : ''))
  if (!tags.includes('canvas')) throw new Error('no canvas; tags=' + tags.filter(Boolean).slice(0, 12).join(','))
  if (!tags.includes('textarea')) throw new Error('no textarea')
  if (!tags.includes('select')) throw new Error('no select')
})
check('sidebar icon renders without throwing', () => {
  hookIndex = 0; pending = []
  const el = sideSlot.component({ size: 1, active: false })
  if (!el) throw new Error('null icon')
})

// ---------- drive a few animation frames (paint path) ----------
rerenderFn = () => {
  if (rerenderBudget-- <= 0) { rerenderFn = () => {}; return }
  const out = renderOnce({ t: ctx.locale.bind('dsh-ode-lab'), size: 1, active: true })
  tree = out.el
  cleanups = cleanups.concat(out.cleanups)
}

check('animation frames paint without throwing', () => {
  let thrown = null
  for (let frame = 0; frame < 5 && rafQueue.length; frame++) {
    const fn = rafQueue.shift()
    try { fn(16 * (frame + 1)) } catch (e) { thrown = e; break }
  }
  if (thrown) throw thrown
})

check('paint draws a 3d trajectory', () => {
  const T = mod.__test
  if (!T || typeof T.paint !== 'function') throw new Error('__test.paint missing')
  const sys = T.parseSystem(['sigma = 10', 'rho = 28', 'beta = 8/3', 'dx/dt = sigma*(y-x)', 'dy/dt = x*(rho-z)-y', 'dz/dt = x*y-beta*z'].join(String.fromCharCode(10)))
  const y0 = T.parseInitial('1, 1, 1', sys)
  const traj = T.integrate(sys, y0, { samples: 600, tMax: 20, substeps: 4 })
  if (traj.count < 100) throw new Error('short trajectory: ' + traj.count)
  const canvas = fakeElement('canvas')
  const theme = { bg: '#111', layer: '#181818', grid: '#262626', axis: '#444', label: '#888', label2: '#999', brand: '#4dd0c1', warm: '#e08a3c', warn: '#d29922', good: '#3fb950' }
  T.paint(canvas, { traj, vars: sys.vars, theme, mode: '3d', axes: [0, 1, 2], yaw: 0.6, pitch: 0.35, zoom: 1, panX: 0, panY: 0, progress: 0.55, emptyText: 'no data' })
  const ops = canvas.__ctx2d.ops
  if (ops.length < 30) throw new Error('only ' + ops.length + ' draw ops')
  const names = new Set(ops.map((o) => o[0]))
  for (const need of ['clearRect', 'moveTo', 'lineTo', 'stroke']) {
    if (!names.has(need)) throw new Error('missing op ' + need + '; saw ' + [...names].join(','))
  }
})

check('paint draws a 2d phase portrait', () => {
  const T = mod.__test
  const sys = T.parseSystem(['a = 1.1', 'b = 0.4', 'dx/dt = x*(a-y)', 'dy/dt = y*(-b+x)'].join(String.fromCharCode(10)))
  const y0 = T.parseInitial('0.5, 0.4', sys)
  const traj = T.integrate(sys, y0, { samples: 400, tMax: 30, substeps: 4 })
  const canvas = fakeElement('canvas')
  const theme = { bg: '#111', layer: '#181818', grid: '#262626', axis: '#444', label: '#888', label2: '#999', brand: '#4dd0c1', warm: '#e08a3c', warn: '#d29922', good: '#3fb950' }
  T.paint(canvas, { traj, vars: sys.vars, theme, mode: '2d', axes: [0, 1, 0], yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0, progress: 1, emptyText: 'no data' })
  if (canvas.__ctx2d.ops.length < 30) throw new Error('only ' + canvas.__ctx2d.ops.length + ' ops')
})

check('paint labels a diverged trajectory', () => {
  const T = mod.__test
  const sys = T.parseSystem('dy/dx = x^2 + y^2')
  const traj = T.integrate(sys, T.parseInitial('0, 0', sys), { samples: 200, tMax: 5, substeps: 4 })
  if (!traj.diverged) throw new Error('expected a diverged trajectory')
  const canvas = fakeElement('canvas')
  const theme = { bg: '#111', layer: '#181818', grid: '#262626', axis: '#444', label: '#888', label2: '#999', brand: '#4dd0c1', warm: '#e08a3c', warn: '#d29922', good: '#3fb950' }
  T.paint(canvas, { traj, vars: sys.vars, theme, mode: '2d', axes: [0, 1, 0], yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0, progress: 1, emptyText: 'no data', divergedText: 'labelled' })
  const ops = canvas.__ctx2d.ops
  if (!ops.some((o) => o[0] === 'fillText' && o[1] === 'labelled')) throw new Error('diverged label not drawn')
})

check('paint handles an empty trajectory', () => {
  const T = mod.__test
  const canvas = fakeElement('canvas')
  const theme = { bg: '#111', layer: '#181818', grid: '#262626', axis: '#444', label: '#888', label2: '#999', brand: '#4dd0c1', warm: '#e08a3c', warn: '#d29922', good: '#3fb950' }
  T.paint(canvas, { traj: null, theme, mode: '2d', axes: [0, 1, 0], yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0, progress: 0, emptyText: 'no data' })
  const ops = canvas.__ctx2d.ops
  if (!ops.some((o) => o[0] === 'fillText')) throw new Error('placeholder text not drawn')
})

check('paint projects a 5-variable system onto chosen axes', () => {
  const T = mod.__test
  const sys = T.parseSystem(['dx/dt = y', 'dy/dt = -x', 'dz/dt = 0.1', 'dw/dt = 0.2', 'dv/dt = 0.3'].join(String.fromCharCode(10)))
  if (sys.dim !== 5) throw new Error('dim=' + sys.dim)
  const y0 = T.parseInitial('1, 0, 0, 0, 0', sys)
  const traj = T.integrate(sys, y0, { samples: 200, tMax: 6.28, substeps: 2 })
  const canvas = fakeElement('canvas')
  const theme = { bg: '#111', layer: '#181818', grid: '#262626', axis: '#444', label: '#888', label2: '#999', brand: '#4dd0c1', warm: '#e08a3c', warn: '#d29922', good: '#3fb950' }
  T.paint(canvas, { traj, vars: sys.vars, theme, mode: '3d', axes: [0, 2, 4], yaw: 0.3, pitch: 0.2, zoom: 1, panX: 0, panY: 0, progress: 1, emptyText: 'no data' })
  if (canvas.__ctx2d.ops.length < 30) throw new Error('only ' + canvas.__ctx2d.ops.length + ' ops')
})

// ---------- bridge to the conversation ----------
check('buildStatePayload describes the system for the agent', () => {
  const T = mod.__test
  const sys = T.parseSystem('a = 2\ndy/dx = a*x')
  const traj = T.integrate(sys, T.parseInitial('0, 0', sys), { samples: 100, tMax: 2, substeps: 2 })
  const payload = T.buildStatePayload({
    equations: 'a = 2\ndy/dx = a*x',
    init: '0, 0',
    tMax: 2,
    samples: 100,
    mode: '2d',
    axes: [0, 1],
    sys,
    traj,
    error: null,
  })
  if (payload.independent !== 'x') throw new Error('independent=' + payload.independent)
  if (payload.vars.join(',') !== 'x,y') throw new Error('vars=' + payload.vars.join(','))
  if (!payload.stats || !payload.stats.ranges || !payload.stats.ranges.y) throw new Error('missing ranges')
  if (payload.stats.points !== traj.count) throw new Error('points=' + payload.stats.points)
  if (payload.diverged !== false) throw new Error('diverged flag wrong')
  // y = x^2 over [0, 2] must top out near 4
  const top = parseFloat(payload.stats.ranges.y[1])
  if (!(top > 3.9 && top < 4.1)) throw new Error('y range top=' + top)
})

check('buildStatePayload marks a diverged run and its stop value', () => {
  const T = mod.__test
  const sys = T.parseSystem('dy/dx = x^2 + y^2')
  const traj = T.integrate(sys, T.parseInitial('1, 1', sys), { samples: 400, tMax: 40, substeps: 4 })
  if (!traj.diverged) throw new Error('expected divergence')
  const payload = T.buildStatePayload({ equations: 'dy/dx = x^2 + y^2', init: '1, 1', tMax: 40, samples: 400, mode: '2d', axes: [0, 1], sys, traj })
  if (payload.diverged !== true) throw new Error('diverged flag missing')
  const stop = parseFloat(payload.stopAt)
  if (!(stop > 1.0 && stop < 2.0)) throw new Error('stopAt=' + payload.stopAt)
})

check('applyPanelPatch applies queued commands', () => {
  const T = mod.__test
  const seen = { setSystemText: null, setInitText: null, setTMaxText: null, setSamplesText: null, setMode: null, setAxes: null, setPresetId: null }
  const setters = {
    setSystemText: (v) => { seen.setSystemText = v },
    setInitText: (v) => { seen.setInitText = v },
    setTMaxText: (v) => { seen.setTMaxText = v },
    setSamplesText: (v) => { seen.setSamplesText = v },
    setMode: (v) => { seen.setMode = v },
    setAxes: (v) => { seen.setAxes = v },
    setPresetId: (v) => { seen.setPresetId = v },
  }
  const applied = T.applyPanelPatch({ equations: 'dx/dt = -x', init: 'x = 2', tMax: 12, samples: 500, mode: '3d', axes: [0, 1] }, setters)
  if (applied.join(',') !== 'equations,init,tMax,samples,mode,axes') throw new Error('applied=' + applied.join(','))
  if (seen.setSystemText !== 'dx/dt = -x') throw new Error('equations not applied')
  if (seen.setTMaxText !== '12') throw new Error('tMax=' + seen.setTMaxText)
  if (seen.setPresetId !== '') throw new Error('preset should be cleared for a custom system')
  if (seen.setMode !== '3d') throw new Error('mode=' + seen.setMode)
  // garbage must be ignored, not thrown
  if (T.applyPanelPatch(null, setters).length !== 0) throw new Error('null patch applied')
  if (T.applyPanelPatch({ tMax: 'nope', mode: '4d', axes: [] }, setters).length !== 0) throw new Error('bad patch applied')
})

// ---- dock offsets against the Windows title-bar overlay ----
check('detectDockTop: plain browser tab → 8', () => { if (mod.__test.detectDockTop() !== 8) throw new Error('expected 8') })

{
  const el = doc.documentElement
  const prevHas = el.hasAttribute
  const prevStyle = win.getComputedStyle
  el.hasAttribute = (name) => name === 'data-windows-titlebar'
  win.getComputedStyle = () => ({ getPropertyValue: (k) => (k === '--dsh-windows-titlebar-height' ? '40px' : '') })
  check('detectDockTop: windows titlebar 40px → 48', () => { if (mod.__test.detectDockTop() !== 48) throw new Error('expected 48') })
  win.getComputedStyle = () => ({ getPropertyValue: (k) => (k === '--dsh-windows-titlebar-height' ? '28px' : '') })
  check('detectDockTop: windows titlebar 28px → 36', () => { if (mod.__test.detectDockTop() !== 36) throw new Error('expected 36') })
  win.getComputedStyle = () => ({ getPropertyValue: (k) => (k === '--dsh-frame-top-clearance' ? '42px' : '') })
  check('detectDockTop: shell clearance 42px → 50', () => { if (mod.__test.detectDockTop() !== 50) throw new Error('expected 50') })
  el.hasAttribute = prevHas
  win.getComputedStyle = prevStyle
  check('detectDockTop: restored → 8', () => { if (mod.__test.detectDockTop() !== 8) throw new Error('expected 8 after restore') })
}

// ---------- report ----------
console.log(log.join('\n'))
if (fail.length) {
  console.log('\n' + fail.join('\n'))
  console.log(`\n${fail.length} FAILED / ${log.length + fail.length} checks`)
  process.exitCode = 1
} else {
  console.log(`\nall ${log.length} checks passed`)
}
for (const c of cleanups) { try { c() } catch {} }
for (const off of effects) { try { off() } catch {} }
