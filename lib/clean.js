/**
 * 清洗 / 分类 / 分章 / 去重。
 *
 * 原则：**只做可解释的机械处理**，不改写原文语义。
 * 每一条被删掉的内容都归到一类并计数，回给用户看 —— 删了什么必须能说清楚。
 */

/** 水印、广告、版权、页眉页脚这类行。 */
const NOISE_RULES = [
  { tag: 'watermark', re: /仅供.{0,8}(学习|参考|交流|内部)|禁止(复制|传播|转载|出售|外传)|内部资料|请勿外传|独家资料/ },
  { tag: 'ad', re: /(扫码|二维码|公众号|微信号|QQ\s*群|客服|淘宝|闲鱼|拼多多|店铺|代写|包过|押题|网盘|下载链接)/i },
  { tag: 'ad', re: /(https?:\/\/|www\.)[^\s]+/i },
  { tag: 'copyright', re: /版权所有|侵权(必究|删除)|Copyright\s*©|All\s+Rights\s+Reserved/i },
  { tag: 'pageNumber', re: /^[\s\-—–·.]*(\d{1,4}|[ivxlcdm]{1,6})[\s\-—–·.]*$/i },
  { tag: 'pageNumber', re: /^第\s*\d+\s*页(\s*[,，]?\s*共\s*\d+\s*页)?$|^共\s*\d+\s*页\s*第\s*\d+\s*页$/ },
  { tag: 'pageNumber', re: /^[-—\s]*\d+\s*\/\s*\d+[-—\s]*$/ },
  { tag: 'junk', re: /^[\s.·…\-—_=*#~|]+$/ },
  { tag: 'junk', re: /^\[?图片\]?$|^\[?image\]?$/i },
]

function normalizeLine(line) {
  return line
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
    .replace(/\u00a0|\u3000/g, ' ')
    .replace(/\t/g, '  ')
    .replace(/[ ]{2,}$/g, '')
}

/**
 * 清洗整个文本。
 * @returns {{text: string, removed: Record<string, number>, lines: number}}
 */
export function cleanText(raw) {
  const src = raw.replace(/\r\n?/g, '\n')
  const lines = src.split('\n').map(normalizeLine)

  // 1) 统计「同一行反复出现」→ 页眉页脚 / 水印横幅
  const freq = new Map()
  for (const line of lines) {
    const t = line.trim()
    if (t.length < 2 || t.length > 60) continue
    const key = t.replace(/\d+/g, '#')
    freq.set(key, (freq.get(key) ?? 0) + 1)
  }
  const recurring = new Set()
  for (const [key, count] of freq) {
    if (count >= 5 && count / Math.max(lines.length, 1) >= 0.02) recurring.add(key)
    // 极短且反复出现的（如「第 1 章」页眉里的书名），阈值更低
    if (count >= 12 && key.length <= 20) recurring.add(key)
  }

  const removed = { headerFooter: 0, watermark: 0, ad: 0, copyright: 0, pageNumber: 0, junk: 0, duplicate: 0 }
  const kept = []
  const seen = new Set()
  for (const line of lines) {
    const t = line.trim()
    if (t === '') { kept.push(''); continue }
    const rule = NOISE_RULES.find((r) => r.re.test(t))
    if (rule) { removed[rule.tag] += 1; continue }
    // 编码坏行：U+FFFD 占比高的整行乱码（GBK/UTF-8 解码事故、OCR 崩坏行），
    // 留着会把词面统计污染成乱码考点
    if ((t.match(/\uFFFD/g) ?? []).length / Math.max(1, t.length) > 0.15) { removed.junk += 1; continue }
    if (recurring.has(t.replace(/\d+/g, '#')) && t.length <= 60) { removed.headerFooter += 1; continue }
    // 相邻完全重复行（PDF 抽取常见）
    if (kept.length > 0 && kept[kept.length - 1] === t && t.length > 8) { removed.duplicate += 1; continue }
    kept.push(t === line ? line : t)
    seen.add(t)
  }

  // 2) 段落级去重（同一段在讲义里重复出现，只留第一处）
  const paragraphs = kept.join('\n').split(/\n{2,}/)
  const paraSeen = new Set()
  const deduped = []
  for (const para of paragraphs) {
    const key = para.replace(/\s+/g, '').slice(0, 200)
    if (key.length >= 30 && paraSeen.has(key)) { removed.duplicate += 1; continue }
    if (key.length >= 30) paraSeen.add(key)
    deduped.push(para)
  }

  const text = deduped
    .filter((p) => p.trim() !== '')
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { text, removed, lines: lines.length }
}

/* ---------------------------------------------------------------------- 分类 ---- */

/** 一行是不是「答案/解析」开头（答案行的字面特征）。 */
const ANSWER_LINE = /^(?:答案|答|解析|解答|【答案】|【解析】|参考答案|评分标准|标准答案)\s*[：:]/u
/** 一行是不是题号开头（1. / 2、/ 10．）。 */
const NUMBER_LINE = /^\d{1,3}\s*[.、．]\s*/u
/** 试卷才有的元信息。 */
const EXAM_SIGNAL = /考试时间|答题卡|考号|准考证|评卷人|闭卷|开卷|满分\s*\d+\s*分?|得分\s*[:：]|姓名\s*[:：]|班级\s*[:：]/gu
/** 一句话里的「问」的特征：题干动词 + 问号/括号空位。 */
const STEM_LINE = /(?:简述|试述|论述|说明|分析|比较|计算|证明|解释|列举|判断|为什么|什么|哪些|如何).{0,40}[？?]|[（(]\s*[）)]\s*$/u
const NOTE_HINT = /课堂笔记|听课记录|板书|老师强调|重点标记|课上补充/gu

/**
 * 文本画像。**只用可解释的占比**，不猜语义。
 *
 * 阈值来自实测（12 章真实「知识点+习题」复习资料 vs 合成教材/试卷/课件夹具）：
 * 复习资料 ansShare 0.00~0.27、proseShare 0.38~1.00、题号占比 0.12~0.18、examSig 0~1；
 * 真题夹具 examSig 4、课件夹具 shortShare 1.00 + bulletShare 0.75。
 * 关键教训：**「出现过」不等于「是」** —— 教材每章末尾都有习题和答案，按出现次数打分
 * 会把整本教材判成参考答案（这就是 v0.2.2 之前的 bug）。
 */
export function profileText(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const chars = Math.max(1, text.length)
  const sum = (arr) => arr.reduce((acc, line) => acc + line.length, 0)
  const answerLines = lines.filter((line) => ANSWER_LINE.test(line))
  const numberLines = lines.filter((line) => NUMBER_LINE.test(line))
  const proseLines = lines.filter((line) => line.length >= 60 && !NUMBER_LINE.test(line) && !STEM_LINE.test(line))
  const stemLines = lines.filter((line) => STEM_LINE.test(line))
  const shortLines = lines.filter((line) => line.length <= 24)
  const bulletLines = lines.filter((line) => /^\s*[•·◆■▪●○\-*]\s/.test(line))
  return {
    lines: lines.length,
    chars,
    avgLen: sum(lines) / Math.max(1, lines.length),
    ansShare: sum(answerLines) / chars,
    ansLines: answerLines.length,
    numShare: sum(numberLines) / chars,
    proseShare: sum(proseLines) / chars,
    stemShare: sum(stemLines) / chars,
    shortShare: shortLines.length / Math.max(1, lines.length),
    bulletShare: bulletLines.length / Math.max(1, lines.length),
    examSig: (text.match(EXAM_SIGNAL) ?? []).length,
  }
}

const pct = (value) => `${Math.round(value * 100)}%`

/**
 * 猜内容类型。返回 kind 与依据，置信度低就明说。
 *
 * 判定顺序 = 从「最不可能误判」到「兜底」：试卷靠元信息，答案靠占比，习题靠题号密度，
 * 其余按正文/课件特征落到教材正文。不是加权求和 —— 求和会让「出现过的关键词」压过
 * 「占了多少篇幅」这一事实。
 */
export function classifyText(text, filename = '') {
  const sample = text.slice(0, 60000)
  const p = profileText(sample)
  const signals = []
  const nameHint = /试卷|真题|模拟|考试/.test(filename)
  const nameAnswer = /答案|解析|解答/.test(filename)
  const nameExercise = /习题|作业|练习/.test(filename)

  if (p.ansLines > 0) signals.push(`答案行 ${p.ansLines} 行、占 ${pct(p.ansShare)}`)
  signals.push(`正文长段 ${pct(p.proseShare)}｜题号 ${pct(p.numShare)}｜短行 ${pct(p.shortShare)}`)
  if (p.examSig > 0) signals.push(`考试元信息 ${p.examSig} 处`)
  if (nameHint) signals.push(`文件名←${filename}`)

  // 1) 试卷：有考试元信息才认。习题册也爱写「每题 2 分」，只靠关键词会误判。
  const strongExam = p.examSig >= 2 || (p.examSig >= 1 && nameHint)
  const weakExam = p.examSig >= 1 && p.ansShare < 0.05 && p.stemShare >= 0.08
  if (strongExam || weakExam) {
    return { kind: '试卷', confidence: strongExam ? 0.9 : 0.72, signals: [`试卷特征：${signals.filter((s) => s.startsWith('考试元信息')).join('') || '考试元信息'}`, ...signals] }
  }

  // 2) 参考答案：答案必须**占掉大半篇幅**才算「参考答案」，只是「书后有答案」不算。
  if (p.ansShare >= 0.4 || (p.ansShare >= 0.25 && nameAnswer)) {
    const conf = Math.min(0.95, 0.82 + p.ansShare * 0.2)
    return { kind: '参考答案', confidence: Number(conf.toFixed(2)), signals: [`答案占 ${pct(p.ansShare)}，答案主体`, ...signals] }
  }

  // 3) 习题：题号密集且几乎没有正文段（有正文段的是「知识点+习题」混排资料）。
  if ((p.numShare >= 0.25 && p.ansShare < 0.2 && p.proseShare < 0.6) || (p.stemShare >= 0.3 && p.ansShare < 0.1)) {
    return { kind: '习题', confidence: 0.75, signals: [`题号 ${pct(p.numShare)}、正文段 ${pct(p.proseShare)}，题目为主`, ...signals] }
  }

  // 4) 课件：短行 + 项目符号密集，且几乎没有成段正文。
  if (p.shortShare >= 0.6 && p.bulletShare >= 0.25 && p.avgLen < 24 && p.proseShare < 0.2) {
    return { kind: '课件', confidence: 0.8, signals: [`短行 ${pct(p.shortShare)}、项目符号 ${pct(p.bulletShare)}`, ...signals] }
  }

  // 5) 笔记：只说「笔记」不算，要同时缺教材正文的长段特征。
  const noteHits = (sample.match(NOTE_HINT) ?? []).length
  if (noteHits >= 2 && p.proseShare < 0.35) {
    return { kind: '笔记', confidence: 0.7, signals: [`笔记线索 ${noteHits} 处`, ...signals] }
  }

  // 6) 兜底：教材正文。混排资料（正文 + 习题 + 答案附后）就该落在这里，
  //    依据是「正文段落占了多少字」，而不是「答案出现过没有」。
  //    OCR 逐视觉行输出的文本（一行十来二十字）proseShare 只有 2%，但四万字、
  //    零题号零答案的长文档不可能是习题/答案/试卷，按正文处理。
  const ocrShaped =
    p.chars >= 4000 && p.ansShare < 0.05 && p.numShare < 0.12 && p.examSig === 0 && p.shortShare >= 0.6
  const proseish = p.proseShare >= 0.35 || (p.avgLen >= 18 && p.shortShare < 0.75) || ocrShaped
  if (proseish) {
    const conf = ocrShaped
      ? 0.62
      : Math.min(0.9, 0.5 + 0.3 * Math.min(1, p.proseShare / 0.6) + (p.numShare >= 0.1 ? 0.05 : 0))
    const mixed = p.ansShare >= 0.05 && p.numShare >= 0.08
    return {
      kind: '教材正文',
      confidence: Number(conf.toFixed(2)),
      signals: [
        mixed ? `正文为主、附习题与答案（答案占 ${pct(p.ansShare)}）` : ocrShaped ? 'OCR 逐行文本，长文无题号' : '正文为主',
        ...signals,
      ],
    }
  }

  // 7) 实在没有结构特征（超短文本、纯列表）：按文件名猜，否则老实说低置信。
  const guess = nameAnswer ? '参考答案' : nameExercise ? '习题' : nameHint ? '试卷' : '教材正文'
  return { kind: guess, confidence: 0.25, signals: ['结构特征不足，按文件名猜', ...signals] }
}

/* ---------------------------------------------------------------------- 分章 ---- */

const HEADING_RULES = [
  { level: 1, re: /^(#{1,2})\s+(.{1,60})$/ },
  { level: 2, re: /^(#{3,4})\s+(.{1,60})$/ },
  { level: 1, re: /^第[一二三四五六七八九十百零〇\d]{1,4}[章篇部]\s*[^\n]{0,50}$/ },
  { level: 2, re: /^第[一二三四五六七八九十百零〇\d]{1,4}[节讲单元]\s*[^\n]{0,50}$/ },
  { level: 2, re: /^[一二三四五六七八九十]{1,3}\s*[、．.]\s*\S[^\n]{0,50}$/ },
  { level: 3, re: /^[（(]\s*[一二三四五六七八九十]{1,3}\s*[）)]\s*\S[^\n]{0,50}$/ },
  { level: 3, re: /^\d+(\.\d+){1,3}\s+\S[^\n]{0,50}$/ },
  { level: 3, re: /^【[^】\n]{1,20}】\s*[^\n]{0,50}$/ },
  { level: 4, re: /^\d{1,2}\s*[、．.]\s*\S[^\n]{0,40}$/ },
]

function headingLevel(line, kind) {
  const t = line.trim()
  if (t.length > 80) return 0
  // 试卷/习题里的「1.」「2.」是题号不是章节 → 不当标题
  const numericHeadingAllowed = !['试卷', '习题', '参考答案'].includes(kind)
  for (const rule of HEADING_RULES) {
    if (!rule.re.test(t)) continue
    const isNumeric = rule === HEADING_RULES[HEADING_RULES.length - 1]
    if (isNumeric && !numericHeadingAllowed) continue
    // 以句末标点结尾的多半是正文
    if (/[。？！；]$/.test(t)) continue
    return rule.level
  }
  return 0
}

/**
 * 分章。没有标题的文档按长度切块，块标题「片段 N」。
 * @returns {{sections: {id,title,level,start,end,chars}[], text:string}}
 */
export function buildSections(text, kind) {
  const lines = text.split('\n')
  const bounds = []
  for (let i = 0; i < lines.length; i += 1) {
    const level = headingLevel(lines[i], kind)
    if (level > 0) bounds.push({ line: i, level, title: lines[i].trim() })
  }

  const sections = []
  const charAtLine = []
  let acc = 0
  for (const line of lines) { charAtLine.push(acc); acc += line.length + 1 }

  if (bounds.length === 0) {
    const size = 4000
    for (let start = 0, i = 1; start < text.length; start += size, i += 1) {
      sections.push({ title: `片段 ${i}`, level: 1, start, end: Math.min(start + size, text.length) })
    }
    if (sections.length === 0) sections.push({ title: '全文', level: 1, start: 0, end: text.length })
    return finalize(sections, text)
  }

  // 第一个标题之前的内容也算一段
  if (bounds[0].line > 0) {
    const head = text.slice(0, charAtLine[bounds[0].line]).trim()
    if (head.length > 20) sections.push({ title: '（开头）', level: 1, start: 0, end: charAtLine[bounds[0].line] })
  }
  bounds.forEach((b, idx) => {
    const start = charAtLine[b.line]
    const end = idx + 1 < bounds.length ? charAtLine[bounds[idx + 1].line] : text.length
    sections.push({ title: b.title, level: b.level, start, end })
  })

  // 目录页会产出大量「只有标题、没有正文」的碎片章节。OCR 教材上尤其明显：
  // 40 页扫描件切出 60 节，每节 7~66 字，study_outline 完全看不出真实章节结构。
  // 做法：把开头 25% 范围内连续 ≥4 个不足 150 字的碎片合成一个「（目录/扉页）」节点。
  const merged = collapseTocRuns(sections, text.length, kind)

  // 超长章节再切块，保证单次读取不会爆上下文
  const capped = []
  for (const sec of merged) {
    const len = sec.end - sec.start
    if (len <= 6000) { capped.push(sec); continue }
    const parts = Math.ceil(len / 6000)
    for (let p = 0; p < parts; p += 1) {
      capped.push({
        ...sec,
        title: `${sec.title}（续${p + 1}）`,
        start: sec.start + p * 6000,
        end: Math.min(sec.start + (p + 1) * 6000, sec.end),
      })
    }
  }
  return finalize(capped, text)
}

/** 合并开头的目录碎片章节（只对教材正文生效，避免把课件/提纲的正常短节压平）。 */
function collapseTocRuns(sections, textLength, kind) {
  if (kind !== '教材正文' || sections.length < 8) return sections
  const TINY = 150
  const tiny = (sec) => sec.end - sec.start < TINY
  const out = []
  for (let i = 0; i < sections.length; i += 1) {
    if (!tiny(sections[i])) { out.push(sections[i]); continue }
    let j = i
    while (j + 1 < sections.length && tiny(sections[j + 1])) j += 1
    const count = j - i + 1
    const nearFront = sections[i].start < textLength * 0.25
    if (count >= 4 && nearFront) {
      out.push({ title: '（目录/扉页）', level: 1, start: sections[i].start, end: sections[j].end })
      i = j
    } else {
      out.push(sections[i])
    }
  }
  return out
}

function finalize(sections, text) {
  return {
    text,
    sections: sections.map((sec, i) => ({
      id: `s${i + 1}`,
      title: String(sec.title).replace(/^#{1,6}\s*/, '').trim(),
      level: sec.level,
      start: sec.start,
      end: sec.end,
      chars: sec.end - sec.start,
    })),
  }
}

/* ---------------------------------------------------------------------- 去重 ---- */

/**
 * 字符 shingle 指纹，用来做跨资料相似度。
 *
 * **step 必须是 1。** 曾经用 step=4 省内存，结果同一章的 docx 与它的 PDF 导出件
 * （内容逐字相同、只差几个空格位置）采样点整体错开，重合度从 0.90 掉到 0.27，去重直接失效。
 * 抽样步长对「近似相同」是致命的：要么不抽样，要么先把两份文本对齐 —— 后者不值得。
 */
export function shingles(text, size = 12, step = 1) {
  const compact = text.replace(/\s+/g, '')
  const set = new Set()
  for (let i = 0; i + size <= compact.length; i += step) set.add(compact.slice(i, i + size))
  return set
}

/** a 有多大比例被 b 覆盖。 */
export function containment(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let hit = 0
  for (const x of a) if (b.has(x)) hit += 1
  return hit / a.size
}

/** 题型识别（统计与出题都用）。 */
export const QUESTION_TYPES = ['选择题', '填空题', '判断题', '名词解释', '简答题', '论述题', '计算题', '证明题', '案例分析题']

export function detectQuestionType(header) {
  const h = header.replace(/\s+/g, '')
  const table = [
    ['选择题', /选择|单选|多选|不定项/],
    ['填空题', /填空/],
    ['判断题', /判断|正误/],
    ['名词解释', /名词解释|概念解释|解释下列/],
    ['简答题', /简答|问答|简述/],
    ['论述题', /论述|分析题|试述|阐述/],
    ['计算题', /计算|求解|求.{0,6}值/],
    ['证明题', /证明|推导/],
    ['案例分析题', /案例|材料分析|综合应用/],
  ]
  for (const [type, re] of table) if (re.test(h)) return type
  return null
}

