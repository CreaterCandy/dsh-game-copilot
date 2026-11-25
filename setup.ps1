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

# 小窗用的 Electron 不走 PATH，只认这几个位置（与 plugin\src\host\desktop-window.mjs 一致）
function Find-ElectronBinary {
    $tries = @()
    if ($env:DSH_GAME_PET_ELECTRON) { $tries += $env:DSH_GAME_PET_ELECTRON }
    if ($env:DSH_PET_ELECTRON_PATH) { $tries += $env:DSH_PET_ELECTRON_PATH }
    $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    $tries += (Join-Path $dshHome 'electron\electron.exe')
    if ($env:LOCALAPPDATA) { $tries += (Join-Path $env:LOCALAPPDATA 'electron\electron.exe') }
    foreach ($t in $tries) {
        if ($t -and (Test-Path -LiteralPath $t)) { return $t }
    }
    return $null
}

Write-Step '1/5 检查 Python 与 Electron'

# requirements.txt 里 numpy 2.5.x 只支持 Python >= 3.12。低版本 pip 会直接报
# "No matching distribution found"，所以先挑一个够新的解释器，别让安装半路死掉。
$minPy = [version]'3.12'
$pyExe = $null
$pyVer = $null

$candidates = @()
# py 启动器能精确点名版本，优先用它挑
$pyLauncher = Get-Command py -ErrorAction SilentlyContinue
if ($pyLauncher) {
    foreach ($v in @('3.14', '3.13', '3.12')) {
        $out = & $pyLauncher.Source "-$v" -c "import sys; print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) { $candidates += ([string]$out).Trim() }
    }
}
foreach ($n in @('python', 'python3')) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c) { $candidates += $c.Source }
}
$candidates = $candidates | Where-Object { $_ } | Select-Object -Unique

foreach ($cand in $candidates) {
    if (-not (Test-Path -LiteralPath $cand)) { continue }
    $v = & $cand -c "import sys; print('%d.%d.%d' % sys.version_info[:3])" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $v) { continue }
    $v = ([string]$v).Trim()
    try { $parsed = [version]$v } catch { continue }
    if ($parsed -ge $minPy) {
        $pyExe = $cand
        $pyVer = $v
        Write-Host "  Python $v -> $cand" -ForegroundColor DarkGray
        break
    }
    Write-Host "  跳过 Python $v（低于 3.12）-> $cand" -ForegroundColor DarkGray
}

if (-not $pyExe) {
    $pathPy = Get-Command python -ErrorAction SilentlyContinue
    $have = if ($pathPy) { (& $pathPy.Source --version 2>&1) -join ' ' } else { 'PATH 里没有 python' }
    throw @"
需要 Python 3.12 或更高版本。当前：$have

requirements.txt 里锁定的 numpy 2.5.x 只支持 3.12+，低版本装不上。
（这里故意拒绝继续：低版本下 pip 会失败，但脚本若接着往下跑会打印"完成"，
  用户以为装好了，其实一个依赖都没装上。宁可现在停。）

三种办法，任选其一：
  1) 装 Python 3.12+（安装时勾 Add to PATH），然后重跑本脚本；
  2) 已装 py 启动器的话：py -3.12 -m venv runtime\venv，再重跑本脚本；
  3) 用 uv：winget install astral-sh.uv，再 uv python install 3.12。
"@
}

$electron = Find-ElectronBinary
if (-not $electron) {
    Write-Host '  [提示] 没找到 Electron 可执行文件：桌宠透明小窗不会启动，气泡与语音问答仍可用。' -ForegroundColor Yellow
    Write-Host '         小窗按这四处找（任一命中即可），注意它不看 PATH：' -ForegroundColor Yellow
    Write-Host '           1) 环境变量 DSH_GAME_PET_ELECTRON = <electron.exe 完整路径>' -ForegroundColor Yellow
    Write-Host '           2) %DSH_HOME%\electron\electron.exe' -ForegroundColor Yellow
    Write-Host '           3) %LOCALAPPDATA%\electron\electron.exe' -ForegroundColor Yellow
    Write-Host '         最省事：把 electron.exe 放到 %LOCALAPPDATA%\electron\electron.exe。' -ForegroundColor Yellow
    Write-Host '         （npm 全局装的 electron 不会被自动发现，得按上面任一条指定。）' -ForegroundColor Yellow
} else {
    Write-Host "  Electron -> $electron" -ForegroundColor DarkGray
}

Write-Step '2/5 建虚拟环境并装依赖'
if (Test-Path $python) {
    # 已有 venv 可能是旧 Python 建的，版本不够同样装不上依赖，先查清楚
    $venvVer = & $python -c "import sys; print('%d.%d.%d' % sys.version_info[:3])" 2>$null
    if ($LASTEXITCODE -eq 0 -and $venvVer) {
        $venvVer = ([string]$venvVer).Trim()
        $vn = $null
        try { $vn = [version]$venvVer } catch { }
        if ($vn -and $vn -lt $minPy) {
            throw "已有虚拟环境是 Python $venvVer 建的，低于 3.12，依赖装不上。`n请删掉这个目录后重跑本脚本：$venv"
        }
        Write-Host "  复用已有虚拟环境（Python $venvVer）" -ForegroundColor DarkGray
    }
} else {
    & $pyExe -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "创建虚拟环境失败（退出码 $LASTEXITCODE）：$venv" }
}

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
if ($LASTEXITCODE -ne 0) {
    throw "升级 pip 失败（退出码 $LASTEXITCODE）。检查网络/代理后重跑本脚本。"
}

