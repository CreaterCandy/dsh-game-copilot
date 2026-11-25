# pack-release.ps1 —— 生成"解压即用"的完整发布包
#
# 和 pack-model.ps1 的区别：
#   pack-model.ps1 只打模型包（给 git clone 的用户加速用）
#   本脚本打完整包：代码 + ASR 模型 + 桌宠小窗的 Electron 运行时，
#   用户下载解压后就是一个完整项目文件夹，跑一次 setup.ps1（建 venv、装依赖、装插件）即可，
#   模型那 464MB 和 Electron 那 255MB 都不用再联网下。
#
# 为什么把 Electron 打进来：置顶小窗只能用 Electron 起（透明、无边框、盖在游戏上层、点击穿透），
# 浏览器页面做不到。原版 dsh-game-pet 是"蹭"dsh-pet 下载的那份，本仓库独立分发，
# 用户机器上没有那份，所以必须自带，否则小窗 100% 起不来。
#
# 产出：
#   dist\dsh-game-copilot-<版本>-full.zip   解压后是 dsh-game-copilot\ 整个目录（含 electron\）
#   dist\SHA256SUMS-full.txt                校验值，一并上传到 Release
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\tools\pack-release.ps1 -ModelsDir D:\path\runtime\models
#   powershell -ExecutionPolicy Bypass -File .\tools\pack-release.ps1 -ModelsDir ... -Version v1.0.0
#   powershell -ExecutionPolicy Bypass -File .\tools\pack-release.ps1 -ModelsDir ... -NoElectron   # 出轻量包
#
# 注意：模型目录不在公开仓库里（被 .gitignore 排除），必须用 -ModelsDir 指向一份
#       已下载好的 faster-whisper small 模型（目录里要有 model.bin）。

param(
    [string]$Version = '',
    [string]$ModelsDir = '',
    [string]$OutDir = (Join-Path $PSScriptRoot '..\dist'),
    # 指定一份 Electron 发行包目录（里面要有 electron.exe），不指定就自动找
    [string]$ElectronDir = '',
    # 出轻量包（不带 Electron，体积小约 255MB，但小窗起不来）
    [switch]$NoElectron
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# 版本号：优先参数，其次 git tag，最后 dev
if (-not $Version) {
    $tag = (& git -C $root describe --tags --abbrev=0 2>$null)
    if ($LASTEXITCODE -eq 0 -and $tag) { $Version = $tag } else { $Version = 'dev' }
}
$Version = $Version -replace '[^A-Za-z0-9._-]', '-'

# 模型源目录：参数 > 仓库自己的 runtime/models
$models = if ($ModelsDir) { $ModelsDir } else { Join-Path $root 'runtime\models' }
$bin = Get-ChildItem -LiteralPath $models -Recurse -File -Filter 'model.bin' -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $bin) {
    throw "没找到 ASR 模型（model.bin）：$models`n请用 -ModelsDir 指向一份已下载好的 runtime\models 目录。"
}

# ── Electron 源：完整包必须自带，否则用户的小窗 100% 起不来 ──
# 只认"干净发行包"（目录里直接有 electron.exe）。npm 装的 electron 在 node_modules\electron\dist 下，
# 本机维护时那份最干净；%LOCALAPPDATA%\electron 是运行目录，可能带 Cache，打之前会清掉。
function Find-ElectronDist {
    param([string]$Explicit)
    $tries = @()
    if ($Explicit) { $tries += $Explicit }
    $tries += (Join-Path $root '..\electron-dist\node_modules\electron\dist')
    $tries += (Join-Path $root 'node_modules\electron\dist')
    if ($env:LOCALAPPDATA) { $tries += (Join-Path $env:LOCALAPPDATA 'electron') }
    foreach ($t in $tries) {
        if ($t -and (Test-Path -LiteralPath (Join-Path $t 'electron.exe'))) {
            return (Resolve-Path -LiteralPath $t).Path
        }
    }
    return $null
}

$electronSrc = $null
if (-not $NoElectron) {
    $electronSrc = Find-ElectronDist -Explicit $ElectronDir
    if (-not $electronSrc) {
        throw @"
没找到 Electron 发行包（目录里要有 electron.exe）。
  三种办法：
    1) -ElectronDir 指向一份现成的发行包目录；
    2) 先 npm i electron@30.5.1 到 ..\electron-dist，再重跑；
    3) 加 -NoElectron 出轻量包（体积小 255MB，但用户的小窗起不来）。
