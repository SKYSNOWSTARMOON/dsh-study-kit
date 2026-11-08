# 用 Windows 自带能力做「扫描 PDF → 文字」：Windows.Data.Pdf 渲染 + Windows.Media.Ocr 识别。
# 完全离线、不用装任何东西（依赖系统里的中文 OCR 语言包 zh-Hans-CN）。
#
# 用法：
#   pwsh -File scripts/ocr-pdf.ps1 -Pdf "D:\书.pdf" -OutDir "D:\out" -From 14 -To 30
#   pwsh -File scripts/ocr-pdf.ps1 -Pdf "..." -OutDir "..." -Chapters chapters.json
#
# 输出：
#   <OutDir>\pages\p0001.txt      每页纯文本（已按版面重排阅读顺序、去中文间空格）
#   <OutDir>\pages.json           每页字数，用来发现空白页/纯图页
#   -Chapters 时另出 <OutDir>\<章名>.txt
param(
  [Parameter(Mandatory = $true)][string]$Pdf,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$From = 1,
  [int]$To = 0,
  [int]$Width = 1700,
  [string]$Chapters = "",
  [switch]$KeepPng
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Data.Pdf.PdfDocument, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

$asTaskGen = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
$asTaskAct = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
  })[0]

function Await($op, $type, $tag) {
  $m = $asTaskGen.MakeGenericMethod($type)
  $task = $m.Invoke($null, @($op))
  try { $task.Wait(-1) | Out-Null } catch { throw "$tag : $($_.Exception.InnerException.InnerException.Message)" }
  return $task.Result
}
function AwaitAction($op, $tag) {
  $task = $asTaskAct.Invoke($null, @($op))
  try { $task.Wait(-1) | Out-Null } catch { throw "$tag : $($_.Exception.InnerException.InnerException.Message)" }
}

# ---------- 版面重排：递归 XY-cut ----------
function Get-OrderedText($lines) {
  # lines: array of [pscustomobject]{ text, x, y, w, h }
  if ($null -eq $lines -or $lines.Count -eq 0) { return "" }
  $items = @($lines)
  if ($items.Count -eq 1) { return $items[0].text }

  $minX = ($items | Measure-Object -Property x -Minimum).Minimum
  $maxX = ($items | ForEach-Object { $_.x + $_.w } | Measure-Object -Maximum).Maximum
  $minY = ($items | Measure-Object -Property y -Minimum).Minimum
  $maxY = ($items | ForEach-Object { $_.y + $_.h } | Measure-Object -Maximum).Maximum
  $regionW = [Math]::Max(1, $maxX - $minX)
  $regionH = [Math]::Max(1, $maxY - $minY)
  $medH = ($items | Measure-Object -Property h -Average).Average

  # 纵向（列）候选：按 x 排序，找相邻行之间没有重叠的缝隙
  $byX = $items | Sort-Object x
  $bestVGap = 0.0; $bestVAt = $null
  $running = $null
  foreach ($it in $byX) {
    if ($null -ne $running) {
      $gap = $it.x - $running
      if ($gap -gt $bestVGap) { $bestVGap = $gap; $bestVAt = $running + $gap / 2 }
    }
    $right = $it.x + $it.w
    if ($null -eq $running -or $right -gt $running) { $running = $right }
  }

  # 横向（行）候选：按 y 排序，找相邻行之间的缝隙（需大于半个行高才算分段）
  $byY = $items | Sort-Object y
  $bestHGap = 0.0; $bestHAt = $null
  $runningBottom = $null
  foreach ($it in $byY) {
    if ($null -ne $runningBottom) {
      $gap = $it.y - $runningBottom
      if ($gap -gt $bestHGap) { $bestHGap = $gap; $bestHAt = $runningBottom + $gap / 2 }
    }
    $bottom = $it.y + $it.h
    if ($null -eq $runningBottom -or $bottom -gt $runningBottom) { $runningBottom = $bottom }
  }

  $vRatio = if ($regionW -gt 0) { $bestVGap / $regionW } else { 0 }
  $hRatio = if ($regionH -gt 0) { $bestHGap / $regionH } else { 0 }

  # 列缝要足够宽（≥3% 页宽）才切列；行缝要 ≥0.6 行高才切段
  $vOk = ($null -ne $bestVAt) -and ($vRatio -ge 0.03) -and ($bestVGap -gt 8)
  $hOk = ($null -ne $bestHAt) -and ($bestHGap -gt 0.6 * $medH)

  if ($vOk -and ((-not $hOk) -or ($vRatio -ge $hRatio * 0.6))) {
    $left = @($items | Where-Object { ($_.x + $_.w / 2) -lt $bestVAt } | Sort-Object y)
    $right = @($items | Where-Object { ($_.x + $_.w / 2) -ge $bestVAt } | Sort-Object y)
    if ($left.Count -gt 0 -and $right.Count -gt 0) {
      return ((Get-OrderedText $left) + "`n" + (Get-OrderedText $right))
    }
  }
  if ($hOk) {
    $top = @($items | Where-Object { ($_.y + $_.h / 2) -lt $bestHAt } | Sort-Object y)
    $bottom = @($items | Where-Object { ($_.y + $_.h / 2) -ge $bestHAt } | Sort-Object y)
    if ($top.Count -gt 0 -and $bottom.Count -gt 0) {
      return ((Get-OrderedText $top) + "`n" + (Get-OrderedText $bottom))
    }
  }
  # 兜底：按 y 再按 x
  return (($items | Sort-Object y, x | ForEach-Object { $_.text }) -join "`n")
}

