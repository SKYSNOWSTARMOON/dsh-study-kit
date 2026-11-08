import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { markdownToDocx } from '../lib/docx.js'
import { buildPack } from '../lib/export.js'

// 生成 docx 冒烟：造一章 markdown → 打包成课程资料 → 断言产物存在且不是空壳。
// 失败直接抛错（exit 1），不要用 console.log 假装通过。
// 只出 docx：PDF 依赖本机浏览器或 LibreOffice Kit，CI 的 ubuntu runner 上不保证有。
const ws = process.argv[2] ?? process.cwd()
const src = path.join(ws, '.tmp', 'pack-smoke', 'src')
const out = path.join(ws, '.tmp', 'pack-smoke', 'out')
await fsp.rm(path.join(ws, '.tmp', 'pack-smoke'), { recursive: true, force: true })
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

## 三、公式

$$|A|=\\sum_{j=1}^{n}a_{1j}A_{1j}$$

【存疑】扫描件第 12 页有一处「细胞代谢」被 OCR 识别为「细胞代i射」。
`

await fsp.writeFile(path.join(src, '01-第1章-生物与生命科学.md'), md, 'utf8')
await fsp.writeFile(path.join(src, '00-课程总览.md'), `# 基础生命科学 · 课程资料包\n\n共 1 章示范。\n`, 'utf8')

const result = await buildPack({ srcDir: src, outDir: out, course: '基础生命科学', format: 'docx' })

assert.ok(result.docxFiles.length >= 2, `docx 数量不足：${result.docxFiles.length}`)
for (const file of result.docxFiles) {
  const size = (await fsp.stat(file)).size
  assert.ok(size > 3000, `${path.basename(file)} 只有 ${size} 字节，疑似空壳`)
  console.log(`ok  ${path.basename(file)}  ${size} bytes`)
}

// 产物里不能残留未渲染的 LaTeX
const { openZip } = await import('../lib/zip.js')
const chapter = result.docxFiles.find((f) => f.includes('第1章'))
const zip = openZip(await fsp.readFile(chapter))
const xml = zip.text('word/document.xml')
const body = xml.split('<w:body>')[1] ?? ''
const text = body.replace(/<[^>]+>/g, '')
assert.equal(text.includes('$'), false, 'docx 正文残留 $（公式没渲染）')
console.log('ok  公式已渲染，无 $ 残留')
console.log('pack-smoke PASS')
