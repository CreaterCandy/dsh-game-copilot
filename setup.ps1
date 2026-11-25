# setup.ps1 —— 一次性安装（Windows PowerShell 5.1 可直接跑）
#
# 做五件事：
#   1. 检查 Python
#   2. 建 runtime\venv 并装 requirements.txt
#   3. 把 config.example.json 落成 config.json（已存在则不动）
#   4. 准备语音识别模型（优先 Release 镜像 + SHA256 校验，失败回退官方源）
#   5. 把 plugin\ 装进 DSH 的 desktop profile，并写设置页默认配置
#
# 全程不覆盖用户已有配置；重跑是安全的。

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$venv = Join-Path $runtime 'venv'
$python = Join-Path $venv 'Scripts\python.exe'

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }

Write-Step '1/5 检查 Python'
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { throw '没找到 python。先装 Python 3.10+（勾 Add to PATH），再重跑本脚本。' }
& $py.Source --version

Write-Step '2/5 建虚拟环境并装依赖'
if (-not (Test-Path $python)) { & $py.Source -m venv $venv }

# 有些 Python 发行版建出的 venv 里，Scripts\python.exe 是启动器，会再拉一个
# 带控制台的子进程；从 DSH 起守护时就会弹两个空终端窗口。换成基础解释器的
# 真身即可，站点包仍走 venv（pyvenv.cfg 决定），不影响隔离。
try {
    $basePrefix = (& $python -c "import sys; print(sys.base_prefix)").Trim()
    $baseExe = Join-Path $basePrefix 'python.exe'
    $baseWexe = Join-Path $basePrefix 'pythonw.exe'
    if (Test-Path $baseExe) {
        Copy-Item $baseExe (Join-Path $venv 'Scripts\python.exe') -Force
        if (Test-Path $baseWexe) { Copy-Item $baseWexe (Join-Path $venv 'pythonw.exe') -Force }
        Write-Host "venv 解释器已换成基础解释器真身（避免弹出空终端）" -ForegroundColor DarkGray
    }
} catch {
    Write-Host "替换 venv 解释器失败（不影响后续安装）：$($_.Exception.Message)" -ForegroundColor Yellow
}

& $python -m pip install --upgrade pip
& $python -m pip install -r (Join-Path $root 'requirements.txt')

Write-Step '3/5 落本地配置'
$localCfg = Join-Path $runtime 'config.json'
if (-not (Test-Path $localCfg)) {
    Copy-Item (Join-Path $runtime 'config.example.json') $localCfg
    Write-Host "已生成 $localCfg" -ForegroundColor Green
} else { Write-Host "已存在，跳过：$localCfg" -ForegroundColor DarkGray }

Write-Step '4/5 准备语音识别模型（约 464MB，首次要联网）'
# 不预下载的话，第一次按键会在 transcribe 里卡在联网下模型：
# 反馈音只响前两声、后续按键被 _busy 吞掉，表现得像"副驾死了"。
& (Join-Path $root 'tools\fetch-model.ps1') -RuntimeDir $runtime -PythonExe $python
if ($LASTEXITCODE -ne 0) {
    Write-Host '模型准备未完全成功，不影响其他功能；首次语音问答可能慢一点' -ForegroundColor Yellow
}

Write-Step '5/5 装插件 + 写设置页默认配置'
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profile = Join-Path $homeDir 'profiles\desktop\node_modules\dsh-game-pet'
if (-not (Test-Path (Split-Path $profile -Parent))) {
    Write-Host "没找到 DSH profile 目录：$profile" -ForegroundColor Yellow
    Write-Host '请先安装并至少启动一次 DeepSeek Harness，然后重跑本脚本。' -ForegroundColor Yellow
} else {
    Copy-Item (Join-Path $root 'plugin') $profile -Recurse -Force
    Write-Host "插件已装到 $profile" -ForegroundColor Green
}
$petCfg = Join-Path $homeDir 'dsh-game-pet.json'
if (-not (Test-Path $petCfg)) {
    Copy-Item (Join-Path $root 'config\dsh-game-pet.example.json') $petCfg
    Write-Host "已生成 $petCfg" -ForegroundColor Green
} else { Write-Host "已存在，跳过：$petCfg" -ForegroundColor DarkGray }

Write-Step '完成'
Write-Host '下一步：' -ForegroundColor Green
Write-Host '  1) 启动 DSH，在设置页打开「桌宠参谋 → 模型与能力」，填一个 OpenAI 兼容端点'
Write-Host '  2) 点「测一下」，让插件判断这个端点能不能看图'
Write-Host '  3) 点顶部「启动副驾」，之后按住 Caps Lock 说话即可'
Write-Host '  设置页也可以直接浏览器打开：http://127.0.0.1:<DSH端口>/dsh-game-pet-7341/settings'
