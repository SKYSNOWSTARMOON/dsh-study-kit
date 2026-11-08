/**
 * 真题统计：拆题 → 题型/分值 → 考点热度。
 *
 * 诚实的边界：
 *  - 拆题靠编号与题型标题，**排版不规整的卷子会漏题**，漏了要报出来（coverage）。
 *  - 考点是「中文 n-gram 词频聚类」，不是语义理解：同义词不会自动合并（如「稳性」/「稳定性」），
 *    所以输出里明确写「需合并同义术语」，并把原始题号列出来供人工/模型复核。
 */

import { detectQuestionType } from './clean.js'

const STOPWORDS = new Set([
  '下列', '以下', '关于', '的是', '正确', '错误', '说法', '属于', '不是', '可以', '应该',
  '简述', '试述', '说明', '计算', '已知', '如图', '根据', '回答', '问题', '什么', '为何',
  '如何', '哪些', '主要', '基本', '概念', '特点', '作用', '影响', '意义', '方法', '过程',
  '条件', '原理', '分析', '论述', '比较', '区别', '联系', '举例', '指出', '写出', '画出',
  '求', '解', '答', '试', '请', '并', '及', '或', '与', '和', '的', '了', '是', '在', '对',
  '一个', '一种', '分别', '简要', '综合', '应用', '设计', '选择', '填空', '判断', '名词',
  '解释', '简答', '论述题', '选择题', '填空题', '判断题', '计算题', '证明题', '共', '每题',
  '分值', '要求', '下列各题', '本题', '本大题', '小题', '得分', '评卷人',
  '最大', '最小', '某船', '提高', '增大', '减小', '下列', '关于', '简述', '说明', '采用', '具有', '以下', '如图', '并说明', '并简述',
])

/**
 * 学科通用词：在几乎任何一份卷子里都会出现，单独看没有信息量（「船舶」「高度」）。
 * 只做**精确匹配**剔除，不做前缀剔除 —— 否则「船舶稳性」「初稳性高度」会被连坐。
 */
const GENERIC = new Set([
  '船舶', '船体', '高度', '倾斜', '大倾', '问题', '因素', '措施', '步骤', '公式', '系统',
  '情况', '需要', '必须', '一般', '方面', '部分', '内容', '时候', '结果', '数据', '数值',
  '试验', '装置', '结构', '性能', '形式', '状态', '变化', '关系', '大小', '多少', '一定',
  // 以下是在真实教材/习题册语料上补的：这些词在任何一本教科书里都高频，单看没有信息量。
  // 注意只做精确匹配，它们被更长的词包含时（「细胞膜」「蛋白质合成」）不会连坐。
  '生物', '生物体', '生命', '科学', '物质', '组成', '形成', '重要', '研究', '规律',
  '现象', '特征', '类型', '方式', '原因', '机制', '区别', '举例', '包括', '属于',
  '具有', '产生', '发生', '进行', '存在', '不同', '相同', '各种', '应用', '发展',
  '概念', '定义', '特点', '基础', '意义', '分类', '来源', '目的', '表示', '描述',
  '判断', '例子', '情形', '条件', '前提', '主要内容', '基本概念', '基本特征',
  // 连接词/虚词类：词面统计会把它们顶到榜首，但它们在题干里几乎必然出现。
  '通过', '之间', '不能', '可以', '使用', '利用', '进入', '进人', '能够', '无法',
  '哪些', '什么', '如何', '为什么', '主要', '相关', '有关', '一般', '整个', '过程',
])

/** 选择题选项行：「A. xxx」「B、xxx」 */
const OPTION_LINE = /^\s*[A-Da-d]\s*[.、．·，,:：]\s*\S/
const BLANK = /[（(〈<]\s*[）)〉>]/

/** 题型兜底推断：小节标题没写题型时，按题干形态判，比一律「未分类」有用。 */
function inferTypeFromStem(stem) {
  const lines = stem.split('\n')
  if (lines.filter((l) => OPTION_LINE.test(l)).length >= 2) return '选择题'
  if (BLANK.test(stem)) return '填空题'
  if (/名词解释|解释下列|解释概念|什么是|简述|试述|论述|说明|比较|为什么/.test(stem.slice(0, 40))) return '简答题'
  if (stem.length >= 60 || lines.length >= 3) return '简答题'
  return '未分类'
}

/**
 * 中文候选术语：取连续汉字串的 2~6 字 n-gram。
 * n-gram 会把「稳性的」「下列哪」「并说明」这类语法碎片也切出来，所以按虚词字符表过滤掉。
 */
const NOISE_CHARS = new Set('的了并而或及以在是与和得地吗呢哪么这那些个每共试请求答解把被从对为将则即也都很更最又还只')

