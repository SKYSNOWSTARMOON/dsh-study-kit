// 量一下「散文度 / 题号密度」，给 classifyText 的教材反证规则找阈值。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dirs = process.argv.slice(2);
for (const dir of dirs) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".txt")).sort()) {
    const text = readFileSync(join(dir, f), "utf8");
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const avgLen = lines.reduce((a, l) => a + l.length, 0) / Math.max(1, lines.length);
    const qNo = (text.match(/^\s*\d+\s*[.、．]/gm) ?? []).length;
    const qRatio = qNo / Math.max(1, lines.length);
    const examSig = /(考试时间|答题卡|考号|满分\s*\d+|闭卷|开卷|期末考试|期中考试)/.test(text);
    const answerSig = (text.match(/(参考答案|答案与解析|【答案】|答：|解析：)/g) ?? []).length;
    const thinkSig = (text.match(/(思考题|练习题|复习题|课后习题)/g) ?? []).length;
    console.log(
      [
        dir.split("\\").pop(),
        f.slice(0, 26),
        `chars=${text.length}`,
        `lines=${lines.length}`,
        `avg=${avgLen.toFixed(1)}`,
        `qNo=${qNo}`,
        `qRatio=${qRatio.toFixed(2)}`,
        `exam=${examSig ? 1 : 0}`,
        `ans=${answerSig}`,
        `think=${thinkSig}`,
      ].join(" "),
    );
  }
}
