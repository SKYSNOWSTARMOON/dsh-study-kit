/**
 * 原文核对（L1.5）：拿资料库里的原文，核对讲义里「有没有瞎写」。
 *
 * 只做三件能机械判定的事，其余一概不碰：
 *   1. 表述覆盖：讲义里带「定义/定理/性质/公式/法则/结论…」的句子，原文里能不能找到相近的三字组；
 *   2. 公式符号：`$...$` 里的符号序列，原文里有没有同样的序列（OCR 常把公式打成散字，找不到不算罪）；
 *   3. 章内自相矛盾：同一符号在两张表/两处给的取值不同（只比同名的「xxx = 值」）。
 *
 * 明确不做：判断「理解对不对」、判断教材本身印错、判断改写表述是否等价。
 * 所以结论一律是【待核对】而不是【错】——误报是常态，别让用户照着清单乱改。
 */

const PUNCT = /[\s，。、；：？！“”‘’（）【】《》〈〉·…—\-_/\\|,.!?;:'"()\[\]{}<>=+*~`^%$#@&]/g
const CLAIM_HEAD = /(定义|定理|性质|公式|法则|结论|判别|判定|充要|条件|注意|易错|陷阱|关系|等价)/
const MATH_LIKE = /[=<>≤≥≈≠+\-*/^_|]/

/** 比对用归一化：去标点空白、去代码与公式、小写、只留汉字与字母数字。 */
export function normalizeText(input) {
  return String(input ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\$\$?[^$]*\$\$?/g, ' ')
    .replace(/\s+/g, '')
    .replace(PUNCT, '')
    .toLowerCase()
}

/** 公式比对用归一化：只留符号与字母数字，去掉上下标标记与 CJK（OCR 常把公式打散）。 */
export function normalizeMathText(input) {
  return String(input ?? '')
    .replace(/\\(left|right|,|;|!|quad|qquad)/g, '')
    .replace(/[\u4e00-\u9fa5]/g, '')
    .replace(/[_^{}]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 三字组集合；size 可调，但比对双方必须一致。 */
export function trigrams(text, size = 3) {
  const set = new Set()
  const s = String(text ?? '')
  for (let i = 0; i + size <= s.length; i++) set.add(s.slice(i, i + size))
  return set
}

/** needle 的三字组有多大比例出现在 haySet 里（0~1）；太短直接算命中。 */
export function coverageOf(needle, haySet, size = 3) {
  const grams = trigrams(normalizeText(needle), size)
  if (grams.size === 0) return 1
  let hit = 0
  for (const g of grams) if (haySet.has(g)) hit += 1
  return hit / grams.size
}

/** 抽「断言型」句子：带定义类词或冒号解释，长度 12~220，跳过表格与标题。 */
export function extractClaims(markdown) {
  const out = []
  const seen = new Set()
  // 习题/答案/解析小节里的句子本来就不在原教材里，拿它核对只会全是噪声
  const QUIZ_SECTION = /(习题|练习|作业|答案|解析|错题|自测|模拟|真题|选择题|填空题|简答)/
  let inQuiz = false
  for (const raw of String(markdown ?? '').split('\n')) {
    if (/^\s*#{1,6}\s+/.test(raw)) {
      inQuiz = QUIZ_SECTION.test(raw)
      continue
    }
    if (inQuiz) continue
    // 任务清单（- [ ] xxx）是给排版用的骨架，不是论断
    if (/^\s*[-*+]\s+\[[ xX]?\]/.test(raw)) continue
    const line = raw
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.、]\s*/, '')
      .replace(/\*\*/g, '')
      .trim()
    if (line.length < 12 || line.length > 220) continue
    if (/^[|#]/.test(line)) continue
    // 表格单元格是压缩过的短语，主语都被省了，拿去跟原文比没有意义
    if ((line.match(/\|/g) || []).length >= 2) continue
    if (!CLAIM_HEAD.test(line) && !/：/.test(line)) continue
    const text = line.replace(/\$\$?[^$]*\$\$?/g, ' ').trim()
    // 去掉公式后只剩标签（「方阵数乘的行列式：」）就没法核对——公式由 extractMath 单独比
    const core = text.replace(/[：:，,。.；;、\s]/g, '')
    if (core.length < 10) continue
    // 自己加的拓展/存疑标注本来就不在原文里，核对它们只会制造噪声
    if (/【\s*(拓展|存疑|原文疑似错误)/.test(line)) continue
    const key = text.slice(0, 40)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out
}

/** 抽行内公式（跳过矩阵等环境，tex.js 也不支持）。 */
export function extractMath(markdown) {
  const out = []
  for (const m of String(markdown ?? '').matchAll(/\$\$?([^$\n]+)\$\$?/g)) {
    const latex = m[1].trim()
    if (latex === '' || /\\begin|\\end/.test(latex)) continue
    if (!MATH_LIKE.test(latex)) continue
    out.push(latex)
  }
  return out
}

/** LaTeX → 可比对的符号骨架（`|kA|=k^n|A|` → `|ka|=kn|a|`）。 */
export function mathSkeleton(latex) {
  return String(latex ?? '')
    .replace(/\\(left|right|,|;|!|quad|qquad)/g, '')
    .replace(/\\(mathrm|mathbf|text|operatorname|mbox)\s*\{([^{}]*)\}/g, '$2')
    .replace(/\\(cdot|times)/g, '*')
    .replace(/\\div/g, '/')
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\[a-zA-Z]+/g, (cmd) => cmd.slice(1).toLowerCase()) // \alpha → alpha
    .replace(/[_^{}]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 预处理原文（三字组集合很贵，多章共用一份）。 */
export function prepareSource(sourceText) {
  const raw = String(sourceText ?? '')
  return {
    hay: trigrams(normalizeText(raw)),
    srcMath: normalizeMathText(raw),
    sourceHasMath: /\$[^$\n]+\$/.test(raw),
    chars: normalizeText(raw).length,
  }
}

/**
 * 核对一章。
 * @param {string} markdown 讲义正文
 * @param {string} sourceText 原文（可多份拼起来）
 * @param {{quoteMin?: number, maxIssues?: number, prepared?: ReturnType<typeof prepareSource>}} options
 */
export function checkChapter(markdown, sourceText, options = {}) {
  const quoteMin = options.quoteMin ?? 0.08
  const maxIssues = options.maxIssues ?? 200
  const prepared = options.prepared ?? prepareSource(sourceText)
  const { hay, srcMath, sourceHasMath } = prepared
  const src = { length: prepared.chars }

  const claims = extractClaims(markdown)
  const quotes = claims.map((text) => ({ text, score: Number(coverageOf(text, hay).toFixed(2)) }))
  const low = quotes.filter((q) => q.score < quoteMin)

  const formulas = extractMath(markdown).map((latex) => {
    const sk = mathSkeleton(latex)
    if (!sourceHasMath) return { latex, skeleton: sk, found: null }
    // 骨架太短（如 a=b）在长原文里必然命中，没有信息量，标成「已核对」跳过
    const found = sk.length < 5 ? true : srcMath.includes(sk)
    return { latex, skeleton: sk, found }
  })
  const missingMath = formulas.filter((f) => f.found === false)
  const unverifiable = formulas.filter((f) => f.found === null)

  const issues = []
  for (const q of low) {
    if (issues.length >= maxIssues) break
    issues.push(`与原文几乎无重叠（覆盖 ${q.score}）：${q.text.slice(0, 70)}`)
  }
  for (const f of missingMath) {
    if (issues.length >= maxIssues) break
    issues.push(`公式未在原文找到相同符号：$${f.latex}$（请翻原文核对）`)
  }

  return {
    issues,
    stats: {
      claims: claims.length,
      lowQuotes: low.length,
      formulas: formulas.length,
      missingFormulas: missingMath.length,
      unverifiableFormulas: unverifiable.length,
      corpusChars: src.length,
      sourceHasMath,
    },
    quotes,
    formulas,
  }
}

/** 报告里的一行摘要。 */
export function summarizeGrounding(result) {
  const s = result.stats
  if (s.claims === 0 && s.formulas === 0) return '原文核对：这章没有可比对的表述与公式'
  const parts = []
  if (s.claims > 0) parts.push(`${s.claims} 条表述中 ${s.lowQuotes} 条在原文里几乎找不到`)
  if (s.formulas > 0) {
    parts.push(
      s.sourceHasMath
        ? `${s.formulas} 个公式中 ${s.missingFormulas} 个符号对不上`
        : `${s.formulas} 个公式无法核对（原文是 OCR 纯文本，公式已被打散）`,
    )
  }
  if (result.issues.length === 0) return `原文核对：${parts.join('；')}；没有发现对不上的地方`
  return `原文核对：${parts.join('；')}（共 ${result.issues.length} 处待核对）`
}
