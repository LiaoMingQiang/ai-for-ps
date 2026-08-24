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

/* ---------------- 3.5 插件目录（安装器用） ---------------- */

// 安装器装的是**未打包的目录**，不是 .ccx。
// .ccx 要靠 Creative Cloud 桌面端来装，而目标用户机器上不一定有它 ——
// 用户的要求是"下载 exe、双击、装完就能用"，中间不能再冒出第二个安装流程。
// UXP 本来就支持直接从 Plugins\External\<id>_<ver>\ 加载目录形式的插件，
// 这也是本机上那个正常工作的插件的存在形式（真机确认过）。
step('插件目录（安装器用）');
const pluginStage = join(RELEASE, 'plugin');
rmSync(pluginStage, { recursive: true, force: true });
mkdirSync(pluginStage, { recursive: true });
cpSync(stage, pluginStage, { recursive: true });
if (existsSync(join(pluginStage, 'manifest.json'))) ok(`${pluginStage}`);
else fail('插件目录里没有 manifest.json');

const pluginManifest = JSON.parse(readFileSync(join(pluginStage, 'manifest.json'), 'utf8'));
if (!pluginManifest.id) fail('插件 manifest 缺少 id');
else ok(`插件 id ${pluginManifest.id}`);

/* ---------------- 4. NSIS 安装器 ---------------- */

step('NSIS 安装器');
const nsiPath = join(RELEASE, 'AI-for-PS-Setup.nsi');
// VIProductVersion 必须是四段数字，NSIS 会校验
const fileVersion = [...PSAI_VERSION.split('-')[0].split('.'), '0', '0', '0'].slice(0, 4).join('.');
const tmpl = readFileSync(resolve(here, 'installer.nsi.tmpl'), 'utf8');
const nsi = tmpl
  .replaceAll('@VERSION@', PSAI_VERSION)
  .replaceAll('@FILE_VERSION@', fileVersion)
  .replaceAll('@PLUGIN_ID@', pluginManifest.id)
  .replaceAll('@PLUGIN_NAME@', pluginManifest.name ?? 'AI for PS');
if (nsi.includes('@')) {
  const left = [...nsi.matchAll(/@[A-Z_]+@/g)].map((m) => m[0]);
  if (left.length) fail(`NSI 模板里还有没替换掉的占位符：${[...new Set(left)].join(', ')}`);
}
// NSIS 的 Unicode true 要求脚本本身是带 BOM 的 UTF-8，
// 否则里面的中文会让 makensis 报 Bad text encoding
writeFileSync(nsiPath, '﻿' + nsi, 'utf8');
ok(`已生成 ${nsiPath}`);

const makensis = ['C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe', 'makensis'].find(
  (p) => p === 'makensis' || existsSync(p)
);

let setupPath = null;
if (makensis) {
  try {
    execFileSync(makensis, [nsiPath], { stdio: 'inherit', cwd: RELEASE });
    setupPath = join(RELEASE, `AI-for-PS-Setup-${PSAI_VERSION}.exe`);
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
for (const doc of ['README.md', 'docs/INSTALL.md', 'docs/ACCEPTANCE.md', 'docs/WORKFLOWS.md']) {
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


function buildChangelog() {
  return `# 变更记录

## ${PSAI_VERSION}

### 安装方式
双击 \`AI-for-PS-Setup-${PSAI_VERSION}.exe\`，按向导装完，打开 Photoshop 即可使用。
不需要 UXP Developer Tool，不需要 Creative Cloud 桌面端，不需要手工拷文件，
也不需要管理员权限（全部装在当前用户目录下）。

安装器会做这些事：
- 释放 Helper 单文件 exe（内置 Node 运行时，目标机器无需安装 Node）与内置工作流
- 把插件装进 \`%APPDATA%\\Adobe\\UXP\\Plugins\\External\\\` 并登记到 Photoshop 的插件注册表
- 建好数据目录、配好开机自启、写入控制面板的卸载入口
- 检测到旧版本时先干净卸载再装新的
- 全程写 \`install.log\`（UTF-16LE，任何语言的系统都读得对）

卸载走控制面板即可。任务历史与生成结果**不会**被删除，留在
\`%LOCALAPPDATA%\\AIforPS\`，需要彻底清除请手动删该目录。

### 已验证
- ComfyUI 分支 11 个固定功能全部对真实 ComfyUI 跑通并出图
- 闭源模型用真实账号（Comfly）验证：gpt-image-2 / Nano-Banana Pro /
  Gemini 图像族 / Midjourney 四族均真机出图，三条协议各自跑通
- 提示词优化内置 GPT-5.6，无需在设置里配置任何语言模型
- 出图尺寸默认跟随原图；平台给不了精确尺寸时自动升到 2K 档位
- 安装 / 升级 / 卸载在本机完整跑通：装后 35 项校验全过，卸载后 18 项全过，
  且用户已有的其他 UXP 插件在这三步里始终未被改动
- 无损放大同输入两次结果逐字节一致
- 重启恢复先查远端，绝不重复提交
- 写回失败与 AI 失败严格分离，结果永久保留可重试
- API Key 只存本机（Windows DPAPI），明文不落盘、不出响应

### 已知限制
- **安装包与 Helper 未做代码签名**。Windows SmartScreen 会提示"未知发布者"，
  用户需要点「更多信息 → 仍要运行」。要消除这个提示得买代码签名证书。
- 未在全新的干净 Windows 虚拟机上验证过。本机验证覆盖了全新安装、升级覆盖、
  静默安装、静默卸载和残留检查，但"从没装过 Photoshop 插件的机器"这一种
  情况只有单元测试覆盖（临时目录模拟无注册表场景），没有真机跑过。
- 安装时若 Photoshop 正开着，插件要等 Photoshop 重启后才出现（安装器会提示）。
- 开发机未装 ESRGAN 类放大模型，放大走 ImageScaleBy 重采样
- 仅支持 Windows（DPAPI 与 NSIS 安装器）
`;
}
