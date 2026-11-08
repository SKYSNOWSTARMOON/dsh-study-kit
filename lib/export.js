/**
 * 课程资料包导出：把一堆按章写好的 markdown 变成「一门课一个文件夹」的 docx / pdf。
 *
 * 目录约定（srcDir 里）：
 *   00-课程总览.md        → 打包说明、章节清单、复习路线（可选，缺了就自动生成目录页）
 *   01-第1章-xxx.md      → 第 1 章（知识点 + 习题都在这个文件里，用二级标题分开）
 *   02-第2章-xxx.md
 *   ...
 * 输出：<outDir>/<课程名>/ 下每章一个 docx（可选同时导出 pdf）。
 *
 * PDF 走本机 Word（COM 自动化，Windows 自带 Office 才有）；没有 Word 就只出 docx，
 * 并在结果里如实说明 —— 不假装转换成功。
 */

import { promises as fsp, writeFileSync, unlinkSync, readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { markdownToDocx } from './docx.js'
import { markdownToHtml } from './html.js'
import { extractDocx } from './office.js'
import { shingles, containment } from './clean.js'
import { parseCards, cardsToAnki } from './anki.js'
import { normalizeMode, lintChapter } from './modes.js'

const ILLEGAL = /[\\/:*?"<>|]/g

export function safeName(name, fallback = '未命名') {
  const cleaned = String(name ?? '').replace(ILLEGAL, '·').replace(/[\r\n\t]/g, ' ').trim()
  return cleaned === '' ? fallback : cleaned.slice(0, 80)
}

/** 从 markdown 里取标题（第一个 # 行），取不到就用文件名。 */
export function titleOf(markdown, filename) {
  const m = /^#\s+(.+)$/m.exec(markdown ?? '')
  if (m) return m[1].trim()
  return filename.replace(/\.md$/i, '').replace(/^\d+[-_.、\s]*/, '')
}

export async function listMarkdown(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && /\.md$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }))
}

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

/** 找本机可用的 Chromium 内核浏览器（Edge 基本一定在）。没有就返回 null。 */
export function findBrowser() {
  for (const p of BROWSERS) {
    try {
      if (existsSync(p)) return p
    } catch { /* 跳过 */ }
  }
  return null
}

/**
 * 用 Chromium 的 headless 打印 PDF：不需要 Word、不需要交互式桌面，纯命令行。
 * 一份 markdown 一个进程，慢但稳（约 2~4 秒一份）。
 * @returns {{ok: boolean, converted: string[], errors: string[]}}
 */
export function htmlToPdfBatch(targets) {
  const browser = findBrowser()
  if (!browser) return { ok: false, converted: [], errors: ['本机没找到 Edge/Chrome，无法用 headless 打印 PDF'] }
  const converted = []
  const errors = []
  const work = path.join(os.tmpdir(), `study-kit-pdf-${process.pid}-${Date.now()}`)
  const profile = path.join(work, 'profile')
  try {
    mkdirSync(profile, { recursive: true })
  } catch (e) {
    return { ok: false, converted: [], errors: [`无法建临时目录：${e.message ?? e}`] }
  }

  for (let n = 0; n < targets.length; n += 1) {
    const { html, pdf, title } = targets[n]
    const htmlPath = path.join(work, `p${n}.html`)
    try {
      writeFileSync(htmlPath, html, 'utf8')
    } catch (e) {
      errors.push(`${title}：写临时 HTML 失败（${e.message ?? e}）`)
      continue
    }
    try { if (existsSync(pdf)) unlinkSync(pdf) } catch { /* 无所谓 */ }
    const r = spawnSync(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--user-data-dir=${profile}`,
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdf}`,
      pathToFileURL(htmlPath).href,
    ], { stdio: 'ignore', timeout: 120000, windowsHide: true })
    if (r.error) {
      errors.push(`${title}：启动浏览器失败（${r.error.message ?? r.error}）`)
      continue
    }
    if (!existsSync(pdf)) {
      errors.push(`${title}：浏览器没产出 PDF（exit ${r.status ?? '?'}）`)
      continue
    }
    converted.push(pdf)
  }

  try { rmSync(work, { recursive: true, force: true }) } catch { /* 临时目录清不掉无所谓 */ }
  return { ok: errors.length === 0, converted, errors }
}

