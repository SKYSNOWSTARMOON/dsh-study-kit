#!/usr/bin/env node
// 扫描逐页 OCR 文本，自动识别章起始页并合并成整章文件。
//
// 难点：页眉里也有「第1章生物与生命科学」这种字样（通常带页码），会被误判成章起点。
// 判据（三条同时满足才算章首页）：
//   1) 前 3 个非空行里有一行「第N章」（可带标题），整行不超过 16 字；
//   2) 该行末尾不是页码数字；
//   3) 同一个章号只认第一次出现（页码乱跳时不会重复切章）。
//
// 用法：node scripts/ocr-chapters-auto.mjs <pagesDir> <outDir> [--title 书名] [--minChars 200]
//      [--tocTitles 章名清单.txt] [--skipBefore 14] [--noReflow]
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

// OCR 是按「视觉行」输出文本的，平均 20 字就一个换行，直接入库会让
// proseShare（长正文行占比）只有 2%，分类器只能按文件名兜底（置信 0.25）。
// 这里把同一段的短行合并回段落：标题行/短行独立成段，其余累加到句末标点为止。
const REFLOW_HEAD =
  /^(?:第\s*[一二三四五六七八九十百零〇\d]{1,3}\s*[章节]|[一二三四五六七八九十]{1,3}\s*、|\d{1,2}(?:\.\d{1,2}){0,3}\s*[、.．]?\s*\S|【|▲|图\s*\d)/u;
const REFLOW_END = /[。！？…；：:!?]$/u;

function reflowPage(text) {
  const out = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(buf); buf = "" } };
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) { flush(); continue }
    if (line.length <= 8 || REFLOW_HEAD.test(line)) { flush(); out.push(line); continue }
    buf += line;
    if (REFLOW_END.test(line)) flush();
  }
  flush();
  return out.join("\n\n");
}

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const [pagesDir, outDir] = positional;
if (!pagesDir || !outDir) {
  console.error("用法：node scripts/ocr-chapters-auto.mjs <pagesDir> <outDir> [--title 书名]");
  process.exit(1);
}
const bookTitle = flag("title", "");
const minPageChars = Number(flag("minChars", 120));
// 标准章名表（JSON 数组，索引 = 章号-1）。给了就用它覆盖 OCR 猜出来的章名，
// 避免 OCR 把标题认错、或命令行传中文被控制台编码破坏。
const titlesFile = flag("titles", "");
const stdTitles = titlesFile ? JSON.parse(readFileSync(titlesFile, "utf8")) : null;
// 扫描件常把首章章号认错（「第 1 章」→「第 7 章」）。章是连续的，所以默认按出现
// 顺序从 1 重新编号；用 --keepNumbers 关掉。给了标准章名表时以表为准，不重编号。
const keepNumbers = args.includes("--keepNumbers");
// 默认保留 OCR 的视觉行（一行一视觉行更好读，能看出原书版面）；
// --reflow 才把短行合并成段落（入库分类更准，但长句会糊成大段）。
const reflow = args.includes("--reflow");

const pages = new Map();
for (const f of readdirSync(pagesDir)) {
  const m = /^p(\d+)\.txt$/.exec(f);
  if (!m) continue;
  pages.set(Number(m[1]), readFileSync(join(pagesDir, f), "utf8"));
}
const nums = [...pages.keys()].sort((a, b) => a - b);

const CN_DIGIT = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnToNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  let n = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch === '十') { n += (cur === 0 ? 1 : cur) * 10; cur = 0; continue }
    if (ch === '百') { n += (cur === 0 ? 1 : cur) * 100; cur = 0; continue }
    const d = CN_DIGIT[ch];
    if (d === undefined) return NaN;
    cur = d;
  }
  return n + cur;
}

const CH = /第\s*([^\s章]{1,4})\s*章/;
const seen = new Set();
const starts = [];

for (const p of nums) {
  const raw = pages.get(p);
  if (raw.trim().length < minPageChars) continue; // 空白页 / 纯图页
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4);
  for (const line of lines) {
    const m = CH.exec(line);
    if (!m) continue;
    if (line.length > 16) break;           // 页眉整行很长 → 不是章标题
    const rest = line.replace(CH, "").trim();
    // 页眉会把页码粘进标题（「第1章生物与生命科学7）」）：标题里出现数字/括号就判为页眉。
    if (/[0-9０-９]/.test(rest) || /[（）()]/.test(rest)) break;
    if (rest.length > 12) break;
    let no = cnToNum(m[1]);
    // 章号可能被 OCR 糟蹋（「第 1 章」被认成「第 7 章」，「第犭章」→ 第1章）。
    // 书里章按顺序排：跟「上一章 +1」差得远的，一律当页眉噪声丢掉，**不要**纠偏成
    // 上一章+1 —— 纠偏会把一处页眉变成假章起点（实测：第1章的页眉被认成「第 7 章」，
    // 纠偏后成了第2章，把整整一章的正文并进了「第2章」，真第2章反被判成重复丢弃）。
    const expected = starts.length > 0 ? starts[starts.length - 1].no + 1 : null;
    if (expected !== null && (!Number.isFinite(no) || Math.abs(no - expected) > 1)) break;
    if (!Number.isFinite(no)) no = 1;
    if (seen.has(no)) break;               // 同一章只认第一次
    seen.add(no);
    // 章标题：这一行去掉「第N章」后剩下的部分；若为空，取下一行
    const inlineTitle = rest;
    const nextLine = lines[lines.indexOf(line) + 1] ?? "";
    const title = (inlineTitle || nextLine)
      .replace(/[（(]\s*\d+\s*[）)]/g, "")
      .replace(/[\s\d]+$/, "")
      .trim();
    starts.push({ page: p, no, title });
    break;
  }
}

