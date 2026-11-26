# setup.ps1 —— 一次性安装（Windows PowerShell 5.1 可直接跑）
#
# 做五件事：
#   1. 检查 Python，并把桌宠小窗用的 Electron 装好（包内自带优先；纯代码包会从 Release 下，约 100MB 只需一次）
#   2. 建 runtime\venv 并装 requirements.txt
#   3. 把 config.example.json 落成 config.json（已存在则不动）
#   4. 准备语音识别模型（优先 Release 镜像 + SHA256 校验，失败回退官方源）
#   5. 把 plugin\ 装进 DSH 的 desktop profile，并写设置页默认配置
#
# 全程不覆盖用户已有配置；重跑是安全的。
# 大件（模型约 430MB、Electron 约 100MB）都只在首次安装时下载一次，之后重跑会跳过。
#
# 用法：
#   .\setup.ps1                  完整安装
#   .\setup.ps1 -OnlyElectron    只装 Electron 小窗运行时（装完轻量包想补小窗时用）

param(
    [switch]$OnlyElectron
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$venv = Join-Path $runtime 'venv'
$python = Join-Path $venv 'Scripts\python.exe'

# DSH 的 home：本脚本和插件（desktop-window.mjs）、热键守护（ptt_voice.pyw）必须是同一个口径，
# 否则会出现"装好了却探测不到"。三处一致：DSH_HOME → 否则 %USERPROFILE%\.dsh
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }

# 小窗用的 Electron 不走 PATH，只认这几个位置（与 plugin\src\host\desktop-window.mjs 一致）
function Find-ElectronBinary {
    $tries = @()
    if ($env:DSH_GAME_PET_ELECTRON) { $tries += $env:DSH_GAME_PET_ELECTRON }
    if ($env:DSH_PET_ELECTRON_PATH) { $tries += $env:DSH_PET_ELECTRON_PATH }
    $tries += (Join-Path $homeDir 'electron\electron.exe')
    if ($env:LOCALAPPDATA) {
        $tries += (Join-Path $env:LOCALAPPDATA 'electron\electron.exe')
        $tries += (Join-Path $env:LOCALAPPDATA 'Programs\electron\electron.exe')
    }
    foreach ($t in $tries) {
        if ($t -and (Test-Path -LiteralPath $t)) { return $t }
    }
    return $null
}

# 完整发布包把 Electron 打在包内（解压后 <包根>\electron\electron.exe）。
# 装到 DSH home 而不是让插件去认包目录：包可以被删、被挪、被重装覆盖，
# 而 DSH home 是稳定位置，插件只看这一处，排障时也只用一个路径。
function Install-BundledElectron {
    $bundled = Join-Path $root 'electron\electron.exe'
    if (-not (Test-Path -LiteralPath $bundled)) { return $null }
    $dest = Join-Path $homeDir 'electron'
    Write-Host "  包内自带 Electron，安装到 $dest（约 255MB，只需一次）…" -ForegroundColor DarkGray
    try {
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Copy-Item -Path (Join-Path $root 'electron\*') -Destination $dest -Recurse -Force -ErrorAction Stop
    } catch {
        Write-Host "  复制失败（不影响语音功能）：$($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
    $target = Join-Path $dest 'electron.exe'
    if (Test-Path -LiteralPath $target) { return $target }
    return $null
}

# 大文件下载：PowerShell 5.1 的 Invoke-WebRequest 会把整个响应读进内存再写盘，
# 下 400MB+ 的模型又慢又占内存。BITS 支持断点续传、有原生进度条，优先用它；
# 拿不到（服务被禁等）就退回流式写盘的 WebClient。
# ⚠️ tools\fetch-model.ps1 里有一份同样的实现，改这里要同步那边。
function Save-RemoteFile {
    param([string]$Url, [string]$OutFile, [string]$Label = '文件')
    if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
        try {
            Start-BitsTransfer -Source $Url -Destination $OutFile -Description $Label -ErrorAction Stop | Out-Null
            if (Test-Path -LiteralPath $OutFile) { return }
        } catch {
            Write-Host "  BITS 下载失败，改用直连：$($_.Exception.Message)" -ForegroundColor DarkGray
            Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
        }
    }
    $wc = New-Object System.Net.WebClient
    try {
        $wc.Headers.Add('User-Agent', 'dsh-game-copilot-setup')
        $wc.DownloadFile($Url, $OutFile)
    } finally {
        $wc.Dispose()
    }
}

