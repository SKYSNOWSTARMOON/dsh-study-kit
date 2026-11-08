/**
 * 离线自测：不启动 DSH，直接用假的 ctx/exec 调工具实现。
 * 覆盖：docx/pptx 解析 → 清洗 → 分类 → 切章 → 入库 → 索引 → 真题统计 → 命题蓝图。
 *
 * 跑法（本机 node 不在 PATH）：
 *   & "C:\Users\SKY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" scripts/selftest.mjs
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildTools } from '../lib/tools.js'
import { markdownToDocx } from '../lib/docx.js'
import { markdownToHtml } from '../lib/html.js'
import { listZipEntries, readZipEntry } from '../lib/zip.js'

const here = path.dirname(fileURLToPath(import.meta.url))
// 夹具目录：命令行第 1 个参数 > 环境变量 STUDY_FIXTURES > <插件目录>/../.tmp/study-fixtures
// （插件装在 profile 的 node_modules 下时，写死的相对路径会指到别处，必须能覆盖）
const fixtures = process.argv[2] || process.env.STUDY_FIXTURES || path.resolve(here, '../../.tmp/study-fixtures')
const workspace = path.resolve(here, '../../.tmp/study-selftest-ws')

const failures = []
const checks = []
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail })
  if (!condition) failures.push(`${label}${detail ? ` —— ${detail}` : ''}`)
}

const ctx = {
  get: (key) => (key === 'workingDirectory' ? { defaultDirectory: workspace } : null),
}
const exec = {}
const log = (level, message) => console.log(`[${level}] ${message}`)

async function main() {
  await fsp.rm(workspace, { recursive: true, force: true })
  await fsp.mkdir(workspace, { recursive: true })

  const tools = buildTools(ctx, log)
  const byName = new Map(tools.map((t) => [t.name, t]))
  const EXPECTED_TOOLS = ['study_ingest', 'study_ingest_text', 'study_outline', 'study_read', 'study_exam_stats', 'study_paper', 'study_pack', 'study_export', 'study_course']
  check(`注册了 ${EXPECTED_TOOLS.length} 个工具`, tools.length === EXPECTED_TOOLS.length, `实际 ${tools.length}: ${tools.map((t) => t.name).join(',')}`)
  for (const name of EXPECTED_TOOLS) check(`工具 ${name} 存在`, byName.has(name))

  // ---------- 1. 入库 ----------
  const ingest = await byName.get('study_ingest').execute({ path: fixtures }, exec)
  console.log('\n' + ingest.text)
  check('入库 4 份资料', ingest.added === 4, `added=${ingest.added}`)
  check('没有需要 OCR 的文件', ingest.needsOcr.length === 0, ingest.needsOcr.join(','))

  const ids = ingest.docs.map((d) => d.id)
  check('拿到 4 个文档 id', ids.length === 4, ids.join(','))

  // 同源重复：两份内容只差一句的资料，第二份应当被跳过而不是又进一份
  // （字节完全相同的那份会走「哈希复用」，两条路都要测）
  const dupDir = path.join(workspace, 'dup')
  await fsp.mkdir(dupDir, { recursive: true })
  const topics = ['船舶静力学', '初稳性高', '复原力臂', '排水量', '浮心', '重心', '横倾角', '动稳性', '静稳性曲线', '稳性衡准']
  const baseNote = topics
    .map((p) => `关于${p}的说明：这一节讨论${p}与船体几何之间的关系，并给出典型算例和常见错误分析，供考试复习时对照检查。`)
    .join('\n') + '\n'
  await fsp.writeFile(path.join(dupDir, '稳性笔记A.txt'), baseNote, 'utf8')
  await fsp.writeFile(path.join(dupDir, '稳性笔记B.txt'), baseNote + '补充说明：动稳性储备用回复力矩曲线下的面积表示，计算时要先画静稳性曲线。\n', 'utf8')
  const dup = await byName.get('study_ingest').execute({ path: dupDir }, exec)
  console.log('\n' + dup.text)
  check('同源副本被跳过', dup.skipped === 1 && dup.added === 1, `added=${dup.added} skipped=${dup.skipped}`)

  // 重复跑同一批文件：按内容哈希复用，不应重复入库
  const again = await byName.get('study_ingest').execute({ path: fixtures }, exec)
  check('重复入库走复用', again.added === 0 && again.reused === 4, `added=${again.added} reused=${again.reused}`)

  // ---------- 2. 索引 ----------
  const outline = await byName.get('study_outline').execute({}, exec)
  console.log('\n' + outline.text)
  check('库列表含 5 份', /资料库：5 份/.test(outline.text), outline.text.slice(0, 80))

  const textbookId = ingest.docs.find((d) => /讲义/.test(d.name))?.id
  const examId = ingest.docs.find((d) => /真题/.test(d.name))?.id
  const slidesId = ingest.docs.find((d) => /课件/.test(d.name))?.id
  check('识别出教材/试卷/课件三类', textbookId && examId && slidesId, JSON.stringify(ingest.docs))

  const tbOutline = await byName.get('study_outline').execute({ doc: textbookId }, exec)
  console.log('\n' + tbOutline.text)
  check('教材切出 ≥2 章', /第[一二]章/.test(tbOutline.text) && tbOutline.text.split('\n').filter((l) => /^\d+\./.test(l)).length >= 2)
  check('教材判为教材正文', /教材正文/.test(tbOutline.text), tbOutline.text.split('\n')[1])

  const slOutline = await byName.get('study_outline').execute({ doc: slidesId }, exec)
  check('课件按页切分', /第1页|第2页|稳性概述/.test(slOutline.text), slOutline.text.slice(0, 200))

  // ---------- 3. 读章节 ----------
  const read = await byName.get('study_read').execute({ doc: textbookId, match: '初稳性', limit: 2000 }, exec)
  console.log('\n--- read ---\n' + read.text.slice(0, 600))
  check('读到了 GM 公式', /GM\s*=\s*KM\s*-\s*KG/.test(read.text), read.text.slice(0, 200))
  check('页眉水印被清掉', !/版权所有，翻印必究/.test(read.text))
  check('表格转成了竖线分隔', /分类维度 \| 类型 \| 判据/.test(read.text), '表格行未出现')

  // PDF 文本层
  const pdfId = ingest.docs.find((d) => /\.pdf$/i.test(d.name))?.id
  const pdfRead = await byName.get('study_read').execute({ doc: pdfId, limit: 4000 }, exec)
  console.log('\n--- pdf ---\n' + pdfRead.text.slice(0, 500))
  check('PDF 抽出两页文字', /Chapter 1/.test(pdfRead.text) && /Chapter 2/.test(pdfRead.text))
  check('PDF 行没粘成一片', /GM = KM - KG/.test(pdfRead.text) && /Chapter 2[\s\S]*Displacement/.test(pdfRead.text))

  // ---------- 4. 真题统计 ----------
  const stats = await byName.get('study_exam_stats').execute({ topN: 10 }, exec)
  console.log('\n' + stats.text)
  check('拆出 12 题', stats.questions === 12, `questions=${stats.questions}`)
  check('分值合计 100', Math.abs(stats.totalScore - 100) < 0.01, `totalScore=${stats.totalScore}`)
  check('热度表有内容', /考点热度/.test(stats.text) && /高频必考|常考|冷门/.test(stats.text))
  check('识别到计算题', /计算题/.test(stats.text))
  check('热度表没有泛词或断词残片', !/\|\s*(船舶|高度|倾斜|初稳|性高|舶稳|大倾|稳性)\s*[|（]/.test(stats.text), '泛词/残片进了热度表')
  

  // ---------- 5. 命题蓝图 ----------
  const paper = await byName.get('study_paper').execute({ name: '自测模拟卷', difficulty: 3, seed: 7 }, exec)
  console.log('\n--- paper head ---\n' + paper.text.split('\n').slice(0, 18).join('\n'))
  check('蓝图落盘', await fsp.stat(paper.path).then((s) => s.isFile()).catch(() => false), paper.path)
  check('蓝图总分 100', Math.abs(paper.totalScore - 100) < 0.01, `totalScore=${paper.totalScore}`)
  check('每题有考点与评分要点位', /考点：/.test(paper.markdown) && /得分点/.test(paper.markdown))
  check('有避重标注', /不得与原题重复/.test(paper.markdown))
  check('校验无 issue', paper.issues.length === 0, paper.issues.join('；'))

  // 同种子可复现
  const paper2 = await byName.get('study_paper').execute({ name: '自测模拟卷2', difficulty: 3, seed: 7 }, exec)
  check('同种子结果一致', paper2.markdown === paper.markdown)

  // ---------- 6. 导出成 Word / PDF ----------
  const exported = await byName.get('study_export').execute({ docs: [textbookId], format: 'docx', outDir: path.join(workspace, 'export') }, exec)
  console.log('\n' + exported.text)
  check('导出了 1 个 Word', exported.docxCount === 1, 'docxCount=' + exported.docxCount)
  const produced = (await fsp.readdir(exported.folder)).filter((n) => n.endsWith('.docx'))
  const docxStat = produced[0] ? await fsp.stat(path.join(exported.folder, produced[0])).catch(() => null) : null
  check('Word 文件不是空壳', docxStat && docxStat.size > 3000, 'size=' + (docxStat ? docxStat.size : 0))

  // ---------- 6b. 课程文件夹：按章出文件 + 增补合并 ----------
  const courseArgs = {
    course: '自测课程',
    outDir: path.join(workspace, 'courses'),
    format: 'docx',
    chapters: [
      { no: 1, title: '细胞', markdown: '# 细胞\n\n## 知识点\n\n- 细胞是生命的基本单位，细胞膜具有选择透过性。' },
      { no: 2, title: '代谢', markdown: '# 代谢\n\n## 知识点\n\n- 酶降低活化能，反应速率受温度与 pH 影响。' },
    ],
  }
  const course1 = await byName.get('study_course').execute(courseArgs, exec)
  check('课程文件夹生成了 2 章 Word', course1.docxCount === 2, 'docxCount=' + course1.docxCount)
  const ch1 = (await fsp.readdir(course1.folder)).filter((n) => /^01-第1章/.test(n))
  check('章节文件名带「01-第1章-章名」', ch1.some((n) => n.endsWith('.docx')), ch1.join(','))

  const course2 = await byName.get('study_course').execute({
    ...courseArgs,
    chapters: [{ no: 1, title: '细胞', markdown: '## 补充点\n\n- 细胞学说由施莱登与施旺提出。' }],
  }, exec)
  const sidecarPath = path.join(course2.folder, '.course-md', '01-第1章-细胞.md')
  const sidecar = await fsp.readFile(sidecarPath, 'utf8')
  check('补充内容并入原章节（## 补充）', sidecar.includes('## 补充') && sidecar.includes('施莱登'))
  check('原章节内容没被覆盖', sidecar.includes('细胞膜具有选择透过性'))

  await byName.get('study_course').execute({
    ...courseArgs,
    chapters: [{ no: 1, title: '细胞', markdown: '## 补充点\n\n- 细胞学说由施莱登与施旺提出。' }],
  }, exec)
  const sidecar3 = await fsp.readFile(sidecarPath, 'utf8')
  const repeated = sidecar3.split('施莱登').length - 1
  check('同样的补充不会写两遍', repeated === 1, '出现 ' + repeated + ' 次')

  // 老文件夹（手工 / study_pack 出的，没有 .course-md 镜像）也要能被增补
  const adoptRoot = path.join(workspace, 'courses-adopt')
  const adoptDir = path.join(adoptRoot, '自测课程')
  await fsp.mkdir(adoptDir, { recursive: true })
  await fsp.writeFile(
    path.join(adoptDir, '01-第1章-细胞.docx'),
    markdownToDocx('## 知识点\n\n- 老内容：细胞是生命的基本单位。', { title: '细胞', subtitle: '自测课程 · 章节资料' }),
  )
  const adopted = await byName.get('study_course').execute({
    course: '自测课程',
    outDir: adoptRoot,
    format: 'docx',
    chapters: [{ no: 1, title: '细胞', markdown: '- 新补充：细胞学说由施莱登与施旺提出。' }],
  }, exec)
  const adoptMd = await fsp.readFile(path.join(adopted.folder, '.course-md', '01-第1章-细胞.md'), 'utf8')
  check('老 docx 能被采纳（adopt）再增补', adoptMd.includes('老内容') && adoptMd.includes('新补充'))
  check('采纳时丢掉封面副标题', !adoptMd.includes('章节资料'), adoptMd.slice(0, 40))

  // 只登记模式：markdown 留空 → 只补镜像，不重写 Word
  const adoptDocx = path.join(adoptDir, '01-第1章-细胞.docx')
  const beforeStat = await fsp.stat(adoptDocx)
  const registered = await byName.get('study_course').execute({
    course: '自测课程',
    outDir: adoptRoot,
    format: 'docx',
    chapters: [{ no: 1, title: '细胞' }],
  }, exec)
  const afterStat = await fsp.stat(adoptDocx)
  const regMd = await fsp.readFile(path.join(registered.folder, '.course-md', '01-第1章-细胞.md'), 'utf8')
  check('只登记模式不重写 Word', beforeStat.mtimeMs === afterStat.mtimeMs, `${beforeStat.mtimeMs} vs ${afterStat.mtimeMs}`)
  check('只登记模式保留镜像正文', regMd.includes('老内容') && regMd.includes('新补充'))

  // rerender：内容不动，按最新渲染器重写 Word
  const rerendered = await byName.get('study_course').execute({
    course: '自测课程',
    outDir: adoptRoot,
    format: 'docx',
    rerender: true,
    chapters: [{ no: 1, title: '细胞' }],
  }, exec)
  const rerenderStat = await fsp.stat(adoptDocx)
  const rerenderMd = await fsp.readFile(path.join(rerendered.folder, '.course-md', '01-第1章-细胞.md'), 'utf8')
  check('rerender 会重写 Word', rerenderStat.mtimeMs !== afterStat.mtimeMs, `${afterStat.mtimeMs} vs ${rerenderStat.mtimeMs}`)
  check('rerender 不改正文', rerenderMd === regMd)

  // 表格单元格里的公式：$|A|$ 的竖线不能被当成列分隔符
  const mathHtml = markdownToHtml('| 项 | 值 |\n| --- | --- |\n| 行列式 | $|A|$ |\n| 下标 | $a_{1p_1}$ |\n', { title: '表格公式' })
  check('表格里的 $|A|$ 不被竖线切断', !mathHtml.includes('$'), mathHtml.slice(0, 120))
  // 只看正文里的 LaTeX 残留（样式表里当然有花括号）
  const mathBody = mathHtml.slice(mathHtml.indexOf('<body'))
  check('嵌套下标不残留 LaTeX 花括号', !mathBody.includes('_{') && !mathBody.includes('\\{') && !mathBody.includes('$'))

  // 粗体里嵌公式（**$n$ 阶行列式**）不能把 $ 留在正文里
  const boldHtml = markdownToHtml('- **$n$ 阶行列式**：定义\n', { title: '粗体公式' })
  const boldBody = boldHtml.slice(boldHtml.indexOf('<body'))
  check('粗体里的公式会渲染成上下标', !boldBody.includes('$') && boldBody.includes('<strong>') && boldBody.includes('class="m"'), boldBody.slice(0, 120))

  // 表格必须是固定列宽：否则 Word/LO 自动排版会把「要求」这种短列压成一字一行
  const widthTable = '| 考点 | 常见陷阱 | 要求 |\n| --- | --- | --- |\n| 行列式的性质 | 互换两行要变号；某一行提公因子只提一次 | 掌握 |\n'
  const widthDocx = await markdownToDocx(widthTable, { title: '列宽' })
  const widthXml = readZipEntry(widthDocx, listZipEntries(widthDocx).find((e) => e.name === 'word/document.xml')).toString('utf8')
  const widthCols = [...widthXml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]))
  check('表格用固定列宽且短列不被压窄', widthXml.includes('<w:tblLayout w:type="fixed"/>') && widthCols.length === 3 && Math.min(...widthCols) > 900, String(widthCols))
  const widthHtml = markdownToHtml(widthTable, { title: '列宽' })
  const htmlPcts = [...widthHtml.matchAll(/<col style="width:([\d.]+)%">/g)].map((m) => Number(m[1]))
  check('HTML 表格带列宽与固定布局', widthHtml.includes('table-layout: fixed') && widthHtml.includes('<colgroup>') && htmlPcts.length === 3 && Math.min(...htmlPcts) >= 10, String(htmlPcts))

  // ---------- 7. 边界：不存在的文件 / 无试卷统计 ----------
  let threw = false
  try { await byName.get('study_ingest').execute({ path: path.join(workspace, 'nope.docx') }, exec) } catch { threw = true }
  check('不存在的路径会报错而不是静默', threw)

  console.log('\n==== 结果 ====')
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.ok ? '' : `  (${c.detail})`}`)
  if (failures.length > 0) {
    console.log(`\n${failures.length} 项失败`)
    process.exitCode = 1
  } else {
    console.log('\n全部通过')
  }
}

main().catch((error) => {
  console.error('自测崩溃：', error)
  process.exitCode = 1
})




