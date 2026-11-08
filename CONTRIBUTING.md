# 贡献指南

## 先跑通自测

```powershell
# 造夹具（可选：python 需装 python-docx / python-pptx）
python scripts/make-fixtures.py    .tmp/study-fixtures
python scripts/make-pdf-fixture.py .tmp/study-fixtures

# 跑自测
node scripts/selftest.mjs .tmp/study-fixtures
```

必须全部通过再提 PR。改了解析/判定/渲染逻辑却不动自测的 PR 会被要求补测试。

## 三条硬约束

1. **不加运行时依赖**
   这个项目零 npm 依赖是刻意的（离线机器、内网、供应链安全）。要新能力就用 Node 内置模块，或调用系统已有程序（PowerShell / 浏览器 / LibreOffice），并在 README 写清平台要求。

2. **不确定就报错，不要猜**
   解析失败、OCR 质量差、题目漏拆时，输出「哪几段不可用」，不要用猜测填充，也不要静默跳过。入库报告里的 warnings 允许用户看见问题，比结果好看重要。

3. **判定逻辑要写依据**
   类型判定、去重阈值、题号密度这些数字都是被真实数据打出来的。改阈值请在 commit / PR 里写「哪个数据支撑这个数字」，历史坑的成因留在代码注释里，别删。

## 代码约定

- ESM，`node:` 前缀导入内置模块；两空格缩进，无分号结尾（与现有文件一致）。
- 面向模型的工具定义在 `lib/tools.js`：`input.schema` 用 JSON Schema 子集（`type/properties/required/description`），`output.schema` 里 `text` 必填，早退分支也要补齐必填字段（否则 schema 校验失败）。
- 落盘路径一律基于 `workingDirectory`，不要写死盘符。
- 写中文文件用编辑器，**不要用 PowerShell 管道重写**：UTF-8 会被当 GBK 解码再编码，中文变乱码；`${}` 会被 PowerShell 当变量吃掉。

## 提交信息

```
fix(docx): 表格单元格按字符扫描切分，$|A|$ 不再被竖线切断

原来用 row.split('|')，数学环境里的竖线会切开公式，成品里留下孤立 $。
自测新增「表格里的 $|A|$ 不被竖线切断」。
```

前缀用 `feat / fix / docs / test / refactor / chore`，正文说清「改了什么、为什么、怎么验证」。

## 想改哪里

- 解析器覆盖：`lib/office.js`（docx/pptx）、`lib/pdf.js`（PDF 文本层）
- 清洗与判定：`lib/clean.js`（`profileText` / `classifyText` / `shingles`）
- 渲染：`lib/docx.js`（OOXML）、`lib/html.js`（打印）、`lib/tex.js`（LaTeX 子集）
- 交付与合并：`lib/export.js`（`buildCourse` 的合并 / 只登记 / rerender 三条路径）
- 统计与出卷：`lib/stats.js`、`lib/paper.js`
