# AI-for-PS 本地服务 (无依赖 PowerShell, 仅监听 127.0.0.1)
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1 [-Port 8754] [-Root <目录>]
param([int]$Port = 8754, [string]$Root = "")
$ErrorActionPreference = "Stop"

# 默认根目录: launcher 同级 app\ (由安装器生成), 否则当前目录
if (-not $Root) {
  $candidate = Join-Path $PSScriptRoot "app"
  if (Test-Path -LiteralPath (Join-Path $candidate "index.html") -PathType Leaf) { $Root = $candidate }
  else { $Root = $PSScriptRoot }
}
$Root = (Resolve-Path -LiteralPath $Root).Path

$mime = @{
  ".html" = "text/html; charset=utf-8"; ".css" = "text/css; charset=utf-8"
  ".js" = "application/javascript; charset=utf-8"; ".mjs" = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"; ".png" = "image/png"; ".jpg" = "image/jpeg"
  ".jpeg" = "image/jpeg"; ".gif" = "image/gif"; ".svg" = "image/svg+xml"; ".ico" = "image/x-icon"
  ".webp" = "image/webp"; ".woff2" = "font/woff2"; ".map" = "application/json"
}
$portFile = Join-Path $env:TEMP "a4p-port.txt"
try { Remove-Item -LiteralPath $portFile -ErrorAction SilentlyContinue } catch { }

$listener = $null
$actualPort = $Port
for ($try = 0; $try -lt 6; $try++) {
  try {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://127.0.0.1:$actualPort/")
    $listener.Start()
    break
  } catch {
    $listener = $null
    $actualPort++
  }
}
if (-not $listener) { Write-Error "无法监听 127.0.0.1:$Port 附近端口, 请释放端口后重试"; exit 1 }

try { [System.IO.File]::WriteAllText($portFile, "$actualPort") } catch { }
Write-Host "AI-for-PS 本地服务已启动: http://127.0.0.1:$actualPort/  根目录: $Root  (Ctrl+C 退出)"

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    $path = $ctx.Request.Url.AbsolutePath.TrimStart("/") -replace "/", "\"
    if ($path -eq "") { $path = "index.html" }
    $file = Join-Path $Root $path
    if (Test-Path -LiteralPath $file -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $res.StatusCode = 200
      $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
      $body = [System.Text.Encoding]::UTF8.GetBytes("404 - $path")
      $res.ContentLength64 = $body.Length
      $res.OutputStream.Write($body, 0, $body.Length)
    }
    $res.OutputStream.Close()
  } catch { }
}
$listener.Stop()