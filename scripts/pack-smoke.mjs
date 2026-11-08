// 生成 docx 冒烟测试：造两页 markdown，导出 docx，再由 Word 转 pdf，检查文件大小。
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { markdownToDocx } from '../lib/docx.js'
import { buildPack, convertToPdf } from '../lib/export.js'

const ws = process.argv[2] ?? process.cwd()
const src = path.join(ws, '.tmp', 'pack-smoke', 'src')
const out = path.join(ws, '.tmp', 'pack-smoke', 'out')
await fsp.mkdir(src, { recursive: true })
await fsp.mkdir(out, { recursive: true })

const md = `# 第1章 生物与生命科学

## 一、知识点

### 1. 生命的五个特征

- **细胞结构**：病毒例外，无细胞结构
- **新陈代谢**：同化与异化
- **生长与发育**
- **应激性**：对刺激的反应
- **遗传与变异**

### 2. 原核 vs 真核

| 特征 | 原核细胞 | 真核细胞 |
|---|---|---|
| 核膜 | 无 | 有 |
| 细胞器 | 仅核糖体 | 多种 |
| DNA | 环状裸露 | 与蛋白结合成染色体 |

> 易错：原核生物并非都小，蓝细菌可长达数十微米。

## 二、习题

1. 简述生命的五个基本特征。
2. 原核细胞与真核细胞的区别有哪些？
3. 为什么说病毒不是完整的生命体？

\`\`\`text
GM = KM - KG
\`\`\`

---

【存疑】扫描件第 12 页有一处「细胞代谢」被 OCR 识别为「细胞代i射」。
`

await fsp.writeFile(path.join(src, '01-第1章-生物与生命科学.md'), md, 'utf8')
await fsp.writeFile(path.join(src, '00-课程总览.md'), `# 基础生命科学 · 课程资料包\n\n共 1 章示范。\n`, 'utf8')

const result = await buildPack({ srcDir: src, outDir: out, course: '基础生命科学', format: 'both' })
const docxSizes = []
for (const f of result.docxFiles) docxSizes.push([path.basename(f), (await fsp.stat(f)).size])
console.log(JSON.stringify({
  folder: result.folder,
  docx: docxSizes,
  pdfOk: result.pdf.ok,
  pdfErrors: result.pdf.errors,
  chapters: result.chapters,
}, null, 2))

const pdfDir = result.folder
const listing = await fsp.readdir(pdfDir)
const sizes = []
for (const name of listing) sizes.push([name, (await fsp.stat(path.join(pdfDir, name))).size])
console.log(JSON.stringify(sizes, null, 2))
