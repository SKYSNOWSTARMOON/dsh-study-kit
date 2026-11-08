#!/usr/bin/env node
// 从扫描版 PDF 里抽出页面图像，供「人工/视觉 OCR」使用。
// 本机没有 poppler / fitz / ghostscript，但扫描页通常就是整页 JPEG（DCTDecode），
// 按页树找到 page → /XObject → 图像对象，直接把 JPEG 字节写出来即可，不需要渲染器。
//
// 用法：
//   node scripts/pdf-images.mjs <file.pdf> <outDir> --pages 1,5,9-12
//   node scripts/pdf-images.mjs <file.pdf> <outDir> --all
//
// 不支持的编码（JBIG2Decode / CCITTFaxDecode / FlateDecode 位图）会报告页号并跳过。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { inflateSync } from "node:zlib";

function parseArgs(argv) {
  const out = { file: null, outDir: null, pages: null, all: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--pages") out.pages = argv[++i];
    else if (a === "--map") out.map = true;
    else rest.push(a);
  }
  [out.file, out.outDir] = rest;
  return out;
}

function parseRanges(spec) {
  const list = [];
  for (const part of String(spec).split(",")) {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part.trim());
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) list.push(i);
    } else if (/^\d+$/.test(part.trim())) list.push(Number(part));
  }
  return [...new Set(list)].sort((a, b) => a - b);
}

function indexObjects(s) {
  const map = new Map();
  const re = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    if (!map.has(num)) map.set(num, m.index + m[0].search(/\d/));
  }
  return map;
}

/** 读 obj 的 dict 文本（到 stream 或 endobj 为止）。 */
function readDict(s, start) {
  const dictStart = s.indexOf("<<", start);
  if (dictStart < 0) return "";
  let depth = 0;
  let i = dictStart;
  while (i < s.length) {
    if (s[i] === "<" && s[i + 1] === "<") { depth += 1; i += 2; continue; }
    if (s[i] === ">" && s[i + 1] === ">") { depth -= 1; i += 2; if (depth === 0) break; continue; }
    i += 1;
  }
  return s.slice(dictStart, i);
}

function readStream(buf, s, start) {
  const streamKw = s.indexOf("stream", start);
  if (streamKw < 0) return null;
  let p = streamKw + 6;
  if (s[p] === "\r") p += 1;
  if (s[p] === "\n") p += 1;
  const endKw = s.indexOf("endstream", p);
  if (endKw < 0) return null;
  let data = buf.subarray(p, endKw);
  while (data.length > 0 && (data[data.length - 1] === 0x0a || data[data.length - 1] === 0x0d)) data = data.subarray(0, data.length - 1);
  return data;
}

const ref = (dict, re) => {
  const m = re.exec(dict);
  return m ? Number(m[1]) : null;
};

/** 找页树根：Kids 数量最多的 /Type/Pages 节点。 */
function findPageTree(s) {
  let best = null;
  for (const m of s.matchAll(/\/Type\s*\/Pages\b[^]*?\/Kids\s*\[([^\]]*)\]/g)) {
    const kids = [...m[1].matchAll(/(\d+)\s+0\s+R/g)].map((x) => Number(x[1]));
    if (!best || kids.length > best.kids.length) best = { kids, count: kids.length };
  }
  return best;
}

