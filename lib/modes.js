/**
 * 五种输出形态的自检（L1：只检查结构，不改内容）。
 *
 * 形态本身是靠「写成什么样」实现的，插件不重写正文；这里做的是**出成品前拦一道**：
 * 缺了该有的小节、表格列不够、缩进跳级、错题没写坑点 —— 都在报告里点名，
 * 但不阻断导出（用户可能就想要一个不完整的版本，也要能拿到文件）。
 */

export const MODE_LIST = ['精简背诵版', '详细完整版', '对比归纳版', '思维导图文本版', '错题本']

const ALIASES = new Map([
  ['精简背诵版', '精简背诵版'],
  ['精简', '精简背诵版'],
  ['背诵版', '精简背诵版'],
  ['背诵', '精简背诵版'],
  ['详细完整版', '详细完整版'],
  ['详细', '详细完整版'],
  ['完整版', '详细完整版'],
  ['对比归纳版', '对比归纳版'],
  ['对比', '对比归纳版'],
  ['对比表', '对比归纳版'],
  ['思维导图文本版', '思维导图文本版'],
  ['思维导图', '思维导图文本版'],
  ['导图', '思维导图文本版'],
  ['mermaid', '思维导图文本版'],
  ['错题本', '错题本'],
  ['错题', '错题本'],
])

/** 认中文全名、简称、大小写 mermaid；认不出返回空串（调用方按「未指定」处理）。 */
export function normalizeMode(value) {
  const key = String(value ?? '').trim()
  if (key === '') return ''
  return ALIASES.get(key) ?? ALIASES.get(key.toLowerCase()) ?? ''
}

/** 逐字符切表格行，`$...$` 里的竖线不是列分隔符。 */
function splitRow(line) {
  const cells = []
  let buf = ''
  let inMath = false
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '$') {
      inMath = !inMath
      buf += ch
      continue
    }
    if (ch === '|' && !inMath) {
      cells.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  cells.push(buf.trim())
  return cells
}

/** 抓所有 markdown 表格：{header, cols, rows}。 */
export function parseTables(markdown) {
  const lines = String(markdown ?? '').split('\n')
  const tables = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue
    const header = splitRow(lines[i])
    const sep = lines[i + 1]
    if (!sep || !/^\s*\|[\s:|-]+\|?\s*$/.test(sep)) {
      i += 1
      continue
    }
    const rows = []
    let j = i + 2
    while (j < lines.length && /^\s*\|/.test(lines[j])) {
      rows.push(splitRow(lines[j]))
      j += 1
    }
    tables.push({ header, cols: header.length, rows })
    i = j - 1
  }
  return tables
}

/** 列表缩进层级（按 2 空格一级算；制表符算 4 级里的 2 格）。 */
function indentLevel(line) {
  let width = 0
  for (const ch of line) {
    if (ch === ' ') width += 1
    else if (ch === '\t') width += 2
    else break
  }
  return Math.floor(width / 2)
}

/**
 * 检查一章是否符合指定形态。
 * @returns {{mode: string, issues: string[], stats: {tables: number, bullets: number, headings: number, depth: number}}}
 */
