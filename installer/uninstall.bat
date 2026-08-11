@echo off
rem AI-for-PS 卸载: 停止服务/旧 Helper -> 删除应用/快捷方式/注册表
rem 用法: uninstall.bat [目标目录]   (默认 %LOCALAPPDATA%\AI-for-PS)
setlocal
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=%LOCALAPPDATA%\AI-for-PS"

echo 正在停止本地服务与 Helper 进程...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '%TARGET%\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
timeout /t 1 /nobreak >nul

echo 正在删除文件...
if exist "%TARGET%" rmdir /s /q "%TARGET%"

echo 正在删除快捷方式...
if exist "%USERPROFILE%\Desktop\AI-for-PS 工作台.lnk" del /q "%USERPROFILE%\Desktop\AI-for-PS 工作台.lnk"
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\AI-for-PS" rmdir /s /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\AI-for-PS"

echo 正在清理注册表...
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-for-PS" /f >nul 2>&1

echo.
echo  ? AI-for-PS 已卸载
pause
endlocal