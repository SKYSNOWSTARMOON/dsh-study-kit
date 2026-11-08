/**
 * markdown -> 独立 HTML（用于无 Word 环境下的 PDF 导出：Edge/Chrome --headless --print-to-pdf）
 * 零依赖，样式与 lib/docx.js 的输出尽量保持一致，两份产物看起来是同一套资料。
 */

import { latexToSegments } from './tex.js'

const CSS = `@page { size: A4; margin: 18mm 16mm 16mm 16mm; }
* { box-sizing: border-box; }
body { font-family: "Microsoft YaHei", "Segoe UI", "SimSun", sans-serif; font-size: 10.5pt; line-height: 1.65; color: #1a1a1a; }
.cover { text-align: center; margin: 0 0 18pt 0; }
.cover h1 { font-size: 22pt; color: #1f3864; border: 0; margin: 0 0 6pt 0; padding: 0; }
.cover .sub { font-size: 10pt; color: #595959; }
hr.rule { border: 0; border-top: 1px solid #bfbfbf; margin: 14pt 0; }
h1, h2, h3, h4, h5, h6 { font-family: "Microsoft YaHei", "SimHei", sans-serif; color: #1f3864; page-break-after: avoid; }
h1 { font-size: 16pt; border-bottom: 2px solid #2e74b5; padding-bottom: 3pt; margin: 18pt 0 8pt; }
h2 { font-size: 13pt; color: #2e74b5; margin: 14pt 0 6pt; }
h3 { font-size: 11.5pt; margin: 12pt 0 5pt; }
h4, h5, h6 { font-size: 10.5pt; margin: 10pt 0 4pt; }
p { margin: 0 0 5pt; text-align: justify; }
ul, ol { margin: 0 0 6pt; padding-left: 18pt; }
li { margin: 0 0 3pt; }
blockquote { margin: 6pt 0 8pt; padding: 4pt 10pt; border-left: 3px solid #2e74b5; background: #f4f7fb; color: #444; font-size: 10pt; }
code { font-family: Consolas, "Courier New", monospace; background: #f2f2f2; padding: 0 2pt; font-size: 9.5pt; }
pre { background: #f5f5f5; padding: 6pt 8pt; font-size: 9pt; overflow: visible; white-space: pre-wrap; page-break-inside: avoid; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; table-layout: fixed; margin: 6pt 0 10pt; font-size: 9.5pt; page-break-inside: avoid; }
th, td { border: 1px solid #bfbfbf; padding: 3pt 5pt; text-align: left; vertical-align: top; }
th { background: #e8eef7; font-weight: 600; }
strong { font-weight: 700; }
a { color: #2e74b5; text-decoration: none; }
.m { font-family: "Cambria Math", "Times New Roman", serif; font-style: italic; }
.math-block { text-align: center; margin: 8pt 0; font-size: 11pt; }
sub, sup { font-size: 72%; line-height: 0; }`

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inline(s) {
  const out = []
  const re = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(\$[^$\n]+\$)/g
  let last = 0
  let m
  const text = (v) => { if (v) out.push(esc(v)) }
  while ((m = re.exec(s)) !== null) {
    text(s.slice(last, m.index))
    if (m[1] !== undefined) out.push(`<code>${esc(m[1].slice(1, -1))}</code>`)
    else if (m[2] !== undefined) {
      const link = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(m[2])
      out.push(`<a href="${esc(link[2])}">${esc(link[1])}</a>`)
    } else if (m[3] !== undefined) out.push(`<strong>${inline(m[3].slice(2, -2))}</strong>`)
    else out.push(mathHtml(m[4].slice(1, -1)))
    last = re.lastIndex
  }
  text(s.slice(last))
  return out.join('')
}

function mathHtml(latex) {
  const parts = latexToSegments(latex).map((seg) => {
    const body = esc(seg.t)
    if (seg.k === 'sub') return `<sub>${body}</sub>`
    if (seg.k === 'sup') return `<sup>${body}</sup>`
    return body
  })
  return `<span class="m">${parts.join('')}</span>`
}

/**
 * @param {string} markdown
 * @param {{title?: string, subtitle?: string, author?: string, coverTitle?: boolean}} meta
 * @returns {string} 完整 HTML 文档
 */
