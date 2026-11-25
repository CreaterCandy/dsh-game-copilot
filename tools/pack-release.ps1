# pack-release.ps1 —— 生成"解压即用"的完整发布包
#
# 和 pack-model.ps1 的区别：
#   pack-model.ps1 只打模型包（给 git clone 的用户加速用）
#   本脚本打完整包：代码 + ASR 模型，用户下载解压后就是一个完整项目文件夹，
#   跑一次 setup.ps1（建 venv、装依赖、装插件）即可，模型那 464MB 不用再联网下。
#
# 产出：
#   dist\dsh-game-copilot-<版本>-full.zip   解压后是 dsh-game-copilot\ 整个目录
#   dist\SHA256SUMS-full.txt                校验值，一并上传到 Release
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\tools\pack-release.ps1 -ModelsDir D:\path\runtime\models
#   powershell -ExecutionPolicy Bypass -File .\tools\pack-release.ps1 -ModelsDir ... -Version v1.0.0
#
# 注意：模型目录不在公开仓库里（被 .gitignore 排除），必须用 -ModelsDir 指向一份
#       已下载好的 faster-whisper small 模型（目录里要有 model.bin）。

param(
    [string]$Version = '',
    [string]$ModelsDir = '',
    [string]$OutDir = (Join-Path $PSScriptRoot '..\dist')
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

    Write-Host '正在压缩完整包（请稍候，约 464MB）…' -ForegroundColor Cyan
    Compress-Archive -LiteralPath $appDir -DestinationPath $zip -CompressionLevel Optimal
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}

$sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$sums = Join-Path $OutDir 'SHA256SUMS-full.txt'
Set-Content -LiteralPath $sums -Value "$sha  $name.zip" -Encoding ASCII -Force

$sizeMB = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1)
Write-Host "完整包：$zip（$sizeMB MB）" -ForegroundColor Green
Write-Host "校验值：$sums" -ForegroundColor Green
Write-Host '下一步：把这两个文件上传到 GitHub Release。用户解压 zip 后跑 setup.ps1 即可（模型已在包内，自动跳过下载）。' -ForegroundColor Green