# 联网装 Electron：给"下的是纯代码包"的人用。
# 资产只在 Release 上传一次，所有代码版本共用同一个直链（GitHub 的 release 资产链接是永久的），
# 所以这里读的是 config\release.json，不写死版本号；换 Electron 版本才需要改配置。
function Install-ElectronFromRelease {
    $cfgPath = Join-Path $root 'config\release.json'
    if (-not (Test-Path -LiteralPath $cfgPath)) { return $null }

    $url = ''
    $sha = ''
    try {
        # 显式按 UTF-8 读：PowerShell 5.1 默认按 ANSI 读无 BOM 文件，会把中文说明读坏
        $cfg = ([IO.File]::ReadAllText($cfgPath, [Text.Encoding]::UTF8)) | ConvertFrom-Json
        if ($cfg.electronMirrorUrl) { $url = [string]$cfg.electronMirrorUrl }
        if ($cfg.electronSha256) { $sha = ([string]$cfg.electronSha256).Trim().ToLowerInvariant() }
    } catch {
        Write-Host "  读取 config\release.json 失败：$($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
    if (-not $url) { return $null }

    $tag = [guid]::NewGuid().ToString('N')
    $zip = Join-Path ([IO.Path]::GetTempPath()) "dsh-electron-$tag.zip"
    $stage = Join-Path ([IO.Path]::GetTempPath()) "dsh-electron-$tag"
    try {
        Write-Host '  下载 Electron 运行时（约 100MB，只需一次）…' -ForegroundColor Cyan
        Write-Host "  $url" -ForegroundColor DarkGray
        Save-RemoteFile -Url $url -OutFile $zip -Label 'Electron 运行时'

        if ($sha) {
            $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne $sha) { throw "SHA256 不匹配：期望 $sha，实际 $actual" }
            Write-Host '  SHA256 校验通过。' -ForegroundColor Green
        } else {
            Write-Host '  未配置 SHA256，跳过校验（维护者请在 config\release.json 补上）。' -ForegroundColor Yellow
        }

        Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
        $src = Join-Path $stage 'electron'
        if (-not (Test-Path -LiteralPath (Join-Path $src 'electron.exe'))) {
            throw '压缩包里没有 electron\electron.exe'
        }
        $dest = Join-Path $homeDir 'electron'
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force -ErrorAction Stop
        $target = Join-Path $dest 'electron.exe'
        if (Test-Path -LiteralPath $target) {
            Write-Host "  Electron 已装到 $dest" -ForegroundColor Green
            return $target
        }
        return $null
    } catch {
        Write-Host "  Electron 下载 / 安装失败：$($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    } finally {
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        # 用 .NET 递归删：Remove-Item -Recurse 在部分安全策略下会按"一次删 N 个文件"被拦并抛错
        try { if (Test-Path -LiteralPath $stage) { [IO.Directory]::Delete($stage, $true) } } catch { }
    }
}

# 只装 Electron：给"下了轻量包、后来想要小窗"的人补装用，也是这段逻辑的独立测试入口。
if ($OnlyElectron) {
    Write-Step '只安装 Electron（-OnlyElectron）'
    $existing = Find-ElectronBinary
    if ($existing) {
        Write-Host "  已存在，不用重装：$existing" -ForegroundColor Green
        exit 0
    }
    $installed = Install-BundledElectron
    if (-not $installed) { $installed = Install-ElectronFromRelease }
    if ($installed) {
        Write-Host "  装好了：$installed" -ForegroundColor Green
        Write-Host '  重启 DSH（或在设置页点一下小窗开关）就会生效。' -ForegroundColor DarkGray
        exit 0
    }
    Write-Host '  没装成：包内没有 electron\ 目录，也没能从 Release 下载到。' -ForegroundColor Yellow
    Write-Host '  三种办法：① 换用带 Electron 的完整包（Release 里的 -full.zip）；' -ForegroundColor Yellow
    Write-Host '            ② 检查网络后重跑本脚本（会从 config\release.json 的直链下载）；' -ForegroundColor Yellow
    Write-Host '            ③ 设环境变量 DSH_GAME_PET_ELECTRON 指向现成的 electron.exe。' -ForegroundColor Yellow
    exit 1
}


Write-Step '1/5 检查 Python、安装小窗运行时'

# requirements.txt 里 numpy 2.5.x 只支持 Python >= 3.12。低版本 pip 会直接报
# "No matching distribution found"，所以先挑一个够新的解释器，别让安装半路死掉。
$minPy = [version]'3.12'
$pyExe = $null
$pyVer = $null

