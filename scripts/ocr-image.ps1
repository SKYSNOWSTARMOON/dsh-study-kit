# OCR for plain images (screenshots / photos of pages / slides) using the Windows built-in
# engine: Windows.Media.Ocr. Offline, no extra install, uses the zh-Hans-CN language pack.
#
# MUST run under powershell.exe (5.1). pwsh 7 cannot load System.Runtime.WindowsRuntime.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\ocr-image.ps1 `
#     -Image "D:\shot1.png","D:\shot2.jpg" -OutDir "D:\out"
#
# Output:
#   <OutDir>\<basename>.txt   plain text, reading order, CJK spaces removed
#   stdout                    each file's text, separated by "=== <file> ==="
param(
  [Parameter(Mandatory = $true)][string[]]$Image,
  [string]$OutDir = "",
  [string]$Language = "zh-Hans-CN"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime] | Out-Null

$asTaskGen = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, $type, $tag) {
  $m = $asTaskGen.MakeGenericMethod($type)
  $task = $m.Invoke($null, @($op))
  try { $task.Wait(-1) | Out-Null } catch { throw "$tag : $($_.Exception.InnerException.InnerException.Message)" }
  return $task.Result
}

$engine = $null
try {
  $lang = New-Object Windows.Globalization.Language $Language
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
} catch { $engine = $null }
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) { throw "no OCR engine available; install the Windows language pack for $Language" }

# CJK text must not keep the per-character spaces the OCR engine emits.
function Remove-CJKSpaces([string]$s) {
  $prev = $null
  while ($prev -ne $s) {
    $prev = $s
    $s = [regex]::Replace($s, '(?<=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])\s+(?=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])', '')
  }
  return $s
}

function Invoke-ImageOcr([string]$path) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile]) "open file"
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream]) "open stream"
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]) "decode"
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap]) "bitmap"
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult]) "ocr"

  $lines = @()
  foreach ($line in $result.Lines) {
    $x = 0.0; $y = 0.0
    $words = @($line.Words)
    if ($words.Count -gt 0) { $x = [double]$words[0].BoundingRect.X; $y = [double]$words[0].BoundingRect.Y }
    # Precompute the row bucket here: a Sort-Object script block over WinRT collections is flaky.
    $row = [int][Math]::Round($y / 12.0)
    $lines += [pscustomobject]@{ text = [string]$line.Text; x = $x; y = $y; row = $row }
  }
  # Reading order: top to bottom, then left to right (12px bucket keeps one visual line together).
  $ordered = $lines | Sort-Object -Property row, x
  $text = ($ordered | ForEach-Object { $_.text }) -join "`r`n"
  return (Remove-CJKSpaces $text)
}

$outRoot = $OutDir
if ($outRoot -ne "" -and -not (Test-Path $outRoot)) { New-Item -ItemType Directory -Path $outRoot -Force | Out-Null }

foreach ($p in $Image) {
  $full = (Resolve-Path -LiteralPath $p).Path
  $text = Invoke-ImageOcr $full
  $name = [System.IO.Path]::GetFileNameWithoutExtension($full)
  if ($outRoot -ne "") {
    $target = Join-Path $outRoot ($name + ".txt")
    [System.IO.File]::WriteAllText($target, $text, [System.Text.Encoding]::UTF8)
  }
  Write-Output "=== $full ==="
  Write-Output $text
}
