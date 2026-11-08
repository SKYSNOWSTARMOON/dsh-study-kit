// 把自动切章的文件名与首行标题规范化（章号 + 标准章名）。
// 由 write 工具落盘，避免命令行传中文被控制台编码破坏。
import { readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const titles = [
  "生物与生命科学",
  "生物的化学组成",
  "细胞——生命的基本单位",
  "能量与代谢",
  "遗传及其分子基础",
  "发育",
  "进化",
  "植物的结构与功能",
  "动物的结构与功能",
  "生物与环境",
  "人体健康与重大疾病预防",
  "生物技术与人类未来",
];

const files = readdirSync(dir).filter((f) => /^\d\d-.*\.txt$/.test(f)).sort();
for (const f of files) {
  const no = Number(f.slice(0, 2));
  if (!Number.isFinite(no) || no < 1 || no > titles.length) continue;
  const p = join(dir, f);
  const raw = readFileSync(p, "utf8");
  const header = `第${no}章 ${titles[no - 1]}`;
  // 去掉旧的两行头（书名 + 章名），换成标准章名
  const body = raw.replace(/^[^\n]*\n\n[^\n]*\n\n/, "");
  writeFileSync(p, `${header}\n\n${body}`, "utf8");
  const nf = `${String(no).padStart(2, "0")}-第${no}章-${titles[no - 1]}.txt`;
  if (nf !== f) renameSync(p, join(dir, nf));
  console.log(`ok ${nf}`);
}