// 起点章号被 OCR 认错时（首章 1→7），后续编号会整体偏移；按顺序重排回来。
if (!keepNumbers && !stdTitles) {
  starts.forEach((s, i) => { s.no = i + 1 });
}

// ---------- 目录标题定位（比「第N章」的数字可靠得多） ----------
// 扫描件的章号经常被认错（第1章→第 7 章、第七章→第丿章、第八章→第 ^ 章），
// 但章名一般认得准。给一份按顺序排列的章名清单，按「章名出现在页首」定位起点。
const tocFile = flag("tocTitles", "");
if (tocFile) {
  const titles = readFileSync(tocFile, "utf8").split(/\r?\n/u).map((s) => s.trim()).filter(Boolean);
  const skipBefore = Number(flag("skipBefore", 1));
  const norm = (s) => s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/gu, "");
  const ratio = (needle, hay) => {
    let i = 0;
    for (const ch of hay) { if (ch === needle[i]) i += 1; if (i === needle.length) break }
    return needle.length ? i / needle.length : 0;
  };
  const tocStarts = [];
  let cursor = skipBefore;
  for (let k = 0; k < titles.length; k += 1) {
    const t = norm(titles[k]);
    if (!t) continue;
    let found = null;
    for (const p of nums) {
      if (p < cursor) continue;
      const lines = pages.get(p).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4);
      let ok = false;
      if (t.length < 4) {
        // 短章名（「进化」）不能用前缀相似度，只认「短行里出现」——正文句子里也会出现，但行很长。
        ok = lines.some((l) => { const n = norm(l); return n.length <= 12 && n.includes(t) });
      } else {
        const head = norm(lines.slice(0, 3).join(""));
        ok = ratio(t, head) >= 0.75 || lines.some((l) => { const n = norm(l); return n.length <= 14 && n.includes(t) });
      }
      if (ok) { found = p; break }
    }
    if (found) { tocStarts.push({ page: found, no: k + 1, title: titles[k] }); cursor = found + 1 }
  }
  if (tocStarts.length >= Math.max(3, Math.ceil(titles.length * 0.6))) {
    starts.length = 0;
    starts.push(...tocStarts);
  } else {
    console.error(`目录定位只匹配到 ${tocStarts.length}/${titles.length} 章，退回「第N章」检测`);
  }
}

mkdirSync(outDir, { recursive: true });
const report = [];
starts.forEach((s, i) => {
  const from = s.page;
  const to = i + 1 < starts.length ? starts[i + 1].page - 1 : nums[nums.length - 1];
  const body = [];
  for (let p = from; p <= to; p += 1) {
    const t = pages.get(p);
    if (!t || t.trim().length < 30) continue;
    // 丢掉整行乱码（OCR 崩坏行 / 编码事故），否则会污染词面统计
    const cleaned = t
      .split("\n")
      .filter((line) => {
        const len = Math.max(1, line.trim().length);
        return (line.match(/\uFFFD/g) ?? []).length / len <= 0.15;
      })
      .join("\n")
      .trimEnd();
    const shaped = reflow ? reflowPage(cleaned) : cleaned;
    if (shaped.length >= 30) body.push(shaped);
  }
  const std = stdTitles ? stdTitles[s.no - 1] : null;
  // 章名在建 starts 时可能还是旧章号算出来的，这里按最终章号重新拼。
  const label = (std ? `第${s.no}章 ${std}` : `第${s.no}章 ${s.title}`).trim();
  const safe = label.replace(/[\\/:*?"<>|\s]+/g, "");
  const file = `${String(s.no).padStart(2, "0")}-${safe.slice(0, 40)}.txt`;
  const content = `${label}\n\n${body.join("\n\n")}\n`;
  writeFileSync(join(outDir, file), content, "utf8");
  report.push({ file, pages: `${from}-${to}`, chars: content.length, label });
});

console.log(JSON.stringify({ chapters: report.length, detail: report }, null, 2));