export function lintChapter(mode, markdown) {
  const canonical = normalizeMode(mode)
  const text = String(markdown ?? '')
  const lines = text.split('\n')
  const tables = parseTables(text)
  const bullets = lines.filter((l) => /^\s*[-*+]\s+\S/.test(l)).length
  const headings = lines.filter((l) => /^#{2,6}\s+\S/.test(l)).length
  const depth = lines.reduce((max, l) => (l.trim() === '' ? max : Math.max(max, indentLevel(l))), 0)
  const issues = []
  const stats = { tables: tables.length, bullets, headings, depth }

  // 通用：每个考点要有「考察角度」「常见陷阱」。
  // 导图与错题本不适用——导图是层级骨架，错题本只收题，逼它们写「考点速查」只会催生套话。
  const needsTrap = canonical === '精简背诵版' || canonical === '详细完整版' || canonical === '对比归纳版'
  const quick = tables.find((t) => t.header.some((h) => /考点/.test(h)) && t.header.some((h) => /陷阱/.test(h)))
  if (needsTrap) {
    if (quick) {
      const trapCol = quick.header.findIndex((h) => /陷阱/.test(h))
      const blank = quick.rows.filter((r) => (r[trapCol] ?? '').trim() === '').length
      if (blank > 0) issues.push(`「常见陷阱」有 ${blank} 行是空的（考点速查表共 ${quick.rows.length} 行）`)
    } else if (!/常见陷阱/.test(text)) {
      issues.push('整章没写「常见陷阱」')
    }
    if (!quick && !/考察角度/.test(text)) issues.push('整章没写「考察角度」')
  }

  switch (canonical) {
    case '精简背诵版': {
      const long = lines.filter((l) => l.trim().length > 160 && !/^\s*\|/.test(l)).length
      if (long > 0) issues.push(`有 ${long} 行超过 160 字，背诵版应拆成短条目`)
      if (bullets < 5) issues.push(`条目只有 ${bullets} 条，背诵版至少 5 条`)
      break
    }
    case '详细完整版': {
      for (const key of ['前提', '适用', '易错']) {
        if (!text.includes(key)) issues.push(`没写「${key}」——详细版每个知识点要有前提/适用范围/易错点`)
      }
      if (!/推导|证明|为什么/.test(text)) issues.push('没写推导或证明过程')
      break
    }
    case '对比归纳版': {
      if (tables.length < 2) issues.push(`对比表只有 ${tables.length} 个，至少 2 个`)
      const narrow = tables.filter((t) => t.cols < 3).length
      if (narrow > 0) issues.push(`有 ${narrow} 个表不足 3 列（易混概念至少「概念 / 易混点 / 判别方法」三列）`)
      const thin = tables.filter((t) => t.rows.length < 2).length
      if (thin > 0) issues.push(`有 ${thin} 个表不足 2 行数据`)
      break
    }
    case '思维导图文本版': {
      if (depth > 4) issues.push(`缩进到了第 ${depth} 层，mermaid 会糊，压到 4 层以内`)
      const jumps = lines.filter((l, i) => {
        if (l.trim() === '' || !/^\s*[-*+]\s+\S/.test(l)) return false
        const prev = [...lines.slice(0, i)].reverse().find((p) => /^\s*[-*+]\s+\S/.test(p))
        if (!prev) return false
        return indentLevel(l) - indentLevel(prev) > 1
      }).length
      if (jumps > 0) issues.push(`有 ${jumps} 处层级跳级（父节点直接跳到孙节点）`)
      if (bullets < 6) issues.push(`节点只有 ${bullets} 个，导图太薄`)
      break
    }
    case '错题本': {
      // 每道题切成一块：以 ### / #### 或「1.」开头的行分段
      const blocks = text
        .split(/\n(?=#{2,4}\s+\S|\s*\d+[.、]\s*\S)/u)
        .filter((b) => /题干|题目|问[:：]|【题干】/.test(b))
      if (blocks.length === 0) issues.push('没找到题目块（每道题用「题干」开头，或小标题分隔）')
      let noTrap = 0
      let noAnswer = 0
      for (const b of blocks) {
        if (!/坑点|陷阱|易错/.test(b)) noTrap += 1
        if (!/解析|答案/.test(b)) noAnswer += 1
      }
      if (noTrap > 0) issues.push(`${noTrap} 道题没写「坑点」`)
      if (noAnswer > 0) issues.push(`${noAnswer} 道题没写「解析」`)
      break
    }
    default:
      return { mode: '', issues: [], stats }
  }
  return { mode: canonical, issues, stats }
}

/** 报告里的一行摘要。 */
export function summarizeLint(title, result) {
  if (result.issues.length === 0) {
    return `${title}｜${result.mode} 自检通过（表 ${result.stats.tables} 个，条目 ${result.stats.bullets} 条）`
  }
  return `${title}｜${result.mode} 有 ${result.issues.length} 处待补：${result.issues.join('；')}`
}
