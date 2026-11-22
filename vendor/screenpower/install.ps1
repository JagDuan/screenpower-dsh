# ScreenPower 一键黑屏 / 定时亮屏 —— 安装脚本
#
# 用法（推荐：以管理员身份在 PowerShell 中运行）:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# 可选参数:
#   -WakeTime "07:00"    每天定时亮屏时间（默认 07:00）
#   -SleepTime "23:30"  每天定时黑屏时间（默认 23:30；设为 "" 可不启用）
#   -InstallDir <path>   安装目录（默认 C:\ProgramData\ScreenPower）
#   -NoDesktopShortcut   不创建桌面快捷方式
#
# 安装内容:
#   1) 复制 ScreenPower.exe / ScreenPower.cs / 使用说明 到安装目录
#   2) 注册计划任务 ScreenPower-Guard      （黑屏期间常驻守护，最高权限，交互式运行）
#   3) 注册计划任务 ScreenPower-Night      （每晚定时黑屏）
#   4) 注册计划任务 ScreenPower-Morning    （每天定时亮屏）
#   5) 桌面快捷方式：立即黑屏 / 立即亮屏 / 查看状态

[CmdletBinding()]
param(
    [string]$WakeTime = "07:00",
    [string]$SleepTime = "23:30",
    [string]$InstallDir = "$env:ProgramData\ScreenPower",
    [switch]$NoDesktopShortcut
)

$ErrorActionPreference = "Stop"
$script:TaskPrefix = "ScreenPower"