/* ---------------------------------------------------------------- OCR 文本重排 ---- */

// 小标题：第X章/节、一、、（一）、1. 之类
const HEADING_LINE = /^(?:第[一二三四五六七八九十百千0-9]+[章节篇部]|[一二三四五六七八九十]+[、．.]|[（(][一二三四五六七八九十0-9]+[）)]|\d{1,2}[.、．](?!\d))/u
// 句末：可以在这里断开成段
const SENTENCE_END = /[。！？!?…”』」）】]$/u

/**
 * 把 OCR 出来的「一行一段」重排成正常段落。
 * OCR 的换行是版面行，不是语义段落；直接导出会得到每行一个自然段的碎片。
 * 规则：按句末标点收段（累积够长才收），遇到小标题另起一段，空行强制分段。
 */
export function reflowOcrText(text) {
  const lines = String(text).replace(/\r\n?/gu, '\n').split('\n').map((l) => l.trim())
  const paragraphs = []
  let buffer = ''
  const flush = () => {
    if (buffer.length > 0) paragraphs.push(buffer)
    buffer = ''
  }

  for (const line of lines) {
    if (line.length === 0) { flush(); continue }
    if (line.length <= 40 && HEADING_LINE.test(line)) { flush(); paragraphs.push(line); continue }
    // 很短又没有句末标点的行，多半是被 OCR 拆掉序号的标题（如「、生命活动需要能量」），单独成段
    if (line.length <= 18 && !/[，。、；：,.;:）)】]$/u.test(line)) { flush(); paragraphs.push(line); continue }
    buffer += line
    if (SENTENCE_END.test(line) && buffer.length >= 80) flush()
  }
  flush()
  return paragraphs.join('\n\n')
}

/**
 * 找 DSH 自带的 LibreOffice Kit CLI（app.asar.unpacked 里那份）。
 * 它是本机最可靠的 docx→pdf 通道：不需要 Office、不需要交互桌面，
 * 而且 Chromium 在沙箱里跑不起来时它照样能用（实测出 599KB 正常 PDF）。
 * 可用 STUDY_KIT_PDF_CLI 环境变量直接指定。
 */
export function findLibreOfficeCli() {
  const rel = path.join('app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')
  const candidates = []
  if (process.env.STUDY_KIT_PDF_CLI) candidates.push(process.env.STUDY_KIT_PDF_CLI)
  try {
    // <resources>\runtime\primary-runtime\dependencies\node\bin\node.exe → <resources>
    const bin = path.dirname(process.execPath)
    candidates.push(path.resolve(bin, '../../../../..', rel))
    candidates.push(path.resolve(bin, '../../../../../..', rel))
  } catch { /* 路径推不出来就只看环境变量 */ }
  for (const p of candidates) {
    try {
      if (p && existsSync(p)) return p
    } catch { /* 继续找 */ }
  }
  return null
}