/** 展开 Kids（可能嵌套 Pages 节点），得到真正的页对象顺序。 */
function flattenPages(s, kids, depth = 0) {
  if (depth > 8) return kids;
  const pages = [];
  for (const num of kids) {
    const off = s.indexOf(`\n${num} 0 obj`);
    const dict = off < 0 ? "" : readDict(s, off);
    if (/\/Type\s*\/Pages\b/.test(dict)) {
      const sub = [...(dict.match(/\/Kids\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/(\d+)\s+0\s+R/g)].map((x) => Number(x[1]));
      pages.push(...flattenPages(s, sub, depth + 1));
    } else {
      pages.push(num);
    }
  }
  return pages;
}

function main() {
  const { file, outDir, pages, all } = parseArgs(process.argv.slice(2));
  if (!file || !outDir) {
    console.error("用法：node scripts/pdf-images.mjs <file.pdf> <outDir> [--pages 1,3-5 | --all]");
    process.exit(1);
  }
  const buf = readFileSync(file);
  const s = buf.toString("latin1");
  const objs = indexObjects(s);
  const tree = findPageTree(s);
  const pageObjs = tree ? flattenPages(s, tree.kids) : [];

  const results = [];
  pageObjs.forEach((pageObjNum, idx) => {
    const pageNo = idx + 1;
    const off = objs.get(pageObjNum);
    const dict = off === undefined ? "" : readDict(s, off);
    // 页面自己的 Resources（若为空，图像在共享资源里，退化为按名字全局搜）
    const xobj = {};
    for (const m of dict.matchAll(/\/(Im\d+|X\d+|Fm\d+)\s+(\d+)\s+0\s+R/g)) xobj[m[1]] = Number(m[2]);
    const contentsNum = ref(dict, /\/Contents\s+(\d+)\s+0\s+R/);

    let picked = null;
    if (contentsNum != null) {
      const cOff = objs.get(contentsNum);
      if (cOff !== undefined) {
        const raw = readStream(buf, s, cOff);
        let text = "";
        if (raw) {
          try { text = inflateSync(raw).toString("latin1"); } catch { text = raw.toString("latin1"); }
        }
        const doNames = [...text.matchAll(/\/(Im\d+|X\d+|Fm\d+)\s+Do/g)].map((m) => m[1]);
        for (const name of doNames) {
          const target = xobj[name] ?? [...s.matchAll(new RegExp(`/${name}\\s+(\\d+)\\s+0\\s+R`, "g"))].map((m) => Number(m[1]))[0];
          if (target == null) continue;
          const tOff = objs.get(target);
          const tDict = tOff === undefined ? "" : readDict(s, tOff);
          if (/\/Subtype\s*\/Image/.test(tDict)) { picked = { num: target, dict: tDict }; break; }
        }
      }
    }
    if (!picked) {
      // 兜底：取该页 Resources 里第一个图像
      for (const [, num] of Object.entries(xobj)) {
        const tOff = objs.get(Number(num));
        const tDict = tOff === undefined ? "" : readDict(s, tOff);
        if (/\/Subtype\s*\/Image/.test(tDict)) { picked = { num: Number(num), dict: tDict }; break; }
      }
    }
    results.push({ pageNo, pageObjNum, ...(picked ? picked : {}) });
  });

  mkdirSync(outDir, { recursive: true });
  const wanted = all ? null : new Set(pages ? parseRanges(pages) : []);
  const stem = basename(file).replace(/\.pdf$/i, "").slice(0, 20).replace(/[\\/:*?"<>|]/g, "_");

  const jpegs = [], skipped = [];
  for (const page of results) {
    if (wanted && !wanted.has(page.pageNo)) continue;
    if (!page.dict) { skipped.push({ pageNo: page.pageNo, why: "找不到图像对象" }); continue; }
    const filter = (/\/Filter\s*(\/[\w]+|\[[^\]]{0,60}\])/.exec(page.dict) ?? [])[1] ?? "可解码";
    if (filter !== "/DCTDecode") { skipped.push({ pageNo: page.pageNo, why: filter }); continue; }
    const off = objs.get(page.num);
    const data = readStream(buf, s, off);
    if (!data || data.length < 100) { skipped.push({ pageNo: page.pageNo, why: "流为空" }); continue; }
    const out = join(outDir, `${stem}-p${String(page.pageNo).padStart(4, "0")}.jpg`);
    writeFileSync(out, data);
    jpegs.push({ pageNo: page.pageNo, out, kb: Math.round(data.length / 1024) });
  }

  console.log(JSON.stringify({
    file: basename(file),
    pagesInTree: pageObjs.length,
    extracted: jpegs.length,
    skipped: skipped.length,
    skippedDetail: skipped.slice(0, 20),
    jpegs,
  }, null, 2));
}

main();
