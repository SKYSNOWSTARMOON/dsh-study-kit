# 安全说明

## 这个插件会碰什么

| 行为 | 范围 |
|---|---|
| 读文件 | 只读你明确传入的路径（`study_ingest` 的 `path`、`docs`），以及 `<工作目录>/.study-kit/` 下的资料库 |
| 写文件 | 只写 `<工作目录>/.study-kit/`、`<工作目录>/<课程名>/`、`<工作目录>/资料导出/`、`.tmp/` |
| 联网 | **不联网**。没有 HTTP 客户端，不调用任何云服务 |
| 子进程 | 只在三种情况启动：PDF 打印（本机 Edge/Chrome）、PDF 转换（DSH 自带 LibreOffice Kit）、Word COM（本机 Word）。都是本地程序，且输出路径限定在上面几处 |
| 执行用户内容 | 不执行。资料里的文本只作为数据解析，不会被 `eval` 或拼进 shell 命令 |

## 已知风险面

- **OCR 脚本用 PowerShell 加载 WinRT**（`ocr-pdf.ps1` / `ocr-image.ps1`），处理的是你自己指定的 PDF/图片；如果文件本身畸形，可能让渲染器崩溃，但不会执行文件里的内容。
- **Word COM 兜底**会启动本机 Word 进程转换 docx。转换失败时可能残留 `WINWORD.EXE`，需要手动结束（README 有说明）。
- **`study_pack` / `study_course` 会覆盖同名文件**（增补模式下写 `## 补充` 段，不覆盖旧正文；`rerender` 会重写 Word/PDF）。请勿把 `outDir` 指向含手写文件的目录。

## 报告漏洞

请不要开公开 issue。用 GitHub 的 [Private vulnerability reporting](https://github.com/SKYSNOWSTARMOON/dsh-study-kit/security/advisories/new) 提交，或直接联系仓库所有者。

请说明：影响范围（读/写/执行哪类文件）、复现所需的最小资料、你的环境。