/** 用 LibreOffice Kit 批量转 PDF（一个文件一个进程，约 3~6 秒一份）。 */
export function convertWithLibreOffice(files, outDir) {
  if (files.length === 0) return { ok: true, converted: [], errors: [] }
  const cli = findLibreOfficeCli()
  if (!cli) return { ok: false, converted: [], errors: ['没找到 DSH 自带的 LibreOffice Kit CLI（可用 STUDY_KIT_PDF_CLI 指定）'] }
  const converted = []
  const errors = []
  for (const file of files) {
    const pdf = path.join(outDir, `${path.basename(file, '.docx')}.pdf`)
    const r = spawnSync(process.execPath, [cli, 'convert', '--input', file, '--output', pdf], {
      stdio: 'ignore', timeout: 180000, windowsHide: true,
    })
    if (r.error) {
      errors.push(`${path.basename(file)}：启动 LibreOffice Kit 失败（${r.error.message ?? r.error}）`)
      continue
    }
    let sig = ''
    try { sig = readFileSync(pdf).subarray(0, 5).toString('latin1') } catch { /* 没产出 */ }
    if (sig !== '%PDF-') {
      errors.push(`${path.basename(file)}：LibreOffice 没产出有效 PDF（exit ${r.status ?? '?'}）`)
      continue
    }
    converted.push(pdf)
  }
  return { ok: errors.length === 0, converted, errors }
}

/**
 * 用 Word 批量把 docx 转 pdf。没有 Word / 转换失败都返回错误列表，不抛。
 * 注意：本机 Word 在 DSH 沙箱里打开文档会直接报错或卡住，只当最后退路。
 */
export function convertToPdf(files, outDir) {
  if (files.length === 0) return { ok: true, converted: [], errors: [] }
  const logPath = path.join(os.tmpdir(), `study-kit-pdf-${Date.now()}.log`)
  // 脚本自己写日志文件、自己捕异常：DSH 沙箱下子进程不能开管道（spawn+pipe = EPERM），
  // 所以 stdio 全部 ignore，结果只能靠文件回传。
  const script = [
    'param([string]$InDir,[string]$OutDir,[string]$LogPath)',
    '$ErrorActionPreference = "Stop"',
    'try {',
    '  $lines = @()',
    '  Add-Type -AssemblyName System.Windows.Forms',
    '  $word = New-Object -ComObject Word.Application',
    '  $word.Visible = $false',
    '  $word.DisplayAlerts = 0',
    '  try {',
    '    Get-ChildItem -Path $InDir -Filter *.docx | ForEach-Object {',
    '      $name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)',
    '      $pdf = Join-Path $OutDir ($name + ".pdf")',
    '      $doc = $word.Documents.Open($_.FullName, $false, $false, $false, "", "", $false, "", "", 0, 65001, $true, $true, $false)',
    '      $doc.SaveAs2($pdf, 17)',
    '      $doc.Close(0)',
    '      $lines += "OK " + $name',
    '    }',
    '  } finally { $word.Quit() }',
    '  $lines += "DONE"',
    '  [System.IO.File]::WriteAllLines($LogPath, $lines, [System.Text.Encoding]::UTF8)',
    '} catch {',
    '  [System.IO.File]::WriteAllLines($LogPath, @("ERR " + $_.Exception.Message), [System.Text.Encoding]::UTF8)',
    '}',
  ].join('\r\n')

  const scriptPath = path.join(os.tmpdir(), `study-kit-pdf-${Date.now()}.ps1`)
  try {
    writeFileSync(scriptPath, '\uFEFF' + script, 'utf8')
  } catch {
    return { ok: false, converted: [], errors: ['无法写入临时转换脚本'] }
  }

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-InDir', files[0] ? path.dirname(files[0]) : outDir, '-OutDir', outDir, '-LogPath', logPath],
    { stdio: 'ignore', timeout: 300000, windowsHide: true },
  )

  let log = ''
  try { log = readFileSync(logPath, 'utf8') } catch { /* 脚本没跑起来 */ }
  try { unlinkSync(scriptPath) } catch { /* 无所谓 */ }
  try { unlinkSync(logPath) } catch { /* 无所谓 */ }

  if (result.error) return { ok: false, converted: [], errors: [`无法启动 powershell：${result.error.message ?? result.error}`] }
  const errLine = log.split(/\r?\n/).find((l) => l.startsWith('ERR '))
  if (errLine) return { ok: false, converted: [], errors: [`Word 转换失败：${errLine.slice(4)}`] }
  if (!log.includes('DONE')) {
    return { ok: false, converted: [], errors: [`Word 转换没跑完（exit ${result.status ?? '?'}）：${log.trim().slice(-200) || '无日志'}`] }
  }
  const produced = readdirSync(outDir).filter((n) => /\.pdf$/i.test(n))
  return { ok: true, converted: files.map((f) => path.join(outDir, `${path.basename(f, '.docx')}.pdf`)).filter((p) => produced.includes(path.basename(p))), errors: [] }
}

