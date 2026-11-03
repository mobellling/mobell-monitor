# 推送一个可被应用检查到的新版本
#
# 用法：
#   $env:GITHUB_TOKEN = "ghp_xxx"      # 需要 repo 权限的 Token（能创建 Release）
#   powershell -ExecutionPolicy Bypass -File scripts\push-release.ps1 -Version 1.1.0
#
# 发布前请确认安装包已生成：
#   dist/windows/MobellMonitor-<版本>-win64.zip
#   dist/android/MobellMonitor-<版本>.apk
#   （可选）dist/ios/MobellMonitor-<版本>-unsigned.ipa
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Repo = "mobellling/mobell-monitor",
    [string]$Notes = "",
    [string]$NotesFile = "",
    [switch]$Draft
)

$ErrorActionPreference = "Stop"

$token = $env:GITHUB_TOKEN
if (-not $token) {
    throw "请先设置环境变量 GITHUB_TOKEN（需要 repo 权限，可创建 Release 并上传附件）。"
}

$version = $Version.TrimStart("v")
$tag = "v$version"

$body = $Notes
if (-not $body -and $NotesFile) {
    if (-not (Test-Path $NotesFile)) { throw "找不到更新说明文件：$NotesFile" }
    $body = Get-Content $NotesFile -Raw -Encoding UTF8
}
if (-not $body) {
    $body = "Mobell 博客监控 v$version" + [Environment]::NewLine + [Environment]::NewLine + "修复问题并改进体验。"
}

$assets = @(
    @{ Path = "dist/windows/MobellMonitor-$version-win64.zip"; Name = "MobellMonitor-$version-win64.zip" },
    @{ Path = "dist/android/MobellMonitor-$version.apk"; Name = "MobellMonitor-$version.apk" },
    @{ Path = "dist/ios/MobellMonitor-$version-unsigned.ipa"; Name = "MobellMonitor-$version-unsigned.ipa" }
)

$existing = @()
foreach ($asset in $assets) {
    if (Test-Path $asset.Path) {
        $existing += $asset
    } else {
        Write-Host "跳过（不存在）：$($asset.Path)" -ForegroundColor DarkYellow
    }
}
if (-not $existing) {
    throw "没有找到任何安装包，请先执行 Windows/Android 构建。"
}

$headers = @{
    Authorization          = "Bearer $token"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "MobellMonitor-Release"
}

# 如果同名 Release 已存在，先复用并删除旧附件
$existingRelease = $null
try {
    $existingRelease = Invoke-RestMethod -Method Get -Uri "https://api.github.com/repos/$Repo/releases/tags/$tag" -Headers $headers
} catch {
    $existingRelease = $null
}

if ($existingRelease) {
    Write-Host "Release $tag 已存在，复用该 Release。" -ForegroundColor Yellow
    $release = $existingRelease
    foreach ($asset in @($release.assets)) {
        Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/$Repo/releases/assets/$($asset.id)" -Headers $headers | Out-Null
    }
    $update = @{ name = "Mobell 博客监控 v$version"; body = $body; draft = [bool]$Draft; prerelease = $false } | ConvertTo-Json -Depth 4
    $release = Invoke-RestMethod -Method Patch -Uri "https://api.github.com/repos/$Repo/releases/$($release.id)" -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($update)) -ContentType "application/json; charset=utf-8"
} else {
    $payload = @{
        tag_name   = $tag
        name       = "Mobell 博客监控 v$version"
        body       = $body
        draft      = [bool]$Draft
        prerelease = $false
    } | ConvertTo-Json -Depth 4
    $release = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Repo/releases" -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -ContentType "application/json; charset=utf-8"
}

foreach ($asset in $existing) {
    $uploadUrl = "https://uploads.github.com/repos/$Repo/releases/$($release.id)/assets?name=$($asset.Name)"
    Write-Host "上传 $($asset.Name) …" -ForegroundColor Cyan
    curl.exe --fail-with-body -sS -X POST `
        -H "Authorization: Bearer $token" `
        -H "User-Agent: MobellMonitor-Release" `
        -H "Content-Type: application/octet-stream" `
        --data-binary "@$($asset.Path)" `
        $uploadUrl | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "上传失败：$($asset.Name)"
    }
}

Write-Host ""
Write-Host "发布完成：$($release.html_url)" -ForegroundColor Green
Write-Host "应用会在下次启动或点击“检查更新”时看到 v$version。"
