#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make-release: 组装 release/ 交付物
- AI-for-PS.ccx            (uxp-plugin zip 改名)
- helper/AI-for-PS-Helper.exe + scripts/dpapi.ps1
- AI-for-PS-Setup.nsi      (NSIS 安装器脚本, 含 Helper 安装+自启动+UXP 注册)
- install-helper.bat       (自启动注册 + 启动 helper)
- checksums.txt            (SHA-256)
- CHANGELOG.md / README.md (由仓库根复制/生成)
"""
import hashlib
import os
import shutil
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELEASE = os.path.join(ROOT, "release")
VERSION = "0.9.0"

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def main():
    if os.path.exists(RELEASE):
        shutil.rmtree(RELEASE)
    os.makedirs(os.path.join(RELEASE, "helper"), exist_ok=True)
    os.makedirs(os.path.join(RELEASE, "uxp"), exist_ok=True)

    # 1. CCX (uxp-plugin -> zip -> .ccx)
    plugin_dir = os.path.join(ROOT, "uxp-plugin")
    ccx_path = os.path.join(RELEASE, "AI-for-PS.ccx")
    with zipfile.ZipFile(ccx_path, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _dirs, files in os.walk(plugin_dir):
            for fn in files:
                full = os.path.join(base, fn)
                rel = os.path.relpath(full, plugin_dir)
                z.write(full, rel)
    print("[release] AI-for-PS.ccx:", os.path.getsize(ccx_path), "bytes")

    # 2. Helper exe + dpapi.ps1
    bundle = os.path.join(ROOT, "helper", "dist-bundle")
    exe_src = os.path.join(bundle, "AI-for-PS-Helper.exe")
    if not os.path.exists(exe_src):
        print("[release] WARN: AI-for-PS-Helper.exe 不存在, 跳过")
    else:
        shutil.copy2(exe_src, os.path.join(RELEASE, "helper", "AI-for-PS-Helper.exe"))
        os.makedirs(os.path.join(RELEASE, "helper", "scripts"), exist_ok=True)
        shutil.copy2(os.path.join(bundle, "scripts", "dpapi.ps1"), os.path.join(RELEASE, "helper", "scripts", "dpapi.ps1"))
        print("[release] helper/AI-for-PS-Helper.exe copied")

    # 3. NSIS 安装器脚本 (Helper 安装 + 自启动 + UXP)
    nsi = f"""; AI-for-PS 正式安装器 (NSIS 3) — {VERSION}
Unicode true
Name "AI for PS {VERSION}"
OutFile "AI-for-PS-Setup.exe"
InstallDir "$LOCALAPPDATA\\AI-for-PS"
RequestExecutionLevel user
SetCompressor /SOLID lzma

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Helper 服务" SEC_HELPER
  SetOutPath "$INSTDIR\\helper"
  File /r "helper\\*.*"
  ; 自启动 (用户登录自动运行, 单实例由 Helper 自身保证)
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "AI-for-PS-Helper" '"$INSTDIR\\helper\\AI-for-PS-Helper.exe"'
  ; 立即启动
  Exec '"$INSTDIR\\helper\\AI-for-PS-Helper.exe"'
SectionEnd

Section "Photoshop 插件 (UXP)" SEC_UXP
  SetOutPath "$INSTDIR\\uxp"
  File "AI-for-PS.ccx"
  ; 说明: 正式发布需签名 .ccx; 开发模式经 UXP Developer Tool 加载
SectionEnd

Section "卸载信息" SEC_UNINST
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AI-for-PS" "DisplayName" "AI for PS (Photoshop AI 工作台)"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AI-for-PS" "DisplayVersion" "{VERSION}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AI-for-PS" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AI-for-PS" "UninstallString" '"$INSTDIR\\uninstaller.exe"'
  WriteUninstaller "$INSTDIR\\uninstaller.exe"
SectionEnd

Section "uninstall"
  DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "AI-for-PS-Helper"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AI-for-PS"
  RMDir /r "$INSTDIR"
SectionEnd
"""
    with open(os.path.join(RELEASE, "AI-for-PS-Setup.nsi"), "w", encoding="utf-8") as f:
        f.write(nsi)
    print("[release] AI-for-PS-Setup.nsi written")

    # 4. install-helper.bat (自启动注册 + 启动)
    bat = f"""@echo off