/**
 * @param {{srcDir: string, outDir: string, course: string, format?: 'docx'|'pdf'|'both', author?: string}} options
 */
export async function buildPack(options) {
  const { srcDir, outDir, course } = options
  const format = options.format ?? 'docx'
  const author = options.author ?? 'dsh-study-kit'

  const names = await listMarkdown(srcDir)
  if (names.length === 0) throw new Error(`目录里没有 markdown 章节文件：${srcDir}`)

  const folder = path.join(outDir, safeName(course, '课程资料'))
  await fsp.mkdir(folder, { recursive: true })

  const written = []
  const chapters = []
  const pdfTargets = []

  const wantDocx = format === 'docx' || format === 'both'
  const wantPdf = format === 'pdf' || format === 'both'

  for (const name of names) {
    const raw = await fsp.readFile(path.join(srcDir, name), 'utf8')
    const title = titleOf(raw, name)
    // 首页已用 Title 样式排了标题，正文里重复的 `# 标题` 去掉，免得一页出现两遍
    const markdown = raw.replace(/^\uFEFF?#\s+[^\n]*\n+/, '')
    const isOverview = /^0*0[-_.、\s]/.test(name)
    const base = name.replace(/\.md$/i, '')
    const meta = {
      title,
      subtitle: isOverview ? `${course} · 课程资料包` : `${course} · 章节资料`,
      author,
      coverTitle: true,
    }

    if (wantDocx) {
      const file = path.join(folder, `${safeName(base)}.docx`)
      await fsp.writeFile(file, markdownToDocx(markdown, meta))
      written.push(file)
    }
    if (wantPdf) {
      pdfTargets.push({ title, html: markdownToHtml(markdown, meta), pdf: path.join(folder, `${safeName(base)}.pdf`) })
    }
    if (!isOverview) chapters.push({ title, file: `${safeName(base)}.docx`, chars: markdown.length })
  }

  let pdf = { ok: true, converted: [], errors: [] }
  if (wantPdf) {
    // 首选无头浏览器打印（不需要 Word、不需要桌面）；
    // 退路是 Word 里另存（要 Office 且要交互式桌面，很多环境下会卡住）。
    pdf = htmlToPdfBatch(pdfTargets)
    if (pdf.converted.length === 0 && written.length > 0) {
      const word = convertToPdf(written, folder)
      if (word.converted.length > 0) {
        pdf = { ok: true, converted: word.converted, errors: [`无头浏览器没出结果，已改用 Word 转换：${pdf.errors.slice(0, 2).join('；')}`] }
      } else {
        pdf.errors = [...pdf.errors, ...word.errors]
      }
    }
    if (!pdf.ok) {
      pdf.errors = [`PDF 没全部成功（Word 文档不受影响）`, ...pdf.errors]
    }
  }

  return { folder, docxFiles: written, pdfFiles: pdf.converted, chapters, pdf }
}

/**
 * 把「已经在内存里的 markdown」直接导出成 docx / pdf，不需要先在磁盘上摆一堆 .md。
 * 用途：资料库里已有的正文（教材章节、OCR 结果）要变成可打印、可转发的文档。
 *
 * PDF 两条路：先试 Edge/Chrome 无头打印（快、不需要 Office）；失败（常见于沙箱挡住
 * Chromium 的命名管道：mojo Check failed 拒绝访问 0x5）再用本机 Word 另存。
 *
 * @param {{items: Array<{base: string, title: string, subtitle?: string, markdown: string}>,
 *          outDir: string, folderName: string, format?: 'docx'|'pdf'|'both', author?: string}} options
 * @returns {Promise<{folder: string, docxFiles: string[], pdfFiles: string[], errors: string[], notes: string[]}>}
 */
export async function exportMarkdownBatch(options) {
  const { items, outDir, folderName } = options
  const format = ['docx', 'pdf', 'both'].includes(options.format) ? options.format : 'docx'
  const author = options.author ?? 'dsh-study-kit'
  const folder = path.join(outDir, safeName(folderName, '资料导出'))
  await fsp.mkdir(folder, { recursive: true })

  const docxFiles = []
  const pdfTargets = []
  const errors = []
  const notes = []
  // format=pdf 时也得先有 docx 才能走 Word 转换，落在临时子目录，转完删掉。
  const tmpDir = path.join(folder, '.docx-tmp')
  const conversionSources = []

  for (const item of items) {
    const base = safeName(item.base, item.title)
    const meta = { title: item.title, subtitle: item.subtitle ?? '', author, coverTitle: true }
    if (format !== 'pdf') {
      const file = path.join(folder, `${base}.docx`)
      try {
        await fsp.writeFile(file, markdownToDocx(item.markdown, meta))
        docxFiles.push(file)
      } catch (e) {
        errors.push(`${item.title}：写 Word 失败（${e?.message ?? e}）`)
      }
    }
    if (format !== 'docx') {
      try {
        pdfTargets.push({ title: item.title, html: markdownToHtml(item.markdown, meta), pdf: path.join(folder, `${base}.pdf`) })
      } catch (e) {
        errors.push(`${item.title}：生成 HTML 失败（${e?.message ?? e}）`)
      }
    }
    if (format === 'pdf') {
      const file = path.join(tmpDir, `${base}.docx`)
      try {
        await fsp.mkdir(tmpDir, { recursive: true })
        await fsp.writeFile(file, markdownToDocx(item.markdown, meta))
        conversionSources.push(file)
      } catch (e) {
        errors.push(`${item.title}：生成中间 Word 失败（${e?.message ?? e}）`)
      }
    }
  }

  let pdfFiles = []
  let browserErrors = []
  if (pdfTargets.length > 0) {
    const r = htmlToPdfBatch(pdfTargets)
    pdfFiles = r.converted
    browserErrors = r.errors
  }
  if (format !== 'docx' && pdfFiles.length === 0) {
    const sources = format === 'pdf' ? conversionSources : docxFiles
    if (sources.length > 0) {
      const lo = convertWithLibreOffice(sources, folder)
      if (lo.converted.length > 0) {
        pdfFiles = lo.converted
        notes.push('无头浏览器出不了 PDF（Chromium 在沙箱里打不开命名管道），已改用 DSH 自带 LibreOffice Kit 转换')
        if (lo.errors.length > 0) errors.push(...lo.errors)
      } else {
        const word = convertToPdf(sources, folder)
        if (word.converted.length > 0) {
          pdfFiles = word.converted
          notes.push('LibreOffice Kit 不可用，PDF 改用本机 Word 转换')
        } else {
          errors.push(...browserErrors, ...lo.errors, ...word.errors)
        }
      }
    }
  }
  if (format !== 'docx' && pdfFiles.length > 0 && browserErrors.length > 0 && pdfFiles.length < pdfTargets.length) {
    // 浏览器只成功了一部分：失败的那些是真问题（不是环境问题），如实报出来。
    errors.push(...browserErrors)
  }
  if (format === 'pdf') {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清不掉无所谓 */ }
  }

  return { folder, docxFiles, pdfFiles, errors, notes }
}

