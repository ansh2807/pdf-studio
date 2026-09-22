<#
  office-convert.ps1 - convert an Office document to PDF using installed
  Microsoft Office apps via COM automation (highest fidelity available).

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File office-convert.ps1 `
        -Input "C:\path\in.docx" -Output "C:\path\out.pdf"

  Emits a single JSON line to stdout describing the result.
#>
param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"
$ext = [System.IO.Path]::GetExtension($InputPath).ToLowerInvariant()

function Emit($obj) {
  Write-Output ($obj | ConvertTo-Json -Compress)
}

# wdFormatPDF = 17, xlTypePDF = 0, ppSaveAsPDF = 32
try {
  switch -Regex ($ext) {
    '\.(docx?|rtf|odt|txt)$' {
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false
      $app.DisplayAlerts = 0
      try {
        $doc = $app.Documents.Open($InputPath, $false, $true)  # ReadOnly
        $doc.SaveAs([ref]$OutputPath, [ref]17)
        $doc.Close($false)
        Emit @{ ok = $true; app = "Word" }
      } finally {
        $app.Quit()
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
      }
      break
    }
    '\.(xlsx?|xlsm|csv|ods)$' {
      $app = New-Object -ComObject Excel.Application
      $app.Visible = $false
      $app.DisplayAlerts = $false
      try {
        $wb = $app.Workbooks.Open($InputPath, 0, $true)  # ReadOnly
        $wb.ExportAsFixedFormat(0, $OutputPath)  # xlTypePDF
        $wb.Close($false)
        Emit @{ ok = $true; app = "Excel" }
      } finally {
        $app.Quit()
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
      }
      break
    }
    '\.(pptx?|ppsx?|odp)$' {
      $app = New-Object -ComObject PowerPoint.Application
      try {
        $pres = $app.Presentations.Open($InputPath, $true, $false, $false)  # ReadOnly, Untitled, WithWindow=false
        $pres.SaveAs($OutputPath, 32)  # ppSaveAsPDF
        $pres.Close()
        Emit @{ ok = $true; app = "PowerPoint" }
      } finally {
        $app.Quit()
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
      }
      break
    }
    default {
      Emit @{ ok = $false; error = "Unsupported Office type: $ext" }
      exit 1
    }
  }
} catch {
  Emit @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
