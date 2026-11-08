/**
 * 纯 Node 的 PDF 文本层抽取（零依赖，只用内置 zlib）。
 *
 * 能处理：FlateDecode 内容流、对象流(/ObjStm)、页面树继承、ToUnicode CMap(bfchar/bfrange)、
 *         常见 Tj/TJ/'/" 文本算子。
 * 不能处理：扫描件（没有文本层）、加密 PDF、LZW/JPX 等罕见滤镜、竖排旋转排版。
 *         这几种情况一律**明确报出来**，不假装成功。
 *
 * 设计取舍：不做完整的 xref 解析，直接全文件扫 "N G obj" —— 对损坏/线性化的 PDF 更稳，
 * 代价是大文件会慢一点（几十 MB 的教材约 1~3 秒）。
 */

import { inflateSync, inflateRawSync } from 'node:zlib'

/* ------------------------------------------------------------------ 基础工具 ---- */

function tryInflate(data) {
  // 有的 PDF 流少了 zlib 头，有的带尾部垃圾 —— 三种都试一遍
  for (const fn of [
    () => inflateSync(data),
    () => inflateRawSync(data),
    () => inflateSync(data, { finishFlush: 2 }), // Z_SYNC_FLUSH，容忍截断
    () => inflateRawSync(data, { finishFlush: 2 }),
  ]) {
    try {
      const out = fn()
      if (out && out.length > 0) return out
    } catch { /* 换下一种 */ }
  }
  return null
}

function asciiHexDecode(data) {
  const text = data.toString('latin1').replace(/[^0-9a-fA-F]/g, '')
  const hex = text.length % 2 === 0 ? text : `${text}0`
  return Buffer.from(hex, 'hex')
}

function ascii85Decode(data) {
  const text = data.toString('latin1').replace(/^<~/, '').replace(/~>[\s\S]*$/, '').replace(/\s+/g, '')
  const out = []
  let block = []
  for (const ch of text) {
    if (ch === 'z' && block.length === 0) { out.push(0, 0, 0, 0); continue }
    block.push(ch.charCodeAt(0) - 33)
    if (block.length === 5) {
      let value = 0
      for (const d of block) value = value * 85 + d
      out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)
      block = []
    }
  }
  if (block.length > 0) {
    while (block.length < 5) block.push(84)
    let value = 0
    for (const d of block) value = value * 85 + d
    out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)
  }
  return Buffer.from(out)
}

/** 解出对象流的**原始字节**（按 /Filter 链处理）。 */
function decodeStream(obj) {
  if (!obj || !obj.stream) return null
  let data = obj.stream
  const filters = []
  const filterRaw = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(obj.dict)
  if (filterRaw) {
    const body = filterRaw[1]
    const names = body.match(/\/[A-Za-z0-9]+/g) ?? []
    for (const n of names) filters.push(n.slice(1))
  }
  for (const f of filters) {
    if (f === 'FlateDecode' || f === 'Fl') {
      const out = tryInflate(data)
      if (!out) return null
      data = out
    } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
      data = asciiHexDecode(data)
    } else if (f === 'ASCII85Decode' || f === 'A85') {
      data = ascii85Decode(data)
    } else {
      return null // 不认识的滤镜：当作解不出来，上层记警告
    }
  }
  return data
}

/* ------------------------------------------------------------------ 对象扫描 ---- */

/**
 * 扫全文件的间接对象。
 * @returns {Map<number, {dict: string, stream: Buffer|null}>}
 */
