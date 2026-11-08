/**
 * dsh-study-kit —— 把「学习资料整合 + 真题统计 + 出模拟卷」做成 DSH 自带工具。
 *
 * 设计原则（照着 dsh-qwen-paint 踩过的坑写的）：
 *  ① **零外部依赖**：只用 node 内置模块。这台机器没有网络（npm/pypi 都不通），
 *     任何 `import 'x'` 都会让插件在 profile 里解析失败，代价是 DSH 起不来。
 *  ② **用局部 root.inject**，不用对象级 inject —— 对象级会把 apply 推迟到服务就绪，
 *     某个服务老宿主机上不存在时插件永远不 apply 且不报错。
 *  ③ **输出契约写进 systemPrompt**，因为「标【存疑】、不编造、给干货」这类要求
 *     靠模型自觉不可靠，得变成常驻规则。
 *  ④ 解析器全部手写（docx/pptx 走 zip+XML，PDF 走文本层），做不到的事**明确说出来**：
 *     PDF 无文本层=扫描件要 OCR、图片没有 OCR 引擎 —— 不假装能读。
 */

import { buildTools } from './tools.js'

export const name = 'study-kit'

const DEFAULTS = {
  /** 单个文件解析超时。 */
  timeoutMs: 180000,
}

const SYSTEM_PROMPT = [
  '本会话装有 study-kit：用户上传的学习资料（教材/笔记/课件/习题/历年真题）会被解析入库，用 study_* 工具处理。',
  '工作流程：新文件先 study_ingest（或 OCR 后 study_ingest_text）→ study_outline 看章节 → study_read 精读 → 需要出卷先 study_exam_stats 统计考点 → study_paper 出蓝图再按骨架填题。',
  '课程资料包（「一次性总结一门课」）：按章把笔记写成 markdown（01-第1章-xxx.md、02-第2章-xxx.md，00-开头的是总览），再 study_pack 生成 <输出目录>/<课程名>/ 下一章一个 Word 文档（format=both 同时出 PDF，走本机 Edge/Chrome 无头打印，不需要 Word）。',
  '最终交付（用户要「按章节做成 word 和 pdf，放在以课程命名的文件夹」）：优先 study_course({course:"课程名", format:"both", chapters:[{no,title,markdown}]})，输出 <工作目录>/<课程名>/01-第1章-章名.docx + .pdf。同一门课以后补充内容再传同一个 course，会并进原文件夹、并进对应章（重复不写，新内容进「## 补充 · 日期」），不要新建目录、不要用 study_export 平铺成一本一本书。',
  '五种整合形态由你写 markdown 决定：精简背诵版（条目化）/ 详细完整版（推导·前提·适用范围·易错点）/ 对比归纳版（表格）/ 思维导图文本版（缩进层级，可直接转 mermaid）/ 错题本（题干·坑点·标准解析）。每个考点都要带「考察角度 / 常见陷阱」，专业课再标 了解 / 识记 / 掌握 / 计算。要按形态交付时给 study_course 传 mode（同名字符串），插件会按该形态做结构自检并把缺的点出来（只报不拦）。',
  '扫描件与图片：PDF 用 scripts/ocr-pdf.ps1，零散图片用 scripts/ocr-image.ps1（都跑 powershell.exe 5.1，不是 pwsh 7），OCR 文本再 study_ingest / study_ingest_text 入库。',
  '导出成文件：资料已经入库后想拿 Word/PDF，用 study_export({prefix:"全本教材", format:"both"})，一份资料一个文件；用户要「做成 pdf/word」时不要手工拼 markdown，直接用它。',
  '输出契约（硬要求，不因用户客气话放松）：',
  '- 只给干货：不写「希望对你有帮助」「加油」这类话，不铺陈背景除非用户要「详细」。',
  '- 资料里没有的内容必须标【拓展】；不确定的标【存疑】；发现原文自相矛盾或明显笔误标【原文疑似错误】；绝不编造文献、数据、页码。',
  '- 应试导向：考点按「考察角度 / 常见陷阱 / 背诵要点」组织；专业课区分 了解 / 识记 / 掌握 / 计算。',
  '- 公式用标准 Markdown LaTeX（行内 $...$，独立 $$...$$）；对比类内容用表格。',
  '- 用户在五种形态里选（精简背诵版 / 详细完整版 / 对比归纳版 / 思维导图文本版 / 错题本），没说就默认精简背诵版。',
  '- 解析失败、OCR 质量差、题目漏拆时，直接说哪几段不可用，不要用猜测填补。',
].join('\n')

/** 极简日志：宿主 logger 可能不存在，取不到就退到 console。 */
export function makeLog(root) {
  let logger = null
  try {
    logger = root?.logger ?? root?.ctx?.logger ?? null
  } catch {
    logger = null
  }
  const write = (level, message) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](`[study-kit] ${message}`)
      else console.log(`[study-kit] ${message}`)
    } catch {
      /* 日志失败不能影响工具 */
    }
  }
  return write
}

export function apply(root, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const log = makeLog(root)

  root.inject(['tools'], (ctx) => {
    const tools = buildTools(ctx, log)
    for (const tool of tools) {
      try {
        ctx.tools.register(tool)
        log('info', `已注册工具 ${tool.name}`)
      } catch (error) {
        log('warn', `注册 ${tool.name} 失败：${error?.message ?? error}`)
      }
    }

    // 输出契约常驻，避免每次都要用户在提示词里重复一遍。
    try {
      const systemPrompt = ctx.get?.('systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        systemPrompt.section({
          name: 'study-kit:output-contract',
          order: 9200,
          text: SYSTEM_PROMPT,
        })
        log('info', '已注册 systemPrompt 段落：study-kit 输出契约')
      }
    } catch (error) {
      log('warn', `注册 systemPrompt 段落失败：${error?.message ?? error}`)
    }

    log('info', '资料库目录：<会话工作目录>/.study-kit/')
  })
}

export default apply
