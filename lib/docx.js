/**
 * Markdown → docx（零依赖）。
 *
 * 只支持「讲义级」语法：标题 / 段落 / 无序与有序列表 / 表格 / 引用 / 代码块 / 分隔线，
 * 行内只处理 **粗体**、`行内代码`、[文字](链接)→文字、$行内公式$（转成 Cambria Math + 上下标）。
 * 够用来生成背诵版与题册，不做完整的 CommonMark（不需要，也不该在这里做）。
 *
 * 列表用「文字前缀 + 悬挂缩进」而不是 numbering.xml：少一个部件就少一个 Word 报错的机会。
 */

import { writeZip } from './zipwrite.js'
import { latexToSegments } from './tex.js'

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const A4_WIDTH = 11906
const MARGIN = 1134 // 2cm
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2

function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内：**粗体**、`代码`、[文字](url)、$公式$。其它字符原样保留（交给 esc）。 */
function runs(text, base = {}) {
  const out = []
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))|(\$([^$\n]+)\$)/g
  let last = 0
  let m
  const pushText = (value, extra = '') => {
    if (value === '') return
    out.push(`<w:r><w:rPr>${base.rpr ?? ''}${extra}</w:rPr><w:t xml:space="preserve">${esc(value)}</w:t></w:r>`)
  }
  // 公式：拆成上下标 run。rFonts 必须在 b/i 之前、vertAlign 在最后，否则 Word 会挑刺。
  const pushMath = (latex, extra = '') => {
    for (const seg of latexToSegments(latex)) {
      if (seg.t === '') continue
      const va = seg.k === 'sub'
        ? '<w:vertAlign w:val="subscript"/>'
        : seg.k === 'sup' ? '<w:vertAlign w:val="superscript"/>' : ''
      const italic = seg.k === '' ? '<w:i/>' : ''
      out.push(
        `<w:r><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/>${base.rpr ?? ''}${extra}${italic}${va}</w:rPr>` +
        `<w:t xml:space="preserve">${esc(seg.t)}</w:t></w:r>`,
      )
    }
  }
  // 粗体里常嵌公式（**$n$ 阶行列式**），公式不能当普通文字输出，否则 $ 会留在成品里
  const pushBold = (text) => {
    for (const part of text.split(/(\$[^$\n]+\$)/)) {
      if (part === '') continue
      if (part.length > 2 && part.startsWith('$') && part.endsWith('$')) pushMath(part.slice(1, -1), '<w:b/>')
      else pushText(part, '<w:b/>')
    }
  }
  while ((m = re.exec(text)) !== null) {
    pushText(text.slice(last, m.index))
    if (m[2] !== undefined) pushBold(m[2])
    else if (m[4] !== undefined) pushText(m[4], '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:fill="F2F2F2"/>')
    else if (m[6] !== undefined) pushText(m[7] && m[7] !== m[6] ? `${m[6]}（${m[7]}）` : m[6])
    else if (m[8] !== undefined) pushMath(m[9])
    last = re.lastIndex
  }
  pushText(text.slice(last))
  return out.join('') || `<w:r><w:rPr>${base.rpr ?? ''}</w:rPr><w:t xml:space="preserve"></w:t></w:r>`
}

function para(styleId, text, opts = {}) {
  const ppr = [`<w:pStyle w:val="${styleId}"/>`]
  if (opts.ind) ppr.push(`<w:ind w:left="${opts.ind.left ?? 0}" w:hanging="${opts.ind.hanging ?? 0}"/>`)
  if (opts.keepNext) ppr.push('<w:keepNext/>')
  if (opts.spacing) ppr.push(`<w:spacing w:before="${opts.spacing.before ?? 0}" w:after="${opts.spacing.after ?? 0}"/>`)
  const rpr = opts.rpr ?? ''
  return `<w:p><w:pPr>${ppr.join('')}</w:pPr>${runs(text, { rpr })}</w:p>`
}