& $python -m pip install -r (Join-Path $root 'requirements.txt')
if ($LASTEXITCODE -ne 0) {
    # PowerShell 5.1 不会因为原生命令失败而停，必须自己查退出码。
    # 不查的话 pip 报错后脚本照样走到最后打印"完成"，用户以为装好了，实际全没装。
    throw "依赖安装失败（退出码 $LASTEXITCODE）。上面有 pip 的原始报错，按报错修好后重跑本脚本即可。"
}
Write-Host '  依赖已全部装好' -ForegroundColor DarkGray

Write-Step '3/5 落本地配置'
$localCfg = Join-Path $runtime 'config.json'
if (-not (Test-Path $localCfg)) {
    Copy-Item (Join-Path $runtime 'config.example.json') $localCfg
    Write-Host "已生成 $localCfg" -ForegroundColor Green
} else { Write-Host "已存在，跳过：$localCfg" -ForegroundColor DarkGray }

Write-Step '4/5 准备语音识别模型（约 464MB，首次要联网）'
# 不预下载的话，第一次按键会在 transcribe 里卡在联网下模型：
# 反馈音只响前两声、后续按键被 _busy 吞掉，表现得像"助理死了"。
& (Join-Path $root 'tools\fetch-model.ps1') -RuntimeDir $runtime -PythonExe $python
if ($LASTEXITCODE -ne 0) {
    Write-Host '模型准备未完全成功，不影响其他功能；首次语音问答可能慢一点' -ForegroundColor Yellow
}

Write-Step '5/5 装插件 + 写设置页默认配置'
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profile = Join-Path $homeDir 'profiles\desktop\node_modules\dsh-game-copilot'
if (-not (Test-Path (Split-Path $profile -Parent))) {
    Write-Host "没找到 DSH profile 目录：$profile" -ForegroundColor Yellow
    Write-Host '请先安装并至少启动一次 DeepSeek Harness，然后重跑本脚本。' -ForegroundColor Yellow
} else {
    Copy-Item (Join-Path $root 'plugin') $profile -Recurse -Force
    Write-Host "插件已装到 $profile" -ForegroundColor Green

    # 登记 runtime 真实路径。打包安装后插件在 node_modules 里，靠相对路径算不回工程根
    # （实测会算成 node_modules\runtime，然后点"启动副驾"报找不到 python.exe）。
    # 必须写无 BOM 的 UTF-8：带 BOM 时插件读到的路径前面多一个不可见字符，
    # existsSync 必然判不存在，等于白登记。
    $runtimeDir = Join-Path $root 'runtime'
    $marker = Join-Path $profile 'runtime-path.txt'
    $noBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($marker, $runtimeDir, $noBom)
    Write-Host "已登记 runtime 路径 -> $marker" -ForegroundColor DarkGray
}
$petCfg = Join-Path $homeDir 'dsh-game-copilot.json'
$legacyPetCfg = Join-Path $homeDir 'dsh-game-pet.json'
if (-not (Test-Path $petCfg) -and (Test-Path $legacyPetCfg)) {
    Copy-Item $legacyPetCfg $petCfg
    Write-Host "已从旧配置迁移：$legacyPetCfg -> $petCfg" -ForegroundColor Green
}
if (-not (Test-Path $petCfg)) {
    Copy-Item (Join-Path $root 'config\dsh-game-copilot.example.json') $petCfg
    Write-Host "已生成 $petCfg" -ForegroundColor Green
} else { Write-Host "已存在，跳过：$petCfg" -ForegroundColor DarkGray }

$legacyProfile = Join-Path $homeDir 'profiles\desktop\node_modules\dsh-game-pet'
if (Test-Path $legacyProfile) {
    Write-Host '检测到旧插件目录 dsh-game-pet：请把 profile 的 cordis.patch.yml 挂载行改成 dsh-game-copilot 后重启 DSH；旧目录可自行备份后删除。' -ForegroundColor Yellow
}

Write-Step '完成'
Write-Host '下一步：' -ForegroundColor Green
Write-Host '  1) 启动 DSH，在设置页打开「DSH游戏助理 → 模型与能力」，填一个 OpenAI 兼容端点'
Write-Host '  2) 点「测一下」，让插件判断这个端点能不能看图'
Write-Host '  3) 点顶部「启动游戏助理」，之后按住 Caps Lock 说话即可'
Write-Host '  设置页也可以直接浏览器打开：http://127.0.0.1:<DSH端口>/dsh-game-copilot-7341/settings'
