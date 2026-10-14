# fuilfl Warehouse icons: the fixed teal→blue tile with "fuilfl." in white (the same mark as the fuilfl. Staff app),
# mirrored like every fuilfl. mark (teal left, blue right). Writes assets/fuilfl/{icon.png,icon-256.png,icon.ico,tray.ico}.
Add-Type -AssemblyName System.Drawing
$Out = Join-Path $PSScriptRoot '..\assets\fuilfl'
New-Item -ItemType Directory -Force $Out | Out-Null
$BLUE = [System.Drawing.ColorTranslator]::FromHtml('#2F7BFF')
$TEAL = [System.Drawing.ColorTranslator]::FromHtml('#00C4A7')

function Get-FittedFont([System.Drawing.Graphics]$g, [string]$text, [int]$maxW, [int]$start) {
    $fam = 'Inter Black'
    try { $t = New-Object System.Drawing.Font($fam, 20); $t.Dispose() } catch { $fam = 'Arial Black' }
    $fmt = [System.Drawing.StringFormat]::GenericTypographic
    for ($s = $start; $s -ge 6; $s -= 1) {
        $f = New-Object System.Drawing.Font($fam, $s, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $m = $g.MeasureString($text, $f, 100000, $fmt)
        if ($m.Width -le $maxW) { return $f }
        $f.Dispose()
    }
}
function New-RoundedPath([int]$w, [int]$h, [int]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath; $d = $r * 2
    $p.AddArc(0, 0, $d, $d, 180, 90); $p.AddArc($w - $d, 0, $d, $d, 270, 90); $p.AddArc($w - $d, $h - $d, $d, $d, 0, 90); $p.AddArc(0, $h - $d, $d, $d, 90, 90); $p.CloseFigure(); return $p
}
function Render([int]$size, [string]$word, [int]$pad, [int]$radius) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $BLUE, $TEAL, 180.0)
    $path = New-RoundedPath $size $size $radius
    $g.FillPath($brush, $path)
    $font = Get-FittedFont $g $word ($size - 2 * $pad) ([int]($size * 0.5))
    $fmt = [System.Drawing.StringFormat]::GenericTypographic
    $m = $g.MeasureString($word, $font, 100000, $fmt)
    $g.DrawString($word, $font, [System.Drawing.Brushes]::White, ($size - $m.Width) / 2, ($size - $m.Height) / 2 - $size * 0.02, $fmt)
    $font.Dispose(); $brush.Dispose(); $g.Dispose()
    return $bmp
}
# App icon (Windows shows its own rounding on the taskbar; a gentle radius keeps it from looking like a flat square)
$big = Render 512 'fuilfl.' 48 96;  $big.Save((Join-Path $Out 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$mid = Render 256 'fuilfl.' 24 48;  $mid.Save((Join-Path $Out 'icon-256.png'), [System.Drawing.Imaging.ImageFormat]::Png)
# .ico files: a 256 px frame for the installer/app, a 32 px "f." for the tray
$ico = [System.Drawing.Icon]::FromHandle($mid.GetHicon()); $fs = [System.IO.File]::Create((Join-Path $Out 'icon.ico')); $ico.Save($fs); $fs.Close()
$tray = Render 32 'f.' 3 7; $tico = [System.Drawing.Icon]::FromHandle($tray.GetHicon()); $fs2 = [System.IO.File]::Create((Join-Path $Out 'tray.ico')); $tico.Save($fs2); $fs2.Close()
$tray.Save((Join-Path $Out 'tray.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("wrote icons to {0}" -f $Out)
