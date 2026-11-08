/**
 * 四个工具的实现：ingest / outline / read / exam_stats / paper。
 * 每个工具都返回「文本里能直接看」的结果，并把结构化数据放在 value 里。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { extractDocx, extractPptx } from './office.js'
import { extractPdfText } from './pdf.js'
import { cleanText, classifyText, buildSections, containment, shingles, profileText } from './clean.js'
import { splitQuestions, topicHeat, heatTable, estimateDifficulty } from './stats.js'
import { buildPaper, validatePaper } from './paper.js'
import { buildPack, buildCourse, exportMarkdownBatch, reflowOcrText } from './export.js'
import * as store from './store.js'

const MAX_CHARS_PER_DOC = 3_000_000
const MAX_READ_CHARS = 12_000
// 同源判定阈值：同一份资料的 docx 与其 pdf 打印件实测 0.89~0.94，
// 不同章节之间 < 0.2，取 0.85 不会误杀「同一本书的不同章节」。
const DUP_SKIP = 0.85

/** 会话工作目录：优先 workingDirectory 服务，取不到再退回进程 cwd。 */
export function workspaceOf(ctx, exec) {
  const session = exec?.agent?.session ?? exec?.session
  try {
    const wd = ctx.get?.('workingDirectory')
    if (wd) {
      if (typeof wd.get === 'function') {
        const value = wd.get(session)
        if (typeof value === 'string' && value !== '') return value
        if (value) {
          for (const key of ['path', 'directory', 'cwd', 'root']) {
            if (typeof value[key] === 'string' && value[key] !== '') return value[key]
          }
        }
      }
      for (const key of ['defaultDirectory', 'defaultPath', 'root']) {
        if (typeof wd[key] === 'string' && wd[key] !== '') return wd[key]
      }
    }
  } catch {
    /* 服务不在就退回 cwd */
  }
  return process.cwd()
}

/* ------------------------------------------------------------ 解析单个文件 ---- */

const CJK_RE = /[\u4e00-\u9fff]/g
const BAD_RE = /\uFFFD/g

function countOf(text, re) {
  const m = text.match(re)
  return m ? m.length : 0
}

/**
 * 纯文本解码：默认 UTF-8；只有在 UTF-8 明显解崩（大比例替换字符）时才尝试 GBK。
 * 早期版本「只要出现一个 U+FFFD 就整篇按 GBK 重解」会把夹带一行乱码的正常 UTF-8 文件
 * 整篇解成 GBK 乱码（OCR 生成的章节文件正好踩中）。
 */
function decodeTextBuffer(buf) {
  const utf8 = buf.toString('utf8')
  const bad = countOf(utf8, BAD_RE)
  if (bad === 0) return utf8
  const badRatio = bad / Math.max(1, utf8.length)
  if (badRatio < 0.02) return utf8 // 零星坏字节：保留原文，交给 cleanText 行级剔除
  try {
    const gbk = new TextDecoder('gbk').decode(buf)
    const gbkBad = countOf(gbk, BAD_RE)
    if (gbkBad * 10 < bad && countOf(gbk, CJK_RE) > countOf(utf8, CJK_RE)) return gbk
  } catch {
    /* 没有 gbk 解码器就保留原样 */
  }
  return utf8
}

// 导出给自测/调参脚本用（不是工具接口，工具走 buildTools 注册）
export async function parseFile(file, kind) {
  const buf = await fsp.readFile(file)
  // 上限按类型分：PDF 常是整本扫描件（几百页、上百 MB），但文本层探测很便宜
  // （501 页扫描教材实测 0.45 秒读到「文本层为空」），先读再判比直接拒收有用得多。
  const limitMb = kind === 'pdf' ? 256 : 60
  if (buf.length > limitMb * 1024 * 1024) throw new Error(`文件过大（${(buf.length / 1048576).toFixed(1)}MB > ${limitMb}MB），跳过`)

  if (kind === 'text' || kind === 'markdown') {
    return { text: decodeTextBuffer(buf), warnings: [] }
  }
  if (kind === 'docx') return extractDocx(buf)
  if (kind === 'pptx') return extractPptx(buf)
  if (kind === 'pdf') {
    const result = extractPdfText(new Uint8Array(buf))
    return { text: result.text, warnings: result.warnings ?? [], pages: result.pages }
  }
  if (kind === 'image') {
    return {
      text: '',
      needsOcr: true,
      warnings: ['图片资料：插件本身不跑 OCR。用 scripts\\ocr-image.ps1 离线识别（Windows 自带引擎），或 modlens_read_image / read_image 读成文字，再交给 study_ingest_text 入库。'],
    }
  }
  throw new Error(`不支持的类型：${kind}`)
}

/* ------------------------------------------------------------------ 入库 ---- */