$candidates = @()
# py 启动器能精确点名版本，优先用它挑
$pyLauncher = Get-Command py -ErrorAction SilentlyContinue
if ($pyLauncher) {
    # ⚠️ 探测必须在宽松的错误策略下跑：py 启动器不认识目标版本时（uv / conda / 自定义安装很常见），
    # 原生命令写 stderr 在本脚本开头的 $ErrorActionPreference='Stop' 下会变成**终止性**
    # NativeCommandError，整个安装脚本第一步就 EXIT=1 —— 即使 PATH 里已经有一个合格的 3.12。
    # 这里临时降级成 Continue，探测完立刻恢复，别让"探测失败"等于"安装失败"。
    $probeEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        foreach ($v in @('3.14', '3.13', '3.12')) {
            try {
                $out = & $pyLauncher.Source "-$v" -c "import sys; print(sys.executable)" 2>$null
                if ($LASTEXITCODE -eq 0 -and $out) { $candidates += ([string]$out).Trim() }
            } catch {
                Write-Host "  py -$v 探测失败，跳过" -ForegroundColor DarkGray
            }
        }
    } finally {
        $ErrorActionPreference = $probeEap
    }
}
foreach ($n in @('python', 'python3')) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c) { $candidates += $c.Source }
}
$candidates = $candidates | Where-Object { $_ } | Select-Object -Unique

foreach ($cand in $candidates) {
    if (-not (Test-Path -LiteralPath $cand)) { continue }
    $v = $null
    # 同上：坏掉/不兼容的解释器写 stderr 会在 Stop 策略下抛终止性错误，不能让它带走整个脚本
    try { $v = & $cand -c "import sys; print('%d.%d.%d' % sys.version_info[:3])" 2>$null } catch { continue }
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
    # 同样在宽松策略下取版本号：`2>&1` 会把原生命令的 stderr 变成 ErrorRecord，Stop 下直接抛
    $have = 'PATH 里没有 python'
    if ($pathPy) {
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $have = (& $pathPy.Source --version 2>&1) -join ' ' } catch { $have = 'python 版本探测失败' } finally { $ErrorActionPreference = $prevEap }
    }
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
    # 完整包自带 Electron，这里直接落地
    $electron = Install-BundledElectron
}
if (-not $electron) {
    # 纯代码包没有 Electron，从 Release 下（约 100MB，只需一次）
    $electron = Install-ElectronFromRelease
}
if ($electron) {
    Write-Host "  Electron -> $electron" -ForegroundColor DarkGray
} else {
    Write-Host '  [提示] 没有 Electron：桌宠透明小窗不会启动，气泡与语音问答仍可用。' -ForegroundColor Yellow
    Write-Host '         小窗按这三处找（不看 PATH，也不需要 npm 装）：' -ForegroundColor Yellow
    Write-Host '           1) 环境变量 DSH_GAME_PET_ELECTRON = <electron.exe 完整路径>' -ForegroundColor Yellow
    Write-Host "           2) $homeDir\electron\electron.exe" -ForegroundColor Yellow
    Write-Host '           3) %LOCALAPPDATA%\electron\electron.exe' -ForegroundColor Yellow
    Write-Host '         最省事：换用带 Electron 的完整包（Release 里的 -full.zip），本脚本会自动装好。' -ForegroundColor Yellow
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
$profile = Join-Path $homeDir 'profiles\desktop\node_modules\dsh-game-copilot'
if (-not (Test-Path (Split-Path $profile -Parent))) {
    Write-Host "没找到 DSH profile 目录：$profile" -ForegroundColor Yellow
    Write-Host '请先安装并至少启动一次 DeepSeek Harness，然后重跑本脚本。' -ForegroundColor Yellow
} else {
    # 复制 plugin\* 的**内容**，不要复制 plugin 目录本身。
    # 目标目录已存在时（重装/升级），Copy-Item 目录会在下面再建一层 plugin\，
    # 新代码躺在新嵌套里、插件加载的仍是根目录那份旧的——实测过，等于升级无效。
    Copy-Item (Join-Path $root 'plugin\*') $profile -Recurse -Force
    if (Test-Path (Join-Path $profile 'plugin\index.js')) {
        Write-Host '  发现多余的 plugin\ 嵌套目录（旧版脚本留下的），可以删：' -ForegroundColor Yellow
        Write-Host "    Remove-Item -Recurse -Force '$(Join-Path $profile 'plugin')'" -ForegroundColor Yellow
    }
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
