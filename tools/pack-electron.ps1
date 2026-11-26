# pack-electron.ps1 —— 生成可放到 Release 的 Electron 运行时包（一次性大件）
#
# 为什么单独打：桌宠小窗只能用 Electron 起（透明、无边框、盖在游戏上层、点击穿透），
# 浏览器页面做不到。这份运行时解压后约 255MB，zip 后约 100MB。
#
# 关键点：它跟代码版本无关，只有换 Electron 版本时才需要重打。所以**只上传一次**，
# 之后所有代码版本都共用 config\release.json 里的同一个直链
# （GitHub 的 release 资产链接是永久的，删了才会失效）。
#
# 产出：
#   dist\dsh-game-copilot-electron-<版本>.zip   解压后是 electron\（内含 electron.exe）
#   dist\SHA256SUMS-asset-electron.txt          校验值（和 pack-release.ps1 的 SHA256SUMS-electron.txt 区分开）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\tools\pack-electron.ps1
#   powershell -ExecutionPolicy Bypass -File .\tools\pack-electron.ps1 -ElectronDir D:\some\electron

param(
    [string]$OutDir = (Join-Path $PSScriptRoot '..\dist'),
    # 指定一份 Electron 发行包目录（里面要有 electron.exe），不指定就自动找
    [string]$ElectronDir = ''
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# ── 找 Electron 发行包 ──
# 只认"干净发行包"（目录里直接有 electron.exe）。npm 装的在 node_modules\electron\dist 下；
# %LOCALAPPDATA%\electron 是运行目录，可能带 Chromium 缓存，打包前会清掉。
# ⚠️ 这段查找顺序与 pack-release.ps1 的 Find-ElectronDist 必须一致，改一处要同步另一处。
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

$src = Find-ElectronDist -Explicit $ElectronDir
if (-not $src) {
    throw @"
没找到 Electron 发行包（目录里要有 electron.exe）。
  三种办法：
    1) -ElectronDir 指向一份现成的发行包目录；
    2) 先 npm i electron@30.5.1 到 ..\electron-dist，再重跑；
    3) 该资产只上传一次，已有直链就不必重打。
"@
}

$eVer = (Get-Content -LiteralPath (Join-Path $src 'version') -ErrorAction SilentlyContinue)
if (-not $eVer) { $eVer = 'unknown' }
$eVer = ([string]$eVer).Trim() -replace '[^A-Za-z0-9._-]', '-'
Write-Host "  Electron 源：$src（版本 $eVer）" -ForegroundColor DarkGray

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$name = "dsh-game-copilot-electron-$eVer"
$zip = Join-Path $OutDir "$name.zip"
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }

# 压缩包根目录必须是 electron\，和 setup.ps1「包内自带 Electron」的目录结构一致，
# 这样 Install-ElectronFromRelease 的 Expand-Archive + Copy-Item 逻辑可以照用。
$stage = Join-Path $OutDir '_stage_electron'
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
$eDest = Join-Path $stage 'electron'
New-Item -ItemType Directory -Path $eDest -Force | Out-Null

try {
    Write-Host '复制 Electron 运行时（约 255MB）…' -ForegroundColor Cyan
    Copy-Item -Path (Join-Path $src '*') -Destination $eDest -Recurse -Force
    # 从 %LOCALAPPDATA% 取源时可能带上 Chromium 缓存，纯属浪费体积
    $cacheDir = Join-Path $eDest 'Cache'
    if (Test-Path -LiteralPath $cacheDir) {
        Remove-Item -LiteralPath $cacheDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath (Join-Path $eDest 'electron.exe'))) {
        throw '暂存目录里没有 electron.exe，请检查源目录。'
    }

    $cnt = (Get-ChildItem -LiteralPath $eDest -Recurse -File | Measure-Object).Count
    Write-Host "  已就位：$cnt 个文件，正在压缩（约 100MB，请稍候）…" -ForegroundColor Cyan
    Compress-Archive -LiteralPath $eDest -DestinationPath $zip -CompressionLevel Optimal
} finally {
    # 清理失败不能拖垮流程（安全策略可能对"一次删 N 个文件"弹确认），否则 zip 打好了却没生成校验值
    if (Test-Path -LiteralPath $stage) {
        try {
            Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop
        } catch {
            Write-Host "临时目录没清掉，手动删一下即可（不影响产物）：$stage" -ForegroundColor Yellow
        }
    }
}

$sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
# 文件名刻意带 asset：pack-release.ps1 的「只含 Electron 的发布包」会写 SHA256SUMS-electron.txt，
# 两者撞名会互相覆盖，而这个文件是资产直链的校验依据，绝不能被顶掉。
$sums = Join-Path $OutDir 'SHA256SUMS-asset-electron.txt'
Set-Content -LiteralPath $sums -Value "$sha  $name.zip" -Encoding ASCII -Force

$sizeMB = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1)
Write-Host "Electron 包：$zip（$sizeMB MB）" -ForegroundColor Green
Write-Host "校验值：$sums" -ForegroundColor Green
Write-Host "SHA256：$sha" -ForegroundColor Green
Write-Host ''
Write-Host '下一步（只需做一次）：' -ForegroundColor Green
Write-Host "  1) 把这个 zip 上传到一个固定 tag 的 Release，例如 assets-v1（说明里写明「共享大件，请勿删除」）；" -ForegroundColor Green
Write-Host "  2) 把直链与 SHA256 填进 config\release.json 的 electronMirrorUrl / electronSha256 / electronVersion。" -ForegroundColor Green
Write-Host '  以后每个代码版本都指向它，不用再重传。' -ForegroundColor DarkGray
