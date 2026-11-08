param([string]$Docx,[string]$Pdf,[string]$LogPath,[int]$Mode = 0)
$ErrorActionPreference = "Stop"
function Log([string]$m) { [System.IO.File]::AppendAllText($LogPath, $m + "`r`n", [System.Text.Encoding]::UTF8) }
try {
  Log ("start mode=" + $Mode)
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  Log "word-ready"
  if ($Mode -eq 0) {
    $doc = $word.Documents.Open($Docx, $false, $true)
  } elseif ($Mode -eq 1) {
    $doc = $word.Documents.OpenNoRepairDialog($Docx, $false, $true, $false)
  } elseif ($Mode -eq 2) {
    $doc = $word.Documents.Open($Docx, $false, $false, $false, "", "", $false, "", "", 0, 65001, $true, $true, $false)
  } else {
    $word.Visible = $true
    $doc = $word.Documents.Open($Docx)
  }
  Log "opened"
  $doc.SaveAs2($Pdf, 17)
  Log "saved"
  $doc.Close(0)
  $word.Quit()
  Log "done"
} catch {
  Log ("ERR " + $_.Exception.Message)
}
