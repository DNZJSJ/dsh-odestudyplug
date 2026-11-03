import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'client.js'), 'utf8')

const start = src.indexOf('/* ===================== math-core:start ===================== */')
const end = src.indexOf('/* ===================== math-core:end ===================== */')
if (start < 0 || end < 0) throw new Error('math core markers not found')

const core = src.slice(start, end)
const factory = new Function(core + '\nreturn { parseSystem, parseInitial, syncInitial, integrate, parseExpression, niceStep }')
const M = factory()

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log('ok   ' + name)
  } catch (err) {
    failures++
    console.log('FAIL ' + name + '\n     ' + (err && err.stack ? err.stack.split('\n')[0] : err))
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}

check('lorenz integrates', () => {
  const sys = M.parseSystem('s = 10\nr = 28\nb = 8/3\n\ndx/dt = s*(y-x)\ndy/dt = x*(r-z)-y\ndz/dt = x*y - b*z')
  assert(sys.dim === 3, 'dim')
  assert(sys.vars.join(',') === 'x,y,z', 'vars ' + sys.vars)
  const y0 = M.parseInitial('1, 1, 1', sys)
  const t0 = performance.now()
  const tr = M.integrate(sys, y0, { samples: 2000, tMax: 40, substeps: 8 })
  const ms = performance.now() - t0
  assert(tr.count === 2001, 'count ' + tr.count)
  assert(!tr.diverged, 'diverged')
  let zmin = Infinity, zmax = -Infinity
  for (let i = 0; i < tr.count; i++) {
    if (!Number.isFinite(tr.cols[0][i]) || !Number.isFinite(tr.cols[2][i])) throw new Error('non-finite at ' + i)
    zmin = Math.min(zmin, tr.cols[2][i]); zmax = Math.max(zmax, tr.cols[2][i])
  }
  assert(zmin > 0 && zmax < 60, 'z range ' + zmin + '..' + zmax)
  console.log('     lorenz 40u x2000 in ' + ms.toFixed(1) + 'ms, z ' + zmin.toFixed(2) + '..' + zmax.toFixed(2))
})

check('lotka volterra 2d', () => {
  const sys = M.parseSystem('a = 1.1\nb = 0.4\nc = 0.1\nd = 0.4\n\ndx/dt = x*(a - b*y)\ndy/dt = y*(c*x - d)')
  const y0 = M.parseInitial('10, 5', sys)
  const tr = M.integrate(sys, y0, { samples: 2400, tMax: 60 })
  assert(tr.dim === 2 && tr.count === 2401 && !tr.diverged, 'traj ' + tr.count)
  assert(Math.abs(tr.cols[0][0] - 10) < 1e-12, 'x0')
})

check('initial by name and expressions', () => {
  const sys = M.parseSystem('k = 2\n\ndx/dt = -k*x\ndy/dt = x')
  const y0 = M.parseInitial('x = 1/k, y = 0', sys)
  assert(Math.abs(y0[0] - 0.5) < 1e-12 && y0[1] === 0, 'values ' + Array.from(y0))
  let threw = false
  try { M.parseInitial('x = 1', sys) } catch (e) { threw = /missing value/.test(e.message) }
  assert(threw, 'missing value should throw')
})

check('non-autonomous t works', () => {
  const sys = M.parseSystem('dx/dt = -x + sin(t)')
  const tr = M.integrate(sys, M.parseInitial('0', sys), { samples: 200, tMax: 10 })
  assert(tr.count === 201 && Number.isFinite(tr.cols[0][200]), 'bad')
})

check('implicit multiplication and precedence', () => {
  const sys = M.parseSystem('a = 2\n\ndx/dt = -2a x + 3 x^2')
  const y0 = M.parseInitial('1', sys)
  const tr = M.integrate(sys, y0, { samples: 64, tMax: 0.001 })
  assert(Number.isFinite(tr.cols[0][1]), 'finite')
  const fn = M.parseExpression('2x')
  assert(typeof fn.a === 'object' && fn.op === '*', 'implicit mult ast')
})

check('errors carry line numbers', () => {
  const cases = [
    ['dx/dt = y\n\nfoo bar', /Line 3/],
    ['dx/dt = zzz', /unknown variable/],
    ['dx/dt = sin(', /Line 1/],
    ['dx/dt = ,', /Line 1/],
    ['q = 1\nq = 2\n\ndx/dt = 1', /defined twice|used both/],
    ['', /No equation/],
  ]
  for (const [text, re] of cases) {
    let msg = null
    try { M.parseSystem(text) } catch (e) { msg = e.message }
    assert(msg !== null, 'expected throw for ' + JSON.stringify(text))
    assert(re.test(msg), 'message "' + msg + '" should match ' + re)
  }
})

