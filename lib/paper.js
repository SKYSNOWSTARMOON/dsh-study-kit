/**
 * 模拟卷「命题蓝图」生成器。
 *
 * 定位必须说清楚：**这一步只出骨架，不出成品题**。
 * 骨架负责三件模型容易做歪的事：
 *   ① 题型/题量/分值的硬约束（总分必须对得上）；
 *   ② 考点覆盖按真题热度加权，冷门也要留比例；
 *   ③ 每题给出难度、命题要求、避重题号，并预留统一格式的评分要点位。
 * 题干与答案由模型按骨架填，填完可以再用 validatePaper() 校验分值。
 */

const DIFFICULTY_LABEL = { 1: '易', 2: '中', 3: '较难', 4: '难' }

/** 可复现的伪随机（mulberry32）。 */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(list, random) {
  const arr = list.slice()
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/**
 * @param {object} input
 * @param {{term:string,count:number,tier:string,questions:string[]}[]} input.topics 热度表
 * @param {{type:string,count:number,score:number}[]} input.blueprint 题型配比
 * @param {number} [input.seed]
 * @param {number} [input.difficulty] 1~4 目标难度
 * @param {boolean} [input.avoidOriginal] 是否在要求里写避重
 */
export function buildPaper(input) {
  const { topics = [], blueprint = [], seed = 20260101, difficulty = 2, avoidOriginal = true } = input
  const random = rng(seed)

  const totalScore = blueprint.reduce((sum, b) => sum + b.count * b.score, 0)
  const totalCount = blueprint.reduce((sum, b) => sum + b.count, 0)

  // 考点池按热度分档加权：高频必考 3 份、常考 2 份、冷门 1 份。
  // 不按 count 直接加权 —— 真题里出现 6 次的考点如果按次数复制，会占掉全卷一半题位，
  // 真卷不会这么出。分档加权 + 不放回抽样，既体现热度又不至于一题堂。
  const tierWeight = { 高频必考: 3, 常考: 2, 冷门: 1 }
  const pool = []
  for (const topic of topics) {
    const weight = tierWeight[topic.tier] ?? 1
    for (let i = 0; i < weight; i += 1) pool.push(topic)
  }
  const fallback = [{ term: '（未统计到考点，请按目录补）', count: 0, tier: '冷门', questions: [] }]
  let bag = shuffle(pool.length > 0 ? pool : fallback, random)
  let bagCursor = 0
  /** 不放回抽一个考点；抽空后重新洗牌，且避免与上一题连考同一考点。 */
  const nextTopic = (previous) => {
    if (bagCursor >= bag.length) {
      bag = shuffle(pool.length > 0 ? pool : fallback, random)
      bagCursor = 0
    }
    if (bag.length > 1 && previous && bag[bagCursor].term === previous) {
      // 同考点连出会显得偷懒：跟后面第一个不同考点的位置换一下
      const alt = bag.findIndex((t, i) => i > bagCursor && t.term !== previous)
      if (alt >= 0) {
        const tmp = bag[alt]
        bag[alt] = bag[bagCursor]
        bag[bagCursor] = tmp
      }
    }
    const picked = bag[bagCursor]
    bagCursor += 1
    return picked
  }

  const slots = []
  blueprint.forEach((block) => {
    for (let i = 0; i < block.count; i += 1) {
      const previous = slots.length > 0 ? slots[slots.length - 1].topic : null
      const topic = nextTopic(previous)
      // 难度：以目标难度为中心做 ±1 的抖动，试卷整体才不会全同难度
      const jitter = [-1, 0, 0, 1][Math.floor(random() * 4)]
      const level = Math.max(1, Math.min(4, difficulty + jitter))
      slots.push({
        no: slots.length + 1,
        type: block.type,
        score: block.score,
        topic: topic.term,
        topicQuestions: topic.questions ?? [],
        difficulty: level,
        difficultyLabel: DIFFICULTY_LABEL[level],
      })
    }
  })

  const markdown = renderMarkdown({ slots, blueprint, totalScore, totalCount, difficulty, avoidOriginal })
  return { markdown, slots, totalScore, totalCount }
}

function renderMarkdown({ slots, blueprint, totalScore, totalCount, difficulty, avoidOriginal }) {
  const lines = []
  lines.push(`# 模拟试卷（命题蓝图）`)
  lines.push('')
  lines.push('> 本文件是**命题骨架**：题型、题量、分值、考点、难度、评分要点位都已定好，题干与答案按「命题要求」填写。')
  lines.push('')
  lines.push('| 项目 | 内容 |')
  lines.push('|---|---|')
  lines.push(`| 满分 | ${totalScore} 分 |`)
  lines.push(`| 题量 | ${totalCount} 题 |`)
  lines.push(`| 目标难度 | ${DIFFICULTY_LABEL[difficulty] ?? '中'}（1 易 ~ 4 难） |`)
  lines.push(`| 题型配比 | ${blueprint.map((b) => `${b.type} ${b.count}×${b.score}分`).join('；')} |`)
  lines.push('| 建议考试时间 | 按每分钟 1.2~1.5 分估：约 ' + Math.round(totalScore / 1.3) + ' 分钟 |')
  lines.push('')

  let printedType = ''
  for (const slot of slots) {
    if (slot.type !== printedType) {
      printedType = slot.type
      const block = blueprint.find((b) => b.type === slot.type)
      lines.push('')
      lines.push(`## ${printedType}（共 ${block ? block.count : '?'} 题，每题 ${slot.score} 分，共 ${(block ? block.count * block.score : '?')} 分）`)
      lines.push('')
    }
    const avoid = avoidOriginal && slot.topicQuestions.length > 0
      ? `；**不得与原题重复**（相似原题：${slot.topicQuestions.slice(0, 2).join('、')}）`
      : ''
    lines.push(`**${slot.no}.**（${slot.score} 分）　考点：${slot.topic}｜难度：${slot.difficultyLabel}`)
    lines.push(`- 题干：〔按考点「${slot.topic}」命题，符合${printedType}规范，无歧义〕`)
    lines.push(`- 命题要求：${requirementOf(slot.type, slot.difficulty)}${avoid}`)
    lines.push(`- 答案与评分要点：〔得分点 ①②③ 分条，标注每点分值，合计 ${slot.score} 分〕`)
    lines.push('')
  }
  return lines.join('\n')
}

function requirementOf(type, level) {
  const base = {
    选择题: '四个选项，只有一个正确；干扰项须对应真实易错点，不得出现「以上都对」凑数项',
    填空题: '每空一个确定答案，答案唯一且可判卷；避免一空多解',
    判断题: '陈述必须是可判真假的完整命题，错误项要错在关键概念上',
    名词解释: '答案 3~5 个采分点，覆盖定义、要素、判据',
    简答题: '答案 4~6 个要点，按点给分，允许同义表述',
    论述题: '要求有论点、论据、结论三段；评分要点按论点/论证/结论分档',
    计算题: '给出已知条件与单位，答案须含公式、代入、结果、单位四步',
    证明题: '条件充分，步骤可验证，不得跳步',
    案例分析题: '材料自洽，问题可分小问，答案须落到知识点',
  }[type] ?? '按该题型常规命题'
  if (level >= 3) return `${base}；难度上调：需跨 2 个以上知识点综合`
  if (level === 1) return `${base}；难度下调：单一知识点直接套用`
  return base
}

/**
 * 校验一份卷子：总分、题量是否与蓝图一致，以及是否残留占位符。
 * @param {object} [options]
 * @param {boolean} [options.allowPlaceholders] 蓝图骨架本身带〔〕占位符，校验骨架时置 true
 */
export function validatePaper(markdown, blueprint, options = {}) {
  const expectedScore = blueprint.reduce((s, b) => s + b.count * b.score, 0)
  const expectedCount = blueprint.reduce((s, b) => s + b.count, 0)
  const numbers = [...markdown.matchAll(/^\*\*(\d+)\.\*\*/gm)].map((m) => Number(m[1]))
  const scores = [...markdown.matchAll(/[（(](\d+(?:\.\d+)?)\s*分[）)]/g)].map((m) => Number(m[1]))
  const placeholders = (markdown.match(/〔[^〕]*〕/g) ?? []).length
  const issues = []
  if (numbers.length !== expectedCount) issues.push(`题号数量 ${numbers.length} ≠ 蓝图 ${expectedCount}`)
  const bodyScore = scores.reduce((a, b) => a + b, 0)
  if (scores.length > 0 && bodyScore !== expectedScore) issues.push(`卷内标注分值合计 ${bodyScore} ≠ 蓝图 ${expectedScore}（表头的满分行会计入，请按题目行核对）`)
  if (placeholders > 0 && !options.allowPlaceholders) issues.push(`仍有 ${placeholders} 处〔占位符〕未填写`)
  return { ok: issues.length === 0, issues, expectedScore, expectedCount, placeholders }
}
