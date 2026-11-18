# Generates the PWA icons (ASCII-only script for Windows PowerShell 5.1)
# Design: dark tile, three "post" bars (digest) and a rising chart line.
param([string]$Out = (Split-Path -Parent $PSScriptRoot))
Add-Type -AssemblyName System.Drawing

function New-RoundRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-Icon([int]$size, [string]$path, [double]$scale) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
  $c1 = [System.Drawing.Color]::FromArgb(255, 30, 41, 59)
  $c2 = [System.Drawing.Color]::FromArgb(255, 11, 15, 20)
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $c1, $c2, 70.0
  $g.FillRectangle($bg, $rect)

  $s = $size * $scale
  $o = ($size - $s) / 2

  # three bars = posts in a digest
  $bars = @(
    @(0.18, 0.20, 0.64, [System.Drawing.Color]::FromArgb(255, 231, 233, 234)),
    @(0.18, 0.36, 0.50, [System.Drawing.Color]::FromArgb(255, 139, 152, 165)),
    @(0.18, 0.52, 0.38, [System.Drawing.Color]::FromArgb(255, 139, 152, 165))
  )
  foreach ($b in $bars) {
    $br = New-Object System.Drawing.SolidBrush $b[3]
    $rr = New-RoundRect ([single]($o + $s * $b[0])) ([single]($o + $s * $b[1])) ([single]($s * $b[2])) ([single]($s * 0.085)) ([single]($s * 0.04))
    $g.FillPath($br, $rr)
  }

  # rising chart line (green) with an orange spark at the top
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 60, 196, 143)), ([single]($s * 0.06))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $pts = @(
    (New-Object System.Drawing.PointF ([single]($o + $s * 0.18)), ([single]($o + $s * 0.84))),
    (New-Object System.Drawing.PointF ([single]($o + $s * 0.40)), ([single]($o + $s * 0.70))),
    (New-Object System.Drawing.PointF ([single]($o + $s * 0.56)), ([single]($o + $s * 0.77))),
    (New-Object System.Drawing.PointF ([single]($o + $s * 0.80)), ([single]($o + $s * 0.52)))
  )
  $g.DrawLines($pen, [System.Drawing.PointF[]]$pts)
  $spark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 240, 138, 76))
  $R = $s * 0.065
  $g.FillEllipse($spark, [single]($o + $s * 0.80 - $R), [single]($o + $s * 0.52 - $R), [single](2 * $R), [single](2 * $R))

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

New-Icon 192 (Join-Path $Out 'icon-192.png') 1.0
New-Icon 512 (Join-Path $Out 'icon-512.png') 1.0
New-Icon 512 (Join-Path $Out 'icon-maskable-512.png') 0.78
New-Icon 180 (Join-Path $Out 'apple-touch-icon.png') 0.92
Write-Output "icons written to $Out"