export function markdownToHtml(markdown, meta = {}) {
  const title = meta.title ?? '学习资料'
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n')
  const body = []
  let i = 0
  let listOpen = null // 'ul' | 'ol'

  const closeList = () => {
    if (listOpen) {
      body.push(`</${listOpen}>`)
      listOpen = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      closeList()
      i += 1
      continue
    }

    // 代码块
    if (/^```/.test(trimmed)) {
      closeList()
      const buf = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i])
        i += 1
      }
      i += 1
      body.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`)
      continue
    }

    // 独立公式块 $$...$$
    if (trimmed.startsWith('$$')) {
      closeList()
      let inner = trimmed.slice(2)
      let closed = inner.includes('$$')
      if (closed) {
        inner = inner.replace(/\$\$\s*$/, '')
        i += 1
      } else {
        i += 1
        while (i < lines.length) {
          const t = lines[i].trim()
          i += 1
          const done = t.includes('$$')
          inner += ` ${done ? t.replace(/\$\$\s*$/, '') : t}`
          if (done) break
        }
      }
      body.push(`<div class="math-block">${mathHtml(inner.trim())}</div>`)
      continue
    }

    // 表格
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      closeList()
      // 同 docx.js：$...$ 内的 | 属于公式（$|A|$），不参与切分
      const split = (row) => {
        const body = row.trim().replace(/^\|/, '').replace(/\|$/, '')
        const cells = []
        let buf = ''
        let inMath = false
        for (const ch of body) {
          if (ch === '$') inMath = !inMath
          if (ch === '|' && !inMath) { cells.push(buf.trim()); buf = ''; continue }
          buf += ch
        }
        cells.push(buf.trim())
        return cells
      }
      const rows = [split(line)]
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(split(lines[i]))
        i += 1
      }
      const [head, ...rest] = rows
      // 列宽按内容长度分配（同 docx.js：等宽会把「掌握」这种短列挤成两行）
      const cols = Math.max(...rows.map((r) => r.length))
      const lens = Array.from({ length: cols }, (_, k) => {
        const m = Math.max(4, ...rows.map((r) => String(r[k] ?? '').length))
        return Math.min(m, 60)
      })
      const sum = lens.reduce((a, b) => a + b, 0)
      // 与 docx 对齐：每列至少 12%、至多 42%，再归一化到 100%（否则「要求」列被压成一字一行）
      let pcts = lens.map((l) => Math.min(42, Math.max(12, (l / sum) * 100)))
      const total = pcts.reduce((a, b) => a + b, 0)
      pcts = pcts.map((p) => (p / total) * 100)
      const colgroup = `<colgroup>${pcts.map((p) => `<col style="width:${p.toFixed(1)}%">`).join('')}</colgroup>`
      const html = [`<table>${colgroup}<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`]
      for (const row of rest) html.push(`<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
      html.push('</tbody></table>')
      body.push(html.join(''))
      continue
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeList()
      body.push('<hr class="rule"/>')
      i += 1
      continue
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      closeList()
      const level = heading[1].length
      body.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`)
      i += 1
      continue
    }

    // 引用
    if (trimmed.startsWith('>')) {
      closeList()
      const buf = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''))
        i += 1
      }
      body.push(`<blockquote>${buf.map((r) => inline(r)).join('<br/>')}</blockquote>`)
      continue
    }

    // 无序列表
    const bullet = /^(\s*)([-*•])\s+(.*)$/.exec(line)
    if (bullet) {
      if (listOpen !== 'ul') {
        closeList()
        body.push('<ul>')
        listOpen = 'ul'
      }
      body.push(`<li>${inline(bullet[3].trim())}</li>`)
      i += 1
      continue
    }

    // 有序列表
    const ordered = /^(\s*)(\d{1,3})[.、)]\s+(.*)$/.exec(line)
    if (ordered) {
      if (listOpen !== 'ol') {
        closeList()
        body.push('<ol>')
        listOpen = 'ol'
      }
      body.push(`<li>${inline(ordered[3].trim())}</li>`)
      i += 1
      continue
    }

    closeList()
    body.push(`<p>${inline(trimmed)}</p>`)
    i += 1
  }
  closeList()

  const cover = meta.coverTitle === false
    ? ''
    : `<div class="cover"><h1>${esc(title)}</h1>${meta.subtitle ? `<div class="sub">${esc(meta.subtitle)}</div>` : ''}</div>`

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${CSS}</style></head>
<body>${cover}${body.join('\n')}</body></html>`
}
