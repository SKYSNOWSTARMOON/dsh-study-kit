"""生成自测用的样例资料：教材 docx、真题 docx、课件 pptx。
只用于验证解析链路，内容为合成的船舶稳性主题，不是真实教材。
"""
import os
from docx import Document
from docx.shared import Pt
from pptx import Presentation
from pptx.util import Inches

import sys

# 输出目录：命令行第 1 个参数 > 环境变量 STUDY_FIXTURES > <本插件目录>/../.tmp/study-fixtures
# （不要写死绝对路径：插件被移动/安装到 profile 的 node_modules 后，原路径就不存在了）
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = (
    sys.argv[1]
    if len(sys.argv) > 1
    else os.environ.get("STUDY_FIXTURES")
    or os.path.normpath(os.path.join(HERE, "..", "..", ".tmp", "study-fixtures"))
)
os.makedirs(OUT, exist_ok=True)

# ---------------- 教材 ----------------
doc = Document()
doc.add_heading("船舶原理", level=1)
doc.add_paragraph("本讲义依据《船舶原理》整理，仅供内部复习使用。")
doc.add_paragraph("版权所有，翻印必究")
doc.add_page_break()

doc.add_heading("第一章 船舶稳性", level=1)
doc.add_paragraph("船舶稳性是指船舶受外力作用离开平衡位置而倾斜，当外力消除后能自行恢复到原平衡位置的能力。")
doc.add_paragraph("稳性按倾斜方向分为横稳性与纵稳性，按倾斜角度分为初稳性与大倾角稳性。")
doc.add_heading("第一节 初稳性", level=2)
doc.add_paragraph("初稳性是指倾斜角不超过 10°~15° 时的稳性。初稳性高度 GM 的计算公式为：")
doc.add_paragraph("GM = KM - KG")
doc.add_paragraph("其中 KM 为横稳心距基线高度，KG 为重心距基线高度。GM > 0 时船舶具有初稳性。")
doc.add_paragraph("表1 稳性分类对照")
table = doc.add_table(rows=3, cols=3)
data = [["分类维度", "类型", "判据"],
        ["倾斜方向", "横稳性", "横向倾斜"],
        ["倾斜角度", "初稳性", "倾角 ≤ 10°~15°"]]
for r, row in enumerate(data):
    for c, val in enumerate(row):
        table.cell(r, c).text = val

doc.add_heading("第二章 浮性与吃水", level=1)
doc.add_paragraph("浮性是指船舶在一定装载情况下浮于水面并保持平衡的能力。")
doc.add_paragraph("排水量 Δ 与吃水 d 的关系由静水力曲线给出，二者并非线性关系。")
doc.add_page_break()

doc.save(os.path.join(OUT, "船舶原理讲义.docx"))

# ---------------- 真题 ----------------
exam = Document()
exam.add_heading("2024 年船舶原理期末考试试卷（A 卷）", level=1)
exam.add_paragraph("考试时间 120 分钟，满分 100 分。")
exam.add_paragraph("得分：______  评卷人：______")

exam.add_paragraph("一、选择题（每题 2 分，共 10 分）")
for i, q in enumerate([
    "下列哪项属于初稳性的判据？（ ）A. GM>0  B. GM<0  C. KG=0  D. KM=0",
    "船舶横稳性的倾斜方向是（ ）。A. 横向  B. 纵向  C. 垂向  D. 任意方向",
    "静水力曲线反映的对应关系是（ ）。A. 排水量与吃水  B. 吃水与航速  C. 航速与功率  D. 功率与排水量",
    "船舶复原力矩的大小与下列哪个量直接相关？（ ）A. 初稳性高度  B. 船长  C. 船速  D. 螺旋桨转速",
    "初稳性适用的最大倾斜角约为（ ）。A. 10°~15°  B. 30°  C. 45°  D. 60°",
], 1):
    exam.add_paragraph(f"{i}. {q}")

exam.add_paragraph("二、名词解释（每题 5 分，共 10 分）")
exam.add_paragraph("1. 船舶稳性：")
exam.add_paragraph("2. 初稳性高度：")

exam.add_paragraph("三、简答题（每题 10 分，共 30 分）")
exam.add_paragraph("1. 简述初稳性高度 GM 的物理意义，并说明 GM 过小与过大各自的风险。")
exam.add_paragraph("2. 说明船舶稳性与浮性的区别与联系。")
exam.add_paragraph("3. 简述提高船舶大倾角稳性的常用措施。")

exam.add_paragraph("四、计算题（共 50 分）")
exam.add_paragraph("1. 已知某船 KM=7.2 m，KG=6.5 m，求初稳性高度 GM，并判断该船是否具有初稳性。（25 分）")
exam.add_paragraph("2. 某船排水量 12000 t，重心高度提高 0.3 m，其余条件不变，求 GM 的变化量并说明对稳性的影响。（25 分）")
exam.save(os.path.join(OUT, "2024真题.docx"))

# ---------------- 课件 ----------------
prs = Presentation()
s1 = prs.slides.add_slide(prs.slide_layouts[1])
s1.shapes.title.text = "船舶稳性概述"
s1.placeholders[1].text = "• 稳性的定义\n• 横稳性与纵稳性\n• 初稳性与大倾角稳性"
s2 = prs.slides.add_slide(prs.slide_layouts[1])
s2.shapes.title.text = "初稳性高度 GM"
s2.placeholders[1].text = "• GM = KM - KG\n• GM>0 才有初稳性\n• GM 过大横摇剧烈"
prs.save(os.path.join(OUT, "稳性课件.pptx"))

print("ok", os.listdir(OUT))
