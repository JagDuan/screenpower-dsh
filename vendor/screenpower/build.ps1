# build.ps1 —— 编译 ScreenPower.exe
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File .\build.ps1
#
# 需要 .NET Framework 4.x 的 csc.exe（Windows 自带）。

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $dir "ScreenPower.cs"
$out = Join-Path $dir "ScreenPower.exe"

if (-not (Test-Path $src)) {
    Write-Host "未找到 ScreenPower.cs" -ForegroundColor Red
    exit 1
}

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) {
    Write-Host "未找到 csc.exe，需要 .NET Framework 4.x" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# 关键: 源码含中文, 必须以 UTF-8 with BOM 保存, 否则 csc 会按系统 ANSI 代码页(GBK)
# 解析, 导致所有中文字符串字面量乱码(表现为界面文字变成 "???" 或乱码)。
# 这里只在缺少 BOM 时补上, 且不做任何内容改写, 避免损坏源文件。
# ---------------------------------------------------------------------------
$bytes = [System.IO.File]::ReadAllBytes($src)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
if (-not $hasBom) {
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    [System.IO.File]::WriteAllText($src, $text, (New-Object System.Text.UTF8Encoding($true)))
    Write-Host "==> 已为源码补上 UTF-8 BOM (必需, 否则中文会乱码)"
} else {
    Write-Host "==> 源码已是 UTF-8 with BOM, 无需修改"
}

& $csc /nologo /target:winexe /platform:anycpu /optimize+ /out:$out `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Management.dll $src

if ($LASTEXITCODE -ne 0) {
    Write-Host "编译失败 (exit=$LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
}

$fi = Get-Item $out
Write-Host "==> 编译成功: $($fi.FullName) ($($fi.Length) bytes)" -ForegroundColor Green
