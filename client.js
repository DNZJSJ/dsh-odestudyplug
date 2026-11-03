window.__ModuleLoader__.load({
  id: 'dsh-ode-lab',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-ode-lab'
    const PANEL_ID = 'ode-lab'

    /* ===================== math-core:start ===================== */

    const CONSTS = {
      pi: Math.PI,
      PI: Math.PI,
      tau: Math.PI * 2,
      e: Math.E,
      phi: (1 + Math.sqrt(5)) / 2,
    }

    const FUNCS = {
      sin: Math.sin, cos: Math.cos, tan: Math.tan,
      asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
      sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
      exp: Math.exp, log: Math.log, ln: Math.log, log10: Math.log10, log2: Math.log2,
      sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sign: Math.sign,
      floor: Math.floor, ceil: Math.ceil, round: Math.round,
      min: Math.min, max: Math.max, pow: Math.pow, hypot: Math.hypot,
      mod: (a, b) => a - b * Math.floor(a / b),
      clamp: (x, a, b) => Math.min(b, Math.max(a, x)),
    }

    function tokenize(src) {
      const toks = []
      const n = src.length
      let i = 0
      while (i < n) {
        const ch = src[i]
        if (ch === ' ' || ch === '\t') { i++; continue }
        if (ch >= '0' && ch <= '9') {
          let j = i
          while (j < n && src[j] >= '0' && src[j] <= '9') j++
          if (src[j] === '.') { j++; while (j < n && src[j] >= '0' && src[j] <= '9') j++ }
          if (src[j] === 'e' || src[j] === 'E') {
            let k = j + 1
            if (src[k] === '+' || src[k] === '-') k++
            if (src[k] >= '0' && src[k] <= '9') {
              j = k
              while (j < n && src[j] >= '0' && src[j] <= '9') j++
            }
          }
          toks.push({ t: 'num', v: parseFloat(src.slice(i, j)), pos: i })
          i = j
          continue
        }
        if (ch === '.') {
          let j = i + 1
          while (j < n && src[j] >= '0' && src[j] <= '9') j++
          if (j === i + 1) throw new Error(`unexpected "." at position ${i + 1}`)
          toks.push({ t: 'num', v: parseFloat(src.slice(i, j)), pos: i })
          i = j
          continue
        }
        const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
        if (isAlpha(ch)) {
          let j = i
          while (j < n && (isAlpha(src[j]) || (src[j] >= '0' && src[j] <= '9'))) j++
          toks.push({ t: 'id', v: src.slice(i, j), pos: i })
          i = j
          continue
        }
        if ('+-*/^(),'.indexOf(ch) >= 0) { toks.push({ t: ch, pos: i }); i++; continue }
        throw new Error(`unexpected character "${ch}" at position ${i + 1}`)
      }
      toks.push({ t: 'eof', pos: n })
      return toks
    }

    function parseExpression(src) {
      const toks = tokenize(src)
      let p = 0
      const peek = () => toks[p]
      const isAtomStart = (tok) => tok.t === 'num' || tok.t === 'id' || tok.t === '('

      function parseExpr() {
        let node = parseTerm()
        for (;;) {
          const tok = peek()
          if (tok.t !== '+' && tok.t !== '-') break
          p++
          node = { t: 'bin', op: tok.t, a: node, b: parseTerm() }
        }
        return node
      }

      function parseTerm() {
        let node = parseUnary()
        for (;;) {
          const tok = peek()
          if (tok.t === '*' || tok.t === '/') {
            p++
            node = { t: 'bin', op: tok.t, a: node, b: parseUnary() }
          } else if (isAtomStart(tok)) {
            node = { t: 'bin', op: '*', a: node, b: parseUnary() }
          } else break
        }
        return node
      }

      function parseUnary() {
        const tok = peek()
        if (tok.t === '-') { p++; return { t: 'neg', a: parseUnary() } }
        if (tok.t === '+') { p++; return parseUnary() }
        return parsePower()
      }

      function parsePower() {
        const base = parseAtom()
        if (peek().t === '^') { p++; return { t: 'bin', op: '^', a: base, b: parseUnary() } }
        return base
      }

      function parseAtom() {
        const tok = peek()
        if (tok.t === 'num') { p++; return { t: 'num', v: tok.v } }
        if (tok.t === 'id') {
          p++
          if (peek().t === '(') {
            const name = tok.v
            if (!FUNCS[name]) throw new Error(`unknown function "${name}()"`)
            p++
            const args = []
            if (peek().t !== ')') {
              args.push(parseExpr())
              while (peek().t === ',') { p++; args.push(parseExpr()) }
            }
            if (peek().t !== ')') throw new Error(`missing ")" after ${name}(...)`)
            p++
            return { t: 'call', name, args }
          }
          return { t: 'var', name: tok.v }
        }
        if (tok.t === '(') {
          p++
          const inner = parseExpr()
          if (peek().t !== ')') throw new Error('missing ")"')
          p++
          return inner
        }
        if (tok.t === 'eof') throw new Error('unexpected end of expression')
        throw new Error(`unexpected "${tok.t}" at position ${tok.pos + 1}`)
      }

      const root = parseExpr()
      if (peek().t !== 'eof') throw new Error(`unexpected "${peek().v || peek().t}" at position ${peek().pos + 1}`)
      return root
    }

    // resolver: name -> { idx } | { c } | null
    function makeResolver(map) {
      return (name) => {
        const idx = map.get(name)
        if (idx !== undefined) return { idx }
        if (Object.prototype.hasOwnProperty.call(CONSTS, name)) return { c: CONSTS[name] }
        return null
      }
    }

    function compileNode(node, resolve) {
      switch (node.t) {
        case 'num': {
          const v = node.v
          return () => v
        }
        case 'var': {
          const r = resolve(node.name)
          if (!r) {
            throw new Error(`unknown variable "${node.name}" — write "d${node.name}/dt = ..." to solve for it, or "${node.name} = 1" to make it a parameter`)
          }
          if ('idx' in r) { const i = r.idx; return (s) => s[i] }
          const c = r.c
          return () => c
        }
        case 'neg': {
          const a = compileNode(node.a, resolve)
          return (s) => -a(s)
        }
        case 'bin': {
          const a = compileNode(node.a, resolve)
          const b = compileNode(node.b, resolve)
          switch (node.op) {
            case '+': return (s) => a(s) + b(s)
            case '-': return (s) => a(s) - b(s)
            case '*': return (s) => a(s) * b(s)
            case '/': return (s) => a(s) / b(s)
            case '^': return (s) => Math.pow(a(s), b(s))
            default: throw new Error(`bad operator "${node.op}"`)
          }
        }
        case 'call': {
          const f = FUNCS[node.name]
          const args = node.args.map((a) => compileNode(a, resolve))
          if (args.length === 1) { const a0 = args[0]; return (s) => f(a0(s)) }
          if (args.length === 2) { const a0 = args[0], a1 = args[1]; return (s) => f(a0(s), a1(s)) }
          if (args.length === 3) { const a0 = args[0], a1 = args[1], a2 = args[2]; return (s) => f(a0(s), a1(s), a2(s)) }
          return (s) => {
            const vals = new Array(args.length)
            for (let i = 0; i < args.length; i++) vals[i] = args[i](s)
            return f.apply(null, vals)
          }
        }
        default:
          throw new Error('bad expression node')
      }
    }

    /**
     * One line per statement:
     *   dx/dt = ...   x' = ...   d x / d t = ...   -> state equation
     *   a = 10                                        -> parameter / constant
     * Blank lines and lines starting with # or // are comments.
     */
    function parseSystem(text) {
      const lines = String(text == null ? '' : text).split(/\r?\n/)
      const eqs = []
      const params = []
      for (let i = 0; i < lines.length; i++) {
        let raw = lines[i].trim()
        if (!raw) continue
        if (raw[0] === '#' || raw.slice(0, 2) === '//') continue
        raw = raw.replace(/[;\s]+$/, '')
        const at = raw.indexOf('=')
        if (at < 0) throw new Error(`Line ${i + 1}: expected "=" (write "dx/dt = ..." or "a = 10")`)
        const lhs = raw.slice(0, at).trim()
        const rhs = raw.slice(at + 1).trim()
        if (!rhs) throw new Error(`Line ${i + 1}: right-hand side is empty`)
        const m1 = lhs.match(/^d\s*([A-Za-z_][A-Za-z0-9_]*)\s*\/\s*d\s*([A-Za-z_][A-Za-z0-9_]*)$/i)
        if (m1) { eqs.push({ name: m1[1], independent: m1[2], rhs, line: i + 1 }); continue }
        const m2 = lhs.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*['\u2032]$/)
        if (m2) { eqs.push({ name: m2[1], rhs, line: i + 1 }); continue }
        const m3 = lhs.match(/^([A-Za-z_][A-Za-z0-9_]*)$/)
        if (m3) { params.push({ name: m3[1], rhs, line: i + 1 }); continue }
        throw new Error(`Line ${i + 1}: cannot read the left-hand side "${lhs}"`)
      }
      if (!eqs.length) throw new Error('No equation found — start with something like "dx/dt = y"')

      // Leibniz notation ("dy/dx = ...") names its own independent variable.
      // When that variable has no equation of its own, it becomes a state
      // variable moving at unit speed, so the x–y picture is the solution curve.
      let independentName = 't'
      if (eqs.some((e) => e.independent !== undefined)) {
        const names = []
        for (const e of eqs) {
          if (e.independent === undefined) continue
          if (names.indexOf(e.independent) < 0) names.push(e.independent)
        }
        if (names.length > 1) {
          throw new Error(`Mixed derivatives: pick one independent variable (found ${names.join(', ')})`)
        }
        const indepName = names[0]
        independentName = indepName
        if (indepName !== 't') {
          if (eqs.some((e) => e.name === indepName)) {
            throw new Error(`"${indepName}" is the independent variable of d/d${indepName}, so it cannot also have its own equation`)
          }
          eqs.unshift({ name: indepName, rhs: '1', line: null })
        }
      }

      const vars = []
      for (const e of eqs) {
        if (vars.indexOf(e.name) >= 0) throw new Error(`Variable "${e.name}" is defined twice`)
        vars.push(e.name)
      }
      const paramSeen = new Set()
      for (const p of params) {
        if (vars.indexOf(p.name) >= 0) throw new Error(`"${p.name}" is used both as a variable and as a parameter`)
        if (paramSeen.has(p.name)) throw new Error(`"${p.name}" is defined twice`)
        paramSeen.add(p.name)
      }

      const dim = vars.length
      const indexMap = new Map()
      vars.forEach((v, i) => indexMap.set(v, i))
      params.forEach((p, i) => indexMap.set(p.name, dim + i))
      const tIndex = dim + params.length
      indexMap.set('t', tIndex)

      const scope = new Float64Array(dim + params.length + 1)
      for (let i = 0; i < params.length; i++) {
        const prm = params[i]
        const local = new Map()
        for (let j = 0; j < i; j++) local.set(params[j].name, dim + j)
        let ast, fn
        try { ast = parseExpression(prm.rhs) } catch (err) { throw new Error(`Line ${prm.line}: ${err.message}`) }
        try { fn = compileNode(ast, makeResolver(local)) } catch (err) { throw new Error(`Line ${prm.line}: ${err.message}`) }
        const val = fn(scope)
        if (!Number.isFinite(val)) throw new Error(`Line ${prm.line}: parameter "${prm.name}" is not a finite number`)
        scope[dim + i] = val
      }

      const exprs = []
      for (const e of eqs) {
        let ast, fn
        try { ast = parseExpression(e.rhs) } catch (err) { throw new Error(`Line ${e.line}: ${err.message}`) }
        try { fn = compileNode(ast, makeResolver(indexMap)) } catch (err) { throw new Error(`Line ${e.line}: ${err.message}`) }
        exprs.push(fn)
      }

      const rhs = (t, y, out) => {
        for (let i = 0; i < dim; i++) scope[i] = y[i]
        scope[tIndex] = t
        for (let i = 0; i < dim; i++) out[i] = exprs[i](scope)
      }

      return { vars, paramNames: params.map((p) => p.name), dim, scope, tIndex, independent: independentName, rhs }
    }

    function parseInitial(text, sys) {
      const dim = sys.dim
      const out = new Float64Array(dim)
      const s = String(text == null ? '' : text).trim()
      if (!s) {
        for (let i = 0; i < dim; i++) out[i] = 1
        return out
      }
      const paramMap = new Map()
      for (let i = 0; i < sys.paramNames.length; i++) paramMap.set(sys.paramNames[i], dim + i)
      paramMap.set('t', sys.tIndex)
      const resolve = makeResolver(paramMap)
      const scope = new Float64Array(dim + sys.paramNames.length + 1)
      for (let i = 0; i < sys.paramNames.length; i++) scope[dim + i] = sys.scope[dim + i]

      const parts = s.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)
      const assigned = new Array(dim).fill(false)
      const positional = []
      for (const part of parts) {
        const m = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/)
        if (!m) { positional.push(part); continue }
        const idx = sys.vars.indexOf(m[1])
        if (idx < 0) throw new Error(`Initial state: unknown variable "${m[1]}"`)
        let fn
        try { fn = compileNode(parseExpression(m[2]), resolve) } catch (err) { throw new Error(`Initial state "${m[1]}": ${err.message}`) }
        const v = fn(scope)
        if (!Number.isFinite(v)) throw new Error(`Initial state "${m[1]}" is not a finite number`)
        out[idx] = v
        assigned[idx] = true
      }
      let k = 0
      for (const part of positional) {
        while (k < dim && assigned[k]) k++
        if (k >= dim) throw new Error('Initial state: too many values')
        let fn
        try { fn = compileNode(parseExpression(part), resolve) } catch (err) { throw new Error(`Initial state: ${err.message}`) }
        const v = fn(scope)
        if (!Number.isFinite(v)) throw new Error('Initial state: not a finite number')
        out[k] = v
        assigned[k] = true
        k++
      }
      const missing = []
      for (let i = 0; i < dim; i++) if (!assigned[i]) missing.push(sys.vars[i])
      if (missing.length) throw new Error(`Initial state: missing value for ${missing.join(', ')}`)
      return out
    }

    // Rewrites an initial-state string to match the current variable list, so that
    // switching presets (or editing the equations by hand) does not leave stale
    // entries like "z = 1" behind and block integration. Values the user already
    // gave for surviving variables are kept; new ones default to 0.
    function syncInitial(text, vars) {
      const names = vars || []
      const s = String(text == null ? '' : text).trim()
      if (!names.length) return s
      const given = new Map()
      const positional = []
      let stray = false
      for (const part of s.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)) {
        const m = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/)
        if (!m) { positional.push(part); continue }
        if (names.includes(m[1])) given.set(m[1], m[2].trim())
        else stray = true
      }
      let k = 0
      for (const part of positional) {
        while (k < names.length && given.has(names[k])) k++
        if (k >= names.length) { stray = true; break }
        given.set(names[k], part)
        k++
      }
      const complete = names.every((n) => given.has(n))
      if (complete && !stray) return s
      return names.map((n) => `${n} = ${given.has(n) ? given.get(n) : '0'}`).join(', ')
    }

    function errorText(err) {
      return (err && err.message) || String(err)
    }

    // Compact number for on-canvas annotations (2-decimal feel without trailing zeros).
    function fmtNum(v) {
      if (!Number.isFinite(v)) return '\u221e'
      const a = Math.abs(v)
      if (a >= 1e5 || (a > 0 && a < 1e-3)) return v.toExponential(1)
      return String(Math.round(v * 1000) / 1000)
    }

    function integrate(sys, y0, options) {
      const dim = sys.dim
      const samples = Math.max(16, Math.min(12000, Math.round(options.samples || 2000)))
      const tMax = Math.max(1e-6, Math.min(1e6, Number(options.tMax) || 20))
      const substeps = Math.max(1, Math.min(40, Math.round(options.substeps || 8)))
      const steps = samples * substeps
      const h = tMax / steps
      const n = samples + 1
      const ts = new Float64Array(n)
      const cols = []
      for (let i = 0; i < dim; i++) cols.push(new Float64Array(n))

      const y = new Float64Array(dim)
      for (let i = 0; i < dim; i++) y[i] = y0[i]
      const k1 = new Float64Array(dim), k2 = new Float64Array(dim)
      const k3 = new Float64Array(dim), k4 = new Float64Array(dim)
      const tmp = new Float64Array(dim)

      let t = 0
      let count = 0
      const record = () => {
        ts[count] = t
        for (let i = 0; i < dim; i++) cols[i][count] = y[i]
        count++
      }
      record()

      let diverged = false
      for (let s = 0; s < steps; s++) {
        sys.rhs(t, y, k1)
        for (let i = 0; i < dim; i++) tmp[i] = y[i] + h * 0.5 * k1[i]
        sys.rhs(t + h * 0.5, tmp, k2)
        for (let i = 0; i < dim; i++) tmp[i] = y[i] + h * 0.5 * k2[i]
        sys.rhs(t + h * 0.5, tmp, k3)
        for (let i = 0; i < dim; i++) tmp[i] = y[i] + h * k3[i]
        sys.rhs(t + h, tmp, k4)
        for (let i = 0; i < dim; i++) {
          y[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])
          if (!Number.isFinite(y[i]) || Math.abs(y[i]) > 1e9) { diverged = true; break }
        }
        t += h
        if (diverged) break
        if ((s + 1) % substeps === 0) record()
      }

      return { ts, cols, dim, count, tMax, diverged }
    }

    function niceStep(range) {
      const raw = range / 8
      if (!(raw > 0)) return 1
      const mag = Math.pow(10, Math.floor(Math.log10(raw)))
      const norm = raw / mag
      let mult = 10
      if (norm <= 1) mult = 1
      else if (norm <= 2) mult = 2
      else if (norm <= 5) mult = 5
      return mult * mag
    }

    /* ===================== math-core:end ===================== */

    const PRESETS = [
      {
        id: 'lorenz',
        label: 'preset.lorenz',
        system: 's = 10\nr = 28\nb = 8/3\n\ndx/dt = s*(y - x)\ndy/dt = x*(r - z) - y\ndz/dt = x*y - b*z',
        init: 'x = 1, y = 1, z = 1',
        tMax: 40,
        samples: 2600,
        mode: '3d',
      },
      {
        id: 'rossler',
        label: 'preset.rossler',
        system: 'a = 0.2\nb = 0.2\nc = 5.7\n\ndx/dt = -(y + z)\ndy/dt = x + a*y\ndz/dt = b + z*(x - c)',
        init: '1, 1, 1',
        tMax: 140,
        samples: 3200,
        mode: '3d',
      },
      {
        id: 'lotka',
        label: 'preset.lotka',
        system: 'a = 1.1\nb = 0.4\nc = 0.1\nd = 0.4\n\ndx/dt = x*(a - b*y)\ndy/dt = y*(c*x - d)',
        init: '10, 5',
        tMax: 60,
        samples: 2400,
        mode: '2d',
      },
      {
        id: 'pendulum',
        label: 'preset.pendulum',
        system: 'k = 0.3\n\ndtheta/dt = omega\ndomega/dt = -k*omega - sin(theta)',
        init: 'theta = 2.6, omega = 0',
        tMax: 30,
        samples: 2400,
        mode: '2d',
      },
      {
        id: 'oscillator',
        label: 'preset.oscillator',
        system: 'w = 1\n\ndx/dt = y\ndy/dt = -w^2*x',
        init: '1, 0',
        tMax: 24,
        samples: 1600,
        mode: '2d',
      },
      {
        id: 'vanDerPol',
        label: 'preset.vanDerPol',
        system: 'mu = 1.5\n\ndx/dt = y\ndy/dt = mu*(1 - x*x)*y - x',
        init: '2, 0',
        tMax: 30,
        samples: 2400,
        mode: '2d',
      },
    ]

    const CSS = `
.odelab-root{position:relative;box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45}
.odelab-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;height:56px;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.odelab-head-main{display:flex;align-items:center;gap:9px;min-width:0}
.odelab-head-text{min-width:0}
.odelab-head-title{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.odelab-head-sub{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.odelab-spacer{flex:1 1 auto}
.odelab-seg{display:inline-flex;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.odelab-seg button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:4px 11px;border-radius:6px;cursor:pointer}
.odelab-seg button:disabled{opacity:.35;cursor:default}
.odelab-seg button[data-on="1"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.22)}
.odelab-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:5px 12px;border-radius:8px;cursor:pointer;white-space:nowrap}
html.ode-dock-open body{padding-right:var(--ode-dock-w,480px)}
.odelab-dock-anchor{position:fixed;right:16px;bottom:96px;z-index:60}
.odelab-dock-pill{position:relative;z-index:60;display:flex;align-items:center;gap:8px;padding:8px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.28)}
.odelab-dock-pill:hover{border-color:var(--dsw-alias-brand-primary)}
.odelab-dock{position:fixed;top:8px;right:8px;bottom:8px;z-index:60;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 50px rgba(0,0,0,.42)}
.odelab-dock-bar{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;height:30px;padding:0 6px 0 12px;font-size:12px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.odelab-dock-close{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:4px 8px;border-radius:6px}
.odelab-dock-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.odelab-dock-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.odelab-dock-handle{position:absolute;left:0;top:30px;bottom:0;width:8px;cursor:col-resize;z-index:1}
.odelab-dock-handle:hover{background:linear-gradient(to right,var(--dsw-alias-brand-primary),transparent);opacity:.35}
.odelab-root.is-dock .odelab-head{height:44px;padding:0 10px}
.odelab-root.is-dock .odelab-head-text{display:none}
.odelab-root.is-dock .odelab-body{flex-direction:column-reverse}
.odelab-root.is-dock .odelab-stage{flex:1 1 auto;min-height:200px}
.odelab-root.is-dock .odelab-side{flex:0 0 auto;max-height:42%;border-right:0;border-top:1px solid var(--dsw-alias-border-l1);padding:10px 12px 12px;gap:10px}
.odelab-root.is-dock .odelab-textarea{min-height:84px}
.odelab-root.is-dock .odelab-head{gap:6px}
.odelab-root.is-dock .odelab-label{font-size:10px}
@media (max-width:720px){.odelab-dock{left:8px;width:auto!important}}
.odelab-btn[data-ask="copied"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.odelab-btn:hover{border-color:var(--dsw-alias-border-l2)}
.odelab-body{flex:1 1 auto;display:flex;min-height:0;min-width:0}
.odelab-side{flex:0 0 322px;min-width:0;display:flex;flex-direction:column;gap:13px;padding:14px;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.odelab-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.odelab-label{font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.odelab-textarea,.odelab-input,.odelab-select{box-sizing:border-box;width:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12px;line-height:1.62;outline:none}
.odelab-textarea:focus,.odelab-input:focus,.odelab-select:focus{border-color:var(--dsw-alias-brand-primary)}
.odelab-textarea{min-height:150px;resize:vertical;tab-size:2}
.odelab-select{appearance:none;padding:6px 8px;cursor:pointer}
.odelab-row{display:flex;gap:8px}
.odelab-row>.odelab-field{flex:1 1 0}
.odelab-chips{display:flex;flex-wrap:wrap;gap:6px}
.odelab-chip{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;padding:4px 9px;border-radius:999px;cursor:pointer;white-space:nowrap}
.odelab-chip:hover{color:var(--dsw-alias-label-primary)}
.odelab-chip[data-on="1"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.odelab-note{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.odelab-error{margin:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 10px;white-space:pre-wrap;word-break:break-word;max-height:140px;overflow:auto}
.odelab-stage{position:relative;flex:1 1 auto;min-width:0;min-height:0;background:var(--dsw-alias-bg-base)}
.odelab-canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab}
.odelab-canvas[data-drag="1"]{cursor:grabbing}
.odelab-hint{position:absolute;left:14px;bottom:10px;font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.75;pointer-events:none}
.odelab-badges{position:absolute;right:12px;top:10px;display:flex;gap:6px;pointer-events:none}
.odelab-badges span{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.odelab-stage-error{position:absolute;left:14px;right:14px;bottom:30px}
`

    const L10N = {
      zh: {
        title: '微分方程演化',
        subtitle: '输入方程组，观察流的演化',
        equations: '方程组',
        parameters: '参数',
        initial: '初始状态',
        horizon: '时间跨度',
        samples: '采样点',
        projection: '投影',
        mode2d: '二维',
        mode3d: '三维',
        presets: '预设',
        play: '播放',
        pause: '暂停',
        resetView: '重置视角',
        askAi: '问 AI',
        askAiCopied: '已复制，去聊天里粘贴',
        askAiFailed: '复制失败，手动输入吧',
        askAiHint: '复制一句现成的提问，粘贴到右侧聊天，让模型读取面板并讲解',
        askAiPrompt: '请用 ode_lab_snapshot 读取侧栏「微分方程演化」面板此刻的方程组和状态，然后用三句话讲解：它是什么系统、为什么会这样演化、改动其中一个参数会发生什么。',
        dockTitle: '微分方程 · 同屏教学',
        dockOpen: '打开方程面板',
        dockClose: '收起',
        dockResize: '拖动调整宽度',

        apply: '运行',
        error: '无法积分',
        hint: "每行一个方程，三种写法都认：dx/dt = 10*(y-x) 、dy/dx = x^2 + y^2 、y' = y。参数写在上面，如 a = 10。",
        drag: '拖拽旋转 · 滚轮缩放 · 双击重置',
        noData: '还没有轨迹',
        diverged: '解已发散',
        divergedNote: '轨迹在奇点前截断：解在这里真的跑到无穷大（不是算错），把时间跨度调到奇点之前能看完整形状',
        timeLabel: 't',
        'preset.lorenz': '洛伦兹吸引子',
        'preset.rossler': '罗斯勒吸引子',
        'preset.lotka': '洛特卡–沃尔泰拉',
        'preset.pendulum': '阻尼摆',
        'preset.oscillator': '谐振子',
        'preset.vanDerPol': '范德波尔振子',
      },
      en: {
        title: 'ODE Evolution Lab',
        subtitle: 'Type a system, watch the flow',
        equations: 'Equations',
        parameters: 'Parameters',
        initial: 'Initial state',
        horizon: 'Time span',
        samples: 'Samples',
        projection: 'Projection',
        mode2d: '2D',
        mode3d: '3D',
        presets: 'Presets',
        play: 'Play',
        pause: 'Pause',
        resetView: 'Reset view',
        askAi: 'Ask AI',
        askAiCopied: 'Copied — paste it in the chat',
        askAiFailed: 'Copy failed — type it instead',
        askAiHint: 'Copy a ready-made question and paste it into the chat so the model can read this panel and explain it',
        askAiPrompt: 'Use ode_lab_snapshot to read the equations and state of the ODE panel in the sidebar, then explain in three sentences: what system this is, why it evolves like this, and what happens if I change one parameter.',
        dockTitle: 'ODE panel · side by side',
        dockOpen: 'Open ODE panel',
        dockClose: 'Hide',
        dockResize: 'Drag to resize',

        apply: 'Run',
        error: 'Cannot integrate',
        hint: "One equation per line; dx/dt = 10*(y-x), dy/dx = x^2 + y^2 and y' = y all work. Parameters go above as a = 10.",
        drag: 'Drag to rotate · scroll to zoom · double-click to reset',
        noData: 'No trajectory yet',
        diverged: 'Solution diverged',
        divergedNote: 'Trail cut before the singularity — the solution really blows up here; shrink the horizon to see the full shape',
        timeLabel: 't',
        'preset.lorenz': 'Lorenz',
        'preset.rossler': 'Rössler',
        'preset.lotka': 'Lotka–Volterra',
        'preset.pendulum': 'Damped pendulum',
        'preset.oscillator': 'Harmonic oscillator',
        'preset.vanDerPol': 'Van der Pol',
      },
    }

    function readTheme(el) {
      const fallback = {
        bg: '#101319', panel: '#181c24', layer2: '#222732',
        border1: 'rgba(255,255,255,0.10)', border2: 'rgba(255,255,255,0.20)',
        brand: '#5ad1c8', label: '#e8ebf1', label2: '#98a1b2',
        error: '#e46c6c', idle: '#8a93a6', success: '#5fbf7f', warn: '#f1b34d',
      }
      if (!el || typeof window === 'undefined') return fallback
      let cs
      try { cs = window.getComputedStyle(el) } catch (e) { return fallback }
      if (!cs) return fallback
      const pick = (name, fb) => {
        let v = ''
        try { v = cs.getPropertyValue(name) } catch (e) { v = '' }
        v = (v || '').trim()
        return v || fb
      }
      return {
        bg: pick('--dsw-alias-bg-base', fallback.bg),
        panel: pick('--dsw-alias-bg-layer-1', fallback.panel),
        layer2: pick('--dsw-alias-bg-layer-2', fallback.layer2),
        border1: pick('--dsw-alias-border-l1', fallback.border1),
        border2: pick('--dsw-alias-border-l2', fallback.border2),
        brand: pick('--dsw-alias-brand-primary', fallback.brand),
        label: pick('--dsw-alias-label-primary', fallback.label),
        label2: pick('--dsw-alias-label-secondary', fallback.label2),
        error: pick('--dsw-alias-state-error-primary', fallback.error),
        idle: pick('--dsw-alias-state-idle-primary', fallback.idle),
        success: pick('--dsw-alias-state-success-primary', fallback.success),
        warn: pick('--dsw-alias-state-warn-primary', fallback.warn),
      }
    }

    function makeRotator(yaw, pitch) {
      const cy = Math.cos(yaw), sy = Math.sin(yaw)
      const cp = Math.cos(pitch), sp = Math.sin(pitch)
      return (x, y, z) => {
        const x1 = x * cy - z * sy
        const z1 = x * sy + z * cy
        const y1 = y * cp - z1 * sp
        return [x1, -y1]
      }
    }

    function paint(canvas, o) {
      const c = canvas.getContext('2d')
      if (!c) return
      const theme = o.theme
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const W = Math.max(1, Math.round(canvas.clientWidth))
      const H = Math.max(1, Math.round(canvas.clientHeight))
      const pw = Math.round(W * dpr)
      const ph = Math.round(H * dpr)
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
      }
      c.setTransform(dpr, 0, 0, dpr, 0, 0)
      c.clearRect(0, 0, W, H)

      const traj = o.traj
      if (!traj || !traj.cols || traj.count < 2) {
        c.fillStyle = theme.label2
        c.font = '12px ui-sans-serif,system-ui,sans-serif'
        c.textAlign = 'center'
        c.fillText(o.emptyText || 'no trajectory', W / 2, H / 2)
        return
      }

      const dim = traj.dim
      const n = traj.count
      const mode3d = o.mode === '3d' && dim >= 3
      const px = new Float32Array(n)
      const py = new Float32Array(n)

      if (dim < 2) {
        for (let i = 0; i < n; i++) { px[i] = traj.ts[i]; py[i] = -traj.cols[0][i] }
      } else if (mode3d) {
        const ax = Math.min(o.axes[0], dim - 1)
        const ay = Math.min(o.axes[1], dim - 1)
        const az = Math.min(o.axes[2], dim - 1)
        const rot = makeRotator(o.yaw, o.pitch)
        const cx = traj.cols[ax], cy = traj.cols[ay], cz = traj.cols[az]
        for (let i = 0; i < n; i++) {
          const q = rot(cx[i], cy[i], cz[i])
          px[i] = q[0]
          py[i] = q[1]
        }
      } else {
        const ax = Math.min(o.axes[0], dim - 1)
        const ay = Math.min(o.axes[1], dim - 1)
        const cx = traj.cols[ax], cy = traj.cols[ay]
        for (let i = 0; i < n; i++) { px[i] = cx[i]; py[i] = -cy[i] }
      }

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (let i = 0; i < n; i++) {
        const x = px[i], y = py[i]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      if (!isFinite(minX)) { minX = -1; maxX = 1; minY = -1; maxY = 1 }
      if (traj.diverged && n > 16) {
        // A blow-up throws one coordinate to ~1e9 and squashes everything else
        // into a hairline. Re-fit on the bulk of the trail: skip points beyond
        // 24x the typical deviation (the runaway tail simply leaves the frame).
        const stride = Math.max(1, Math.floor(n / 400))
        const sx = []
        const sy = []
        for (let i = 0; i < n; i += stride) { sx.push(px[i]); sy.push(py[i]) }
        sx.sort((a, b) => a - b)
        sy.sort((a, b) => a - b)
        const medX = sx[sx.length >> 1]
        const medY = sy[sy.length >> 1]
        // Median absolute deviation: resistant to the handful of exploding samples,
        // unlike a percentile (the blow-up is monotone, so it poisons the top decile).
        const dev = (arr, m, fallback) => {
          const d = arr.map((v) => Math.abs(v - m)).sort((a, b) => a - b)
          const v = 1.4826 * d[d.length >> 1]
          return v > 0 ? v : Math.max(1e-9, fallback)
        }
        const scaleX = dev(sx, medX, sx[sx.length - 1] - sx[0])
        const scaleY = dev(sy, medY, sy[sy.length - 1] - sy[0])
        const limX = scaleX * 30
        const limY = scaleY * 30
        let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity
        let kept = 0
        for (let i = 0; i < n; i++) {
          if (Math.abs(px[i] - medX) > limX || Math.abs(py[i] - medY) > limY) continue
          kept++
          if (px[i] < bx0) bx0 = px[i]
          if (px[i] > bx1) bx1 = px[i]
          if (py[i] < by0) by0 = py[i]
          if (py[i] > by1) by1 = py[i]
        }
        if (kept >= 8 && isFinite(bx0) && isFinite(by0)) {
          minX = bx0; maxX = bx1; minY = by0; maxY = by1
        }
      }
      const spanX = Math.max(1e-9, maxX - minX)
      const spanY = Math.max(1e-9, maxY - minY)
      const pad = 36
      let scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY)
      if (!isFinite(scale) || scale <= 0) scale = 1
      scale *= o.zoom
      const ox = W / 2 - ((minX + maxX) / 2) * scale + o.panX
      const oy = H / 2 - ((minY + maxY) / 2) * scale + o.panY
      const X = (i) => ox + px[i] * scale
      const Y = (i) => oy + py[i] * scale

      // ---- grid ----
      const step = niceStep(90 / scale)
      const wx0 = (0 - ox) / scale
      const wx1 = (W - ox) / scale
      const wy0 = (0 - oy) / scale
      const wy1 = (H - oy) / scale
      c.lineWidth = 1
      c.strokeStyle = theme.border1
      c.globalAlpha = 0.45
      c.beginPath()
      for (let v = Math.ceil(wx0 / step) * step; v <= wx1; v += step) {
        const sx = Math.round(ox + v * scale) + 0.5
        c.moveTo(sx, 0)
        c.lineTo(sx, H)
      }
      for (let v = Math.ceil(wy0 / step) * step; v <= wy1; v += step) {
        const sy = Math.round(oy + v * scale) + 0.5
        c.moveTo(0, sy)
        c.lineTo(W, sy)
      }
      c.stroke()
      c.globalAlpha = 1

      if (mode3d) {
        // axis triad in the corner
        const rot = makeRotator(o.yaw, o.pitch)
        const bx = W - 62, by = H - 54
        const unit = 30
        const axisLabel = (slot) => {
          const index = Math.min(o.axes[slot], dim - 1)
          const names = o.vars || []
          const nm = names[index]
          return typeof nm === 'string' && nm ? nm : 'x' + String(index + 1)
        }
        const axesNames = [axisLabel(0), axisLabel(1), axisLabel(2)]
        const dirs = [rot(1, 0, 0), rot(0, 1, 0), rot(0, 0, 1)]
        c.font = '10px ui-sans-serif,system-ui,sans-serif'
        c.textAlign = 'center'
        c.textBaseline = 'middle'
        for (let a = 0; a < 3; a++) {
          const ex = bx + dirs[a][0] * unit
          const ey = by + dirs[a][1] * unit
          c.strokeStyle = a === 2 ? theme.warn : theme.label2
          c.globalAlpha = 0.85
          c.lineWidth = 1.3
          c.beginPath()
          c.moveTo(bx, by)
          c.lineTo(ex, ey)
          c.stroke()
          c.globalAlpha = 1
          c.fillStyle = a === 2 ? theme.warn : theme.label2
          c.fillText(String(axesNames[a]), bx + dirs[a][0] * (unit + 8), by + dirs[a][1] * (unit + 8))
        }
      } else {
        // zero axes
        c.strokeStyle = theme.border2
        c.globalAlpha = 0.8
        c.lineWidth = 1
        c.beginPath()
        const zx = ox
        const zy = oy
        if (zx >= 0 && zx <= W) { c.moveTo(Math.round(zx) + 0.5, 0); c.lineTo(Math.round(zx) + 0.5, H) }
        if (zy >= 0 && zy <= H) { c.moveTo(0, Math.round(zy) + 0.5); c.lineTo(W, Math.round(zy) + 0.5) }
        c.stroke()
        c.globalAlpha = 1
      }

      // ---- trajectory ----
      const drawPath = (upto, width, alpha, blur) => {
        if (upto < 1) return
        c.beginPath()
        c.moveTo(X(0), Y(0))
        for (let i = 1; i <= upto; i++) c.lineTo(X(i), Y(i))
        c.strokeStyle = theme.brand
        c.lineWidth = width
        c.lineJoin = 'round'
        c.lineCap = 'round'
        c.globalAlpha = alpha
        if (blur > 0) { c.shadowColor = theme.brand; c.shadowBlur = blur }
        c.stroke()
        c.shadowBlur = 0
        c.globalAlpha = 1
      }

      drawPath(n - 1, 1, 0.16, 0)

      const p = Math.max(0, Math.min(1, o.progress || 0))
      const head = Math.max(1, Math.round(p * (n - 1)))
      drawPath(head, 1.7, 1, 7)

      // start / end markers
      c.fillStyle = theme.success
      c.beginPath()
      c.arc(X(0), Y(0), 3, 0, Math.PI * 2)
      c.fill()

      c.strokeStyle = theme.warn
      c.lineWidth = 1.2
      c.beginPath()
      c.arc(X(n - 1), Y(n - 1), 2.8, 0, Math.PI * 2)
      c.stroke()

      // moving head
      const hx = X(head)
      const hy = Y(head)
      const glow = c.createRadialGradient(hx, hy, 0, hx, hy, 14)
      glow.addColorStop(0, theme.brand)
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      c.globalAlpha = 0.5
      c.fillStyle = glow
      c.beginPath()
      c.arc(hx, hy, 14, 0, Math.PI * 2)
      c.fill()
      c.globalAlpha = 1
      c.fillStyle = theme.brand
      c.beginPath()
      c.arc(hx, hy, 2.6, 0, Math.PI * 2)
      c.fill()

      if (traj.diverged && o.divergedText) {
        c.fillStyle = theme.error
        c.font = '11px ui-sans-serif,system-ui,sans-serif'
        c.textAlign = 'left'
        c.textBaseline = 'alphabetic'
        c.fillText(o.divergedText, 14, 22)
      }
    }

    function readDockFlag(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null || raw === undefined) return fallback
        return raw === '1'
      } catch (err) { return fallback }
    }

    function writeDockFlag(key, value) {
      try { window.localStorage.setItem(key, value ? '1' : '0') } catch (err) { /* private mode */ }
    }

    function readDockWidth() {
      try {
        const raw = Number(window.localStorage.getItem('dsh-ode-lab.dock.width'))
        if (Number.isFinite(raw) && raw >= 320) return clampWidth(raw)
      } catch (err) { /* ignore */ }
      return 480
    }

    function clampWidth(value) {
      const viewport = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1280
      const max = Math.max(360, viewport - 360)
      return Math.round(Math.min(Math.max(value, 360), max))
    }

    // The teaching layout: chat on the left, this panel floating on the right.
    // It lives in shell.overlay so it survives panel navigation — the chat keeps
    // running underneath while the user changes equations and asks questions.
    function OdeLabDock(props) {
      const t = typeof props.t === 'function' ? props.t : (k) => k
      const [open, setOpen] = React.useState(() => readDockFlag('dsh-ode-lab.dock.open', false))
      const [width, setWidth] = React.useState(readDockWidth)
      const [dragging, setDragging] = React.useState(false)
      const [dockTop, setDockTop] = React.useState(() => detectDockTop())

      React.useEffect(() => {
        if (!open) return undefined
        // Re-measure when the panel opens: the shell may have finished mounting.
        const raf = window.requestAnimationFrame(() => setDockTop(detectDockTop()))
        return () => window.cancelAnimationFrame(raf)
      }, [open])

      React.useEffect(() => {
        if (!dragging) return undefined
        const move = (event) => {
          const next = clampWidth(event.clientX ? (window.innerWidth - event.clientX - 8) : width)
          setWidth(next)
        }
        const up = () => setDragging(false)
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
        }
      }, [dragging, width])

      React.useEffect(() => {
        writeDockFlag('dsh-ode-lab.dock.open', open)
        if (open) {
          try { window.localStorage.setItem('dsh-ode-lab.dock.width', String(width)) } catch (err) { /* ignore */ }
        }
      }, [open, width])

      // Reserve real layout space for the dock so the chat column reflows left
      // instead of hiding its composer behind the panel.
      React.useEffect(() => {
        const root = document.documentElement
        if (!root) return undefined
        root.classList.toggle('ode-dock-open', open)
        root.style.setProperty('--ode-dock-w', width + 'px')
        return () => {
          root.classList.remove('ode-dock-open')
          root.style.removeProperty('--ode-dock-w')
        }
      }, [open, width])

      if (!open) {
        return h('div', { className: 'odelab-dock-anchor' },
          h('style', null, CSS),
          h('button', {
            type: 'button',
            className: 'odelab-dock-pill',
            title: t('subtitle'),
            onClick: () => setOpen(true),
          }, h(OdeLabMark, { size: 16 }), h('span', null, t('dockOpen')))
        )
      }

      return h('div', { className: 'odelab-dock', style: { width: width + 'px', top: dockTop + 'px' } },
        h('style', null, CSS),
        h('div', { className: 'odelab-dock-bar' },
          h('span', null, t('dockTitle')),
          h('button', { type: 'button', className: 'odelab-dock-close', onClick: () => setOpen(false) }, t('dockClose'))
        ),
        h('div', { className: 'odelab-dock-body' }, h(OdeLabPanel, { t, variant: 'dock' })),
        h('div', {
          className: 'odelab-dock-handle',
          title: t('dockResize'),
          onPointerDown: (event) => {
            try { event.currentTarget.setPointerCapture(event.pointerId) } catch (err) { /* ignore */ }
            setDragging(true)
          },
        })
      )
    }

    function toDispose(x) {
      return typeof x === 'function' ? x : () => {}
    }

    function useDebounced(value, ms) {
      const [v, setV] = React.useState(value)
      React.useEffect(() => {
        const id = setTimeout(() => setV(value), ms)
        return () => clearTimeout(id)
      }, [value, ms])
      return v
    }

    function numFrom(text, fallback, min, max) {
      const v = parseFloat(String(text).replace(',', '.'))
      if (!Number.isFinite(v)) return fallback
      return Math.max(min, Math.min(max, v))
    }

    // ---- conversation bridge ------------------------------------------------
    // The panel and the agent share this plugin: the panel reports what it is
    // showing (POST /ode-lab/state) and polls for "change this" commands queued
    // by the host-side tools (GET /ode-lab/command). Same origin, so no CORS.
    // The desktop shell draws an overlay title bar over the page (its window
    // buttons occupy the top ~60px), so a dock pinned to the very top slides
    // under them. Measure that band instead of guessing: any full-width drag
    // region sitting at the top of the window IS the title bar.
    const IS_DESKTOP_SHELL = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent || '')

    function detectDockTop() {
      // The Windows shell uses titleBarStyle:"hidden" + titleBarOverlay, so the
      // native window buttons float above the page. The app exposes the band it
      // reserves as --dsh-frame-top-clearance (set on <html data-windows-titlebar>).
      try {
        const root = document.documentElement
        if (!root) return 8
        const readPx = (name) => {
          const raw = String(window.getComputedStyle(root).getPropertyValue(name) || '').trim()
          const parsed = parseFloat(raw)
          return Number.isFinite(parsed) ? parsed : NaN
        }
        const clearance = readPx('--dsh-frame-top-clearance')
        if (Number.isFinite(clearance) && clearance > 0) return Math.round(clearance) + 8
        if (root.hasAttribute('data-windows-titlebar')) {
          const band = readPx('--dsh-windows-titlebar-height')
          return Math.round(Number.isFinite(band) && band > 0 ? band : 40) + 8
        }
        if (IS_DESKTOP_SHELL) return 48
      } catch (e) {
        /* fall through */
      }
      return 8
    }

    const BRIDGE = '/ode-lab'
    const BRIDGE_POLL_MS = 1500

    function bridgeBase() {
      try {
        if (typeof window === 'undefined' || !window.location) return ''
        const origin = window.location.origin
        if (!origin || origin === 'null') return ''
        return origin
      } catch (err) {
        return ''
      }
    }

    function bridgeJson(path, options) {
      const base = bridgeBase()
      if (!base || typeof fetch !== 'function') return Promise.resolve(null)
      try {
        return fetch(base + path, options)
          .then((res) => (res && res.ok ? res.json() : null))
          .catch(() => null)
      } catch (err) {
        return Promise.resolve(null)
      }
    }

    function fmtNum3(v) {
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v)
      if (n !== 0 && (Math.abs(n) >= 1e5 || Math.abs(n) < 1e-3)) return n.toExponential(2)
      return String(Math.round(n * 1000) / 1000)
    }

    // Snapshot handed to the host half, which turns it into text for the model.
    function buildStatePayload(input) {
      const sys = input.sys || null
      const traj = input.traj || null
      const payload = {
        equations: String(input.equations || ''),
        init: String(input.init || ''),
        tMax: input.tMax,
        samples: input.samples,
        mode: input.mode,
        axes: (input.axes || []).slice(0, 3),
      }
      if (sys) {
        payload.vars = sys.vars.slice()
        payload.independent = sys.independent || 't'
      }
      if (input.error) payload.error = String(input.error)
      if (traj && traj.count > 0) {
        const indepName = (sys && sys.independent) || 't'
        const indepIndex = sys ? sys.vars.indexOf(indepName) : -1
        payload.diverged = !!traj.diverged
        if (traj.diverged) {
          payload.stopAt = indepIndex >= 0
            ? fmtNum3(traj.cols[indepIndex][traj.count - 1])
            : fmtNum3(traj.ts[traj.count - 1])
        }
        const ranges = {}
        if (sys) {
          sys.vars.forEach((name, i) => {
            const col = traj.cols[i]
            let lo = Infinity
            let hi = -Infinity
            for (let k = 0; k < traj.count; k++) {
              const v = col[k]
              if (v < lo) lo = v
              if (v > hi) hi = v
            }
            if (Number.isFinite(lo) && Number.isFinite(hi)) ranges[name] = [fmtNum3(lo), fmtNum3(hi)]
          })
        }
        payload.stats = { ranges, points: traj.count }
      }
      return payload
    }

    // Applies one queued command to the panel state. Returns the field names it
    // touched so tests (and the panel) can tell a no-op from a real change.
    function applyPanelPatch(patch, setters) {
      const applied = []
      if (!patch || typeof patch !== 'object' || !setters) return applied
      if (typeof patch.equations === 'string' && patch.equations.trim()) {
        setters.setSystemText(patch.equations)
        if (setters.setPresetId) setters.setPresetId('')
        applied.push('equations')
      }
      if (typeof patch.init === 'string' && patch.init.trim()) {
        setters.setInitText(patch.init)
        applied.push('init')
      }
      if (Number.isFinite(Number(patch.tMax)) && Number(patch.tMax) > 0) {
        setters.setTMaxText(String(patch.tMax))
        applied.push('tMax')
      }
      if (Number.isFinite(Number(patch.samples)) && Number(patch.samples) > 0) {
        setters.setSamplesText(String(Math.round(Number(patch.samples))))
        applied.push('samples')
      }
      if (patch.mode === '2d' || patch.mode === '3d') {
        setters.setMode(patch.mode)
        applied.push('mode')
      }
      if (Array.isArray(patch.axes) && patch.axes.length && setters.setAxes) {
        const axes = patch.axes
          .map((item) => Math.round(Number(item)))
          .filter((item) => Number.isFinite(item) && item >= 0)
          .slice(0, 3)
        if (axes.length) {
          setters.setAxes(axes)
          applied.push('axes')
        }
      }
      return applied
    }

    function OdeLabMark(props) {
      const size = props.size || 22
      const color = props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: color, strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M3.5 18.5C4 11.5 11 4.5 18.5 4.5c2.8 0 4.5 1.8 4.5 4.2 0 3.6-4.6 5.4-8 5.4' }),
        h('path', { d: 'M3.5 18.5c4 2.6 9.4 1.4 12-1.6' }),
        h('circle', { cx: 3.5, cy: 18.5, r: 1.6, fill: color, stroke: 'none' }),
        h('circle', { cx: 13.5, cy: 11.5, r: 1.1, fill: color, stroke: 'none' })
      )
    }

    function OdeLabIcon(props) {
      const size = props && props.size ? props.size : 22
      return h(OdeLabMark, { size, active: !!(props && props.active) })
    }

    function OdeLabPanel(props) {
      const t = typeof props.t === 'function' ? props.t : (k) => k
      const docked = props.variant === 'dock'

      const rootRef = React.useRef(null)
      const stageRef = React.useRef(null)
      const canvasRef = React.useRef(null)
      const drawRef = React.useRef(() => {})
      const themeRef = React.useRef(null)
      const dirtyRef = React.useRef(true)
      const playingRef = React.useRef(true)
      const progressRef = React.useRef(0)
      const dragRef = React.useRef(null)

      const first = PRESETS[0]
      const [presetId, setPresetId] = React.useState(first.id)
      const [systemText, setSystemText] = React.useState(first.system)
      const [initText, setInitText] = React.useState(first.init)
      const [tMaxText, setTMaxText] = React.useState(String(first.tMax))
      const [samplesText, setSamplesText] = React.useState(String(first.samples))
      const [mode, setMode] = React.useState(first.mode)
      const [axes, setAxes] = React.useState([0, 1, 2])
      const [playing, setPlaying] = React.useState(true)
      const [dragging, setDragging] = React.useState(false)
      const [themeTick, setThemeTick] = React.useState(0)
      const [view, setView] = React.useState({ yaw: 0.62, pitch: 0.36, zoom: 1, panX: 0, panY: 0 })

      const dbSystem = useDebounced(systemText, 260)
      const dbInit = useDebounced(initText, 200)

      const tMax = numFrom(tMaxText, first.tMax, 0.001, 5000)
      const samples = Math.round(numFrom(samplesText, first.samples, 64, 12000))

      const model = React.useMemo(() => {
        let sys
        try {
          sys = parseSystem(dbSystem)
        } catch (err) {
          return { sys: null, traj: null, vars: [], dim: 0, error: errorText(err) }
        }
        // A stale initial state (e.g. "z = 1" after switching to a 2-variable
        // system) must not blank the canvas: fall back to zeros and let the
        // syncInitial effect rewrite the text on the next tick.
        let y0
        try {
          y0 = parseInitial(dbInit, sys)
        } catch (err) {
          y0 = new Float64Array(sys.dim)
        }
        try {
          const traj = integrate(sys, y0, { samples, tMax, substeps: 8 })
          return { sys, traj, vars: sys.vars, dim: sys.dim, error: null }
        } catch (err) {
          return { sys, traj: null, vars: sys.vars, dim: sys.dim, error: errorText(err) }
        }
      }, [dbSystem, dbInit, tMax, samples])

      const dim = model.dim
      const varsKey = model.vars.join(',')
      const axesKey = (axes || []).join(',')

      // Report what the panel shows so the agent can read it back with
      // ode_lab_snapshot. Debounced: typing in the textarea must not spam.
      const payloadRef = React.useRef(null)
      React.useEffect(() => {
        const payload = buildStatePayload({
          equations: systemText,
          init: initText,
          tMax,
          samples,
          mode,
          axes,
          sys: model.sys,
          traj: model.traj,
          error: model.error,
        })
        payloadRef.current = payload
        let cancelled = false
        const id = setTimeout(() => {
          if (cancelled) return
          bridgeJson(BRIDGE + '/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        }, 400)
        return () => {
          cancelled = true
          clearTimeout(id)
        }
      }, [systemText, initText, tMax, samples, mode, axesKey, model])

      // Heartbeat: the host treats a panel that has not spoken for ~8s as closed,
      // so the agent knows whether its snapshot is still what the user sees.
      React.useEffect(() => {
        const id = setInterval(() => {
          const payload = payloadRef.current
          if (!payload) return
          bridgeJson(BRIDGE + '/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        }, 3000)
        return () => clearInterval(id)
      }, [])

      // Poll for commands queued by ode_lab_set (and the debug POST door).
      const sinceRef = React.useRef(0)
      const applyRef = React.useRef(null)
      applyRef.current = (patch) => applyPanelPatch(patch, {
        setSystemText,
        setInitText,
        setTMaxText,
        setSamplesText,
        setMode,
        setAxes,
        setPresetId,
      })

      React.useEffect(() => {
        let stopped = false
        const tick = () => {
          bridgeJson(BRIDGE + '/command?since=' + sinceRef.current).then((res) => {
            if (stopped || !res || !Array.isArray(res.commands)) return
            res.commands.forEach((command) => {
              if (!command) return
              if (typeof command.seq === 'number' && command.seq > sinceRef.current) sinceRef.current = command.seq
              if (command.patch && applyRef.current) applyRef.current(command.patch)
            })
          })
        }
        const id = setInterval(tick, BRIDGE_POLL_MS)
        tick()
        return () => {
          stopped = true
          clearInterval(id)
        }
      }, [])

      React.useEffect(() => {
        if (!varsKey) return
        setInitText((prev) => syncInitial(prev, varsKey.split(',')))
      }, [varsKey])

      React.useEffect(() => {
        if (!dim) return
        setAxes((prev) => {
          const next = prev.map((v) => Math.min(v, dim - 1))
          if (dim >= 2 && next[0] === next[1]) next[1] = (next[0] + 1) % dim
          if (dim >= 3 && (next[2] === next[0] || next[2] === next[1])) next[2] = (next[0] + 2) % dim
          if (next[0] === prev[0] && next[1] === prev[1] && next[2] === prev[2]) return prev
          return next
        })
        if (dim < 3) setMode((m) => (m === '3d' ? '2d' : m))
      }, [model, dim])

      React.useEffect(() => {
        progressRef.current = 0
        dirtyRef.current = true
      }, [model])

      React.useEffect(() => {
        playingRef.current = playing
      }, [playing])

      React.useEffect(() => {
        dirtyRef.current = true
      }, [mode, axes, view, themeTick])

      React.useEffect(() => {
        const root = document.documentElement
        const body = document.body
        const bump = () => {
          themeRef.current = null
          setThemeTick((v) => v + 1)
        }
        const mo = new MutationObserver(bump)
        try { mo.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] }) } catch (e) { /* noop */ }
        if (body && body !== root) {
          try { mo.observe(body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] }) } catch (e) { /* noop */ }
        }
        return () => mo.disconnect()
      }, [])

      const indepName = model.sys && model.sys.independent ? model.sys.independent : 't'
      let divergedText = ''
      if (model.traj && model.traj.diverged) {
        // The independent variable is a state variable for Leibniz systems
        // (with dy/dx, x runs at unit speed), so read its value from the columns;
        // for dx/dt systems it is the integrator clock.
        const indepIndex = model.vars.indexOf(indepName)
        const stop = indepIndex >= 0
          ? model.traj.cols[indepIndex][model.traj.count - 1]
          : model.traj.ts[model.traj.count - 1]
        divergedText = t('diverged') + ' · ' + indepName + ' ≈ ' + fmtNum(stop)
      }

      drawRef.current = () => {
        const canvas = canvasRef.current
        if (!canvas || !canvas.isConnected) return
        const theme = themeRef.current || (themeRef.current = readTheme(rootRef.current))
        paint(canvas, {
          traj: model.traj,
          vars: model.vars,
          axes,
          mode,
          yaw: view.yaw,
          pitch: view.pitch,
          zoom: view.zoom,
          panX: view.panX,
          panY: view.panY,
          progress: progressRef.current,
          theme,
          emptyText: t('noData'),
          divergedText: divergedText,
        })
      }

      React.useEffect(() => {
        const canvas = canvasRef.current
        const stage = stageRef.current
        if (!canvas) return
        let raf = 0
        let last = performance.now()

        const onWheel = (e) => {
          e.preventDefault()
          const k = Math.exp(-e.deltaY * 0.0014)
          setView((v) => ({ ...v, zoom: Math.max(0.15, Math.min(24, v.zoom * k)) }))
        }
        canvas.addEventListener('wheel', onWheel, { passive: false })

        const loop = (now) => {
          const dt = Math.min(0.12, Math.max(0, (now - last) / 1000))
          last = now
          if (canvas.clientWidth > 0 && canvas.isConnected) {
            if (playingRef.current) {
              progressRef.current = (progressRef.current + dt * 0.16) % 1
              dirtyRef.current = true
            }
            if (dirtyRef.current) {
              dirtyRef.current = false
              drawRef.current()
            }
          }
          raf = requestAnimationFrame(loop)
        }
        raf = requestAnimationFrame(loop)

        let ro = null
        if (typeof ResizeObserver !== 'undefined' && stage) {
          ro = new ResizeObserver(() => { dirtyRef.current = true })
          ro.observe(stage)
        }
        return () => {
          cancelAnimationFrame(raf)
          canvas.removeEventListener('wheel', onWheel)
          if (ro) ro.disconnect()
        }
      }, [])

      const applyPreset = (p) => {
        setPresetId(p.id)
        setSystemText(p.system)
        setInitText(p.init)
        setTMaxText(String(p.tMax))
        setSamplesText(String(p.samples))
        setMode(p.mode)
        setAxes([0, 1, 2])
        setView({ yaw: 0.62, pitch: 0.36, zoom: 1, panX: 0, panY: 0 })
        progressRef.current = 0
      }

      const resetView = () => setView({ yaw: 0.62, pitch: 0.36, zoom: 1, panX: 0, panY: 0 })

      // Panel -> chat handoff. The client half has no composer service, so the
      // cheapest honest bridge is a ready-made question on the clipboard.
      const [askState, setAskState] = React.useState('idle')
      const askAi = () => {
        const finish = (ok) => {
          setAskState(ok ? 'copied' : 'failed')
          setTimeout(() => setAskState('idle'), 1900)
        }
        try {
          const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null
          if (clip && typeof clip.writeText === 'function') {
            clip.writeText(t('askAiPrompt')).then(() => finish(true), () => finish(false))
            return
          }
        } catch (err) { /* fall through to the failure state */ }
        finish(false)
      }

      const onPointerDown = (e) => {
        const canvas = canvasRef.current
        if (!canvas) return
        try { canvas.setPointerCapture(e.pointerId) } catch (err) { /* noop */ }
        dragRef.current = {
          id: e.pointerId, x: e.clientX, y: e.clientY,
          yaw: view.yaw, pitch: view.pitch, panX: view.panX, panY: view.panY,
        }
        setDragging(true)
      }

      const onPointerMove = (e) => {
        const d = dragRef.current
        if (!d || d.id !== e.pointerId) return
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        if (mode === '3d' && dim >= 3) {
          setView((v) => ({
            ...v,
            yaw: d.yaw + dx * 0.01,
            pitch: Math.max(-1.45, Math.min(1.45, d.pitch + dy * 0.01)),
          }))
        } else {
          setView((v) => ({ ...v, panX: d.panX + dx, panY: d.panY + dy }))
        }
      }

      const endDrag = (e) => {
        const d = dragRef.current
        if (!d) return
        dragRef.current = null
        setDragging(false)
        const canvas = canvasRef.current
        if (canvas) { try { canvas.releasePointerCapture(d.id) } catch (err) { /* noop */ } }
      }

      const varSelect = (index, key) => h('select', {
        key,
        className: 'odelab-select',
        value: String(axes[index]),
        onChange: (e) => {
          const value = Number(e.target.value)
          setAxes((prev) => {
            const next = prev.slice()
            next[index] = value
            return next
          })
        },
      }, model.vars.map((name, i) => h('option', { key: name + i, value: String(i) }, name)))

      const axisCount = mode === '3d' && dim >= 3 ? 3 : 2
      const badges = []
      if (dim > 0) badges.push(dim < 2 ? 't → ' + model.vars[0] : model.vars[axes[0]] + ' · ' + model.vars[Math.min(axes[1], dim - 1)] + (axisCount === 3 ? ' · ' + model.vars[Math.min(axes[2], dim - 1)] : ''))
      badges.push((model.sys && model.sys.independent ? model.sys.independent : 't') + ' ≤ ' + tMax)

      return h('div', { className: docked ? 'odelab-root is-dock' : 'odelab-root', ref: rootRef },
        h('style', null, CSS),
        h('div', { className: 'odelab-head' },
          h('div', { className: 'odelab-head-main' },
            h(OdeLabMark, { size: 22 }),
            h('div', { className: 'odelab-head-text' },
              h('div', { className: 'odelab-head-title' }, t('title')),
              h('div', { className: 'odelab-head-sub' }, t('subtitle'))
            )
          ),
          h('div', { className: 'odelab-spacer' }),
          h('div', { className: 'odelab-seg' },
            h('button', { type: 'button', 'data-on': mode === '2d' ? '1' : '0', onClick: () => setMode('2d') }, t('mode2d')),
            h('button', { type: 'button', 'data-on': mode === '3d' ? '1' : '0', disabled: dim < 3, onClick: () => setMode('3d') }, t('mode3d'))
          ),
          h('button', { type: 'button', className: 'odelab-btn', onClick: () => setPlaying((p) => !p) }, playing ? t('pause') : t('play')),
          h('button', { type: 'button', className: 'odelab-btn', onClick: resetView }, t('resetView')),
          h('button', {
            type: 'button',
            className: 'odelab-btn',
            onClick: askAi,
            title: t('askAiHint'),
            'data-ask': askState,
          }, askState === 'copied' ? t('askAiCopied') : askState === 'failed' ? t('askAiFailed') : t('askAi'))
        ),
        h('div', { className: 'odelab-body' },
          h('aside', { className: 'odelab-side' },
            h('div', { className: 'odelab-field' },
              h('div', { className: 'odelab-label' }, t('presets')),
              h('div', { className: 'odelab-chips' }, PRESETS.map((p) => h('button', {
                key: p.id, type: 'button', className: 'odelab-chip',
                'data-on': presetId === p.id ? '1' : '0',
                onClick: () => applyPreset(p),
              }, t(p.label))))
            ),
            h('div', { className: 'odelab-field' },
              h('div', { className: 'odelab-label' }, t('equations')),
              h('textarea', {
                className: 'odelab-textarea',
                spellCheck: false,
                value: systemText,
                onChange: (e) => setSystemText(e.target.value),
                rows: 9,
              })
            ),
            h('div', { className: 'odelab-field' },
              h('div', { className: 'odelab-label' }, t('initial')),
              h('input', {
                className: 'odelab-input',
                spellCheck: false,
                value: initText,
                onChange: (e) => setInitText(e.target.value),
              })
            ),
            h('div', { className: 'odelab-row' },
              h('div', { className: 'odelab-field' },
                h('div', { className: 'odelab-label' }, t('horizon')),
                h('input', {
                  className: 'odelab-input',
                  inputMode: 'decimal',
                  value: tMaxText,
                  onChange: (e) => setTMaxText(e.target.value),
                })
              ),
              h('div', { className: 'odelab-field' },
                h('div', { className: 'odelab-label' }, t('samples')),
                h('input', {
                  className: 'odelab-input',
                  inputMode: 'numeric',
                  value: samplesText,
                  onChange: (e) => setSamplesText(e.target.value),
                })
              )
            ),
            dim >= 2 ? h('div', { className: 'odelab-field' },
              h('div', { className: 'odelab-label' }, t('projection')),
              h('div', { className: 'odelab-row' },
                varSelect(0, 'a0'),
                varSelect(1, 'a1'),
                axisCount === 3 ? varSelect(2, 'a2') : null
              )
            ) : null,
            h('div', { className: 'odelab-note' }, t('hint')),
            model.error ? h('div', { className: 'odelab-error' }, t('error') + ': ' + model.error) : null
          ),
          h('div', { className: 'odelab-stage', ref: stageRef },
            h('canvas', {
              className: 'odelab-canvas',
              ref: canvasRef,
              'data-drag': dragging ? '1' : '0',
              onPointerDown,
              onPointerMove,
              onPointerUp: endDrag,
              onPointerCancel: endDrag,
              onDoubleClick: resetView,
            }),
            h('div', { className: 'odelab-badges' }, badges.map((b, i) => h('span', { key: i }, b))),
            h('div', { className: 'odelab-hint' }, [mode === '3d' ? t('drag') : '', divergedText ? t('divergedNote') : ''].filter(Boolean).join('  ·  '))
          )
        )
      )
    }

    function registerLocale(locale, ns, dicts) {
      try {
        locale.register(ns, dicts)
        return
      } catch (err) {
        /* fall through to the per-locale form */
      }
      Object.keys(dicts).forEach((key) => {
        try { locale.register(ns, key, dicts[key]) } catch (err) { /* noop */ }
      })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // A throwing apply() fails the client entry, and the web boot audit
        // turns that into a full-window startup error. Stay defensive: report
        // and keep the shell alive instead of taking the app down with us.
        try {
          const slots = ctx.slots
          const locale = ctx.locale

          registerLocale(locale, NS, L10N)
          const t = locale.bind(NS)

          ctx.effect(() => {
            const offInject = slots.inject('sidebar.panellist', () => {
              const offMain = slots.register(
                { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) },
                (props) => h(OdeLabPanel, Object.assign({}, props, { t }))
              )
              const offSide = slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 40,
                  label: () => t('title'),
                  locale: NS,
                },
                (props) => h(OdeLabIcon, props)
              )
              return () => {
                toDispose(offSide)()
                toDispose(offMain)()
              }
            })
            return () => { toDispose(offInject)() }
          })

          // Side-by-side teaching dock: floats above the conversation so the
          // chat and the equations stay on screen at the same time.
          ctx.effect(() => {
            const offDock = slots.inject('shell.overlay', () => slots.register(
              { name: 'shell.overlay', id: PANEL_ID + '-dock', order: 40, locale: NS },
              (props) => h(OdeLabDock, Object.assign({}, props, { t }))
            ))
            return () => { toDispose(offDock)() }
          })
        } catch (err) {
          const logger = (ctx && ctx.logger) || console
          logger.error('[dsh-ode-lab] failed to mount the panel', err)
        }
      },
      // Test-only surface: the panel and the drawing code are covered by
      // tools/test-ode-client.mjs, which has no React renderer of its own.
      __test: {
        paint, integrate, parseSystem, parseInitial, syncInitial, makeRotator, readTheme, buildStatePayload, applyPanelPatch, detectDockTop,
      },
    }
  },
})
