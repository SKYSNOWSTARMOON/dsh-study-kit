/**
 * Anki 卡片导出（纯文本 TSV，零依赖）。
 *
 * 从章节 Markdown 里抠出「背诵清单」小节，按行转成 front/back/tag 三列。
 * 输出的是 Anki「导入文件」，不是 .apkg —— 后者要 SQLite，违背零依赖，收益也不值得。
 *
 * 支持两种写法（认第一种，第二种是给懒人写的）：
 *   | 正面 | 背面 | 标签 |
 *   | --- | --- | --- |
 *   | 逆序数的定义？ | 排列中前面大于后面的数对个数 | 行列式 |
 *
 *   - 逆序数的定义？｜排列中前面大于后面的数对个数｜行列式
 */

const SECTION_HINT = /背诵|记忆卡|闪卡|anki|速记/i
const FRONT_HEAD = /正面|问题|提问|问法|考点|概念/
const BACK_HEAD = /背面|答案|解答|答|解释|解析/
const TAG_HEAD = /标签|章节|分类|来源/

/** 逐字符切表格行，`$...$` 里的竖线不是列分隔符（和 markdown 表格规则一致）。 */
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

/** 取出「背诵清单」这类小节的正文行；没有就返回空数组（不硬编卡片）。 */
export function findCardSection(markdown) {
  const lines = String(markdown ?? '').split('\n')
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i])
    if (m && SECTION_HINT.test(m[2])) {
      start = i + 1
      level = m[1].length
      break
    }
  }
  if (start < 0) return []
  const out = []
  for (let i = start; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i])
    if (m && m[1].length <= level) break
    out.push(lines[i])
  }
  return out
}

function mapColumns(headerCells) {
  const map = { front: 0, back: 1, tags: 2 }
  headerCells.forEach((cell, index) => {
    if (FRONT_HEAD.test(cell)) map.front = index
    else if (BACK_HEAD.test(cell)) map.back = index
    else if (TAG_HEAD.test(cell)) map.tags = index
  })
  return map
}

/**
 * 从一章 Markdown 里抽卡片。
 * @returns {Array<{front: string, back: string, tags: string[]}>}
 */
export function parseCards(markdown) {
  const lines = findCardSection(markdown)
  if (lines.length === 0) return []
  const cards = []
  const seen = new Set()
  const push = (front, back, tags) => {
    const f = String(front ?? '').trim()
    const b = String(back ?? '').trim()
    if (f === '' || b === '' || f === b) return
    const key = f.replace(/\s+/g, ' ')
    if (seen.has(key)) return
    seen.add(key)
    const list = String(tags ?? '')
      .split(/[\s,，、;；]+/u)
      .map((t) => t.trim())
      .filter(Boolean)
    cards.push({ front: f, back: b, tags: list })
  }

  let header = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*\|/.test(line)) {
      // 表格：先攒列名，再吃分隔行，之后每行一张卡
      if (header === null) {
        header = splitRow(line)
        continue
      }
      if (/^\s*\|[\s:|-]+\|?\s*$/.test(line)) continue
      const cells = splitRow(line)
      const map = mapColumns(header)
      push(cells[map.front], cells[map.back], cells[map.tags])
      continue
    }
    header = null
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line)
    if (!bullet) continue
    const body = bullet[1].trim()
    // 「**术语**：解释」——背诵清单最常见的写法
    const bold = /^\*\*(.+?)\*\*\s*[：:]\s*(.+)$/.exec(body)
    if (bold) {
      push(bold[1], bold[2], '')
      continue
    }
    // 「术语：解释」（不加大写/加粗，靠冒号分面）
    if (!body.includes('｜') && !body.includes('|')) {
      const colon = /^([^：:]{2,24})[：:]\s*(.{4,})$/.exec(body)
      if (colon) {
        push(colon[1], colon[2], '')
        continue
      }
    }
    // 「正面｜背面｜标签」
    const parts = body.split(/\s*[｜|]\s*|\s+::\s+/u)
    if (parts.length >= 2) push(parts[0], parts[1], parts[2])
  }
  return cards
}

/** 卡片字段转义：TSV 里不能出现真 Tab / 换行，HTML 模式下别把正文当标签。 */
function esc(field) {
  return String(field ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\t/g, '    ')
    .replace(/\r?\n/g, '<br>')
}

/**
 * 正文清理：去掉 markdown 记号，行内公式换成 Anki 认的 \( ... \)。
 * Anki 需要在偏好设置里勾选 MathJax 才会渲染公式；没勾就显示原文，不会丢内容。
 */
function cleanField(field) {
  return String(field ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\$([^$\n]+)\$/g, '\\($1\\)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

/** 卡组名里不能有单个冒号与文件非法字符；`::` 是 Anki 的子卡组分隔符，要留着。 */
function deckName(deck) {
  return String(deck ?? 'dsh-study-kit')
    .replace(/::/g, '\u0000')
    .replace(/[:：]/g, '-')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\u0000/g, '::')
    .trim() || 'dsh-study-kit'
}

/**
 * 卡片 → Anki 可导入的 TSV 文本。
 * @param {Array<{front: string, back: string, tags?: string[]}>} cards
 * @param {{deck?: string}} options
 */
export function cardsToAnki(cards, options = {}) {
  const list = Array.isArray(cards) ? cards : []
  if (list.length === 0) return ''
  const head = [
    '#separator:tab',
    '#html:true',
    '#tags column:3',
    `#deck:${deckName(options.deck)}`,
  ]
  const rows = list.map((card) => {
    const tags = (card.tags ?? []).map((t) => String(t).replace(/\s+/g, '_')).join(' ')
    return `${esc(cleanField(card.front))}\t${esc(cleanField(card.back))}\t${esc(tags)}`
  })
  return `${head.join('\n')}\n${rows.join('\n')}\n`
}
