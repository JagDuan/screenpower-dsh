# ScreenPower 一键黑屏 / 定时亮屏 —— 卸载脚本
#
# 用法（以管理员身份运行）:
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#
# 可选参数:
#   -InstallDir <path>   安装目录（默认 C:\ProgramData\ScreenPower）
#   -KeepFiles           保留安装目录与日志文件（默认删除）

[CmdletBinding()]
param(
    [string]$InstallDir = "$env:ProgramData\ScreenPower",
    [switch]$KeepFiles
)

$ErrorActionPreference = "Continue"

function Write-Step { param([string]$m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "    [OK] $m" -ForegroundColor Green }
function Write-Warn2{ param([string]$m) Write-Host "    [!]  $m" -ForegroundColor Yellow }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "需要管理员权限。请以管理员身份运行 PowerShell。" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- 1) 停止守护进程
Write-Step "停止正在运行的守护进程"
try {
    Get-Process ScreenPower -ErrorAction SilentlyContinue | ForEach-Object {
        try { $_.Kill(); Write-Ok "已结束进程 pid=$($_.Id)" } catch { Write-Warn2 "结束 pid=$($_.Id) 失败" }
    }
} catch { }

# ---------------------------------------------------------------- 2) 删除计划任务
Write-Step "删除计划任务"
foreach ($name in @("ScreenPower-Guard", "ScreenPower-Night", "ScreenPower-Morning")) {
    try {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
            Write-Ok "已删除任务 $name"
        } else {
            Write-Ok "任务 $name 不存在，跳过"
        }
    } catch { Write-Warn2 "删除任务 $name 失败: $($_.Exception.Message)" }
}

# ---------------------------------------------------------------- 3) 删除桌面快捷方式
Write-Step "删除桌面快捷方式"
$desktop = [Environment]::GetFolderPath("Desktop")
foreach ($f in @("黑屏（睡觉模式）.lnk", "亮屏（取消黑屏）.lnk", "黑屏状态.lnk")) {
    $p = Join-Path $desktop $f
    try {
        if (Test-Path $p) { Remove-Item $p -Force; Write-Ok "已删除 $f" }
    } catch { Write-Warn2 "删除 $f 失败: $($_.Exception.Message)" }
}

# ---------------------------------------------------------------- 4) 还原电源设置
Write-Step "还原电源计划（睡眠/休眠）"
$exe = Join-Path $InstallDir "ScreenPower.exe"
if (Test-Path $exe) {
    try {
        & $exe on | Out-Null
        Write-Ok "已通过 ScreenPower on 还原亮度与电源设置"
    } catch { Write-Warn2 "还原失败: $($_.Exception.Message)" }
} else {
    # 兜底: 直接把睡眠/休眠恢复为合理默认值（AC 30 分钟, DC 45 分钟）
    Write-Warn2 "未找到 ScreenPower.exe，跳过自动还原"
}

# ---------------------------------------------------------------- 5) 删除安装目录
if ($KeepFiles) {
    Write-Ok "按要求保留安装目录 $InstallDir"
} else {
    Write-Step "删除安装目录"
    try {
        if (Test-Path $InstallDir) {
            Remove-Item $InstallDir -Recurse -Force -ErrorAction Stop
            Write-Ok "已删除 $InstallDir"
        } else {
            Write-Ok "安装目录不存在，跳过"
        }
    } catch { Write-Warn2 "删除安装目录失败: $($_.Exception.Message)" }
}

Write-Host ""
Write-Host "卸载完成。" -ForegroundColor Green