const TYPE_HEADER = /^\s*[一二三四五六七八九十]{1,3}\s*[、．.]\s*[^\n]{0,40}$/
const QUESTION_START = /^\s*(\d{1,3})\s*[.、．]\s*(?=\S)/
const SUB_QUESTION = /^\s*[（(]\s*(\d{1,2})\s*[）)]/

/**
 * 拆题。
 * @returns {{questions: {id,no,type,stem,score,lines}[], types: Map, total:{count,score}, warnings:string[]}}
 */
export function splitQuestions(text, docId = 'd1') {
  const lines = text.split('\n')
  const questions = []
  let currentType = '未分类'
  let current = null
  let section = 0
  /** 每个大题小节的分值信息：总分、声明题数、每题分。 */
  const sectionInfo = new Map()
  const warnings = []

  const push = () => {
    if (!current) return
    const stem = current.lines.join('\n').trim()
    if (stem.length < 6) { current = null; return }
    // 参考文献/推荐阅读材料里的条目会被当题目拆出来（「北京：高等教育出版社」），剔掉。
    if (/出版社|ISBN|第\s*\d+\s*版|印刷|书号|定价/.test(stem) && stem.length < 120) { current = null; return }
    // 题干里的「（25 分）」优先级最高；小节信息留给后处理分配
    const scoreMatch = /[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/.exec(current.head)
    questions.push({
      id: `${docId}-q${questions.length + 1}`,
      no: current.no,
      type: current.type,
      stem,
      head: current.head,
      section: current.section,
      score: scoreMatch ? Number(scoreMatch[1]) : null,
    })
    current = null
  }

  for (const line of lines) {
    const t = line.trim()
    if (t === '') { if (current) current.lines.push(''); continue }

    if (TYPE_HEADER.test(t) && /题|部分/.test(t)) {
      const type = detectQuestionType(t)
      if (type) {
        push()
        section += 1
        currentType = type
        const allScore = /共\s*(\d+(?:\.\d+)?)\s*分/.exec(t)
        const perScore = /每(?:小)?题\s*(\d+(?:\.\d+)?)\s*分/.exec(t)
        const countAll = /(\d+)\s*(?:小?题|道)/.exec(t)
        sectionInfo.set(section, {
          type,
          total: allScore ? Number(allScore[1]) : null,
          per: perScore ? Number(perScore[1]) : null,
          declared: countAll ? Number(countAll[1]) : null,
        })
        continue
      }
    }

    const start = QUESTION_START.exec(t)
    if (start && !SUB_QUESTION.test(t)) {
      const no = Number(start[1])
      push()
      current = { no, type: currentType, section, head: t, lines: [t] }
      continue
    }

    if (current) current.lines.push(t)
  }
  push()

  // 小节标题没写题型时按题干形态兜底判一次，否则整卷题型统计是空的。
  for (const q of questions) {
    if (q.type === '未分类') q.type = inferTypeFromStem(q.stem)
  }

  // 分值补全：① 小节写了「每题 X 分」→ 直接用；② 写了「共 X 分」→ 按实际拆出的题数均分；
  // ③ 都没有 → 留空，不猜。均分时最后一位吸收舍入误差，保证合计对得上。
  for (const [sec, info] of sectionInfo) {
    const group = questions.filter((q) => q.section === sec && q.score === null)
    if (group.length === 0) continue
    if (info.per !== null) {
      for (const q of group) q.score = info.per
    } else if (info.total !== null) {
      const each = Math.floor((info.total / group.length) * 10) / 10
      group.forEach((q, i) => {
        q.score = i === group.length - 1
          ? Number((info.total - each * (group.length - 1)).toFixed(1))
          : each
      })
    }
  }

  const types = new Map()
  for (const q of questions) {
    const entry = types.get(q.type) ?? { count: 0, score: 0, scored: 0 }
    entry.count += 1
    if (q.score !== null) { entry.score += q.score; entry.scored += 1 }
    types.set(q.type, entry)
  }
  const total = {
    count: questions.length,
    score: [...types.values()].reduce((a, b) => a + b.score, 0),
  }

  const numbered = (text.match(QUESTION_START) ?? []).length
  if (numbered > questions.length + 3) {
    warnings.push(`检测到约 ${numbered} 处题号但只拆出 ${questions.length} 题，可能有漏题（排版不规整或题号在小标题里）。`)
  }
  if (questions.length === 0) warnings.push('没有识别到题目：这份资料可能不是试卷，或题号格式特殊。')

  return { questions, types, total, warnings }
}

/**
 * 考点热度：题级 n-gram 词频聚类。
 * @param questions splitQuestions 的结果
 * @param topN 返回前多少个考点
 */
export function topicHeat(questions, topN = 30) {
  // 统计 2~7 字全部 n-gram 的题级 df：多算 1 字是为了判断「这个词是不是总被更长的词包住」。
  const allDf = new Map()
  const allQ = new Map()
  const charSet = new Set()
  for (const q of questions) {
    const runs = q.stem.match(/[\u4e00-\u9fff]+/g) ?? []
    const local = new Set()
    for (const run of runs) {
      for (const ch of run) charSet.add(ch)
      for (let len = 2; len <= 7; len += 1) {
        for (let i = 0; i + len <= run.length; i += 1) local.add(run.slice(i, i + len))
      }
    }
    for (const term of local) {
      allDf.set(term, (allDf.get(term) ?? 0) + 1)
      if (!allQ.has(term)) allQ.set(term, new Set())
      allQ.get(term).add(q.id)
    }
  }
  const chars = [...charSet]
  /** 左右各加一个字之后的最大 df —— 判断残片用。 */
  const extMax = (term) => {
    let best = 0
    for (const ch of chars) {
      const a = allDf.get(ch + term)
      if (a && a > best) best = a
      const b = allDf.get(term + ch)
      if (b && b > best) best = b
    }
    return best
  }

  const n = Math.max(questions.length, 1)
  const scored = []
  for (const [term, df] of allDf) {
    if (term.length < 2 || term.length > 6) continue
    if (GENERIC.has(term) || STOPWORDS.has(term)) continue
    if ([...term].some((ch) => NOISE_CHARS.has(ch))) continue
    if (term.length > 2 && STOPWORDS.has(term.slice(0, 2))) continue
    // 页眉/章名漏进正文时会出现「章生物」「第章」这类词，一律不要。
    if (term.includes('章') || /^[第\d]/.test(term)) continue
    if (df < (term.length >= 3 ? 2 : 3)) continue
    if (df > n * 0.75 && n > 6) continue // 几乎每题都有 → 是套话，不是考点
    // 过半题目都出现的短词（2~3 字）不算考点：它更可能是学科背景词，不是被考的知识点。
    if (n >= 8 && term.length <= 3 && df / n >= 0.45) continue
    // 中文没有词边界：某个 n-gram 如果几乎每次都还能向右/左再延一个字，
    // 它就是长词的残片（「初稳」「性高」「舶稳性」），丢掉。
    if (extMax(term) >= df * 0.85) continue
    const lengthBonus = term.length >= 3 ? 1.25 : 1
    scored.push({ term, df, score: df * lengthBonus, qids: new Set(allQ.get(term)) })
  }
  scored.sort((a, b) => b.df - a.df || b.term.length - a.term.length || a.term.localeCompare(b.term))

  // 同义/包含变体归并：df 大的当主词，长变体并进 variants，题目集合取并集。
  const kept = []
  for (const item of scored) {
    const hit = kept.find(
      (k) => (k.term.includes(item.term) || item.term.includes(k.term)) && item.df <= k.df * 1.4,
    )
    if (hit) {
      hit.variants.push(item.term)
      for (const id of item.qids) hit.qids.add(id)
      continue
    }
    kept.push({ ...item, variants: [] })
    if (kept.length >= topN * 4) break
  }

  const heat = kept.slice(0, topN).map((item, index) => {
    const related = questions.filter((q) => item.qids.has(q.id))
    return {
      rank: index + 1,
      term: item.term,
      variants: item.variants.slice(0, 6),
      count: related.length,
      ratio: Number((related.length / n).toFixed(2)),
      tier: related.length / n >= 0.3 ? '高频必考' : related.length / n >= 0.15 ? '常考' : '冷门',
      questions: related.slice(0, 8).map((q) => q.id),
      types: [...new Set(related.map((q) => q.type))],
    }
  })
  return heat
}

/** 生成 Markdown 热度表（给模型直接用，省一次格式化）。 */
export function heatTable(heat) {
  const rows = heat.map((h) => {
    const label = h.variants?.length ? `${h.term}（含${h.variants.slice(0, 2).join('、')}）` : h.term
    return `| ${h.rank} | ${label} | ${h.count} | ${Math.round(h.ratio * 100)}% | ${h.tier} | ${h.types.join('/')} | ${h.questions.slice(0, 3).join(' ')} |`
  })
  return [
    '| # | 考点（词面） | 出现题数 | 覆盖率 | 热度 | 题型 | 样例题号 |',
    '|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

/**
 * 难度估算：只做启发式，用于出题难度配比，不是绝对判断。
 */
export function estimateDifficulty(q) {
  const stem = q.stem
  let level = 1
  if (q.type === '论述题' || q.type === '案例分析题' || q.type === '证明题') level = 3
  else if (q.type === '计算题' || q.type === '简答题') level = 2
  if (stem.length > 120) level += 1
  if (/计算|推导|证明|分析|比较|综合/.test(stem)) level += 1
  if (/\d/.test(stem) && /计算|求/.test(stem)) level += 1
  return Math.min(4, level)
}

