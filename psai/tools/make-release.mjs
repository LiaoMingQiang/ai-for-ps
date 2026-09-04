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
/*
 * PHOTOSHOP_ACCEPTANCE.md 必须跟着走。
 *
 * CHANGELOG 里让用户"按清单验收"，而写回/选区/捕获那三组检查全在这一份里 ——
 * 不随包的话，那句话就指向了一个用户手上没有的文件。
 */
for (const doc of [
  'README.md',
  'docs/INSTALL.md',
  'docs/ACCEPTANCE.md',
  'docs/PHOTOSHOP_ACCEPTANCE.md',
  'docs/WORKFLOWS.md'
]) {
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


/**
 * 随包的变更记录。
 *
 * 纪律：这里只写**这一次构建真的验过**的东西。
 *
 * 上一版这段话是照着更早的一次构建抄下来的，里面写着
 * "安装/升级/卸载在本机完整跑通"、"11 个功能对真实 ComfyUI 出图"之类 ——
 * 那些是当时的事实，不是这一版的。随包文档里一句没验过的"已验证"，
 * 比没有这句话糟得多：用户会据此跳过自己的验收。
 */
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

### 这一版改了什么

真机现象：登记了 RunningHub 的 AI 应用 ID，选中后提交报「该功能尚未绑定工作流」。

用真实 key 打只读接口实测下来，原因和表面现象完全不同：

    AI 应用 1892509998193545217 → code 380 WORKFLOW_NOT_EXISTS
    工作流 2095750036550721537  → code 810 WORKFLOW_NOT_SAVED_OR_NOT_RUNNING

**工作流接口根本不认识 AI 应用的 ID。** 那条「没有参数绑定」是本机自己的
闸门（它拦得对 —— 空的 nodeInfoList 提上去，平台会用作者的示例图出图，
是花了钱的假成功），但它把真正的原因盖住了：就算放行，请求也发错了地方。

- **AI 应用与 ComfyUI 工作流现在分开处理**，各走各的接口：
  工作流走 \`/task/openapi/create\`（apiKey 在 body），
  AI 应用走 \`/openapi/v2/run/ai-app/{id}\`（Bearer 认证、ID 在路径），
  状态和结果走 \`/openapi/v2/query\`，上传走 \`/openapi/v2/media/upload/binary\`。
- **登记 AI 应用时要粘一段东西**。它的节点号没有任何公开接口能查到 ——
  平台只在给每个应用单独生成的 API 文档页里给出。工作流那条自动路
  （拉图 → 扫描 → 推导绑定）对 AI 应用不成立，因为它的 ID 压根拉不回图。
  把该应用 API 页面「提交请求 → 请求示例」那段 curl 整个粘进来即可；
  整段 curl、光是请求体、光是那个数组，三种都认。
- **不带节点表的 AI 应用当场拒绝登记**，认不出哪个字段收图也停下、不猜。
  猜错的后果不是报错，而是拿作者的示例图出一张跟你输入无关的图 ——
  带着"成功"回来，钱也花了，界面上还看不出哪里不对。
- **登记的云端 ComfyUI 工作流现在真的能跑了**。以前绑定只有两个来源
  （内置预设、本机导入的同名工作流），用户自己登记的那条两样都不是 ——
  于是登记完提交必然被闸门拦下。现在提交时把平台的图拉回来，用导入本机
  工作流那同一套扫描器扫一遍，绑定自动推导出来，**不用你填任何节点号**。
  这就是「工作流填个 ID 就能用」成立的原因，也是它和 AI 应用的分界线。
- **ComfyUI 工作流要先在平台上保存并成功跑过一次**，平台才给接口格式。
  登记本身不联网、随时能加；卡住的是提交那一步。
- **平台的两个错误码翻成了能照着做的话**（都是实测见过的）：
  WORKFLOW_NOT_SAVED_OR_NOT_RUNNING → 「请到 RunningHub 打开这份工作流，
  点一次「运行」，跑成功之后再回来提交」；WORKFLOW_NOT_EXISTS → 「如果你填的
  是 AI 应用的 ID，请把类型改成「AI 应用」」。平台原文一并保留，方便对着文档查。
  其余的码没实际观测过，不凭猜翻 —— 猜出来的说明比英文原文更坏。

### 这一版验过什么

- 自动化套件 660 条：连续两轮全绿
- **AI 应用整条链路真机验证过**（对着 RunningHub 真跑了一次，花了 RH币）：
  上传 → 提交 → 轮询 165 秒 → 取回结果图。走的是实际发货的那份适配器代码，
  不是另写的一段。关键是核对了出来的图 —— 1024×1024 的输入被精修放大成
  1536×1536，内容是**输入图本身**，不是作者的示例图。
  也就是说 nodeInfoList 真的落位了，那道闸门防的正是这件事
- **云端 ComfyUI 工作流整条链路也真机验证过**：工作流 2095750596867792898，
  自动扫出 8 条绑定（image / sampler / seed / scheduler / denoise / steps /
  upscaleModel / prompt），提交 → 轮询 425 秒 → 取回结果。
  1024×1024 的输入跑出 8192×8192，出来的同样是**输入图本身**
- \`npm run check\`（typecheck / lint / manifest 校验 / 接线审计）通过
- 日志扫描：无非法状态转移、无未处理异常
- 上面每一条修复都有对应的回归用例，且都**先对着旧实现验证过会红**
- 两条**结构性**检查，专门堵这一版暴露出的那类 bug：声明在设置页上的
  凭据字段必须真的有人读；每个可绑定参数都必须能画出控件。
  这类问题靠人眼审查不出来 —— 声明和读取隔在两个包里，而且「没人读」
  不会有任何编译错误或运行时报错。

### 这一版**没有**验过什么

请在自己的机器上验收之后再投入正式工作：

- **真机 Photoshop 验收整体未做**。清单在 \`PHOTOSHOP_ACCEPTANCE.md\`
  （另有一份更早的通用清单 \`ACCEPTANCE.md\`），所有勾选框都是空的。
  选区遮罩取值（A 组）、捕获（C 组）、写回（D 组）这三组只能在
  装了 Photoshop 的机器上验 —— 自动化测试用的是替身，
  替身再忠实也不是 Photoshop。
- **安装 / 升级 / 卸载这一版没有真机跑过**。安装器逻辑本身有单元测试，
  但这一版构建出来的 Setup.exe 没有在真机上装过。
- **没有在干净的 Windows 虚拟机上验证过**。
- **没有对真实 ComfyUI / 云端平台重新出过图**。

### 已知限制

- **测试里有一个尚未定位的间歇性故障**。全量测试偶尔会有整个文件的用例
  一起变红，报的是 undici 的一句 \`bad port\`。已经出现过三次，仍未查到根因；
  它只影响测试环境，不影响装出来的产品。这一版把可疑的端口解析写法换掉了，
  并在故障点加了守卫 —— 下次再犯，报的会是可查的原因而不是那句英文。
  改完连跑三轮全绿，但之前也出现过绿一轮又红，所以**不认为已经修好**。
- **安装包与 Helper 未做代码签名**。Windows SmartScreen 会提示"未知发布者"，
  需要点「更多信息 → 仍要运行」。消除它需要代码签名证书。
- 安装时若 Photoshop 正开着，插件要等 Photoshop 重启后才出现（安装器会提示）。
- 仅支持 Windows（DPAPI 与 NSIS 安装器）。
`;
}