function tableBlock(rows) {
  if (rows.length === 0) return ''
  const cols = Math.max(...rows.map((r) => r.length))
  // 列宽按内容长度分配（等宽会让「掌握」这种短列被挤成两行），每列至少 12%、至多 42%
  const lens = Array.from({ length: cols }, (_, i) => {
    const m = Math.max(4, ...rows.map((r) => String(r[i] ?? '').length))
    return Math.min(m, 60)
  })
  const sum = lens.reduce((a, b) => a + b, 0)
  const raw = lens.map((l) => Math.round((CONTENT_WIDTH * l) / sum))
  const minW = Math.floor(CONTENT_WIDTH * 0.12)
  const maxW = Math.floor(CONTENT_WIDTH * 0.42)
  const clamped = raw.map((w) => Math.min(maxW, Math.max(minW, w)))
  // 夹逼后再把误差摊回最大的一列，保证总宽正好等于版心
  const diff = CONTENT_WIDTH - clamped.reduce((a, b) => a + b, 0)
  const widest = clamped.indexOf(Math.max(...clamped))
  clamped[widest] += diff
  const widths = clamped
  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`
  const head = `<w:trPr><w:tblHeader/></w:trPr>`
  const body = rows
    .map((cells, index) => {
      const isHead = index === 0
      const tcs = Array.from({ length: cols }, (_, i) => {
        const text = cells[i] ?? ''
        const shd = isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EEF7"/>' : ''
        return `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/>${shd}<w:vAlign w:val="center"/></w:tcPr>` +
          `<w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr>${runs(text, { rpr: isHead ? '<w:b/>' : '' })}</w:p></w:tc>`
      }).join('')
      return `<w:tr>${isHead ? head : ''}${tcs}</w:tr>`
    })
    .join('')
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
    `<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl><w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>`
}

/** 把 markdown 切成块，再逐块渲染。 */
export function markdownToXml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed === '') { i += 1; continue }

    // 代码块
    if (/^```/.test(trimmed)) {
      i += 1
      const code = []
      while (i < lines.length && !/^```/.test(lines[i].trim())) { code.push(lines[i]); i += 1 }
      i += 1
      for (const row of code) out.push(para('Code', row))
      continue
    }

    // 独立公式块 $$...$$（居中）
    if (trimmed.startsWith('$$')) {
      let inner = trimmed.slice(2)
      if (inner.includes('$$')) {
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
      out.push(`<w:p><w:pPr><w:pStyle w:val="Normal"/><w:jc w:val="center"/><w:spacing w:before="80" w:after="80"/></w:pPr>${runs(`$${inner.trim()}$`)}</w:p>`)
      continue
    }

    // 表格：本行以 | 开头且下一行是分隔行
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      const rows = []
      // 按 | 切单元格，但 $...$ 里的 | 是公式内容（如 $|A|$），不能当分隔符
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
      rows.push(split(line))
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(split(lines[i])); i += 1 }
      out.push(tableBlock(rows))
      continue
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr><w:spacing w:after="120"/></w:pPr></w:p>')
      i += 1
      continue
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      const level = Math.min(6, heading[1].length)
      out.push(para(`Heading${Math.min(4, level)}`, heading[2].trim(), { keepNext: true }))
      i += 1
      continue
    }

    // 引用
    if (trimmed.startsWith('>')) {
      const buf = []
      while (i < lines.length && lines[i].trim().startsWith('>')) { buf.push(lines[i].trim().replace(/^>\s?/, '')); i += 1 }
      for (const row of buf) out.push(para('Quote', row))
      continue
    }

    // 无序列表
    const bullet = /^(\s*)([-*•])\s+(.*)$/.exec(line)
    if (bullet) {
      const level = Math.floor(bullet[1].length / 2)
      out.push(para('ListBullet', bullet[3].trim(), { ind: { left: 360 + level * 360, hanging: 240 } }))
      i += 1
      continue
    }

    // 有序列表
    const ordered = /^(\s*)(\d{1,3})[.、)]\s+(.*)$/.exec(line)
    if (ordered) {
      const level = Math.floor(ordered[1].length / 2)
      out.push(para('ListNumber', `${ordered[2]}. ${ordered[3].trim()}`, { ind: { left: 360 + level * 360, hanging: 300 } }))
      i += 1
      continue
    }

    out.push(para('Normal', trimmed))
    i += 1
  }

  return out.join('')
}

const SECT_PR = `<w:sectPr><w:pgSz w:w="${A4_WIDTH}" w:h="16838"/><w:pgMar w:top="1134" w:right="${MARGIN}" w:bottom="1134" w:left="${MARGIN}" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>`

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W_NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:line="300" w:lineRule="auto" w:after="80"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="both"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="44"/><w:color w:val="1F3864"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="200"/></w:pPr><w:rPr><w:sz w:val="20"/><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="0"/><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="2" w:color="2E74B5"/></w:pBdr></w:pPr><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="32"/><w:color w:val="1F3864"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="26"/><w:color w:val="2E74B5"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="100"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="21"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="480" w:right="480"/><w:spacing w:after="60"/></w:pPr><w:rPr><w:i/><w:sz w:val="19"/><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/><w:jc w:val="left"/></w:pPr><w:rPr><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`

function coreProps(title, author) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(title)}</dc:title><dc:creator>${esc(author)}</dc:creator><cp:lastModifiedBy>${esc(author)}</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`
}

const APP_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>dsh-study-kit</Application>
</Properties>`

/**
 * @param {string} markdown
 * @param {{title?: string, subtitle?: string, author?: string}} meta
 * @returns {Buffer}
 */
export function markdownToDocx(markdown, meta = {}) {
  const title = meta.title ?? '学习资料'
  const head = []
  if (meta.coverTitle !== false) head.push(para('Title', title))
  if (meta.subtitle) head.push(para('Subtitle', meta.subtitle))
  const body = `${head.join('')}${markdownToXml(markdown)}${SECT_PR}`
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}><w:body>${body}</w:body></w:document>`

  return writeZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'docProps/core.xml', data: coreProps(title, meta.author ?? 'dsh-study-kit') },
    { name: 'docProps/app.xml', data: APP_PROPS },
  ])
}
