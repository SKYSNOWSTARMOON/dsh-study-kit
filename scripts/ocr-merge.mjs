#!/usr/bin/env node
// 把 OCR 出来的逐页文本按章合并成整章文件（供 study_ingest 入库）。
// 与 ocr-pdf.ps1 分开是故意的：章页码范围经常要按实际扫描页微调，重排一次不用重跑 OCR。
//
// 用法：node scripts/ocr-merge.mjs <pagesDir> <chapters.json> <outDir>
// chapters.json: [{ "title": "第一章 ...", "file": "ch01-xxx.txt", "from": 14, "to": 37 }]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [pagesDir, chaptersJson, outDir] = process.argv.slice(2);
if (!pagesDir || !chaptersJson || !outDir) {
  console.error("用法：node scripts/ocr-merge.mjs <pagesDir> <chapters.json> <outDir>");
  process.exit(1);
}
const chapters = JSON.parse(readFileSync(chaptersJson, "utf8").replace(/^\uFEFF/, ""));
mkdirSync(outDir, { recursive: true });

const pageText = new Map();
for (const f of readdirSync(pagesDir)) {
  const m = /^p(\d+)\.txt$/.exec(f);
  if (!m) continue;
  pageText.set(Number(m[1]), readFileSync(join(pagesDir, f), "utf8"));
}

const report = [];
for (const ch of chapters) {
  const parts = [];
  const missing = [];
  for (let p = ch.from; p <= ch.to; p += 1) {
    const t = pageText.get(p);
    if (t === undefined) { missing.push(p); continue; }
    if (t.trim().length > 0) parts.push(t.trimEnd());
  }
  const content = `${ch.title}\n\n${parts.join("\n\n")}\n`;
  writeFileSync(join(outDir, ch.file), content, "utf8");
  report.push({ file: ch.file, pages: `${ch.from}-${ch.to}`, chars: content.length, missing: missing.length });
}
console.log(JSON.stringify({ chapters: report, totalChars: report.reduce((a, b) => a + b.chars, 0) }, null, 2));