async function ingestOne(workspace, index, file, options) {
  const kind = store.kindOf(file)
  if (!kind) return { file, skipped: '不支持的扩展名' }

  const parsed = await parseFile(file, kind)
  if (parsed.needsOcr) {
    return { file, name: path.basename(file), kind: 'image', needsOcr: true, warnings: parsed.warnings }
  }

  let text = parsed.text ?? ''
  const warnings = [...(parsed.warnings ?? [])]
  if (text.trim().length === 0) {
    return { file, name: path.basename(file), kind, empty: true, warnings: [...warnings, '没有抽到任何文字。'] }
  }
  if (text.length > MAX_CHARS_PER_DOC) {
    text = text.slice(0, MAX_CHARS_PER_DOC)
    warnings.push(`正文超过 ${MAX_CHARS_PER_DOC} 字，已截断。`)
  }

  const before = text.length
  if (options.clean) {
    const cleaned = cleanText(text)
    text = cleaned.text
    warnings.push(...(cleaned.notes ?? []))
  }
  const name = path.basename(file)
  const classified = classifyText(text, name)
  const sections = buildSections(text, classified.kind).sections

  // 同源近重复：同一份资料的 docx 与它的 pdf 打印件内容几乎逐字相同，两份入库只会
  // 让索引翻倍、让 study_pack 把同一章生成两次。入库前先比内容（shingle 双向包含），
  // 实测同源对重合度 0.89~0.94，不同章之间 < 0.2，取 0.85 当阈值很安全。
  // 注意顺序：先按内容哈希判「同一份文件重复入库」（复用，不该报成跳过的重复），
  // 哈希对不上才做近重复比对。
  const hash = store.sha1(Buffer.from(text, 'utf8'))
  const exact = index.docs.find((d) => d.hash === hash)
  const cache = options.cache ?? new Map()
  const stem = name.replace(/\.[^.]+$/u, '')
  let near = null
  if (!exact) {
    const mine = shingles(text)
    for (const other of index.docs) {
      if (!other.sections || other.sections.length === 0) continue
      try {
        let theirs = cache.get(other.id)
        if (!theirs) {
          theirs = shingles(await store.readDocSlice(workspace, other, 0, 20000))
          cache.set(other.id, theirs)
        }
        const c = Math.max(containment(mine, theirs), containment(theirs, mine))
        // 同名不同格式（a.docx / a.pdf）本身就是强证据：短文档（如课程总览）被
        // 页码、页眉稀释后重合度只有 0.7，但内容仍是同一份，这里放宽到 0.5。
        const sameStem = typeof other.name === 'string' && other.name.replace(/\.[^.]+$/u, '') === stem
        if ((c >= DUP_SKIP || (sameStem && c >= 0.5)) && (!near || c > near.overlap)) {
          near = { id: other.id, name: other.name, overlap: Number(c.toFixed(2)) }
        }
      } catch { /* 读失败就不算重复 */ }
    }
  }
  if (near) {
    return {
      file, name, kind, format: kind, duplicateOf: near.id, overlap: near.overlap,
      chars: text.length,
      warnings: [...warnings, `与 ${near.id}「${near.name}」内容重合 ${near.overlap}，已跳过入库（保留先入库的那份）。`],
    }
  }

  const { doc, reused } = await store.putDoc(workspace, index, {
    name, kind: classified.kind, text, sections, sourcePath: file, hash,
    meta: { parser: kind, confidence: classified.confidence, signals: classified.signals },
  })

  return {
    file,
    name,
    id: doc.id,
    reused,
    format: kind,
    libraryKind: classified.kind,
    confidence: classified.confidence,
    chars: text.length,
    trimmedChars: Math.max(0, before - text.length),
    sections: sections.length,
    warnings,
  }
}

/* --------------------------------------------------------------- 工具定义 ---- */

const P_INGEST = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: '文件或目录的绝对路径（也接受相对工作目录的路径）。' },
    recursive: { type: 'boolean', description: '目录是否递归子目录，默认 true。' },
    clean: { type: 'boolean', description: '是否清除水印/页眉页脚/页码/广告，默认 true。' },
  },
  required: ['path'],
}

const P_INGEST_TEXT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: '资料名（用于索引与后续引用）。' },
    text: { type: 'string', description: '正文纯文本（OCR 结果或用户粘贴的内容）。' },
    kind: { type: 'string', description: '可选：标注内容类型（教材正文/笔记/课件/习题/试卷/参考答案）。不填则自动判定。' },
    clean: { type: 'boolean', description: '是否清洗，默认 true。' },
  },
  required: ['name', 'text'],
}

const P_OUTLINE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc: { type: 'string', description: '文档 id（如 d1）或名字片段。省略则列出整个资料库。' },
    maxSections: { type: 'integer', description: '每份文档最多列出的章节数，默认 80。' },
  },
  required: [],
}

const P_READ = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc: { type: 'string', description: '文档 id（如 d1）或名字片段。' },
    section: { type: 'integer', description: '章节序号（1 起，来自 study_outline）。' },
    match: { type: 'string', description: '按标题文字模糊匹配章节，如「第三章」。' },
    limit: { type: 'integer', description: '最多返回多少字，默认 8000，上限 12000。' },
  },
  required: ['doc'],
}

const P_EXAM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    docs: { type: 'array', items: { type: 'string' }, description: '试卷文档 id 列表；省略则用资料库里所有试卷类文档。' },
    topN: { type: 'integer', description: '热度表返回多少个考点，默认 25。' },
  },
  required: [],
}

const P_PAPER = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: '模拟卷名，也作为落盘文件名。' },
    blueprint: {
      type: 'array',
      description: '题型配比，如 [{type:"选择题",count:10,score:2},{type:"计算题",count:4,score:10}]。省略则按真题统计的题型配比自动生成。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string' },
          count: { type: 'integer' },
          score: { type: 'number' },
        },
        required: ['type', 'count', 'score'],
      },
    },
    docs: { type: 'array', items: { type: 'string' }, description: '依据哪些试卷统计考点；省略则用全部试卷。' },
    seed: { type: 'integer', description: '随机种子，同种子结果可复现。' },
    difficulty: { type: 'integer', description: '目标难度 1~4，默认 2。' },
    avoidOriginal: { type: 'boolean', description: '是否在每题标注避重原题号，默认 true。' },
    totalScore: { type: 'number', description: '目标总分；给了就在 blueprint 省略时按此缩放题量。' },
  },
  required: [],
}