function Remove-CjkSpaces([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return $text }
  $cjk = '\p{IsCJKUnifiedIdeographs}'
  $t = [regex]::Replace($text, "(?<=$cjk)[ \t]+(?=$cjk)", '')
  $t = [regex]::Replace($t, "(?<=$cjk)[ \t]+(?=[，。、；：？！（）《》“”‘’…—·])", '')
  $t = [regex]::Replace($t, "(?<=[，。、；：？！（）《》“”‘’…—·])[ \t]+(?=$cjk)", '')
  $t = [regex]::Replace($t, '[ \t]+$', '')
  return $t
}

# ---------- 主流程 ----------
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw "系统没有可用的 OCR 引擎（缺中文语言包）" }
$langs = ([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join ','

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$pagesDir = Join-Path $OutDir 'pages'
New-Item -ItemType Directory -Force -Path $pagesDir | Out-Null
if ($KeepPng) {
  $pngDir = Join-Path $OutDir 'png'
  New-Item -ItemType Directory -Force -Path $pngDir | Out-Null
}

$fs = [System.IO.File]::Open($Pdf, 'Open', 'Read', 'ReadWrite')
try {
  $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($fs)
  $doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromStreamAsync($ras)) ([Windows.Data.Pdf.PdfDocument]) 'LoadPdf'
  $total = [int]$doc.PageCount
  $from = [Math]::Max(1, $From)
  $to = if ($To -gt 0) { [Math]::Min($total, $To) } else { $total }

  Write-Host ("PDF 共 {0} 页；OCR 语言 {1}；处理 {2}-{3}" -f $total, $langs, $from, $to)

  $meta = @()
  $texts = @{}
  $sw = [System.Diagnostics.Stopwatch]::StartNew()

  for ($p = $from; $p -le $to; $p++) {
    $page = $doc.GetPage($p - 1)
    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = [uint32]$Width
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    AwaitAction ($page.RenderToStreamAsync($stream, $opts)) "Render$p"

    $size = [int]$stream.Size
    if ($KeepPng) {
      $bytes = New-Object byte[] $size
      $stream.Seek(0)
      $dr = New-Object Windows.Storage.Streams.DataReader($stream)
      Await ($dr.LoadAsync([uint32]$size)) ([uint32]) 'ReadBytes' | Out-Null
      $dr.ReadBytes($bytes)
      [System.IO.File]::WriteAllBytes((Join-Path $pngDir ("p{0:d4}.png" -f $p)), $bytes)
      $stream.Seek(0)
    }

    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]) "Decode$p"
    $bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap]) "Bmp$p"
    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult]) "Ocr$p"
    $page.Dispose()

    $boxes = @()
    foreach ($line in $res.Lines) {
      $words = @($line.Words)
      if ($words.Count -eq 0) { continue }
      $x0 = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
      $y0 = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
      $x1 = ($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
      $y1 = ($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
      $boxes += [pscustomobject]@{ text = $line.Text; x = [double]$x0; y = [double]$y0; w = [double]($x1 - $x0); h = [double]($y1 - $y0) }
    }

    $text = Remove-CjkSpaces (Get-OrderedText $boxes)
    $texts[$p] = $text
    $path = Join-Path $pagesDir ("p{0:d4}.txt" -f $p)
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))

    $chars = if ($null -eq $text) { 0 } else { $text.Length }
    $meta += [pscustomobject]@{ page = $p; chars = $chars; lines = @($res.Lines).Count }
    if (($p - $from) % 10 -eq 0) {
      $per = $sw.Elapsed.TotalSeconds / [Math]::Max(1, ($p - $from + 1))
      Write-Host ("  p{0} {1}字  平均 {2:N2}s/页  预计剩余 {3:N0} 分钟" -f $p, $chars, $per, (($to - $p) * $per / 60))
    }
  }

  $meta | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $OutDir 'pages.json') -Encoding UTF8

  if ($Chapters -ne "" -and (Test-Path $Chapters)) {
    $spec = Get-Content $Chapters -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($ch in $spec) {
      $body = @()
      foreach ($p in $ch.from..$ch.to) {
        if ($texts.ContainsKey($p)) { $body += $texts[$p].TrimEnd() }
      }
      $content = ($ch.title + "`n`n" + ($body -join "`n`n"))
      $file = Join-Path $OutDir ($ch.file)
      [System.IO.File]::WriteAllText($file, $content, (New-Object System.Text.UTF8Encoding $false))
      Write-Host ("  写出 " + $ch.file + "  " + $content.Length + " 字")
    }
  }

  Write-Host ("完成：{0} 页，耗时 {1:N1} 分钟" -f ($to - $from + 1), ($sw.Elapsed.TotalMinutes))
}
finally {
  if ($fs) { $fs.Dispose() }
}
