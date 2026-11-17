# Test helper: tile every image of a folder into one contact sheet with captions.
# Usage: powershell -File tools\sheet.ps1 -Dir <folder> -Out <png> [-Cols 5] [-Cell 256] [-Filter *.png]
param([string]$Dir, [string]$Out, [int]$Cols = 5, [int]$Cell = 256, [string]$Filter = '*.png')
Add-Type -AssemblyName System.Drawing
$files = Get-ChildItem -LiteralPath $Dir -Filter $Filter | Sort-Object Name
if (-not $files) { 'no images'; exit 1 }
$cap = 18
$rows = [Math]::Ceiling($files.Count / $Cols)
$bmp = New-Object System.Drawing.Bitmap ($Cols * $Cell), ($rows * ($Cell + $cap))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(40, 40, 40))
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$font = New-Object System.Drawing.Font 'Consolas', 9
$bgA = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(96, 110, 96))
$bgB = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(72, 84, 72))
$i = 0
foreach ($f in $files) {
  $x = ($i % $Cols) * $Cell
  $y = [Math]::Floor($i / $Cols) * ($Cell + $cap)
  # checker background so that transparent areas and both light and dark strokes stay visible
  for ($cy = 0; $cy -lt $Cell; $cy += 32) { for ($cx = 0; $cx -lt $Cell; $cx += 32) {
    $b = if ((($cx + $cy) / 32) % 2 -eq 0) { $bgA } else { $bgB }
    $g.FillRectangle($b, $x + $cx, $y + $cap + $cy, 32, 32)
  } }
  try {
    $img = [System.Drawing.Image]::FromFile($f.FullName)
    $g.DrawImage($img, $x, $y + $cap, $Cell, $Cell)
    $label = '{0} {1}px' -f $f.BaseName, $img.Width
    $img.Dispose()
  } catch { $label = $f.BaseName + ' (unreadable)' }
  $g.DrawString($label, $font, [System.Drawing.Brushes]::White, $x + 2, $y + 2)
  $i++
}
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
'{0} images -> {1}' -f $files.Count, $Out