const P_PACK = {
  type: 'object',
  additionalProperties: false,
  properties: {
    course: { type: 'string', description: '课程名，也是输出文件夹名（如「基础生命科学」）。' },
    srcDir: { type: 'string', description: '存放按章 markdown 的目录（01-第1章-xxx.md …；00-开头的是总览）。相对路径按会话工作目录解析。' },
    outDir: { type: 'string', description: '输出根目录，包里会建 <outDir>/<课程名>/。默认=会话工作目录。' },
    format: { type: 'string', description: 'docx（默认）/ pdf / both。pdf 需要本机装 Word。' },
    author: { type: 'string', description: '文档属性里的作者名，可选。' },
  },
  required: ['course', 'srcDir'],
}

const P_COURSE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    course: {
      type: 'string',
      description: '课程名，也是文件夹名（如「基础生命科学」）。同一门课以后补充内容时传同一个名字，就并进原文件夹，不另起目录。',
    },
    chapters: {
      type: 'array',
      description: '按章排好序的正文。markdown 里用二级标题分「知识点」「习题」等小节；一门课一次传完整 12 章，也可只传要补的那几章。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          no: { type: 'integer', description: '章号（1 起）。文件名会排成 01-第1章-章名。' },
          title: { type: 'string', description: '章名，如「生物与生命科学」。' },
          markdown: { type: 'string', description: '该章正文（Markdown，公式用 $...$）。留空=只登记：章节 docx 已存在时，只补 .course-md 镜像、不重写 Word/PDF（用于把旧课程包纳入管理）。' },
          part: { type: 'string', description: '补充块的标题前缀，默认「补充」，可写「考研补充」「错题订正」之类。' },
        },
        required: ['title'],
      },
    },
    outDir: { type: 'string', description: '课程文件夹放在哪个根目录下，默认=会话工作目录（这样就是 C:\\Users\\SKY\\Desktop\\资料\\<课程名>\\）。' },
    format: { type: 'string', description: 'docx / pdf / both，默认 both（用户要的就是 Word + PDF 都有）。' },
    merge: { type: 'boolean', description: '章节已存在时是否合并，默认 true：内容重复不写，新内容追加到「## 补充 · 日期」下。' },
    rerender: { type: 'boolean', description: '按现有 .course-md 镜像重写 Word/PDF（内容不动）。改了模板或想重出一遍成品时用。' },
    author: { type: 'string', description: '文档属性里的作者名，可选。' },
  },
  required: ['course', 'chapters'],
}

const P_EXPORT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    docs: {
      type: 'array',
      items: { type: 'string' },
      description: '要导出的资料：id（d3）或名字片段（可多个，如 ["d27","d28"] 或 ["全本教材"]）。和 prefix 二选一，都不给=导出整个库。',
    },
    prefix: { type: 'string', description: '按名字前缀筛选，如「全本教材」「习题指导」。' },
    outDir: { type: 'string', description: '输出根目录，会建 <outDir>/<folderName>/。默认=<会话工作目录>\\资料导出。' },
    folderName: { type: 'string', description: '输出子文件夹名，默认按 prefix 或「资料导出」。' },
    format: { type: 'string', description: 'docx（默认）/ pdf / both。PDF 先试 Edge/Chrome 无头打印，不行用 DSH 自带 LibreOffice Kit，不需要 Word。' },
    author: { type: 'string', description: '文档属性里的作者名，可选。' },
    reflow: {
      type: 'string',
      description: 'auto（默认）/ on / off：OCR 出来的资料是一行一段，auto 会在识别出 OCR 文本时按标点重排成正常段落；on 强制重排；off 保留原样。',
    },
  },
}

/* ---------------------------------------------------------------- 构建工具 ---- */

