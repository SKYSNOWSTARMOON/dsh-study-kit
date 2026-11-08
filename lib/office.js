/**
 * Word(.docx) / PowerPoint(.pptx) 抽取。
 *
 * 输出带标题标记的纯文本：# 号数量对应原文标题级别（docx 的 Heading 样式 / pptx 的幻灯片）。
 * 上层清洗与分章直接吃这个标记，所以这里**不做**任何美化或改写。
 *
 * 说明：.doc / .ppt（OLE 二进制）不支持，调用方要给出「另存为 .docx」的提示。
 */

import { openZip, xmlToText } from './zip.js'

/** docx 的 pStyle 值 → 标题级别。兼容中文版 Word 的「标题 1」与内置样式 id。 */
function docxHeadingLevel(styleId) {
  if (!styleId) return 0
  const s = styleId.toLowerCase()
  let m = /^heading(\d)$/.exec(s)
  if (m) return Number(m[1])
  m = /^标题\s*(\d)$/.exec(styleId)
  if (m) return Number(m[1])
  if (s === 'title' || styleId === '标题') return 1
  return 0
}

/** 从 w:p 里抠段落文字与样式。 */
function docxParagraphs(xml) {
  const out = []
  const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g
  let m
  while ((m = paraRe.exec(xml)) !== null) {
    const inner = m[1]
    const styleMatch = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(inner)
    // 段落文字：w:t 里才是真文字；w:tab / w:br 转成制表与换行；公式 w:oMath 里的文本也收
    let text = ''
    const runRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g
    let r
    while ((r = runRe.exec(inner)) !== null) {
      if (r[1] !== undefined) text += r[1]
      else if (r[0].startsWith('<w:tab')) text += '\t'
      else text += '\n'
    }
    if (text.trim() === '') continue
    out.push({ text: xmlToText(text), level: docxHeadingLevel(styleMatch?.[1]) })
  }
  return out
}

/** 表格 → 每行「单元格 | 单元格」（题目/参数表里的信息不能丢）。 */
function docxTableRows(tableXml) {
  const rows = []
  const rowRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g
  let r
  while ((r = rowRe.exec(tableXml)) !== null) {
    const cells = []
    const cellRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g
    let c
    while ((c = cellRe.exec(r[1])) !== null) cells.push(xmlToText(c[1]).replace(/\s+/g, ' ').trim())
    if (cells.some((x) => x !== '')) rows.push(cells.join(' | '))
  }
  return rows
}

/** docx：正文 + 表格按行拼接，保持文档顺序。 */
export function extractDocx(buf) {
  const zip = openZip(buf)
  if (!zip.has('word/document.xml')) throw new Error('docx 结构异常：缺少 word/document.xml')
  const xml = zip.text('word/document.xml')

  // 单一正则在文档顺序上交替匹配「整张表」和「单个段落」：
  // 表格优先吃掉，所以表内段落不会被当正文重复收一遍。
  const scanRe = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  const paragraphs = []
  let m
  while ((m = scanRe.exec(xml)) !== null) {
    const chunk = m[0]
    if (chunk.startsWith('<w:tbl')) {
      const rows = docxTableRows(chunk)
      if (rows.length > 0) paragraphs.push({ text: rows.join('\n'), level: 0 })
      continue
    }
    const styleMatch = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(chunk)
    let text = ''
    const runRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:drawing\b/g
    let r
    while ((r = runRe.exec(chunk)) !== null) {
      if (r[1] !== undefined) text += r[1]
      else if (r[0].startsWith('<w:tab')) text += '\t'
      else if (r[0].startsWith('<w:drawing')) text += ' [图片] '
      else text += '\n'
    }
    text = xmlToText(text)
    if (text.trim() === '') continue
    paragraphs.push({ text, level: docxHeadingLevel(styleMatch?.[1]) })
  }

  const lines = paragraphs.map((p) => (p.level > 0
    ? `${'#'.repeat(Math.min(p.level, 6))} ${p.text.trim()}`
    : p.text.replace(/[ \t]+$/g, '')))
  return { kind: 'docx', text: lines.join('\n'), paragraphs: paragraphs.length }
}

/** pptx：按 slide 编号顺序，一页一段，标题当 ## 级。 */
export function extractPptx(buf) {
  const zip = openZip(buf)
  const slides = zip.names
    .map((name) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(name))
    .filter(Boolean)
    .map((m) => ({ num: Number(m[1]), name: `ppt/slides/slide${m[1]}.xml` }))
    .sort((a, b) => a.num - b.num)
  if (slides.length === 0) throw new Error('pptx 结构异常：没有幻灯片')

  const notesByNum = new Map()
  for (const name of zip.names) {
    const m = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(name)
    if (m) notesByNum.set(Number(m[1]), name)
  }

  const blocks = []
  for (const slide of slides) {
    const xml = zip.text(slide.name)
    // 每页的文字按 <a:p> 分段；第一段通常是标题
    const paras = []
    const pRe = /<a:p>([\s\S]*?)<\/a:p>/g
    let p
    while ((p = pRe.exec(xml)) !== null) {
      let text = ''
      const tRe = /<a:t>([\s\S]*?)<\/a:t>/g
      let tt
      while ((tt = tRe.exec(p[1])) !== null) text += tt[1]
      text = xmlToText(text).trim()
      if (text !== '') paras.push(text)
    }
    if (paras.length === 0) continue
    const [title, ...rest] = paras
    blocks.push(`## 第${slide.num}页 ${title}`)
    for (const line of rest) blocks.push(`- ${line}`)

    const noteName = notesByNum.get(slide.num)
    if (noteName) {
      const noteText = xmlToText(zip.text(noteName)).replace(/\n{2,}/g, '\n').trim()
      // 备注里常有页码占位「1」「2024/5/1」，太短的不收
      if (noteText.length > 12) blocks.push(`> 备注：${noteText}`)
    }
  }
  return { kind: 'pptx', text: blocks.join('\n'), paragraphs: blocks.length, slides: slides.length }
}