function Write-Step  { param([string]$m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok    { param([string]$m) Write-Host "    [OK] $m" -ForegroundColor Green }
function Write-Warn2 { param([string]$m) Write-Host "    [!]  $m" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 管理员检查
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "需要管理员权限。请右键以管理员身份运行 PowerShell，然后执行:" -ForegroundColor Red
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`"" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- 定位源码
$srcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exeSrc = Join-Path $srcDir "ScreenPower.exe"
$csSrc  = Join-Path $srcDir "ScreenPower.cs"
if (-not (Test-Path $exeSrc)) {
    Write-Host "未找到 ScreenPower.exe（应在脚本所在目录）。请先运行 build.ps1 编译。" -ForegroundColor Red
    exit 1
}

Write-Step "安装到 $InstallDir"
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# ---------------------------------------------------------------- 停止占用旧文件的进程
# ScreenPower.exe 正在运行（守护进程 / sleep-guard / 手动黑屏）时会锁住 exe，
# 导致下面的 Copy-Item 报 "being used by another process"。先优雅停止并等待退出。
function Stop-ScreenPowerProcesses([string]$Dir) {
    $target = Join-Path $Dir "ScreenPower.exe"
    $procs = @(Get-Process -Name "ScreenPower" -ErrorAction SilentlyContinue |
               Where-Object { $_.Path -eq $target })
    if ($procs.Count -eq 0) { return }
    Write-Warn2 "检测到 $($procs.Count) 个正在运行的 ScreenPower 进程，正在停止…"
    foreach ($p in $procs) {
        try { $p.CloseMainWindow() | Out-Null } catch {}
    }
    foreach ($p in $procs) {
        try {
            if (-not $p.WaitForExit(3000)) { $p.Kill() }
        } catch { Write-Warn2 "停止进程 $($p.Id) 失败: $($_.Exception.Message)" }
    }
    Start-Sleep -Milliseconds 400
    $left = @(Get-Process -Name "ScreenPower" -ErrorAction SilentlyContinue |
              Where-Object { $_.Path -eq $target })
    if ($left.Count -gt 0) {
        Write-Warn2 "仍有 $($left.Count) 个 ScreenPower 进程未退出，文件可能被占用。"
    } else {
        Write-Ok "已停止旧进程"
    }
}
Stop-ScreenPowerProcesses $InstallDir

Copy-Item $exeSrc (Join-Path $InstallDir "ScreenPower.exe") -Force
if (Test-Path $csSrc) { Copy-Item $csSrc (Join-Path $InstallDir "ScreenPower.cs") -Force }
foreach ($extra in @("README.md", "使用说明.txt")) {
    $p = Join-Path $srcDir $extra
    if (Test-Path $p) { Copy-Item $p (Join-Path $InstallDir $extra) -Force }
}
Write-Ok "文件已复制"

$exe = Join-Path $InstallDir "ScreenPower.exe"

# ---------------------------------------------------------------- 校验时间格式
function Test-TimeFormat([string]$t) {
    return $t -match '^([01]\d|2[0-3]):([0-5]\d)$'
}
if ($WakeTime -and -not (Test-TimeFormat $WakeTime)) {
    Write-Host "WakeTime 格式无效: '$WakeTime'（应为 HH:mm）" -ForegroundColor Red; exit 1
}
if ($SleepTime -and -not (Test-TimeFormat $SleepTime)) {
    Write-Host "SleepTime 格式无效: '$SleepTime'（应为 HH:mm）" -ForegroundColor Red; exit 1
}

# ---------------------------------------------------------------- 任务管理函数
function Remove-TaskSafe([string]$name) {
    try {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
            Write-Ok "已移除旧任务 $name"
        }
    } catch { Write-Warn2 "移除任务 $name 失败: $($_.Exception.Message)" }
}

function New-TaskInteractive {
    <# 注册一个"仅在用户登录时运行"的交互式任务, 这样黑屏覆盖层才能显示在屏幕上 #>
    param(
        [string]$Name,
        [string]$Arguments,
        [string]$TriggerTime,      # HH:mm, 为空则不注册时间触发器
        [string]$TriggerDaily = $true
    )
    $action = New-ScheduledTaskAction -Execute $exe -Argument $Arguments -WorkingDirectory $InstallDir
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
                                            -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                                             -DontStopIfGoingOnBatteries `
                                             -DontStopOnIdleEnd `
                                             -StartWhenAvailable `
                                             -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
                                             -MultipleInstances IgnoreNew
    if ($TriggerTime) {
        $t = $TriggerTime -split ':'
        $trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours([int]$t[0]).AddMinutes([int]$t[1]))
        $trigger.DaysInterval = 1
    } else {
        $trigger = New-ScheduledTaskTrigger -AtStartup
    }
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
                            -Principal $principal -Settings $settings `
                            -Description "ScreenPower 一键黑屏/定时亮屏 辅助任务" -Force | Out-Null
    Write-Ok "已注册任务 $Name" + $(if ($TriggerTime) { " (每天 $TriggerTime)" } else { " (无时间触发)" })
}

# ---------------------------------------------------------------- 1) 守护任务
Write-Step "注册计划任务"
Remove-TaskSafe "$script:TaskPrefix-Guard"
New-TaskInteractive -Name "$script:TaskPrefix-Guard" -Arguments "guard"

# ---------------------------------------------------------------- 2) 夜间自动黑屏
Remove-TaskSafe "$script:TaskPrefix-Night"
if ($SleepTime) {
    New-TaskInteractive -Name "$script:TaskPrefix-Night" -Arguments "off --until $WakeTime" -TriggerTime $SleepTime
} else {
    Write-Ok "已跳过夜间黑屏任务 (SleepTime 为空)"
}

# ---------------------------------------------------------------- 3) 早晨自动亮屏
Remove-TaskSafe "$script:TaskPrefix-Morning"
if ($WakeTime) {
    New-TaskInteractive -Name "$script:TaskPrefix-Morning" -Arguments "on" -TriggerTime $WakeTime
} else {
    Write-Ok "已跳过早晨亮屏任务 (WakeTime 为空)"
}

# ---------------------------------------------------------------- 4) 桌面快捷方式
if (-not $NoDesktopShortcut) {
    Write-Step "创建桌面快捷方式"
    $desktop = [Environment]::GetFolderPath("Desktop")
    $ws = New-Object -ComObject WScript.Shell

    # 注意: 不能用 $Args 作为参数名 —— $args 是 PowerShell 的自动变量(脚本参数数组),
    # 会覆盖形参导致快捷方式的 Arguments 为空。必须用别的名字。
    function New-Shortcut([string]$Path, [string]$Target, [string]$ShortcutArgs, [string]$Icon, [string]$Desc) {
        $sc = $ws.CreateShortcut($Path)
        $sc.TargetPath = $Target
        $sc.Arguments = $ShortcutArgs
        $sc.WorkingDirectory = $InstallDir
        $sc.IconLocation = $Icon
        $sc.Description = $Desc
        $sc.Save()
        Write-Ok "已创建 $(Split-Path -Leaf $Path)  [$ShortcutArgs]"
    }

    $icon = "$exe,0"
    New-Shortcut (Join-Path $desktop "黑屏（睡觉模式）.lnk") $exe "off --until $WakeTime" $icon "关闭显示器，电脑保持运行；$WakeTime 自动亮屏"
    New-Shortcut (Join-Path $desktop "亮屏（取消黑屏）.lnk") $exe "on" $icon "立即点亮显示器并恢复电源设置"
    New-Shortcut (Join-Path $desktop "黑屏状态.lnk") $exe "status" $icon "查看 ScreenPower 当前状态"
}

# ---------------------------------------------------------------- 5) 完成信息
Write-Step "安装完成"
Write-Host ""
Write-Host "  已安装    : $exe" -ForegroundColor Green
Write-Host "  状态/日志 : $InstallDir\screenpower.log" -ForegroundColor Green
Write-Host "  唤醒时间  : $WakeTime" -ForegroundColor Green
Write-Host "  黑屏时间  : $(if ($SleepTime) { $SleepTime } else { '未启用' })" -ForegroundColor Green
Write-Host ""
Write-Host "  用法:" -ForegroundColor Cyan
Write-Host "    立即黑屏到明早 : `"$exe`" off --until $WakeTime"
Write-Host "    立即亮屏       : `"$exe`" on"
Write-Host "    查看状态       : `"$exe`" status"
Write-Host "    黑屏中唤醒     : 按任意键 / 点鼠标，或 Ctrl+Alt+F12"
Write-Host ""
Write-Host "  卸载: 运行 uninstall.ps1" -ForegroundColor Cyan
