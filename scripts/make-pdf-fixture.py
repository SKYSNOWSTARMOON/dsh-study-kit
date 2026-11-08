"""手搓一份带文本层的 PDF（ASCII，Helvetica），用于验证 PDF 文本抽取链路。
不依赖 reportlab；中文需要内嵌字体，这里只验 ASCII 的 Tj/TJ、换行与多页。
"""
import os
import sys
import zlib

# 输出目录：命令行第 1 个参数 > 环境变量 STUDY_FIXTURES > <本插件目录>/../.tmp/study-fixtures
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = (
    sys.argv[1]
    if len(sys.argv) > 1
    else os.environ.get("STUDY_FIXTURES")
    or os.path.normpath(os.path.join(HERE, "..", "..", ".tmp", "study-fixtures"))
)

pages = [
    ["Chapter 1  Ship Stability", "GM = KM - KG", "Initial stability applies up to 10-15 degrees.", "Table 1  Stability classification"],
    ["Chapter 2  Buoyancy and Draught", "Displacement is not linear with draught.", "See the hydrostatic curves for details."],
]

def content_stream(lines):
    ops = ["BT", "/F1 12 Tf", "72 720 Td", "14 TL"]
    for i, line in enumerate(lines):
        if i:
            ops.append("T*")
        escaped = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        ops.append(f"({escaped}) Tj")
    ops.append("ET")
    return ("\n".join(ops)).encode("latin-1")

objects = {}
objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
kids = " ".join(f"{3 + i * 2} 0 R" for i in range(len(pages)))
objects[2] = f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode()
for i, lines in enumerate(pages):
    page_no = 3 + i * 2
    content_no = page_no + 1
    objects[page_no] = (
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        f"/Resources << /Font << /F1 9 0 R >> >> /Contents {content_no} 0 R >>"
    ).encode()
    raw = content_stream(lines)
    comp = zlib.compress(raw)
    objects[content_no] = b"<< /Length " + str(len(comp)).encode() + b" /Filter /FlateDecode >>\nstream\n" + comp + b"\nendstream"
objects[9] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"

out = bytearray(b"%PDF-1.4\n")
offsets = {}
for num in sorted(objects):
    offsets[num] = len(out)
    out += f"{num} 0 obj\n".encode() + objects[num] + b"\nendobj\n"
xref_at = len(out)
count = max(objects) + 1
out += f"xref\n0 {count}\n".encode()
out += b"0000000000 65535 f \n"
for num in range(1, count):
    if num in offsets:
        out += f"{offsets[num]:010d} 00000 n \n".encode()
    else:
        out += b"0000000000 65535 f \n"
out += f"trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n".encode()

os.makedirs(OUT, exist_ok=True)
path = os.path.join(OUT, "stability-notes.pdf")
with open(path, "wb") as f:
    f.write(bytes(out))
print("ok", path, len(out))