function scanObjects(s) {
  const objects = new Map()
  const re = /(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g
  let m
  while ((m = re.exec(s)) !== null) {
    const num = Number(m[1])
    const bodyStart = m.index + m[0].length
    const endObj = s.indexOf('endobj', bodyStart)
    const streamIdx = s.indexOf('stream', bodyStart)
    let dictEnd = endObj < 0 ? s.length : endObj
    let stream = null
    let dict
    if (streamIdx >= 0 && (endObj < 0 || streamIdx < endObj)) {
      dict = s.slice(bodyStart, streamIdx)
      let dataStart = streamIdx + 'stream'.length
      if (s[dataStart] === '\r') dataStart += 1
      if (s[dataStart] === '\n') dataStart += 1
      const endStream = s.indexOf('endstream', dataStart)
      const dataEnd = endStream < 0 ? s.length : endStream
      stream = Buffer.from(s.slice(dataStart, dataEnd), 'latin1')
      // 去掉尾随换行（PDF 规范里 endstream 前的 EOL 不属于数据）
      while (stream.length > 0 && (stream[stream.length - 1] === 0x0a || stream[stream.length - 1] === 0x0d)) {
        stream = stream.subarray(0, stream.length - 1)
      }
      if (stream.length === 0) stream = null
    } else {
      dict = s.slice(bodyStart, dictEnd)
    }
    if (!objects.has(num)) objects.set(num, { dict, stream })
  }
  return objects
}

/** 展开对象流：把 /Type/ObjStm 里面的对象拆出来补进表。 */
function expandObjectStreams(objects) {
  const additions = new Map()
  for (const [num, obj] of objects) {
    if (!/\/Type\s*\/ObjStm/.test(obj.dict)) continue
    const data = decodeStream(obj)
    if (!data) continue
    const nMatch = /\/N\s+(\d+)/.exec(obj.dict)
    const firstMatch = /\/First\s+(\d+)/.exec(obj.dict)
    if (!nMatch || !firstMatch) continue
    const n = Number(nMatch[1])
    const first = Number(firstMatch[1])
    const head = data.subarray(0, first).toString('latin1').trim()
    const nums = head.split(/\s+/).map(Number)
    for (let i = 0; i < Math.min(n, Math.floor(nums.length / 2)); i += 1) {
      const objNum = nums[i * 2]
      const offset = nums[i * 2 + 1]
      const nextOffset = i + 1 < Math.floor(nums.length / 2) ? nums[(i + 1) * 2 + 1] : data.length - first
      if (!Number.isFinite(objNum) || !Number.isFinite(offset)) continue
      const slice = data.subarray(first + offset, first + Math.max(offset, nextOffset)).toString('latin1')
      if (additions.has(objNum)) continue
      additions.set(objNum, { dict: slice.replace(/endobj[\s\S]*$/, ''), stream: null })
    }
  }
  for (const [num, obj] of additions) if (!objects.has(num)) objects.set(num, obj)
}

/** 从字典文本里取引用 "12 0 R"。 */
function refOf(dict, key) {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict)
  return m ? Number(m[1]) : null
}

