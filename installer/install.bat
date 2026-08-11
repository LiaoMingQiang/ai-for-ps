@echo off
rem ============================================================
rem  AI-for-PS ???? AI ????? - ?????? (Windows 10/11)
rem  ???: ??????? + ????????/??????????? + §Ø?????
rem  ?¡Â?: install.bat [?????] [-noshortcuts]
rem ============================================================
setlocal enabledelayedexpansion
set "APPNAME=AI-for-PS"
set "DEFAULT_TARGET=%LOCALAPPDATA%\AI-for-PS"
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=%DEFAULT_TARGET%"

rem ---- ??¦Ë?????? (?????œ… app\ ???????; ??¦Â???? uxp-plugin\) ----
set "SRC=%~dp0app"
if not exist "%SRC%\index.html" set "SRC=%~dp0..\uxp-plugin"
if not exist "%SRC%\index.html" (
  echo [????] ¦Ä??? index.html?????????????? uxp-plugin ??????, ??????? build.cmd ??? app\??
  pause
  exit /b 1
)

echo.
echo   AI-for-PS ???? AI ?????  v0.5.0 (mock preview)
echo   -------------------------------------------------------
echo   ???: %SRC%
echo   ?????: %TARGET%
echo.

rem ---- 1. ?????????? ----
if not exist "%TARGET%\app" mkdir "%TARGET%\app"
robocopy "%SRC%" "%TARGET%\app" /E /NFL /NDL /NJH /NJS >nul
if %ERRORLEVEL% GEQ 8 (
  echo [????] ??????????
  pause
  exit /b 1
)
if not exist "%TARGET%\server.ps1" copy /y "%~dp0server.ps1" "%TARGET%\server.ps1" >nul
if not exist "%TARGET%\run.bat" copy /y "%~dp0run.bat" "%TARGET%\run.bat" >nul

rem ---- 2. ????? (???? + ??????) ----
if /i not "%~2"=="-noshortcuts" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$s=New-Object -ComObject WScript.Shell;" ^
    "$lnk=$s.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\AI-for-PS ?????.lnk');" ^
    "$lnk.TargetPath='%TARGET%\run.bat';$lnk.WorkingDirectory='%TARGET%';$lnk.Description='AI-for-PS ???? AI ?????';$lnk.Save();" ^
    "$sm=[Environment]::GetFolderPath('StartMenu')+'\Programs\AI-for-PS';New-Item -ItemType Directory -Force -Path $sm|Out-Null;" ^
    "$l2=$s.CreateShortcut($sm+'\AI-for-PS ?????.lnk');$l2.TargetPath='%TARGET%\run.bat';$l2.WorkingDirectory='%TARGET%';$l2.Save();" ^
    "$l3=$s.CreateShortcut($sm+'\§Ø?? AI-for-PS.lnk');$l3.TargetPath='%TARGET%\uninstall.bat';$l3.WorkingDirectory='%TARGET%';$l3.Save();"
)

rem ---- 3. §Õ??§Ø????? (???????"??¨²????"???) ----
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-for-PS" /v DisplayName /t REG_SZ /d "AI-for-PS (???? AI ?????)" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-for-PS" /v DisplayVersion /t REG_SZ /d "0.5.0" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-for-PS" /v InstallLocation /t REG_SZ /d "%TARGET%" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-for-PS" /v DisplayIcon /t REG_SZ /d "%TARGET%\app\index.html" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-for-PS" /v UninstallString /t REG_SZ /d "%TARGET%\uninstall.bat" /f >nul

echo.
echo  ? ??????
echo    ????????:  AI-for-PS ?????
echo    ?????:      %TARGET%
echo    ???????:      http://127.0.0.1:8754 (??????, ??????)
echo.
choice /c YN /m "??????? AI-for-PS?"
if errorlevel 2 exit /b 0
start "" "%TARGET%\run.bat"
endlocal