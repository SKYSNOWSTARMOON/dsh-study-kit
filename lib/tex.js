/**
 * 极简 LaTeX 行内公式 → 纯文本片段（带上下标标记）。
 * 只覆盖讲义里真实出现的写法：$K_m$、$V_{max}$、$p^2+2pq+q^2=1$、$\alpha$、$\times$、$\frac{a}{b}$……
 * 完整 TeX 排版不在范围内（没有 MathJax、也不该手写一个）。
 *
 * 返回 [{ t: '文本', k: '' | 'sub' | 'sup' }]
 */

const SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ',
  sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', to: '→', rightarrow: '→', longrightarrow: '⟶',
  leftarrow: '←', Rightarrow: '⇒', leftrightarrow: '↔', approx: '≈', neq: '≠', ne: '≠',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', equiv: '≡', propto: '∝', infty: '∞', partial: '∂',
  sum: 'Σ', prod: 'Π', int: '∫', sqrt: '√', angle: '∠', perp: '⊥', circ: '°', degree: '°',
  maybe: '⋯', cdots: '⋯', ldots: '…', dots: '…', uparrow: '↑', downarrow: '↓',
  sim: '~', simeq: '≃', cong: '≅', prime: '′', ast: '*', star: '⋆', bullet: '•', deg: '°',
  left: '', right: '', quad: ' ', qquad: ' ', limits: '', nolimits: '', displaystyle: '',
  '%': '%', '&': '&', '#': '#', '_': '_', '{': '{', '}': '}', ' ': ' ', ',': ' ', ';': ' ', ':': ' ',
}

/** 把 \cmd{a}{b} 之类的花括号组替换掉（\frac、\xrightarrow 单独处理）。 */
function stripGroups(src) {
  let out = src
  out = out.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => `${a}/${b}`)
  out = out.replace(/\\(?:mathrm|mathbf|mathit|text|textrm|operatorname)\s*\{([^{}]*)\}/g, '$1')
  // 带标注的长箭头：\xrightarrow{光能} → →(光能)
  out = out.replace(/\\xrightarrow\s*\{([^{}]*)\}/g, '→($1)')
  out = out.replace(/\\xleftarrow\s*\{([^{}]*)\}/g, '←($1)')
  out = out.replace(/\\(?:quad|qquad)/g, ' ')
  out = out.replace(/\\[,;:!\s]/g, ' ') // \, \; \: \! 以及反斜杠+空格都当窄空格
  // 注意：\left \right 不能在这里整词删掉，否则 \rightarrow 会剩下 "arrow"
  out = out.replace(/\\[a-zA-Z]+/g, (cmd) => {
    const name = cmd.slice(1)
    return Object.prototype.hasOwnProperty.call(SYMBOLS, name) ? SYMBOLS[name] : name
  })
  return out
}

/**
 * @param {string} latex 不带 $ 的公式主体
 * @returns {{t: string, k: ''|'sub'|'sup'}[]}
 */
export function latexToSegments(latex) {
  const src = stripGroups(String(latex ?? ''))
  const segs = []
  let buf = ''
  let k = ''
  const flush = () => {
    if (buf !== '') {
      segs.push({ t: buf, k })
      buf = ''
    }
  }
  let i = 0
  const takeGroup = () => {
    // 当前位置是 { 时取到匹配的 }，返回内部文本
    let depth = 0
    let out = ''
    for (; i < src.length; i += 1) {
      const ch = src[i]
      if (ch === '{') {
        depth += 1
        if (depth === 1) continue
      } else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          i += 1
          break
        }
      }
      out += ch
    }
    return out
  }
  while (i < src.length) {
    const ch = src[i]
    if (ch === '_' || ch === '^') {
      flush()
      k = ch === '_' ? 'sub' : 'sup'
      i += 1
      if (src[i] === '{') buf = takeGroup().replace(/[_^{}]/g, '')
      else if (i < src.length) { buf = src[i]; i += 1 }
      flush()
      k = ''
      continue
    }
    if (ch === '{' || ch === '}') { i += 1; continue }
    buf += ch
    i += 1
  }
  flush()
  return segs.length > 0 ? segs : [{ t: '', k: '' }]
}

/** 纯文本版（给不支持上下标的地方用，例如表格里嵌 markdown 的极端情形）。 */
export function latexToText(latex) {
  return latexToSegments(latex).map((s) => (s.k === 'sub' ? `_${s.t}` : s.k === 'sup' ? `^${s.t}` : s.t)).join('')
}
