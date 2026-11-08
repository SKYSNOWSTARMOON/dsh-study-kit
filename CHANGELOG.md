# 变更日志

## 0.9.0

- 新增 `lib/modes.js`：五种输出形态的**结构自检**（L1）。`study_course` 加 `mode` 参数，出成品前按形态检查必备结构，结果逐条列在报告里；**只报不拦**，不合格照样出 Word/PDF。
- 检查项：精简背诵版（条目 ≥5、无 >160 字长行）、详细完整版（前提/适用/易错、推导）、对比归纳版（表 ≥2 个、≥3 列、≥2 行）、思维导图文本版（层级 ≤4、不跳级、节点 ≥6）、错题本（每题有坑点与解析）；前三种另查「考点速查表」的常见陷阱列是否留空。
- `mode` 认全名、简称（「精简」「对比」「导图」「错题」）与 `mermaid`；索引 `_index.md` 多一列「形态自检」，多张表记录《形态：xxx》。
- 输出多 `mode` 与 `lintCount` 两个字段；systemPrompt 补一句「要按形态交付就传 mode」。
- 自测 +3（点名待补项、不拦导出、别名归一 + 合规通过），共 61 项。

## 0.8.0

- 新增 `lib/anki.js`：把章节里的「## 背诵清单」小节转成 Anki 可导入的 TSV（`#separator:tab` / `#html:true` / `#tags column:3` / `#deck:课程::章`）。
- `study_course` 新增 `anki:true`，产物落在 `<课程文件夹>\anki\第N章.txt`；输出多一个 `ankiCount`。
- 卡片只认写好的内容（表格三列、`**术语**：解释`、`正面｜背面｜标签`），不自动从正文抽句子编卡；一张都没有时报告直说「没有找到背诵清单」。
- 卡片字段会清掉 markdown 记号、行内公式转 `\(...\)`（需在 Anki 里开 MathJax）。
- 新增 `examples/walkthrough.md`：从装到出成品到 Anki 卡片的完整命令与真实输出。
- 自测 +3（卡片文件生成、卡片条数、字段清理），共 58 项。

## 0.7.5

- CI 从「只做语法检查」改为真跑全部 55 项断言（Linux runner × Node 20/22），渲染冒烟失败即红；第一次跑就抓到下面的 bug。
- 修 `scripts/selftest.mjs` 的夹具路径：相对路径被工具按会话工作目录解析，CI 上变成 `<workspace>/.tmp/study-fixtures` 而 ENOENT；现在统一 `path.resolve`。
- `scripts/pack-smoke.mjs` 改为真断言（产物 ≥3000 字节、正文不残留 `$`）。
- 新增 issue / PR 模板、`SECURITY.md`、`.editorconfig`；README 增「三句话上手」并修正 OCR 命令顺序。

## 0.7.4

- 表格改为固定列宽：docx 用 `gridCol + tcW + tblLayout(fixed)`，HTML 用 `colgroup + table-layout: fixed`；列宽按内容长度分配并夹在 12%~42%，短列（「要求」「掌握」）不再被压成一字一行。
- 修正 `tblLayout` 在 `tblPr` 中的位置（必须在 `tblBorders` 之后），否则被 Word / LibreOffice 忽略，退回自动排版。
- 自测 +2（固定列宽、HTML 列宽下限）。

## 0.7.3

- `docx` / `html` 表格单元格改为逐字符切分，`$|A|$` 的竖线不再被当列分隔符（成品里残留孤立 `$` 的根因）。
- 粗体里嵌公式（`**$n$ 阶行列式**`）走数学渲染，不再原样输出 `$`。
- `tex.js` 上下标组内的嵌套标记压平（`a_{1p_1}` 不再残留 `p_1`）。
- 自测 +3。

## 0.7.2

- `buildCourse` 支持 `rerender: true`：按现有 `.course-md` 镜像重写 Word/PDF，正文不动。改了渲染器不必重发正文。
- 表格列宽按内容长度分配（等宽会让短列折行）。

## 0.7.0

- 新增 `scripts/ocr-chapters-auto.mjs --tocTitles`：按目录章名定位章起点。扫描件 OCR 认错章号（「第 1 章」→「第 7 章」）导致章号模式切出 11 章，章名模式 12/12。
- 新增 `--skipBefore`（跳过封面/目录）与 `--reflow`（OCR 视觉行合并成段落，默认关）。

## 0.6.0

- 新增工具 `study_course`：按章交付 `<课程名>/01-第1章-章名.docx + .pdf`，同一门课再补内容并进原文件夹（重合 ≥0.7 不写、覆盖 ≥0.9 整章替换、其余追加到 `## 补充 · 日期`）。
- 新增 `scripts/ocr-image.ps1`：零散图片 OCR（Windows.Media.Ocr，约 2 秒/张）。
- 老课程包 adopt：没有 `.course-md` 镜像时从 docx 抠回正文当基线。

## 0.5.0

- 新增工具 `study_export`：把库里已有资料直接导出 Word/PDF（一份资料一个文件）。
- PDF 三级兜底：无头浏览器 → DSH 自带 LibreOffice Kit → Word COM，报告写明走了哪条。
- OCR 文本按句末标点重排段落（`reflow: auto/on/off`）。

## 0.4.0

- 分类器补 OCR 分支（长文、无题号、全是短行 → 教材正文 0.62）。
- 切章支持 `--skipBefore`；修复章号误判导致的多章合并。

## 0.3.0

- 入库前同源跳过：哈希精确复用优先，再双向 containment（阈值 0.85，同名不同格式 0.5），报告标 `⇄`。
- 类型判定改为「顺序级联 + 篇幅占比开门」，替代关键词加权求和（后者把 24 份混排复习资料全判成参考答案）。
- `shingles()` 步长改 1（step=4 时同源文档重合度 0.905 → 0.272，去重失效）。
- 修复 PDF 断行：`BT` 不再清 `lastY`（Edge/Chrome 打印件每行一个 `BT`，8 页只抽出 14 个换行）。

## 0.2.0

- 新增工具 `study_pack`（按章 markdown 打包成课程资料）、`study_exam_stats`、`study_paper`。
- 零依赖 docx 生成器与 markdown → HTML，PDF 走本机无头浏览器。

## 0.1.0

- 首个版本：`study_ingest` / `study_ingest_text` / `study_outline` / `study_read`，资料库落在 `<工作目录>/.study-kit/`。