/* ----------------------------------------------- 课程文件夹（按章 · 可增补） ---- */

/** 章节目录镜像：源 markdown 留一份，才能在下次补充时合并而不是覆盖。 */
const COURSE_MD_DIR = '.course-md'

export function chapterBaseName(no, title) {
  const clean = safeName(title, '未命名章节')
  const n = Number(no)
  if (!Number.isInteger(n) || n <= 0) return clean
  return `${String(n).padStart(2, '0')}-第${n}章-${clean}`
}

/**
 * 把新内容并进已有章节。
 *  - 新内容已被旧内容覆盖（≥0.7）→ 不写，避免同一段笔记被追加三遍；
 *  - 新内容覆盖了旧内容的大半（≥0.9）→ 用新内容替换（旧的是残缺版）；
 *  - 其余 → 追加到「## 补充 · 日期」下面，旧内容一字不动（准确性优先，不做自动改写）。
 */
export function mergeChapterMarkdown(existing, addition, options = {}) {
  const oldText = String(existing ?? '').trim()
  const addText = String(addition ?? '').trim()
  const date = options.date ?? new Date().toISOString().slice(0, 10)
  const part = options.part ?? '补充'
  if (addText === '') return { markdown: oldText, added: false, reason: '新内容为空，未改动' }
  if (oldText === '') return { markdown: addText, added: true, reason: '' }

  const so = shingles(oldText)
  const sa = shingles(addText)
  const covered = containment(sa, so)
  if (covered >= 0.7) return { markdown: oldText, added: false, reason: `与已有内容重合 ${covered.toFixed(2)}，未重复写入` }
  if (containment(so, sa) >= 0.9) return { markdown: addText, added: true, replaced: true, reason: '新内容覆盖了原有内容，已整章替换' }
  return { markdown: `${oldText}\n\n## ${part} · ${date}\n\n${addText}\n`, added: true, reason: '' }
}

