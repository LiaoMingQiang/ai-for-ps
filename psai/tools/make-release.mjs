/**
 * 打交付物：Helper 单文件 exe + 插件 .ccx + NSIS 安装器 + 校验和。
 *
 * 用法：node tools/make-release.mjs
 * 输出：psai/release/
 *
 * 纪律：每一步都要真的产出文件并校验，做不出来的就明确报错，
 * 不允许"跳过但当作成功"。
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  cpSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeZip, listZip, collectFiles } from './zip.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const RELEASE = resolve(ROOT, 'release');

const { PSAI_VERSION } = await import(pathToFileURL(resolve(ROOT, 'packages/shared/dist/index.js')).href);

const problems = [];
function step(name) {
  console.log(`\n=== ${name} ===`);
}
function ok(msg) {
  console.log(`  OK   ${msg}`);
}
function fail(msg) {
  console.log(`  FAIL ${msg}`);
  problems.push(msg);
}

/* ---------------- 1. 构建 ---------------- */

step('构建各包');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
ok('shared / helper / plugin 均已构建');

/* ---------------- 2. Helper exe ---------------- */

step('Helper 单文件 exe');
execFileSync(process.execPath, [resolve(here, 'bundle-helper.mjs')], { cwd: ROOT, stdio: 'inherit' });
const exePath = join(RELEASE, 'helper', 'AI-for-PS-Helper.exe');
if (existsSync(exePath)) ok(`${exePath} (${(statSync(exePath).size / 1048576).toFixed(1)} MB)`);
else fail('Helper exe 没有产出');

/* ---------------- 3. 插件 .ccx ---------------- */

step('插件 .ccx');
const PLUGIN = resolve(ROOT, 'packages/plugin');
const stage = resolve(ROOT, '.tmp/ccx');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// .ccx 里只放运行时需要的东西：清单、入口、打好的包、样式、图标
for (const item of ['manifest.json', 'index.html', 'dist', 'styles', 'assets']) {
  const src = join(PLUGIN, item);
  if (!existsSync(src)) {
    fail(`插件缺少 ${item}`);
    continue;
  }
  cpSync(src, join(stage, item), { recursive: true });
}
// sourcemap 不进交付物
const distMap = join(stage, 'dist/main.js.map');
if (existsSync(distMap)) rmSync(distMap);

const ccxPath = join(RELEASE, 'AI-for-PS.ccx');
mkdirSync(RELEASE, { recursive: true });
rmSync(ccxPath, { force: true });

const zipped = writeZip(ccxPath, collectFiles(stage));
ok(`${ccxPath} (${(zipped.bytes / 1024).toFixed(0)} KB, ${zipped.entries} 个条目)`);

/* 校验 .ccx 内容：条目名必须用正斜杠，manifest 必须在包根 */
step('校验 .ccx');
const entries = listZip(ccxPath);
ok(`${entries.length} 个条目`);
const backslashed = entries.filter((e) => e.includes('\\'));
if (backslashed.length) fail(`条目名用了反斜杠，不符合 ZIP 规范：${backslashed.join(', ')}`);
else ok('条目名全部使用正斜杠');

if (!entries.includes('manifest.json')) fail('.ccx 根目录下没有 manifest.json（Photoshop 会拒绝安装）');
else ok('manifest.json 在包根');
if (!entries.some((e) => e === 'index.html')) fail('.ccx 缺少 index.html');
if (!entries.some((e) => e.startsWith('dist/main.js'))) fail('.ccx 缺少 dist/main.js');
if (!entries.some((e) => e.startsWith('styles/'))) fail('.ccx 缺少 styles/');
if (!entries.some((e) => e.startsWith('assets/'))) fail('.ccx 缺少图标');
if (entries.some((e) => e.endsWith('.map'))) fail('.ccx 里混入了 sourcemap');

/* manifest 版本要和产品版本一致 */
const manifest = JSON.parse(readFileSync(join(PLUGIN, 'manifest.json'), 'utf8'));
if (manifest.version !== PSAI_VERSION) fail(`manifest 版本 ${manifest.version} 与产品版本 ${PSAI_VERSION} 不一致`);
else ok(`版本一致 ${PSAI_VERSION}`);

/* ---------------- 4. NSIS 安装器 ---------------- */

step('NSIS 安装器');
const nsiPath = join(RELEASE, 'AI-for-PS-Setup.nsi');
// NSIS 的 Unicode true 要求脚本本身是带 BOM 的 UTF-8，
// 否则里面的中文会让 makensis 报 Bad text encoding
writeFileSync(nsiPath, '﻿' + buildNsi(), 'utf8');
ok(`已生成 ${nsiPath}`);

const makensis = ['C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe', 'makensis'].find(
  (p) => p === 'makensis' || existsSync(p)
);

let setupPath = null;
if (makensis) {
  try {
    execFileSync(makensis, [nsiPath], { stdio: 'inherit', cwd: RELEASE });
    setupPath = join(RELEASE, 'AI-for-PS-Setup.exe');
    if (existsSync(setupPath)) ok(`${setupPath} (${(statSync(setupPath).size / 1048576).toFixed(1)} MB)`);
    else {
      fail('makensis 跑完但没有产出 Setup.exe');
      setupPath = null;
    }
  } catch (e) {
    fail(`makensis 编译失败：${e instanceof Error ? e.message : String(e)}`);
  }
} else {
  fail('本机没有安装 NSIS，无法编译 Setup.exe（.nsi 脚本已生成，可在装了 NSIS 的机器上编译）');
}

