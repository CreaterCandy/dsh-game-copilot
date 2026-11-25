# 给 plugin.mjs 查后台守护进程用：输出 PTT <pid> / BRIDGE <pid>。
# 用 -File 调用，避免 -Command 里的引号被吃掉（踩过：WQL LIKE 的引号在嵌套 PowerShell 中丢失）。
$ProgressPreference = 'SilentlyContinue'

function Find-Proc([string]$pattern) {
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$pattern*" } |
    Select-Object -First 1 ProcessId, CommandLine
}

$p = Find-Proc 'ptt_voice.pyw'
if ($p) { "PTT $($p.ProcessId)" }

$b = Find-Proc 'pet_voice_bridge.py'
if ($b) { "BRIDGE $($b.ProcessId)" }
