# pack-model.ps1 —— 生成可放到 Release 的 ASR 模型包
#
# 产出：
#   dist\dsh-game-copilot-model-small.zip   解压后是 runtime\models\
#   dist\SHA256SUMS.txt                 校验值，一并上传到 Release
#
# 用法：powershell -ExecutionPolicy Bypass -File .\tools\pack-model.ps1

param(
    [string]$OutDir = (Join-Path $PSScriptRoot '..\dist'),
    [string]$ModelsDir = ''
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$models = if ($ModelsDir) { $ModelsDir } else { Join-Path $root 'runtime\models' }
if (-not (Test-Path $models)) { throw "没找到模型目录：$models" }

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$zip = Join-Path $OutDir 'dsh-game-copilot-model-small.zip'
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }

# 用临时目录保证压缩包根目录就是 models/，和 setup.ps1 的解压目标一致
$stage = Join-Path $OutDir '_stage'
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
    Copy-Item -LiteralPath $models -Destination (Join-Path $stage 'models') -Recurse -Force
    Write-Host '正在压缩模型包（约 464MB，请稍候）…' -ForegroundColor Cyan
    Compress-Archive -LiteralPath (Join-Path $stage 'models') -DestinationPath $zip -CompressionLevel Optimal
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}

$sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$sums = Join-Path $OutDir 'SHA256SUMS.txt'
Set-Content -LiteralPath $sums -Value "$sha  dsh-game-copilot-model-small.zip" -Encoding ASCII -Force

Write-Host "模型包：$zip" -ForegroundColor Green
Write-Host "校验值：$sums" -ForegroundColor Green
Write-Host '下一步：把这两个文件上传到 GitHub Release，并把直链与 SHA256 填进 config\release.json。' -ForegroundColor Green
