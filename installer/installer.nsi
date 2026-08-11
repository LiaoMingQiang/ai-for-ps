; AI-for-PS 一键安装器 (NSIS 3, 可选: 生成真正的 setup.exe)
; 用法: 安装 NSIS 后, 右键本文件 -> Compile (或 makensis installer.nsi)
Unicode true
Name "AI-for-PS 电商 AI 工作台"
OutFile "AI-for-PS-Setup.exe"
InstallDir "$LOCALAPPDATA\AI-for-PS"
RequestExecutionLevel user

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "安装 (默认)" SEC_APP
  SetOutPath "$INSTDIR\app"
  File /r "app\*.*"
  SetOutPath "$INSTDIR"
  File "server.ps1"
  File "run.bat"
  File "uninstall.bat"

  CreateShortCut "$DESKTOP\AI-for-PS 工作台.lnk" "$INSTDIR\run.bat" "" "$INSTDIR"
  CreateDirectory "$SMPROGRAMS\AI-for-PS"
  CreateShortCut "$SMPROGRAMS\AI-for-PS\AI-for-PS 工作台.lnk" "$INSTDIR\run.bat" "" "$INSTDIR"
  CreateShortCut "$SMPROGRAMS\AI-for-PS\卸载 AI-for-PS.lnk" "$INSTDIR\uninstall.bat" "" "$INSTDIR"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-for-PS" "DisplayName" "AI-for-PS (电商 AI 工作台)"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-for-PS" "DisplayVersion" "0.5.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-for-PS" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-for-PS" "UninstallString" "$INSTDIR\uninstall.bat"
  WriteUninstaller "$INSTDIR\uninstaller.exe"
SectionEnd

Section "uninstall"
  nsExec::ExecToLog '"$INSTDIR\uninstall.bat"'
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\AI-for-PS 工作台.lnk"
  RMDir /r "$SMPROGRAMS\AI-for-PS"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-for-PS"
SectionEnd