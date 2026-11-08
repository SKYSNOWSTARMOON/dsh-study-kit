# 走一遍：从三个文件到一门课的 Word/PDF

下面是一次真实运行（2026-11-08，Windows 11 + DSH）。命令里的路径换成你自己的，其余不用改。

## 0. 装

```powershell
git clone https://github.com/SKYSNOWSTARMOON/dsh-study-kit.git C:\tools\dsh-study-kit
```

DSH 里：

```
plugin_manager install_bundle target=C:\tools\dsh-study-kit
```

装完让 DSH 重新加载一次（`set_plugin include:study-kit enabled=false` 再 `=true`），`study_*` 工具就出现了。

## 1. 看库里有什么

```
study_outline
```

空库会返回「资料库是空的」。资料库落在**会话工作目录**下的 `.study-kit/`，不是全局目录。

## 2. 入库

```
study_ingest path=C:\Users\me\Desktop\资料\基础生命科学
```

真实输出（26 份 docx + pdf，其中 13 对是同源副本）：

```
已入库 13 份（复用 0 份，跳过 13 份同源重复）
- 01-第1章-生物与生命科学.docx｜教材正文 0.85
- 01-第1章-生物与生命科学.pdf｜⇄ 与 01-第1章-生物与生命科学.docx 同源（重合 0.92），跳过入库
...
```

docx 和它的打印件 pdf 会判成同源，只入一份——不会出现两个章节列表。

## 3. 出成品（一章一对 Word/PDF）

```
study_course
  course    = 基础生命科学
  format    = both
  chapters  = [
    { no: 1, title: "生物与生命科学", markdown: "## 一、知识点\n..." },
    { no: 2, title: "生物的化学组成", markdown: "..." }
  ]
```

产物（`<会话工作目录>\基础生命科学\`）：

```
00-课程总览.docx / .pdf        ← 不给就自动生成目录页
01-第1章-生物与生命科学.docx / .pdf
02-第2章-生物的化学组成.docx / .pdf
.course-md\                    ← 每章 markdown 镜像，下次增补用
_index.md                      ← 章号/标题/字数/操作/时间
```

第 1 章那份 docx 约 12 KB、pdf 约 480 KB（12 章合计 pdf 约 8 MB）。

## 4. 补一章

同一门课再调一次，只传要补的那章：

```
study_course course=基础生命科学 format=both
  chapters=[{ no: 3, title: "细胞——生命的基本单位", markdown: "## 补充：线粒体内膜\n..." , part: "考研补充" }]
```

报告会写 `补充`，原文件尾部多一段 `## 考研补充 · 2026-11-08`，旧内容一字不动。完全重复的内容不会写第二遍（重合 ≥ 0.7 直接跳过）。

## 5. 顺手出 Anki 卡片

```
study_course course=线性代数 format=docx anki=true
  chapters=[{ no: 1, title: "行列式" }, ...]
```

只要章节里有「## 背诵清单」小节，就会生成 `线性代数\anki\01-第1章-行列式.txt`：

```
#separator:tab
#html:true
#tags column:3
#deck:线性代数::第1章
二阶行列式	\(D=ad-bc\)，即主对角线乘积减副对角线乘积。	
```

Anki → 文件 → 导入，选「制表符分隔」，勾「允许 HTML」。公式要在 Anki 偏好里开 MathJax 才渲染。

## 6. 扫描件怎么办

文本层为空会直接告诉你 `没抽到文字（pdf）`，两条路：

```powershell
# 整本 OCR（500 页约 18 分钟）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\ocr-pdf.ps1 -Pdf 教材.pdf -OutDir 教材OCR\教材

# 按章名切（比按「第N章」可靠：OCR 常把章号认错）
node scripts\ocr-chapters-auto.mjs 教材OCR\教材\pages 教材OCR\教材\chapters --tocTitles titles.txt --skipBefore 13
```

然后 `study_course` 把 chapters 目录里的 txt 逐章写成 markdown。OCR 的公式不可信，数值要回原书核对。