"@
    }
    $electronVer = Get-Content -LiteralPath (Join-Path $electronSrc 'version') -ErrorAction SilentlyContinue
    Write-Host "  Electron 源：$electronSrc（版本 $electronVer）" -ForegroundColor DarkGray
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$name = "dsh-game-copilot-$Version-full"
$zip = Join-Path $OutDir "$name.zip"
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }

$stage = Join-Path $OutDir '_stage_full'
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
$appDir = Join-Path $stage 'dsh-game-copilot'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null

try {
    # 用 git archive 导出已提交的代码：自动排除 .git、venv、模型、配置、日志等所有被忽略的东西
    Write-Host '导出仓库代码（git archive HEAD）…' -ForegroundColor Cyan
    $codeZip = Join-Path $stage 'code.zip'
    & git -C $root archive --format=zip HEAD -o $codeZip
    if ($LASTEXITCODE -ne 0) { throw 'git archive 失败' }
    Expand-Archive -LiteralPath $codeZip -DestinationPath $appDir -Force
    Remove-Item -LiteralPath $codeZip -Force

    # 注入模型：解压后落在 runtime\models\，setup.ps1 检测到 model.bin 会跳过下载
    Write-Host '注入 ASR 模型（约 464MB）…' -ForegroundColor Cyan
    Copy-Item -LiteralPath $models -Destination (Join-Path $appDir 'runtime\models') -Recurse -Force

    # 校验包里确实有模型
    $check = Get-ChildItem -LiteralPath (Join-Path $appDir 'runtime\models') -Recurse -File -Filter 'model.bin' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $check) { throw '打包后模型缺失，请检查源目录。' }

    # 注入 Electron：解压后落在 electron\，setup.ps1 会把它装到 DSH home
    if ($electronSrc) {
        Write-Host '注入 Electron 运行时（约 255MB）…' -ForegroundColor Cyan
        $eDest = Join-Path $appDir 'electron'
        New-Item -ItemType Directory -Path $eDest -Force | Out-Null
        Copy-Item -Path (Join-Path $electronSrc '*') -Destination $eDest -Recurse -Force
        # 从 %LOCALAPPDATA% 取源时可能带上 Chromium 缓存，纯属浪费体积
        $cacheDir = Join-Path $eDest 'Cache'
        if (Test-Path -LiteralPath $cacheDir) {
            Remove-Item -LiteralPath $cacheDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        if (-not (Test-Path -LiteralPath (Join-Path $eDest 'electron.exe'))) { throw '打包后 Electron 缺失，请检查源目录。' }
        $eCount = (Get-ChildItem -LiteralPath $eDest -Recurse -File | Measure-Object).Count
        $eMB = [math]::Round(((Get-ChildItem -LiteralPath $eDest -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
        Write-Host "  Electron 已就位：$eCount 个文件，$eMB MB" -ForegroundColor DarkGray
    } else {
        Write-Host '按 -NoElectron 出轻量包：不含 Electron，用户的小窗不会启动。' -ForegroundColor Yellow
    }

    Write-Host '正在压缩完整包（请稍候，约 700MB）…' -ForegroundColor Cyan
    Compress-Archive -LiteralPath $appDir -DestinationPath $zip -CompressionLevel Optimal
} finally {
    # 清临时目录失败不能拖垮整个流程：某些安全策略会对"一次删除 N 个文件"
    # 弹确认，抛的是 NativeCommandError，-ErrorAction SilentlyContinue 管不住，
    # 之前就在这一步 throw，导致 zip 明明打好了却没生成校验值。
    if (Test-Path -LiteralPath $stage) {
        try {
            Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop
        } catch {
            Write-Host "临时目录没清掉，手动删一下即可（不影响产物）：$stage" -ForegroundColor Yellow
        }
    }
}

$sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$sums = Join-Path $OutDir 'SHA256SUMS-full.txt'
Set-Content -LiteralPath $sums -Value "$sha  $name.zip" -Encoding ASCII -Force

$sizeMB = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1)
Write-Host "完整包：$zip（$sizeMB MB）" -ForegroundColor Green
Write-Host "校验值：$sums" -ForegroundColor Green
if ($electronSrc) {
    Write-Host '下一步：把这两个文件上传到 GitHub Release。用户解压 zip 后跑 setup.ps1 即可——模型和 Electron 都已在包内，全程不用再联网下大件。' -ForegroundColor Green
} else {
    Write-Host '下一步：上传后要在 Release 说明里写清楚"本包不含 Electron，桌宠小窗不会启动"。' -ForegroundColor Yellow
}