rem AI for PS Helper {VERSION} — 安装到 %%LOCALAPPDATA%%\\AI-for-PS\\helper 并注册自启动
set "DEST=%%LOCALAPPDATA%%\\AI-for-PS\\helper"
if not exist "%%DEST%%" mkdir "%%DEST%%"
copy /Y "%~dp0helper\\AI-for-PS-Helper.exe" "%%DEST%%\\" >nul
if not exist "%%DEST%%\\scripts" mkdir "%%DEST%%\\scripts"
copy /Y "%~dp0helper\\scripts\\dpapi.ps1" "%%DEST%%\\scripts\\" >nul
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "AI-for-PS-Helper" /t REG_SZ /d "\\"%%DEST%%\\AI-for-PS-Helper.exe\\"" /f >nul
start "" "%%DEST%%\\AI-for-PS-Helper.exe"
echo Helper 已安装并启动: http://127.0.0.1:33057/v1/health
"""
    with open(os.path.join(RELEASE, "install-helper.bat"), "w", encoding="utf-8") as f:
        f.write(bat)
    print("[release] install-helper.bat written")

    # 5. checksums
    lines = []
    for base, _dirs, files in os.walk(RELEASE):
        for fn in sorted(files):
            p = os.path.join(base, fn)
            rel = os.path.relpath(p, RELEASE).replace("\\", "/")
            lines.append(f"{sha256(p)}  {rel}")
    with open(os.path.join(RELEASE, "checksums.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("[release] checksums.txt written")

    # 6. CHANGELOG
    changelog = f"""# CHANGELOG

## {VERSION} (开发里程碑)
- 真实 UXP 插件入口 (Manifest v5 + entrypoints.setup), Photoshop 25.2+
- 真实 PhotoshopBridge: 图层/选区/蒙版快照导出 PNG, 智能对象/像素层写回, 选区原位写回, 写回前文档校验
- 本地 Helper (Fastify + SQLite + WS): 配对 token 认证, 单实例, DPAPI 凭据, Asset Store (sha256/去重), Project Context, 生成血缘
- Provider Adapter: ComfyUI (官方 API + 安全取消 + 恢复不重提交), OpenAI Compatible, Gemini, 火山方舟, 阿里百炼, RunningHub, ModelScope
- Job Engine: 18 态状态机 + job_events + 重启恢复 (先查远端) + 并发闸
- Workflow 导入/扫描/Studio/版本 (不覆盖旧版本), 依赖中心 (真实 ComfyUI 扫描)
- GPU Monitor, Workers, 成本中心 (本地 GPU 时长, 不虚构云费用)
- Agent: 受控工具 + Plan 批准 + 全量审计
- 打包: AI-for-PS-Helper.exe (Node SEA 单文件), AI-for-PS.ccx, NSIS 安装器 (自启动)

## 0.5.0 (历史)
- 浏览器预览版 (ComfyUI 真实链路)
"""
    with open(os.path.join(RELEASE, "CHANGELOG.md"), "w", encoding="utf-8") as f:
        f.write(changelog)
    print("[release] CHANGELOG.md written")

    # 7. README
    readme = f"""# AI for PS {VERSION} — Release

Photoshop 原生设计环境 + AI Workflow Operating Layer。

## 交付物
- `AI-for-PS.ccx` — Photoshop UXP 插件 (Manifest v5, PS 25.2+)
- `helper/AI-for-PS-Helper.exe` — 本地 Helper (单文件, 无需 Node/Python)
- `AI-for-PS-Setup.nsi` — NSIS 安装器 (编译为 AI-for-PS-Setup.exe, 含 Helper 安装 + 自启动)
- `install-helper.bat` — 免 NSIS 的 Helper 安装/自启动脚本
- `checksums.txt` — SHA-256 校验

## 架构
UXP Plugin → 本地 Helper (SQLite/DPAPI/JobEngine/ProviderAdapters) → ComfyUI / OpenAI Compatible / Gemini / 火山方舟 / 阿里百炼 / RunningHub / ModelScope

## 安装
1. 运行 install-helper.bat (或安装 AI-for-PS-Setup.exe)
2. Helper 自动启动于 http://127.0.0.1:33057 (首次自动配对)
3. Photoshop 中通过 UXP Developer Tool 加载 AI-for-PS.ccx (正式签名发布后可直接安装)

## 版本状态
{VERSION} — 开发里程碑; 1.0.0 Release Gate 尚未全部通过 (需 Photoshop 实机 E2E)
"""
    with open(os.path.join(RELEASE, "README.md"), "w", encoding="utf-8") as f:
        f.write(readme)
    print("[release] README.md written")

    print("[release] done:", RELEASE)

if __name__ == "__main__":
    main()
