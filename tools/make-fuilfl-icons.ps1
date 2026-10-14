# fuilfl Warehouse icons: the fixed teal→blue tile with "fuilfl." in white, mirrored like every fuilfl. mark (teal left,
# blue right). Renders PNG frames at every size Windows uses; tools/make-ico.mjs then assembles proper PNG-in-ICO files
# (full alpha — the earlier Icon.FromHandle route gave a 1-bit mask, hence ragged corners). Writes assets/fuilfl/.
Add-Type -AssemblyName System.Drawing
$Out = Join-Path $PSScriptRoot '..\assets\fuilfl'
New-Item -ItemType Directory -Force $Out | Out-Null
$BLUE = [System.Drawing.ColorTranslator]::FromHtml('#2F7BFF')
$TEAL = [System.Drawing.ColorTranslator]::FromHtml('#00C4A7')

function Get-FittedFont([System.Drawing.Graphics]$g, [string]$text, [int]$maxW, [int]$start) {
    $fam = 'Inter Black'
    try { $t = New-Object System.Drawing.Font($fam, 20); $t.Dispose() } catch { $fam = 'Arial Black' }
    $fmt = [System.Drawing.StringFormat]::GenericTypographic
    for ($s = $start; $s -ge 5; $s -= 1) {
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
function Render([int]$size, [string]$word) {
    # Supersample ×4 then shrink: clean anti-aliased corners and lettering at every size.
    $S = $size * 4
    $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $S, $S)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $BLUE, $TEAL, 180.0)
    $g.FillPath($brush, (New-RoundedPath $S $S ([int]($S * 0.19))))
    $pad = [int]($S * 0.08)
    $font = Get-FittedFont $g $word ($S - 2 * $pad) ([int]($S * 0.55))
    $fmt = [System.Drawing.StringFormat]::GenericTypographic
    $m = $g.MeasureString($word, $font, 100000, $fmt)
    $g.DrawString($word, $font, [System.Drawing.Brushes]::White, ($S - $m.Width) / 2, ($S - $m.Height) / 2 - $S * 0.02, $fmt)
    $font.Dispose(); $brush.Dispose(); $g.Dispose()
    $small = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.InterpolationMode = 'HighQualityBicubic'; $g2.SmoothingMode = 'AntiAlias'; $g2.PixelOffsetMode = 'HighQuality'; $g2.CompositingQuality = 'HighQuality'
    $g2.DrawImage($bmp, 0, 0, $size, $size); $g2.Dispose(); $bmp.Dispose()
    return $small
}
# App icon frames — the word "fuilfl." at every size (founder: the word, always).
foreach ($sz in 256, 128, 64) { $b = Render $sz 'fuilfl.'; $b.Save((Join-Path $Out "app-$sz.png"), [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose() }
foreach ($sz in 48, 32, 24, 16) { $b = Render $sz 'fuilfl.'; $b.Save((Join-Path $Out "app-$sz.png"), [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose() }
# The files electron-builder and the app use
Copy-Item (Join-Path $Out 'app-256.png') (Join-Path $Out 'icon-256.png') -Force
$big = Render 512 'fuilfl.'; $big.Save((Join-Path $Out 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png); $big.Dispose()
$t = Render 32 'fuilfl.'; $t.Save((Join-Path $Out 'tray.png'), [System.Drawing.Imaging.ImageFormat]::Png); $t.Dispose()
Write-Output 'frames written'
