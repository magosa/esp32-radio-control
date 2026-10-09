$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$output = Join-Path $PSScriptRoot '..\public\appearance'
[System.IO.Directory]::CreateDirectory($output) | Out-Null
$bitmap = New-Object System.Drawing.Bitmap(1800, 1200)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)
$fold = New-Object System.Drawing.Drawing2D.GraphicsPath
$fold.AddBezier(-180, 870, 330, 860, 360, 0, 1250, 120)
$fold.AddBezier(1250, 120, 1500, 145, 1600, 510, 1960, 310)
$fold.AddLine(1960, 310, 1960, 560)
$fold.AddBezier(1960, 560, 1500, 870, 1320, 370, 1030, 440)
$fold.AddBezier(1030, 440, 650, 420, 720, 1250, -180, 1200)
$fold.CloseFigure()
$fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.Point]::new(450, 950), [System.Drawing.Point]::new(1300, 150), [System.Drawing.Color]::FromArgb(12, 255, 255, 255), [System.Drawing.Color]::FromArgb(170, 255, 255, 255))
$graphics.FillPath($fill, $fold)
$fill.Dispose()
$fold.Dispose()
for ($index = 0; $index -lt 9; $index++) {
    $offset = $index * 26
    $curve = New-Object System.Drawing.Drawing2D.GraphicsPath
    $curve.AddBezier(-180, (890 + $offset), 330, (880 + $offset), 360, (20 + $offset), 1250, (140 + $offset))
    $curve.AddBezier(1250, (140 + $offset), 1500, (165 + $offset), 1600, (530 + $offset), 1960, (330 + $offset))
    $shade = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(3, 0, 0, 0), 18)
    $light = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb((150 - $index * 11), 255, 255, 255), 3)
    $graphics.DrawPath($shade, $curve)
    $graphics.DrawPath($light, $curve)
    $shade.Dispose()
    $light.Dispose()
    $curve.Dispose()
}
$graphics.Dispose()
$bitmap.Save((Join-Path $output 'glass-folds.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
$grain = New-Object System.Drawing.Bitmap(128, 128)
$random = New-Object System.Random(4125)
for ($row = 0; $row -lt 128; $row++) {
    for ($column = 0; $column -lt 128; $column++) {
        $channel = if ($random.Next(2) -eq 0) { 0 } else { 255 }
        $grain.SetPixel($column, $row, [System.Drawing.Color]::FromArgb($random.Next(0, 5), $channel, $channel, $channel))
    }
}
$grain.Save((Join-Path $output 'glass-grain.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$grain.Dispose()
Get-ChildItem $output -Filter 'glass-*.png' | Select-Object Name, Length