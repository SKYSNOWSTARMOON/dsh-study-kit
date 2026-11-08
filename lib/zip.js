/**
 * 极简 ZIP 读取器（只用 Node 内置 zlib）。
 *
 * 用途：.docx / .pptx 本质都是 ZIP，本插件零依赖、离线可用，
 * 所以不能指望 adm-zip / jszip，这里只实现读，不实现写。
 *
 * 支持：store(0) / deflate(8)；中文文件名按 UTF-8 解码（flag bit 11 或回退）。不支持 ZIP64。
 */

import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

/** 从尾部向前找 EOCD（注释最长 65535）。 */
function findEocd(buf) {
  const max = Math.min(buf.length, 0xffff + 22)
  for (let i = buf.length - 22; i >= buf.length - max; i -= 1) {
    if (i < 0) break
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/**
 * 读取 zip 条目表。
 * @returns {{name: string, method: number, size: number, offset: number}[]}
 */
export function listZipEntries(buf) {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 ZIP/docx/pptx：找不到中央目录结尾')
  const count = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16)
  if (ptr === 0xffffffff) throw new Error('不支持 ZIP64 格式的 Office 文件')
  const entries = []
  for (let i = 0; i < count; i += 1) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CEN_SIG) break
    const flags = buf.readUInt16LE(ptr + 8)
    const method = buf.readUInt16LE(ptr + 10)
    const size = buf.readUInt32LE(ptr + 20)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const offset = buf.readUInt32LE(ptr + 42)
    const rawName = buf.subarray(ptr + 46, ptr + 46 + nameLen)
    // bit 11 = 名字是 UTF-8；没置位也可能是 UTF-8（多数打包器），先按 UTF-8 试、失败再 latin1
    let name
    try {
      name = rawName.toString('utf8')
      if (name.includes('\uFFFD') && (flags & 0x800) === 0) name = rawName.toString('latin1')
    } catch {
      name = rawName.toString('latin1')
    }
    entries.push({ name, method, size, offset })
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 读出某条目的解压后 Buffer。 */
export function readZipEntry(buf, entry) {
  const off = entry.offset
  if (buf.readUInt32LE(off) !== LOC_SIG) throw new Error(`ZIP 条目头损坏：${entry.name}`)
  const nameLen = buf.readUInt16LE(off + 26)
  const extraLen = buf.readUInt16LE(off + 28)
  const start = off + 30 + nameLen + extraLen
  // 中央目录里的 size 可能为 0（部分打包器），此时靠 data descriptor，兜底读到下一个签名
  let size = entry.size
  if (size === 0) {
    const next = buf.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), start)
    size = next > start ? next - start : buf.length - start
  }
  const data = buf.subarray(start, start + size)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) return inflateRawSync(data)
  throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}：${entry.name}`)
}

/** 建立 名字→条目 的索引，读起来顺手。 */
export function openZip(buf) {
  const entries = listZipEntries(buf)
  const byName = new Map(entries.map((e) => [e.name, e]))
  return {
    names: entries.map((e) => e.name),
    has: (name) => byName.has(name),
    /** 读成 utf8 文本 */
    text(name) {
      const entry = byName.get(name)
      if (!entry) throw new Error(`ZIP 内不存在：${name}`)
      return readZipEntry(buf, entry).toString('utf8')
    },
    /** 读成 Buffer */
    bytes(name) {
      const entry = byName.get(name)
      if (!entry) throw new Error(`ZIP 内不存在：${name}`)
      return readZipEntry(buf, entry)
    },
  }
}

/* ---------------------------------------------------------------- XML 小工具 ---- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXmlEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[body] ?? m
  })
}

/** 去掉标签只留文字（段落/换行标签先转成换行）。 */
export function xmlToText(xml) {
  return decodeXmlEntities(
    xml
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/a:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
}