/** 取数组引用 "[1 0 R 2 0 R]"。 */
function refArrayOf(dict, key) {
  const m = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`).exec(dict)
  if (!m) return []
  return (m[1].match(/(\d+)\s+\d+\s+R/g) ?? []).map((ref) => Number(ref.match(/(\d+)/)[1]))
}

/* ---------------------------------------------------------------- 字体与编码 ---- */

const CP1252_EXTRA = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
}

function hexToUnits(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const units = []
  for (let i = 0; i + 3 < clean.length + 1; i += 4) {
    const slice = clean.slice(i, i + 4)
    if (slice.length < 4) break
    units.push(parseInt(slice, 16))
  }
  return units
}

/** 解析 ToUnicode CMap → Map<code, string>。 */
function parseToUnicode(text) {
  const map = new Map()
  for (const block of text.match(/beginbfchar[\s\S]*?endbfchar/g) ?? []) {
    const pairs = block.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g) ?? []
    for (const pair of pairs) {
      const [, src, dst] = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/.exec(pair)
      const code = parseInt(src, 16)
      const units = hexToUnits(dst)
      if (units.length > 0) map.set(code, String.fromCharCode(...units))
    }
  }
  for (const block of text.match(/beginbfrange[\s\S]*?endbfrange/g) ?? []) {
    const entries = block.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g) ?? []
    for (const entry of entries) {
      const m = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/.exec(entry)
      const lo = parseInt(m[1], 16)
      const hi = parseInt(m[2], 16)
      if (hi < lo || hi - lo > 0xffff) continue
      const dstPart = m[3]
      if (dstPart.startsWith('[')) {
        const targets = dstPart.match(/<[0-9a-fA-F]*>/g) ?? []
        targets.forEach((t, i) => {
          const units = hexToUnits(t.slice(1, -1))
          if (units.length > 0) map.set(lo + i, String.fromCharCode(...units))
        })
      } else {
        const base = hexToUnits(dstPart.slice(1, -1))
        if (base.length === 0) continue
        for (let code = lo; code <= hi && code - lo < 0x10000; code += 1) {
          const shifted = base.slice()
          shifted[shifted.length - 1] += code - lo
          map.set(code, String.fromCharCode(...shifted))
        }
      }
    }
  }
  return map
}

/** 字体对象 → {twoByte, map} */
function loadFont(objects, fontObj) {
  if (!fontObj) return { twoByte: false, map: null }
  const twoByte = /\/Subtype\s*\/Type0/.test(fontObj.dict) || /Identity-[HV]/.test(fontObj.dict)
  let map = null
  const toUni = refOf(fontObj.dict, 'ToUnicode')
  if (toUni !== null) {
    const cmapObj = objects.get(toUni)
    const data = decodeStream(cmapObj)
    if (data) map = parseToUnicode(data.toString('latin1'))
  }
  return { twoByte, map }
}

/* ---------------------------------------------------------------- 内容流解析 ---- */

/** 从内容流里按出现顺序取「文本片段 + 位置变化」。 */
function* tokenize(content) {
  const s = content
  const n = s.length
  let i = 0
  const isDelim = (ch) => ch === undefined || ' \t\r\n\f\0()<>[]{}/%'.includes(ch)
  while (i < n) {
    const ch = s[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\0') { i += 1; continue }
    if (ch === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i += 1; continue }
    if (ch === '(') {
      let depth = 1
      let out = ''
      i += 1
      while (i < n && depth > 0) {
        const c = s[i]
        if (c === '\\') {
          const next = s[i + 1]
          const esc = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }
          if (esc[next] !== undefined) { out += esc[next]; i += 2; continue }
          if (next >= '0' && next <= '7') {
            let oct = ''
            let k = 0
            while (k < 3 && s[i + 1 + k] >= '0' && s[i + 1 + k] <= '7') { oct += s[i + 1 + k]; k += 1 }
            out += String.fromCharCode(parseInt(oct, 8) & 0xff)
            i += 1 + k
            continue
          }
          if (next === '\n' || next === '\r') { i += 2; continue }
          out += next ?? ''
          i += 2
          continue
        }
        if (c === '(') depth += 1
        if (c === ')') { depth -= 1; if (depth === 0) { i += 1; break } }
        out += c
        i += 1
      }
      yield { type: 'string', value: out }
      continue
    }
    if (ch === '<' && s[i + 1] !== '<') {
      let j = s.indexOf('>', i + 1)
      if (j < 0) j = n
      yield { type: 'hex', value: s.slice(i + 1, j) }
      i = j + 1
      continue
    }
    if (ch === '[') { yield { type: 'arrayStart' }; i += 1; continue }
    if (ch === ']') { yield { type: 'arrayEnd' }; i += 1; continue }
    if (ch === '/') {
      let j = i + 1
      while (j < n && !isDelim(s[j])) j += 1
      yield { type: 'name', value: s.slice(i + 1, j) }
      i = j
      continue
    }
    if (ch === '<' && s[i + 1] === '<') { i += 2; continue }
    if (ch === '>' && s[i + 1] === '>') { i += 2; continue }
    // 运算子或数字
    let j = i
    while (j < n && !isDelim(s[j])) j += 1
    const word = s.slice(i, j)
    i = j
    if (/^[-+]?[\d.]+$/.test(word)) yield { type: 'number', value: Number(word) }
    else if (word === 'BI') {
      // 内联图片：跳到 EI，别把二进制当文字
      const ei = s.indexOf('EI', i)
      i = ei < 0 ? n : ei + 2
    } else if (word !== '') yield { type: 'op', value: word }
  }
}

/**
 * 解一段内容流，产出带换行的文本。
 * @param content 内容流（latin1 字符串）
 * @param fonts Map<资源名, {twoByte, map}>
 */
function extractFromContent(content, fonts, state) {
  const out = []
  const stack = []
  let font = { twoByte: false, map: null }
  let fontSize = 12
  let leading = 0
  let x = 0
  let y = 0
  let lastY = null
  let lastX = null
  let lineOpen = false

  const newline = () => {
    if (lineOpen) { out.push('\n'); lineOpen = false }
    lastX = null
  }
  const put = (text) => {
    if (text === '') return
    if (lastY !== null && Math.abs(y - lastY) > Math.max(1, fontSize * 0.35)) newline()
    if (lineOpen && lastX !== null && x - lastX > Math.max(0.8, fontSize * 0.22)) out.push(' ')
    out.push(text)
    lineOpen = true
    lastY = y
    lastX = x + text.length * fontSize * 0.5
  }
  const show = (bytes) => {
    if (!font.map && font.twoByte) {
      state.undecodable += bytes.length / 2
      return
    }
    let text = ''
    if (font.map) {
      if (font.twoByte) {
        for (let i = 0; i + 1 < bytes.length; i += 2) {
          const code = (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1)
          const mapped = font.map.get(code)
          if (mapped !== undefined) text += mapped
          else { state.undecodable += 1; text += '\uFFFD' }
        }
      } else {
        for (let i = 0; i < bytes.length; i += 1) {
          const code = bytes.charCodeAt(i)
          const mapped = font.map.get(code)
          if (mapped !== undefined) text += mapped
          else if (code >= 32) text += CP1252_EXTRA[code] ?? String.fromCharCode(code)
        }
      }
    } else {
      for (let i = 0; i < bytes.length; i += 1) {
        const code = bytes.charCodeAt(i)
        if (code >= 32 || code === 9) text += CP1252_EXTRA[code] ?? String.fromCharCode(code)
      }
    }
    put(text)
    x = lastX ?? x
  }

  for (const token of tokenize(content)) {
    if (token.type === 'op') {
      const op = token.value
      // BT 只重置文本矩阵，**不能清 lastY**：Edge/Chrome 打印出来的 PDF 每行一个 BT，
      // 清掉基线记忆后「换行判定」永远拿不到上一行的 y，整页被拼成一行
      // （实测 8 页文档只抽出 14 个换行、切章只剩 2 段）。保留基线才能按 y 断行。
      if (op === 'BT') { x = 0 }
      else if (op === 'Tf') {
        const size = stack[stack.length - 1]
        const name = stack[stack.length - 2]
        if (typeof size === 'number') fontSize = Math.abs(size) || 12
        font = fonts.get(name) ?? { twoByte: false, map: null }
      } else if (op === 'Tm') {
        const f = stack.slice(-6)
        if (f.length === 6) { x = f[4]; y = f[5] }
      } else if (op === 'Td' || op === 'TD') {
        const [tx, ty] = stack.slice(-2)
        if (typeof tx === 'number') x += tx
        if (typeof ty === 'number') { y += ty; if (op === 'TD') leading = -ty }
      } else if (op === 'TL') {
        const v = stack[stack.length - 1]
        if (typeof v === 'number') leading = v
      } else if (op === 'T*') { y -= leading }
      else if (op === 'Tj') {
        const str = stack[stack.length - 1]
        if (typeof str === 'string') show(str)
      } else if (op === 'TJ') {
        // 数组里数字是字距，负得很厉害时补空格
        for (let k = stack.length - 1; k >= 0; k -= 1) {
          if (stack[k] === '[') break
          if (typeof stack[k] === 'number' && stack[k] < -180) put(' ')
        }
        for (const item of stack) if (typeof item === 'string') show(item)
      } else if (op === "'" || op === '"') {
        y -= leading
        const items = stack.filter((v) => typeof v === 'string')
        if (items.length > 0) show(items[items.length - 1])
      }
      stack.length = 0
      continue
    }
    if (token.type === 'arrayStart') { stack.push('['); continue }
    if (token.type === 'arrayEnd') continue
    if (token.type === 'string' || token.type === 'hex') {
      stack.push(token.type === 'hex' ? hexToString(token.value) : token.value)
      continue
    }
    stack.push(token.value)
  }
  return out.join('')
}

function hexToString(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const even = clean.length % 2 === 0 ? clean : `${clean}0`
  let out = ''
  for (let i = 0; i < even.length; i += 2) out += String.fromCharCode(parseInt(even.slice(i, i + 2), 16))
  return out
}

/* -------------------------------------------------------------------- 页面树 ---- */

function collectPages(objects) {
  const pages = []
  const visit = (num, inherited, depth) => {
    if (depth > 64) return
    const obj = objects.get(num)
    if (!obj) return
    const dict = obj.dict
    const resRef = refOf(dict, 'Resources')
    const resources = resRef !== null ? objects.get(resRef)?.dict ?? inherited : (/\/Resources\s*<</.test(dict) ? dict : inherited)
    if (/\/Type\s*\/Page[^s]/.test(dict)) {
      pages.push({ num, dict, resources })
      return
    }
    const kids = refArrayOf(dict, 'Kids')
    for (const kid of kids) visit(kid, resources, depth + 1)
  }

  let rootNum = null
  const catalog = [...objects.entries()].find(([, obj]) => /\/Type\s*\/Catalog/.test(obj.dict))
  if (catalog) rootNum = catalog[0]
  const pagesNum = catalog ? refOf(objects.get(catalog[0]).dict, 'Pages') : null
  if (pagesNum !== null) visit(pagesNum, null, 0)

  if (pages.length === 0) {
    for (const [num, obj] of objects) if (/\/Type\s*\/Page[^s]/.test(obj.dict)) pages.push({ num, dict: obj.dict, resources: null })
    pages.sort((a, b) => a.num - b.num)
  }
  return pages
}

/** 取页面的字体表：名字 → {twoByte, map} */
function pageFonts(objects, resources) {
  const fonts = new Map()
  if (!resources) return fonts
  let fontDictText = null
  const fontRef = refOf(resources, 'Font')
  if (fontRef !== null) fontDictText = objects.get(fontRef)?.dict ?? null
  else {
    const inline = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)
    if (inline) fontDictText = inline[1]
  }
  if (!fontDictText) return fonts
  const refRe = /\/([^\s/<>\[\]]+)\s+(\d+)\s+\d+\s+R/g
  let m
  while ((m = refRe.exec(fontDictText)) !== null) {
    const name = m[1]
    const fontObj = objects.get(Number(m[2]))
    if (fontObj) fonts.set(name, loadFont(objects, fontObj))
  }
  return fonts
}

/* ---------------------------------------------------------------------- 入口 ---- */

/**
 * 抽取 PDF 文本。
 * @param {Uint8Array|Buffer} bytes
 * @returns {{text: string, pages: number, warnings: string[], textPages: number}}
 */
export function extractPdfText(bytes) {
  const buf = Buffer.from(bytes)
  if (buf.length < 8 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('不是 PDF 文件（缺少 %PDF- 文件头）')
  }
  const head = buf.subarray(0, 2048).toString('latin1')
  const warnings = []
  if (/\/Encrypt\b/.test(head)) {
    // 加密 PDF 绝大多数有权限口令，压缩流解不出来；先照常尝试，末尾按结果报告
    warnings.push('检测到 /Encrypt（加密/权限保护），文本可能不完整；若结果为空请提供未加密版本。')
  }

  const s = buf.toString('latin1')
  const objects = scanObjects(s)
  expandObjectStreams(objects)
  const pages = collectPages(objects)

  const state = { undecodable: 0 }
  const pageTexts = []
  let failedStreams = 0

  for (const page of pages) {
    const contents = refArrayOf(page.dict, 'Contents')
    if (contents.length === 0) {
      const single = refOf(page.dict, 'Contents')
      if (single !== null) contents.push(single)
    }
    let content = ''
    for (const ref of contents) {
      const obj = objects.get(ref)
      const data = decodeStream(obj)
      if (!data) { failedStreams += 1; continue }
      content += `${data.toString('latin1')}\n`
    }
    if (content === '') { pageTexts.push(''); continue }
    const fonts = pageFonts(objects, page.resources)
    pageTexts.push(extractFromContent(content, fonts, state))
  }

  if (failedStreams > 0) warnings.push(`${failedStreams} 个内容流无法解码（可能是加密或罕见滤镜），对应页可能缺文。`)

  let text = pageTexts
    .map((t) => t.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim())
    .filter((t) => t !== '')
    .join('\n\n')

  // 去重连续重复行（页眉页脚在抽取结果里很常见，这里只做最保守的相邻合并）
  text = text.replace(/(^|\n)([^\n]{2,40})\n\2(\n|$)/g, '$1$2$3')

  // 中文排版被 Td 位移切出来的空格要收掉：「课 程 论 文」→「课程论文」。
  // 只处理两个汉字/中文标点**之间**的空格，英文单词间距不受影响。
  const cjk = '\\u3000-\\u303f\\u4e00-\\u9fff'
  for (let i = 0; i < 5; i += 1) {
    const before = text
    text = text.replace(new RegExp(`([${cjk}])[ \\t]+([${cjk}])`, 'g'), '$1$2')
    if (before === text) break
  }

  const textPages = pageTexts.filter((t) => t.trim() !== '').length
  const totalChars = text.replace(/\s/g, '').length
  if (pages.length > 0 && (totalChars < pages.length * 20 || textPages === 0)) {
    warnings.push('文本层几乎为空：这份 PDF 是扫描件（图片页），本解析器只能读到图片，读不到文字。走 OCR：用本插件 scripts/ocr-pdf.ps1（Windows 自带 PDF 渲染 + 中文 OCR，离线）把页面转成文本，再 study_ingest 入库。')
  }
  if (state.undecodable > 200 && totalChars > 0 && state.undecodable > totalChars) {
    warnings.push('大量字形缺少 ToUnicode 映射，抽取结果中会出现 \uFFFD；建议换一份带文本层的 PDF。')
  }

  return { text, pages: pages.length, textPages, warnings, chars: totalChars }
}
