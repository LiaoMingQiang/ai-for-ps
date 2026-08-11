@echo off
rem AI-for-PS ??????: ????????????????????
setlocal
set "PORTFILE=%TEMP%\a4p-port.txt"
del /q "%PORTFILE%" 2>nul
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
set "PORT=8754"
for /l %%i in (1,1,30) do (
  if exist "%PORTFILE%" (
    set /p PORT=<"%PORTFILE%"
    goto :ok
  )
  timeout /t 1 /nobreak >nul
)
:ok
start "" "http://127.0.0.1:%PORT%/"
endlocal