check('divergence is detected', () => {
  const sys = M.parseSystem('dx/dt = x^2')
  const tr = M.integrate(sys, M.parseInitial('1', sys), { samples: 400, tMax: 5 })
  assert(tr.diverged === true, 'should diverge')
  assert(tr.count < 401, 'should stop early, got ' + tr.count)
})

check('presets all parse and integrate', () => {
  const presetText = src.slice(src.indexOf('const PRESETS = ['), src.indexOf('const CSS = `'))
  const defs = new Function(presetText + '\nreturn PRESETS')()
  assert(defs.length >= 5, 'preset count')
  for (const p of defs) {
    const sys = M.parseSystem(p.system)
    const y0 = M.parseInitial(p.init, sys)
    const tr = M.integrate(sys, y0, { samples: p.samples, tMax: p.tMax })
    assert(!tr.diverged, p.id + ' diverged')
    assert(tr.count > p.samples * 0.5, p.id + ' short ' + tr.count)
    console.log('     ' + p.id + ': dim=' + tr.dim + ' vars=' + sys.vars.join(',') + ' points=' + tr.count)
  }
})

check('niceStep sane', () => {
  for (const r of [0.0003, 1, 7, 90, 1e5]) {
    const s = M.niceStep(r)
    assert(s > 0 && Number.isFinite(s), 'step ' + s)
    assert(s >= r / 40 && s <= r, 'step ' + s + ' for range ' + r)
  }
})

check('leibniz dy/dx becomes a 2d system', () => {
  const sys = M.parseSystem('dy/dx = x^2 + y^2')
  assert(sys.dim === 2, 'dim ' + sys.dim)
  assert(sys.vars.join(',') === 'x,y', 'vars ' + sys.vars.join(','))
  const tr = M.integrate(sys, M.parseInitial('x = 0, y = 0', sys), { samples: 200, tMax: 1 })
  assert(!tr.diverged, 'diverged')
  assert(Math.abs(tr.cols[0][tr.count - 1] - 1) < 1e-6, 'x should end at 1, got ' + tr.cols[0][tr.count - 1])
  const yEnd = tr.cols[1][tr.count - 1]
  assert(yEnd > 0.3 && yEnd < 0.42, 'y(1) should be near 0.35, got ' + yEnd)
})

check('leibniz works with parameters and several equations', () => {
  const sys = M.parseSystem('a = 2\ndy/dx = a*x\ndz/dx = y')
  assert(sys.vars.join(',') === 'x,y,z', 'vars ' + sys.vars.join(','))
  const tr = M.integrate(sys, M.parseInitial('0, 0, 0', sys), { samples: 100, tMax: 2 })
  assert(!tr.diverged, 'diverged')
  assert(Math.abs(tr.cols[1][tr.count - 1] - 4) < 1e-3, 'y(2)=2x^2 -> 8? got ' + tr.cols[1][tr.count - 1])
})

check('leibniz rejects a self-referential independent variable', () => {
  let msg = null
  try { M.parseSystem('dy/dx = x\ndx/dt = 1') } catch (e) { msg = e.message }
  assert(msg !== null, 'expected throw')
  assert(/independent variable/.test(msg), msg)
})

check('unicode prime marks a derivative', () => {
  const sys = M.parseSystem('x\u2032 = y\ny\u2032 = -x')
  assert(sys.vars.join(',') === 'x,y', 'vars ' + sys.vars.join(','))
})

check('syncInitial drops stale variables and keeps the rest', () => {
  assert(M.syncInitial('x = 1, y = 1, z = 1', ['x', 'y']) === 'x = 1, y = 1', M.syncInitial('x = 1, y = 1, z = 1', ['x', 'y']))
  assert(M.syncInitial('x = 1, y = 1', ['x', 'y']) === 'x = 1, y = 1', 'stable input should be untouched')
  assert(M.syncInitial('1, 0', ['x', 'y']) === '1, 0', 'positional input should be untouched')
  assert(M.syncInitial('', ['x', 'y']) === 'x = 0, y = 0', M.syncInitial('', ['x', 'y']))
  assert(M.syncInitial('x = 2', ['x', 'y', 'z']) === 'x = 2, y = 0, z = 0', M.syncInitial('x = 2', ['x', 'y', 'z']))
})

console.log(failures ? '\n' + failures + ' FAILED' : '\nall math-core checks passed')
process.exit(failures ? 1 : 0)