export function buildTools(ctx, log) {
  const tools = []

  tools.push({
    name: 'study_ingest',
    description:
      '把学习资料（txt/md/docx/pptx/pdf，或整个目录）解析入库：清除水印页眉页脚页码、按篇幅占比判定内容类型（教材/笔记/课件/习题/试卷/参考答案）、' +
      '同源内容（同一份资料的 docx 与它的 pdf 打印件）入库时自动跳过、按标题切章并建索引。返回每份资料的 id（后续 study_outline / study_read / study_exam_stats 用它）。' +
      '图片不含 OCR 引擎，会提示改用 study_ingest_text。',
    parameters: P_INGEST,
    timeoutMs: 180000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '给人看的入库报告。' },
          added: { type: 'integer' },
          reused: { type: 'integer' },
          skipped: { type: 'integer' },
          needsOcr: { type: 'array', items: { type: 'string' } },
          docs: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { id: { type: 'string' }, name: { type: 'string' } } } },
        },
        required: ['text', 'added', 'reused', 'skipped', 'needsOcr', 'docs'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspace = workspaceOf(ctx, exec)
      const target = path.isAbsolute(args.path) ? args.path : path.join(workspace, args.path)
      const info = await fsp.stat(target)
      const files = info.isDirectory()
        ? (await store.listFiles(target)).filter((f) => store.kindOf(f) !== null)
        : [target]
      if (files.length === 0) {
        return { text: `没找到可解析的文件：${target}`, added: 0, reused: 0, skipped: 0, needsOcr: [], docs: [] }
      }

      const index = await store.loadIndex(workspace)
      const results = []
      // 同源比对的文本摘要缓存：一批 60 份文件逐对比对时，同一份已有文档会被读很多次
      const cache = new Map()
      for (const file of files.slice(0, 60)) {
        try {
          results.push(await ingestOne(workspace, index, file, { clean: args.clean !== false, cache }))
        } catch (error) {
          results.push({ file, name: path.basename(file), error: error?.message ?? String(error) })
        }
      }
      await store.saveIndex(workspace, index)

      // 跨资料重复检测（同源补全/互相覆盖）
      const dupes = []
      for (let i = 0; i < index.docs.length; i += 1) {
        for (let j = i + 1; j < index.docs.length; j += 1) {
          const a = index.docs[i]
          const b = index.docs[j]
          if (a.sections.length === 0 || b.sections.length === 0) continue
          try {
            const ta = await store.readDocSlice(workspace, a, 0, 20000)
            const tb = await store.readDocSlice(workspace, b, 0, 20000)
            // 取两个方向的最大值：小文档被大文档完全包含时，单向 containment 会偏小。
            // （实测同一章的 docx 与 pdf 导出件：单向 0.90，反向 0.89，取 max 才稳。）
            const sa = shingles(ta)
            const sb = shingles(tb)
            const c = Math.max(containment(sa, sb), containment(sb, sa))
            if (c >= 0.5) dupes.push({ a: a.id, b: b.id, overlap: Number(c.toFixed(2)) })
          } catch { /* 读失败就算了 */ }
        }
      }

      const added = results.filter((r) => r.id && !r.reused).length
      const reused = results.filter((r) => r.reused).length
      const skipped = results.filter((r) => r.duplicateOf).length
      const needsOcr = results.filter((r) => r.needsOcr).map((r) => r.file)
      // 抽不到文字的 PDF 多半是扫描件 —— 解析器的说明必须原样给出去，
      // 只写「没抽到文字」用户不知道下一步该 OCR 还是这份文件坏了。
      const scanned = results.filter((r) => r.empty && r.kind === 'pdf').map((r) => r.file)
      const failed = results.filter((r) => r.error || r.empty)

      const lines = [
        `已入库 ${added} 份（复用 ${reused} 份${skipped > 0 ? `，跳过 ${skipped} 份同源重复` : ''}），资料库共 ${index.docs.length} 份。`,
        '',
      ]
      for (const r of results) {
        if (r.error) { lines.push(`- ✗ ${r.name ?? r.file}：${r.error}`); continue }
        if (r.empty) {
          lines.push(`- ✗ ${r.name}：没抽到文字（${r.kind}）`)
          for (const w of r.warnings ?? []) lines.push(`    · ${w}`)
          continue
        }
        if (r.needsOcr) {
          lines.push(`- ⚠ ${r.name}：图片，需要 OCR`)
          for (const w of r.warnings ?? []) lines.push(`    · ${w}`)
          continue
        }
        if (r.duplicateOf) {
          lines.push(`- ⇄ ${r.name}｜与 ${r.duplicateOf} 同源（重合 ${r.overlap}），跳过入库`)
          for (const w of r.warnings ?? []) lines.push(`    · ${w}`)
          continue
        }
        lines.push(`- ${r.id} ${r.name}｜${r.libraryKind}（置信 ${r.confidence}）｜${r.chars} 字｜${r.sections} 节${r.reused ? '｜已存在，复用' : ''}`)
        for (const w of r.warnings ?? []) lines.push(`    · ${w}`)
      }
      if (dupes.length > 0) {
        lines.push('', '内容相近但不完全相同（可只留一份，或用另一份补全缺失章节）：')
        for (const d of dupes) lines.push(`- ${d.a} ≈ ${d.b}，重合度 ${d.overlap}`)
      }
      if (needsOcr.length > 0 || scanned.length > 0) {
        const list = [...needsOcr, ...scanned].join('、')
        lines.push('', `需要 OCR：${list}`,
          '做法（二选一）：',
          '  a) 扫描版 PDF：跑本插件 scripts/ocr-pdf.ps1（Windows 自带 PDF 渲染 + 中文 OCR，离线、免费），产出逐页文本后再 study_ingest 入库；',
          '  b) 零散图片：跑 scripts/ocr-image.ps1 -Image 图1,图2 -OutDir 输出目录（同一套 Windows OCR 引擎），或直接用 read_image 读字；产出的 txt 再 study_ingest。')
      }
      if (failed.length > 0) lines.push('', `解析失败/无文字：${failed.map((f) => f.name ?? f.file).join('、')}（扫描件或纯图 PDF 需要 OCR）`)

      return {
        text: lines.join('\n'),
        added, reused, skipped, needsOcr,
        docs: results.filter((r) => r.id).map((r) => ({ id: r.id, name: r.name })),
      }
    },
  })

  tools.push({
    name: 'study_ingest_text',
    description:
      '把纯文本直接入库（用于 OCR 结果、用户粘贴的笔记、网页复制的内容）。清洗、判类型、切章与 study_ingest 相同。',
    parameters: P_INGEST_TEXT,
    timeoutMs: 120000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          id: { type: 'string' },
          kind: { type: 'string' },
        },
        required: ['text', 'id', 'kind'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspace = workspaceOf(ctx, exec)
      const index = await store.loadIndex(workspace)
      const raw = String(args.text ?? '')
      const name = String(args.name ?? '粘贴文本')
      const cleaned = args.clean === false ? raw : cleanText(raw).text
      const classified = classifyText(cleaned, name)
      const libraryKind = typeof args.kind === 'string' && args.kind !== '' ? args.kind : classified.kind
      const sections = buildSections(cleaned, libraryKind).sections
      const hash = store.sha1(Buffer.from(cleaned, 'utf8'))
      const { doc, reused } = await store.putDoc(workspace, index, {
        name, kind: libraryKind, text: cleaned, sections, sourcePath: null, hash,
        meta: { parser: 'text', confidence: classified.confidence, signals: classified.signals },
      })
      await store.saveIndex(workspace, index)
      return {
        text: `${reused ? '已存在，复用' : '已入库'} ${doc.id}｜${name}｜${libraryKind}｜${cleaned.length} 字｜${sections.length} 节`,
        id: doc.id,
        kind: libraryKind,
      }
    },
  })

  tools.push({
    name: 'study_outline',
    description:
      '看资料库索引：不带 doc 时列出所有资料（id/类型/字数/章节数/真题题数）；带 doc 时给出该资料的章节清单（序号、标题、字数、字符区间），' +
      '便于用 study_read 精读某一章。',
    parameters: P_OUTLINE,
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          docId: { type: 'string' },
        },
        required: ['text', 'docId'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const workspace = workspaceOf(ctx, exec)
      const index = await store.loadIndex(workspace)
      if (index.docs.length === 0) {
        return { text: '资料库是空的。先用 study_ingest 入库文件，或 study_ingest_text 入库粘贴的文本。', docId: '' }
      }

      if (!args.doc) {
        const lines = [`资料库：${index.docs.length} 份（更新于 ${index.updatedAt ?? '—'}）`, '']
        lines.push('| id | 名称 | 类型 | 字数 | 章节 | 真题 | 来源 |')
        lines.push('|---|---|---|---|---|---|---|')
        for (const d of index.docs) {
          const q = d.meta?.questions ?? 0
          lines.push(`| ${d.id} | ${d.name} | ${d.kind} | ${d.chars} | ${d.sections.length} | ${q} | ${d.sourcePath ? path.basename(path.dirname(d.sourcePath)) : '粘贴'} |`)
        }
        lines.push('', '下一步：study_outline({doc:"d1"}) 看章节；study_exam_stats() 统计真题。')
        return { text: lines.join('\n'), docId: '' }
      }

      const doc = await store.findDoc(index, args.doc)
      if (!doc) return { text: `没找到文档「${args.doc}」。先 study_outline() 看有哪些。`, docId: '' }
      const max = Math.min(200, Math.max(1, args.maxSections ?? 80))
      const lines = [`## ${doc.id} ${doc.name}`, `${doc.kind}｜${doc.chars} 字｜${doc.sections.length} 节${doc.meta?.confidence ? `｜类型置信 ${doc.meta.confidence}` : ''}`, '']
      doc.sections.slice(0, max).forEach((sec, i) => {
        const len = sec.end - sec.start
        lines.push(`${i + 1}. ${'　'.repeat(Math.max(0, sec.level - 1))}${sec.title}（${len} 字）`)
      })
      if (doc.sections.length > max) lines.push(`…还有 ${doc.sections.length - max} 节未列出（调大 maxSections）`)
      if (doc.meta?.questions) {
        lines.push('', `真题题数：${doc.meta.questions}（用 study_exam_stats 看考点热度）`)
      }
      return { text: lines.join('\n'), docId: doc.id }
    },
  })

  tools.push({
    name: 'study_read',
    description: '读某份资料的某一章（章节序号或标题关键词），或整份资料的开头。返回原文，供整理考点、出题时引用。',
    parameters: P_READ,
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          section: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['text', 'section', 'truncated'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const workspace = workspaceOf(ctx, exec)
      const index = await store.loadIndex(workspace)
      const doc = await store.findDoc(index, args.doc)
      if (!doc) return { text: `没找到文档「${args.doc}」。先 study_outline() 看列表。`, section: '', truncated: false }

      const limit = Math.min(MAX_READ_CHARS, Math.max(500, args.limit ?? 8000))
      let sec = null
      if (Number.isInteger(args.section) && args.section > 0) sec = doc.sections[args.section - 1]
      else if (typeof args.match === 'string' && args.match !== '') {
        sec = doc.sections.find((s) => s.title.includes(args.match)) ?? null
      }
      const start = sec ? sec.start : 0
      const end = sec ? Math.min(sec.end, start + limit) : Math.min(doc.chars, limit)
      const body = await store.readDocSlice(workspace, doc, start, end)
      const truncated = end < (sec ? sec.end : doc.chars)
      const head = sec ? `## ${doc.name} › ${sec.title}（${sec.end - sec.start} 字）` : `## ${doc.name}（前 ${end} 字）`
      const tail = truncated ? `\n\n…已截断（本章还剩 ${(sec ? sec.end : doc.chars) - end} 字；调大 limit 或换章节）` : ''
      return { text: `${head}\n\n${body}${tail}`, section: sec?.title ?? '（开头）', truncated }
    },
  })

  tools.push({
    name: 'study_exam_stats',
    description:
      '统计历年真题：拆题、统计题型与分值分布、按词频聚类出考点热度（高频必考 / 常考 / 冷门），输出可直接用的 Markdown 热度表。' +
      '考点是词面聚类，同义术语需人工合并 —— 结果里会说明这一点，并把例题号列出来。',
    parameters: P_EXAM,
    timeoutMs: 120000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          questions: { type: 'integer' },
          totalScore: { type: 'number' },
        },
        required: ['text', 'questions', 'totalScore'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const workspace = workspaceOf(ctx, exec)
      const index = await store.loadIndex(workspace)
      let docs = []
      if (Array.isArray(args.docs) && args.docs.length > 0) {
        for (const ref of args.docs) {
          const d = await store.findDoc(index, ref)
          if (d) docs.push(d)
        }
      } else {
        docs = index.docs.filter((d) => ['试卷', '习题', '参考答案'].includes(d.kind))
        if (docs.length === 0) docs = index.docs
      }
      if (docs.length === 0) return { text: '资料库里没有可统计的试卷。先 study_ingest 入库真题。', questions: 0, totalScore: 0 }

      const all = []
      const warnings = []
      const perDoc = []
      for (const doc of docs) {
        const text = await store.readDocText(workspace, doc)
        const result = splitQuestions(text, doc.id)
        warnings.push(...result.warnings.map((w) => `${doc.id} ${doc.name}：${w}`))
        perDoc.push({ doc, result })
        all.push(...result.questions)
        doc.meta = { ...(doc.meta ?? {}), questions: result.questions.length }
      }
      await store.saveIndex(workspace, index)

      const heat = topicHeat(all, Math.min(60, Math.max(5, args.topN ?? 25)))
      const lines = []

      lines.push(`# 真题统计（${docs.length} 份卷子，${all.length} 题）`, '')
      lines.push('| 卷子 | 题数 | 分值合计 |', '|---|---|---|')
      for (const { doc, result } of perDoc) lines.push(`| ${doc.id} ${doc.name} | ${result.questions.length} | ${result.total.score || '—'} |`)

      const typeAgg = new Map()
      for (const q of all) {
        const e = typeAgg.get(q.type) ?? { count: 0, score: 0 }
        e.count += 1
        e.score += q.score ?? 0
        typeAgg.set(q.type, e)
      }
      lines.push('', '## 题型分布', '', '| 题型 | 题数 | 占比 | 分值合计 | 平均每题 |', '|---|---|---|---|---|')
      for (const [type, e] of [...typeAgg.entries()].sort((a, b) => b[1].count - a[1].count)) {
        lines.push(`| ${type} | ${e.count} | ${Math.round((e.count / all.length) * 100)}% | ${e.score || '—'} | ${e.count ? (e.score / e.count).toFixed(1) : '—'} |`)
      }

      lines.push('', `## 考点热度（Top ${heat.length}）`, '')
      lines.push(heatTable(heat))
      lines.push('', '> 考点是中文词面聚类：同义术语（如「稳性」与「稳定性」）不会自动合并，请人工/结合上下文归并；样例题号可用来回查原题。')

      const levelCount = [0, 0, 0, 0]
      for (const q of all) levelCount[estimateDifficulty(q) - 1] += 1
      lines.push('', '## 难度估算（启发式）', '', '| 易 | 中 | 较难 | 难 |', '|---|---|---|---|')
      lines.push(`| ${levelCount[0]} | ${levelCount[1]} | ${levelCount[2]} | ${levelCount[3]} |`)
      if (warnings.length > 0) {
        lines.push('', '## 需要人工核对', '')
        for (const w of warnings.slice(0, 20)) lines.push(`- ${w}`)
      }
      const totalScore = [...typeAgg.values()].reduce((a, b) => a + b.score, 0)
      return { text: lines.join('\n'), questions: all.length, totalScore }
    },
  })

  tools.push({
    name: 'study_paper',
    description:
      '生成模拟卷的「命题蓝图」：按真题考点热度加权分配考点，题型/题量/分值/难度/评分要点位全部钉死，并可落盘。' +
      '注意：产出的是骨架（每题的考点、难度、命题要求、避重原题号、得分点占位），题干与答案由你按骨架填写 —— 不要把它当成成品卷交给用户。',
    parameters: P_PAPER,
    timeoutMs: 120000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          markdown: { type: 'string' },
          path: { type: 'string' },
          totalScore: { type: 'number' },
          issues: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'markdown', 'path', 'totalScore', 'issues'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspace = workspaceOf(ctx, exec)
      const index = await store.loadIndex(workspace)
      let docs = []
      if (Array.isArray(args.docs) && args.docs.length > 0) {
        for (const ref of args.docs) {
          const d = await store.findDoc(index, ref)
          if (d) docs.push(d)
        }
      } else {
        docs = index.docs.filter((d) => ['试卷', '习题', '参考答案'].includes(d.kind))
      }

      let questions = []
      for (const doc of docs) {
        const text = await store.readDocText(workspace, doc)
        questions.push(...splitQuestions(text, doc.id).questions)
      }
      const heat = questions.length > 0 ? topicHeat(questions, 40) : []
      // 出题只用品相干净的考点：2 字词多半是「高度」「船舶」这类泛词，塞进卷子会显得没水平。
      const paperTopics = heat.filter((t) => t.term.length >= 3 && t.count >= 2)
      const topicsForPaper = paperTopics.length >= 4 ? paperTopics : heat

      let blueprint = Array.isArray(args.blueprint) ? args.blueprint.filter((b) => b && b.count > 0) : null
      if (!blueprint || blueprint.length === 0) {
        if (questions.length === 0) {
          return {
            text: '资料库里没有试卷，无法按真题风格定量。请先 study_ingest 入库真题，或显式给出 blueprint（如 [{type:"简答题",count:5,score:10}]）。',
            markdown: '', path: '', totalScore: 0, issues: ['缺少试卷统计与 blueprint'],
          }
        }
        const agg = new Map()
        for (const q of questions) {
          const e = agg.get(q.type) ?? { count: 0, score: 0, scored: 0 }
          e.count += 1
          if (q.score) { e.score += q.score; e.scored += 1 }
          agg.set(q.type, e)
        }
        blueprint = [...agg.entries()].map(([type, e]) => ({
          type,
          count: e.count,
          score: e.scored > 0 ? Number((e.score / e.scored).toFixed(1)) : 5,
        }))
      }

      if (typeof args.totalScore === 'number' && args.totalScore > 0) {
        const current = blueprint.reduce((s, b) => s + b.count * b.score, 0)
        if (current > 0) {
          const k = args.totalScore / current
          blueprint = blueprint.map((b) => ({ ...b, score: Math.max(0.5, Number((b.score * k).toFixed(1))) }))
        }
      }

      const built = buildPaper({
        topics: topicsForPaper,
        blueprint,
        seed: Number.isInteger(args.seed) ? args.seed : 20260101,
        difficulty: Math.min(4, Math.max(1, args.difficulty ?? 2)),
        avoidOriginal: args.avoidOriginal !== false,
      })
      const check = validatePaper(built.markdown, blueprint, { allowPlaceholders: true })
      const name = String(args.name ?? `模拟卷-${new Date().toISOString().slice(0, 10)}`)
      const file = await store.savePaper(workspace, name, built.markdown)

      const text = [
        `已生成命题蓝图：${file}`,
        `满分 ${built.totalScore}｜题量 ${built.totalCount}｜题型 ${blueprint.map((b) => `${b.type}${b.count}×${b.score}`).join(' / ')}`,
        `考点来源：${questions.length > 0 ? `${docs.length} 份真题、${questions.length} 题统计` : '无真题（考点靠目录补）'}`,
        '',
        built.markdown,
        '',
        check.ok
          ? `校验：分值/题量与蓝图一致；还有 ${check.placeholders} 处〔占位符〕待填题干与答案。`
          : `校验：${check.issues.join('；')}`,
      ].join('\n')
      return { text, markdown: built.markdown, path: file, totalScore: built.totalScore, issues: check.issues }
    },
  })

  tools.push({
    name: 'study_pack',
    description:
      '把按章写好的 markdown 一次性打包成一门课的交付文件夹：<输出目录>/<课程名>/ 下每章一个 Word 文档' +
      '（知识点与习题用二级标题分开），可选同时导出 PDF（本机 Edge/Chrome 无头打印，不需要 Word）。' +
      'srcDir 里用 01-第1章-章名.md、02-第2章-章名.md 命名以保证顺序，00-开头的文件当总览页。',
    parameters: P_PACK,
    timeoutMs: 300000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          folder: { type: 'string' },
          docxCount: { type: 'integer' },
          pdfCount: { type: 'integer' },
          errors: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'folder', 'docxCount', 'pdfCount', 'errors'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspace = workspaceOf(ctx, exec)
      const resolve = (p) => (path.isAbsolute(p) ? p : path.join(workspace, p))
      const srcDir = resolve(args.srcDir)
      const outDir = args.outDir ? resolve(args.outDir) : workspace
      const format = ['docx', 'pdf', 'both'].includes(args.format) ? args.format : 'docx'

      try {
        const result = await buildPack({ srcDir, outDir, course: String(args.course), format, author: args.author })
        const lines = [
          `已生成课程资料包：${result.folder}`,
          `Word ${result.docxFiles.length} 个｜PDF ${result.pdf.converted.length} 个｜章节 ${result.chapters.length} 章`,
          '',
        ]
        for (const c of result.chapters) lines.push(`- ${c.file}（${c.chars} 字源文本）`)
        if (result.pdf.errors.length > 0) {
          lines.push('', ...result.pdf.errors.map((e) => `- ⚠ ${e}`))
          if (format !== 'docx') lines.push('- Word 文档已生成且不受影响；PDF 缺的那几个可以单独重跑 format=pdf。')
        }
        return {
          text: lines.join('\n'),
          folder: result.folder,
          docxCount: result.docxFiles.length,
          pdfCount: result.pdf.converted.length,
          errors: result.pdf.errors,
        }
      } catch (error) {
        return {
          text: `打包失败：${error?.message ?? error}`,
          folder: '', docxCount: 0, pdfCount: 0, errors: [String(error?.message ?? error)],
        }
      }
    },
  })

  tools.push({
    name: 'study_export',
    description:
      '把资料库里已有的正文直接导出成 Word / PDF 文件（一份资料一个文件，一次可导出整本书或整个库），' +
      '用于打印、转发、离线阅读。docs 传 id 或名字片段（可多个）；prefix 按名字前缀批量选（如「全本教材」）；都不给=导出整个库。' +
      'PDF 先试 Edge/Chrome 无头打印，不行就换 DSH 自带 LibreOffice Kit，全程不需要 Word。',
    parameters: P_EXPORT,
    timeoutMs: 300000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          folder: { type: 'string' },
          docxCount: { type: 'integer' },
          pdfCount: { type: 'integer' },
          errors: { type: 'array', items: { type: 'string' } },
          notes: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'folder', 'docxCount', 'pdfCount', 'errors', 'notes'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspace = workspaceOf(ctx, exec)
      const resolve = (p) => (path.isAbsolute(p) ? p : path.join(workspace, p))
      const index = await store.loadIndex(workspace)
      if (index.docs.length === 0) {
        return { text: '资料库是空的：先用 study_ingest（或 OCR 后 study_ingest_text）入库。', folder: '', docxCount: 0, pdfCount: 0, errors: [], notes: [] }
      }

      const picked = []
      const errors = []
      if (Array.isArray(args.docs) && args.docs.length > 0) {
        for (const key of args.docs) {
          const doc = await store.findDoc(index, key)
          if (!doc) { errors.push(`资料库里没有「${key}」`); continue }
          if (!picked.includes(doc)) picked.push(doc)
        }
      } else if (args.prefix) {
        picked.push(...index.docs.filter((d) => d.name.includes(String(args.prefix))))
      } else {
        picked.push(...index.docs)
      }

      if (picked.length === 0) {
        return { text: `没有匹配到任何资料${args.prefix ? `（前缀「${args.prefix}」）` : ''}。`, folder: '', docxCount: 0, pdfCount: 0, errors, notes: [] }
      }

      const items = []
      const reflowMode = args.reflow ?? 'auto'
      let reflowed = 0
      for (const doc of picked) {
        try {
          const raw = await store.readDocText(workspace, doc)
          const base = doc.name.replace(/\.[^.]+$/u, '')
          let body = raw
          if (reflowMode !== 'off') {
            const p = profileText(raw)
            // 只看「教材正文」：课件也是一堆短行，但那是版面本来如此，合并会毁掉版式。
            // 不卡 numShare：指导书里有「精选习题」整段编号，卡了就漏判（实测 12 章有 3 章漏）。
            const ocrShaped = doc.kind === '教材正文' && p.chars >= 3000 && p.ansShare < 0.05 && p.examSig === 0 && p.shortShare >= 0.6
            if (reflowMode === 'on' || ocrShaped) {
              body = reflowOcrText(raw)
              reflowed += 1
            }
          }
          items.push({ base, title: base, subtitle: `${doc.kind}｜${raw.length} 字`, markdown: body })
        } catch (error) {
          errors.push(`${doc.name}：读正文失败（${error?.message ?? error}）`)
        }
      }

      const outDir = args.outDir ? resolve(args.outDir) : path.join(workspace, '资料导出')
      const folderName = args.folderName ?? (args.prefix ? String(args.prefix) : '资料导出')
      const result = await exportMarkdownBatch({
        items,
        outDir,
        folderName,
        format: args.format ?? 'docx',
        author: args.author,
      })
      errors.push(...result.errors)
      const notes = [...result.notes]
      if (reflowed > 0) notes.push(`${reflowed} 份 OCR 文本已按标点重排成段落`)

      const lines = [
        `已导出：${result.folder}`,
        `Word ${result.docxFiles.length} 个｜PDF ${result.pdfFiles.length} 个｜资料 ${items.length} 份`,
      ]
      const shown = result.docxFiles.length > 0 ? result.docxFiles : result.pdfFiles
      for (const f of shown.slice(0, 8)) lines.push(`- ${path.basename(f)}`)
      if (shown.length > 8) lines.push(`- …还有 ${shown.length - 8} 个`)
      for (const n of notes) lines.push(`- ℹ ${n}`)
      if (errors.length > 0) lines.push('', ...errors.slice(0, 8).map((e) => `- ⚠ ${e}`))

      return {
        text: lines.join('\n'),
        folder: result.folder,
        docxCount: result.docxFiles.length,
        pdfCount: result.pdfFiles.length,
        errors,
        notes,
      }
    },
  })

  tools.push({
    name: 'study_course',
    description:
      '生成/增补一门课的交付文件夹：<工作目录>/<课程名>/ 下 01-第1章-章名.docx + .pdf（一章一对文件）。' +
      '这是最终交付用的工具（用户要「按章节做成 word 和 pdf，放以课程命名的文件夹」就用它，不要用 study_export 平铺）。' +
      '同一门课以后补充资料时传同一个 course：已存在的章会被合并——重复内容不重写，新内容追加到「## 补充 · 日期」下面，旧内容一字不动。' +
      '章只传 title、markdown 留空时是「只登记」模式：章节 Word 已存在就只补 .course-md 镜像和索引，不重写 Word/PDF（把手工/study_pack 的旧课程包纳入管理用这个）。',
    parameters: P_COURSE,
    timeoutMs: 300000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          folder: { type: 'string' },
          docxCount: { type: 'integer' },
          pdfCount: { type: 'integer' },
          errors: { type: 'array', items: { type: 'string' } },
          notes: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'folder', 'docxCount', 'pdfCount', 'errors', 'notes'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspace = workspaceOf(ctx, exec)
      const outDir = args.outDir
        ? (path.isAbsolute(args.outDir) ? args.outDir : path.join(workspace, args.outDir))
        : workspace
      const course = String(args.course ?? '').trim()
      if (course === '') {
        return { text: '没给课程名：course 是文件夹名，必填（如「基础生命科学」）。', folder: '', docxCount: 0, pdfCount: 0, errors: ['缺少 course'], notes: [] }
      }
      if (!Array.isArray(args.chapters) || args.chapters.length === 0) {
        return { text: '没有章节正文：chapters 里每章要有 title 和 markdown。', folder: '', docxCount: 0, pdfCount: 0, errors: ['缺少 chapters'], notes: [] }
      }

      try {
        const result = await buildCourse({
          outDir,
          course,
          chapters: args.chapters,
          format: args.format ?? 'both',
          merge: args.merge !== false,
          rerender: args.rerender === true,
          author: args.author,
        })
        const lines = [
          `课程文件夹：${result.folder}`,
          `Word ${result.docxFiles.length} 个｜PDF ${result.pdfFiles.length} 个｜章节 ${result.chapters.length} 章`,
          '',
        ]
        for (const c of result.chapters) {
          const tag = c.action === 'created' ? '新增' : c.action === 'updated' ? '补充' : c.action === 'rerendered' ? '重渲染' : '未变'
          lines.push(`- ${c.file}（${tag}，${c.chars} 字）`)
        }
        for (const n of result.notes) lines.push(`- ℹ ${n}`)
        if (result.errors.length > 0) lines.push('', ...result.errors.slice(0, 8).map((e) => `- ⚠ ${e}`))
        return {
          text: lines.join('\n'),
          folder: result.folder,
          docxCount: result.docxFiles.length,
          pdfCount: result.pdfFiles.length,
          errors: result.errors,
          notes: result.notes,
        }
      } catch (error) {
        const msg = String(error?.message ?? error)
        return { text: `生成课程文件夹失败：${msg}`, folder: '', docxCount: 0, pdfCount: 0, errors: [msg], notes: [] }
      }
    },
  })

  return tools
}



