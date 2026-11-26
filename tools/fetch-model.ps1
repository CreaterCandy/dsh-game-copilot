# fetch-model.ps1 —— 准备 faster-whisper small 模型
#
# 顺序：
#   1. 已有 model.bin 就直接返回
#   2. config/release.json 里填了镜像地址和 SHA256 → 下载、校验、解压
#   3. 镜像失败或没填 → 回退 faster-whisper 官方下载（需要联网）
#
# 可单独运行：powershell -ExecutionPolicy Bypass -File .\tools\fetch-model.ps1

param(
    [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\runtime'),
    [string]$PythonExe = ''
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseCfg = Join-Path $root 'config\release.json'
$modelsDir = Join-Path $RuntimeDir 'models'

function Test-ModelReady {
    if (-not (Test-Path $modelsDir)) { return $false }
    $bin = Get-ChildItem -LiteralPath $modelsDir -Recurse -File -Filter 'model.bin' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    return [bool]$bin
}

if (Test-ModelReady) {
    Write-Host 'ASR 模型已就绪，跳过下载。' -ForegroundColor Green
    exit 0
}

# 大文件下载：PowerShell 5.1 的 Invoke-WebRequest 会把整个响应读进内存再写盘，
# 下 400MB+ 的模型又慢又占内存。BITS 支持断点续传、有原生进度条，优先用它；
# 拿不到（服务被禁等）就退回流式写盘的 WebClient。
# ⚠️ setup.ps1 里有一份同样的实现，改这里要同步那边。
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

$mirrorUrl = ''
$expectedSha = ''
if (Test-Path $releaseCfg) {
    try {
        # 显式按 UTF-8 读：PowerShell 5.1 默认按 ANSI 读无 BOM 文件，会把中文说明读坏
        $jsonText = [IO.File]::ReadAllText($releaseCfg, [Text.Encoding]::UTF8)
        $cfg = $jsonText | ConvertFrom-Json
        if ($cfg.modelMirrorUrl) { $mirrorUrl = [string]$cfg.modelMirrorUrl }
        if ($cfg.modelSha256) { $expectedSha = ([string]$cfg.modelSha256).Trim().ToLowerInvariant() }
    } catch {
        Write-Host "读取 $releaseCfg 失败：$($_.Exception.Message)" -ForegroundColor Yellow
    }
}

if ($mirrorUrl) {
    $zip = Join-Path ([IO.Path]::GetTempPath()) ("dsh-game-copilot-model-" + [guid]::NewGuid().ToString('N') + '.zip')
    try {
        Write-Host "从 Release 镜像下载模型包（约 430MB，只需一次）：$mirrorUrl" -ForegroundColor Cyan
        Save-RemoteFile -Url $mirrorUrl -OutFile $zip -Label 'ASR 模型包'

        if ($expectedSha) {
            $actualSha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualSha -ne $expectedSha) {
                throw "SHA256 不匹配：期望 $expectedSha，实际 $actualSha"
            }
            Write-Host 'SHA256 校验通过。' -ForegroundColor Green
        } else {
            Write-Host '未提供 SHA256，跳过校验（建议补上）。' -ForegroundColor Yellow
        }

        New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
        Expand-Archive -LiteralPath $zip -DestinationPath $RuntimeDir -Force
        Write-Host '模型包已解压。' -ForegroundColor Green
    } catch {
        Write-Host "镜像下载 / 校验 / 解压失败：$($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host '将回退到官方下载源。' -ForegroundColor Yellow
    } finally {
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    }
}

if (Test-ModelReady) {
    Write-Host 'ASR 模型已就绪（镜像）。' -ForegroundColor Green
    exit 0
}

if (-not $PythonExe) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $PythonExe = $cmd.Source }
}
if (-not $PythonExe) {
    Write-Host '未找到 Python，无法回退官方下载。' -ForegroundColor Yellow
    exit 1
}

Write-Host '回退 faster-whisper 官方下载（首次约 464MB）…' -ForegroundColor Cyan
if (-not (Test-Path $RuntimeDir)) { New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null }
Push-Location $RuntimeDir
try {
    & $PythonExe -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8', download_root='models')"
    if ($LASTEXITCODE -eq 0) {
        Write-Host 'ASR 模型已就绪（官方源）。' -ForegroundColor Green
        exit 0
    }
    Write-Host '官方下载未返回成功码，模型可能不完整。' -ForegroundColor Yellow
    exit 1
} catch {
    Write-Host "官方下载失败：$($_.Exception.Message)" -ForegroundColor Yellow
    exit 1
} finally {
    Pop-Location
}