/* ---------------- 5. 随包文档 ---------------- */

step('随包文档');
for (const doc of ['README.md', 'docs/ACCEPTANCE.md', 'docs/WORKFLOWS.md']) {
  const src = resolve(ROOT, doc);
  if (existsSync(src)) {
    cpSync(src, join(RELEASE, doc.split('/').pop()));
    ok(doc);
  }
}
writeFileSync(join(RELEASE, 'CHANGELOG.md'), buildChangelog(), 'utf8');
ok('CHANGELOG.md');

/* ---------------- 6. 校验和 ---------------- */

step('校验和');
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name !== 'checksums.txt') files.push(p);
  }
};
walk(RELEASE);

const lines = files
  .sort()
  .map((f) => {
    const hash = createHash('sha256').update(readFileSync(f)).digest('hex');
    return `${hash}  ${relative(RELEASE, f).replaceAll('\\', '/')}`;
  });
writeFileSync(join(RELEASE, 'checksums.txt'), lines.join('\n') + '\n', 'utf8');
ok(`${lines.length} 个文件已记录 SHA-256`);

/* ---------------- 汇总 ---------------- */

step('汇总');
console.log(`  版本 ${PSAI_VERSION}`);
console.log(`  输出目录 ${RELEASE}`);
if (problems.length) {
  console.log(`\n  未完成 ${problems.length} 项：`);
  for (const p of problems) console.log(`   - ${p}`);
  process.exitCode = 1;
} else {
  console.log('  RELEASE-OK 全部交付物就绪');
}

/* ---------------- 模板 ---------------- */

function buildNsi() {
  return `; AI for PS 安装器
; 由 tools/make-release.mjs 生成

Unicode true
!include "MUI2.nsh"

Name "AI for PS Helper"
OutFile "AI-for-PS-Setup.exe"
; 程序装在 Programs 下，数据留在 %LOCALAPPDATA%\\AIforPS —— 两者必须分开，
; 否则卸载时一不小心就把用户几个月的任务历史和生成结果一起删了
InstallDir "$LOCALAPPDATA\\Programs\\AIforPS"
RequestExecutionLevel user
ShowInstDetails show

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Helper" SecHelper
  SetOutPath "$INSTDIR"
  File "helper\\AI-for-PS-Helper.exe"
  File "helper\\run-helper.bat"

  SetOutPath "$INSTDIR\\workflows"
  File /r "helper\\workflows\\*.*"

  SetOutPath "$INSTDIR"
  File "AI-for-PS.ccx"
  File /nonfatal "README.md"
  File /nonfatal "ACCEPTANCE.md"
  File /nonfatal "CHANGELOG.md"
  File "checksums.txt"

  ; 开机自启：Helper 必须一直在，插件才连得上
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "AIforPSHelper" '"$INSTDIR\\AI-for-PS-Helper.exe"'

  ; 卸载信息
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AIforPS" "DisplayName" "AI for PS Helper"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AIforPS" "DisplayVersion" "${PSAI_VERSION}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AIforPS" "UninstallString" '"$INSTDIR\\Uninstall.exe"'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AIforPS" "InstallLocation" "$INSTDIR"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"

  ; 装完立刻起一次，用户不用重启。
  ; 用 ExecShell 而不是 Exec：Exec 起的子进程和安装器进程绑在一起，
  ; 静默安装结束时会被一并收走，结果就是"装完了但 Helper 没在跑"。
  ExecShell "open" "$INSTDIR\\AI-for-PS-Helper.exe" SW_SHOWMINNOACTIVE
SectionEnd

Section "Uninstall"
  ; 先把还在跑的 Helper 关掉，否则文件删不掉
  nsExec::Exec 'taskkill /F /IM AI-for-PS-Helper.exe'
  Sleep 800

  DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "AIforPSHelper"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AIforPS"

  Delete "$INSTDIR\\AI-for-PS-Helper.exe"
  Delete "$INSTDIR\\run-helper.bat"
  Delete "$INSTDIR\\AI-for-PS.ccx"
  Delete "$INSTDIR\\README.md"
  Delete "$INSTDIR\\ACCEPTANCE.md"
  Delete "$INSTDIR\\CHANGELOG.md"
  Delete "$INSTDIR\\checksums.txt"
  Delete "$INSTDIR\\Uninstall.exe"
  RMDir /r "$INSTDIR\\workflows"
  RMDir "$INSTDIR"

  ; 任务历史与结果资产默认保留，用户可以自己删
  DetailPrint "任务历史与生成结果保留在 $LOCALAPPDATA\\AIforPS，如需清除请手动删除该目录。"
SectionEnd
`;
}

function buildChangelog() {
  return `# 变更记录

## ${PSAI_VERSION}

首个版本。

### 已验证
- ComfyUI 分支 11 个固定功能全部对真实 ComfyUI 跑通并出图
- 无损放大同输入两次结果逐字节一致
- 重启恢复先查远端，绝不重复提交
- 写回失败与 AI 失败严格分离，结果永久保留可重试
- API Key 只存本机（Windows DPAPI），明文不落盘、不出响应

### 已知限制
- 闭源模型与 RunningHub 只做了协议实现与桩测试，未用真实账号验证
- .ccx 未经 Adobe 签名，需用 UXP Developer Tool 以开发模式加载
- 开发机未装 ESRGAN 类放大模型，放大走 ImageScaleBy 重采样
- 仅支持 Windows（DPAPI 与 NSIS 安装器）
`;
}