/** 已存在但没有 .course-md 镜像的章节（手工或 study_pack 生成的旧包），从 docx 里把正文抠回来。 */
async function adoptChapterMarkdown(folder, base) {
  const docx = path.join(folder, `${base}.docx`)
  try {
    const buf = await fsp.readFile(docx)
    let text = extractDocx(buf).text.trim()
    // 抠回来的第一行是封面标题，去掉免得再套一层标题
    text = text.replace(/^#\s+[^\n]*\n+/, '')
    // 封面副标题（「课程 · 章节资料」或「教材正文｜43989 字」）也会被抠出来，去掉
    text = text.replace(/^[^\n]{0,80}(?:章节资料|[｜|]\s*\d+\s*字)[^\n]*\n+/, '')
    return text.trim()
  } catch {
    return ''
  }
}

function courseIndexMarkdown(course, chapters, mode = '') {
  // 只登记模式下调用方只给了文件名（01-第1章-章名），章号与标题从中解出来，索引才好看
  const pick = (c) => {
    const m = /^(\d+)-/.exec(c.base ?? '')
    return {
      no: c.no ?? (m ? Number(m[1]) : ''),
      title: m ? String(c.title).replace(/^\d+-/, '') : c.title,
    }
  }
  const rows = chapters
    .map((c) => {
      const { no, title } = pick(c)
      const lint = c.lintIssues && c.lintIssues > 0 ? `${c.lintIssues} 处待补` : ''
      return `| ${no} | ${title} | ${c.file} | ${c.chars} | ${c.action} | ${lint} | ${c.updatedAt} |`
    })
    .join('\n')
  return [
    `# ${course} · 章节索引`,
    '',
    '由 study_kit 生成，每次增补都会重写这份索引。章节正文在 `.course-md/<章>.md`，Word/PDF 在同一层的同名文件。',
    ...(mode ? ['', `形态：${mode}`] : []),
    '',
    '| 章 | 标题 | 文件 | 字数 | 本次操作 | 形态自检 | 更新时间 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    rows,
  ].join('\n')
}

/**
 * 生成/增补一门课的交付文件夹：<outDir>/<课程名>/01-第1章-章名.docx(+ .pdf)。
 *
 * 与 study_pack 的区别：那个是「一次生成一整套」，这个是「同一门课反复补」——
 * 章节已存在就合并（见 mergeChapterMarkdown），不另起文件、不覆盖旧内容。
 *
 * @param {{outDir: string, course: string,
 *          chapters: Array<{no?: number, title: string, markdown: string, part?: string}>,
 *          format?: 'docx'|'pdf'|'both', author?: string, merge?: boolean, date?: string}} options
 */
export async function buildCourse(options) {
  const course = options.course
  const format = ['docx', 'pdf', 'both'].includes(options.format) ? options.format : 'both'
  const author = options.author ?? 'dsh-study-kit'
  const date = options.date ?? new Date().toISOString().slice(0, 10)
  const doMerge = options.merge !== false
  const folder = path.join(options.outDir, safeName(course, '课程'))
  const mdDir = path.join(folder, COURSE_MD_DIR)
  await fsp.mkdir(mdDir, { recursive: true })

  const errors = []
  const notes = []
  const docxFiles = []
  const pdfTargets = []
  const chapters = []
  const ankiFiles = []
  let ankiCards = 0
  const mode = normalizeMode(options.mode)
  const modeIssues = []

  const list = Array.isArray(options.chapters) ? options.chapters : []

  /**
   * 形态自检（L1）：只检查结构，不拦导出。
   * 形态本身靠正文写法实现——这里负责「写歪了要说出来」，否则五形态等于没有护栏。
   */
  const runLint = (base, title, markdown) => {
    if (!mode) return 0
    const r = lintChapter(mode, markdown)
    for (const issue of r.issues) modeIssues.push(`${title}：${issue}`)
    return r.issues.length
  }

  /** 「背诵清单」小节 → Anki 可导入的 TSV（一章一个文件，卡组 = 课程/章）。 */
  const writeAnki = async (base, title, markdown) => {
    if (!options.anki) return
    try {
      const cards = parseCards(markdown)
      if (cards.length === 0) return
      // 卡组名去掉文件名里的序号前缀（01-第1章-），否则 Anki 里显示成「01-第1章-行列式」
      const deckTitle =
        String(title)
          .replace(/^\d+-\s*第\d+章\s*[-—·]?\s*/u, '')
          .replace(/^\d+-\s*第\d+节\s*[-—·]?\s*/u, '')
          .replace(/^\d+-\s*/u, '')
          .replace(/^第\d+[章节]\s*[-—·]?\s*/u, '')
          .trim() || String(title)
      const ankiDir = path.join(folder, 'anki')
      await fsp.mkdir(ankiDir, { recursive: true })
      const ankiPath = path.join(ankiDir, `${base}.txt`)
      await fsp.writeFile(ankiPath, cardsToAnki(cards, { deck: `${course}::${deckTitle}` }), 'utf8')
      ankiFiles.push(ankiPath)
      ankiCards += cards.length
    } catch (e) {
      errors.push(`${base}：写 Anki 卡片失败（${e?.message ?? e}）`)
    }
  }

  for (const item of list) {
    const title = String(item.title ?? '').trim() || '未命名章节'
    const base = chapterBaseName(item.no, title)
    const mdPath = path.join(mdDir, `${base}.md`)
    let existing = ''
    try { existing = await fsp.readFile(mdPath, 'utf8') } catch { existing = '' }
    if (existing.trim() === '') existing = await adoptChapterMarkdown(folder, base)

    let markdown = String(item.markdown ?? '')
    let action = existing.trim() === '' ? 'created' : 'updated'
    let skipMerge = false
    // 只登记（markdown 留空、章节已存在）：只补 .course-md 镜像，不重渲染 Word/PDF。
    // 用途：把手工/study_pack 生成的旧课程包一次性纳入管理，之后才能走增补合并。
    if (markdown.trim() === '' && existing.trim() !== '') {
      try {
        await fsp.writeFile(mdPath, existing, 'utf8')
      } catch (e) {
        errors.push(`${base}：写镜像失败（${e?.message ?? e}）`)
        continue
      }
      if (!options.rerender) {
        const lintIssues = runLint(base, title, existing)
        chapters.push({ no: item.no ?? null, title, base, file: `${base}.docx`, chars: existing.length, action: 'unchanged', lintIssues, updatedAt: date })
        await writeAnki(base, title, existing)
        continue
      }
      // rerender：内容不动，只按最新渲染器重写 Word/PDF（改了 docx/html 生成逻辑后重出一遍用）
      markdown = existing
      action = 'rerendered'
      skipMerge = true
    }
    if (doMerge && existing.trim() !== '' && !skipMerge) {
      const merged = mergeChapterMarkdown(existing, markdown, { date, part: item.part })
      markdown = merged.markdown
      if (!merged.added) action = 'unchanged'
      if (merged.reason) notes.push(`${base}：${merged.reason}`)
      if (merged.replaced) notes.push(`${base}：新内容覆盖原有内容，已整章替换`)
    }
    if (markdown.trim() === '') {
      errors.push(`${base}：正文为空，跳过`)
      continue
    }

    try {
      await fsp.writeFile(mdPath, markdown, 'utf8')
    } catch (e) {
      errors.push(`${base}：写章节源文件失败（${e?.message ?? e}）`)
      continue
    }
    await writeAnki(base, title, markdown)

    const meta = { title, subtitle: `${course} · 章节资料`, author, coverTitle: true }
    const docxPath = path.join(folder, `${base}.docx`)
    const pdfPath = path.join(folder, `${base}.pdf`)
    if (format !== 'pdf') {
      try {
        await fsp.writeFile(docxPath, markdownToDocx(markdown, meta))
        docxFiles.push(docxPath)
      } catch (e) {
        errors.push(`${base}：写 Word 失败（${e?.message ?? e}）`)
      }
    }
    if (format !== 'docx') {
      try {
        pdfTargets.push({ title, html: markdownToHtml(markdown, meta), pdf: pdfPath })
      } catch (e) {
        errors.push(`${base}：生成 HTML 失败（${e?.message ?? e}）`)
      }
    }
    chapters.push({ no: item.no ?? null, title, base, file: `${base}.docx`, chars: markdown.length, action, lintIssues: runLint(base, title, markdown), updatedAt: date })
  }

  let pdfFiles = []
  if (pdfTargets.length > 0) {
    const r = htmlToPdfBatch(pdfTargets)
    pdfFiles = r.converted
    if (pdfFiles.length === 0) {
      const lo = convertWithLibreOffice(docxFiles, folder)
      if (lo.converted.length > 0) {
        pdfFiles = lo.converted
        notes.push('无头浏览器出不了 PDF，已改用 DSH 自带 LibreOffice Kit 转换')
        if (lo.errors.length > 0) errors.push(...lo.errors)
      } else {
        errors.push(...r.errors, ...lo.errors)
      }
    }
  }

  try {
    await fsp.writeFile(path.join(mdDir, '_index.md'), courseIndexMarkdown(course, chapters, mode), 'utf8')
  } catch { /* 索引写不了不影响交付文件 */ }

  if (options.anki && ankiCards === 0) {
    notes.push('没有找到「背诵清单」小节，未生成 Anki 卡片（卡片不会凭空编造）')
  }
  if (mode) {
    notes.push(
      modeIssues.length === 0
        ? `形态自检（${mode}）：通过`
        : `形态自检（${mode}）：${modeIssues.length} 处待补 —— ${modeIssues.slice(0, 6).join('；')}${modeIssues.length > 6 ? `；…还有 ${modeIssues.length - 6} 处` : ''}`,
    )
  }

  return { folder, docxFiles, pdfFiles, errors, notes, chapters, ankiFiles, ankiCards, mode, modeIssues }
}
