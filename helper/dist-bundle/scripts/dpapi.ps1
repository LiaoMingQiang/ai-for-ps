# DPAPI protect/unprotect via .NET ProtectedData (CurrentUser scope)
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File dpapi.ps1 -Mode protect -Base64Data <b64>
param([string]$Mode, [string]$Base64Data)
Add-Type -AssemblyName System.Security
if ($Mode -eq 'protect') {
  $bytes = [Convert]::FromBase64String($Base64Data)
  $enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($enc))
} elseif ($Mode -eq 'unprotect') {
  $bytes = [Convert]::FromBase64String($Base64Data)
  $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($dec))
} else {
  Write-Error "unknown mode: $Mode"
  exit 1
}
