/**
 * 资料库持久化：把解析后的正文落盘，索引留在 index.json。
 * 目录：<workspace>/.study-kit/
 *   index.json          文档索引（含章节偏移、真题统计结果）
 *   docs/<id>.md        清洗后的全文（按章节偏移切片读取）
 *   papers/<id>.md      生成的模拟卷/蓝图
 *
 * 设计取舍：正文单独存文件，索引只存偏移量。这样 read 一个章节不必加载整本书。
 */

import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { join, dirname, basename, extname } from 'node:path'
import { createHash } from 'node:crypto'

const INDEX_VERSION = 1

export function storeRoot(workspace) {
  return join(workspace, '.study-kit')
}

function indexFile(workspace) {
  return join(storeRoot(workspace), 'index.json')
}

export async function loadIndex(workspace) {
  try {
    const raw = await readFile(indexFile(workspace), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== INDEX_VERSION) return emptyIndex()
    return parsed
  } catch {
    return emptyIndex()
  }
}

function emptyIndex() {
  return { version: INDEX_VERSION, updatedAt: null, docs: [], nextId: 1 }
}

export async function saveIndex(workspace, index) {
  await mkdir(storeRoot(workspace), { recursive: true })
  index.updatedAt = new Date().toISOString()
  await writeFile(indexFile(workspace), JSON.stringify(index, null, 2), 'utf8')
}

export function sha1(buffer) {
  return createHash('sha1').update(buffer).digest('hex')
}

export function docId(n) {
  return `d${n}`
}

/** 文档落盘，返回 id。同内容（sha1 相同）复用旧 id，不重复入库。 */
export async function putDoc(workspace, index, { name, kind, text, sections, sourcePath, hash, meta }) {
  const existing = index.docs.find((d) => d.hash === hash)
  if (existing) {
    existing.name = existing.name || name
    existing.sourcePath = sourcePath ?? existing.sourcePath
    existing.meta = { ...existing.meta, ...meta }
    return { doc: existing, reused: true }
  }
  const id = docId(index.nextId++)
  const dir = join(storeRoot(workspace), 'docs')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${id}.md`), text, 'utf8')
  const doc = {
    id,
    name,
    kind,
    chars: text.length,
    hash,
    sourcePath,
    addedAt: new Date().toISOString(),
    sections,
    meta: meta ?? {},
  }
  index.docs.push(doc)
  return { doc, reused: false }
}

export async function readDocText(workspace, doc) {
  return readFile(join(storeRoot(workspace), 'docs', `${doc.id}.md`), 'utf8')
}

export async function readDocSlice(workspace, doc, start, end) {
  const full = await readDocText(workspace, doc)
  return full.slice(Math.max(0, start), Math.min(full.length, end))
}

export async function findDoc(index, idOrName) {
  if (!idOrName) return null
  const key = String(idOrName).trim()
  return (
    index.docs.find((d) => d.id === key) ??
    index.docs.find((d) => d.name === key) ??
    index.docs.find((d) => d.name.includes(key)) ??
    null
  )
}

export async function savePaper(workspace, name, markdown) {
  const dir = join(storeRoot(workspace), 'papers')
  await mkdir(dir, { recursive: true })
  const safe = basename(String(name)).replace(/[\\/:*?"<>|]/g, '_')
  const target = join(dir, safe.endsWith('.md') ? safe : `${safe}.md`)
  await writeFile(target, markdown, 'utf8')
  return target
}

export async function listFiles(dir) {
  const out = []
  // 只收顶层文件：OCR 产物目录里常有 pages/ 这种逐页文本子目录，
  // 递归会把 500 个单页文件当资料灌进库，把资料库彻底搅乱。
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    out.push(join(dir, entry.name))
  }
  return out
}

export function kindOf(path) {
  const ext = extname(path).toLowerCase()
  return {
    '.txt': 'text', '.md': 'markdown', '.markdown': 'markdown',
    '.pdf': 'pdf', '.docx': 'docx', '.pptx': 'pptx',
    '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.bmp': 'image', '.gif': 'image',
  }[ext] ?? null
}

export { dirname, basename, extname, stat }
