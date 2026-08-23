/**
 * 接线审计：把「后端有什么」和「界面用了什么」摆在一起对。
 *
 * 这个工具要抓的是一类特别容易蒙混过关的问题 ——
 * 界面渲染得好好的，控件也能点，点了却什么都没发生；
 * 或者后端辛辛苦苦实现了一个能力，界面上根本没有入口。
 * 这两种都不会让任何测试变红，只会让用户觉得"这功能是不是坏了"。
 *
 * 查四件事：
 *   1. Helper 的每条路由，插件侧有没有对应的 api.* 方法
 *   2. 每个 api.* 方法，界面里有没有真的被调用
 *   3. 界面里的事件处理器有没有空壳（onclick 里啥也不干）
 *   4. 设置项（AppSettings 的字段）有没有界面在读写
 *
 * 允许存在的例外都要写进下面的白名单，并且**必须写清楚为什么**。
 * 白名单是给"确实不需要界面入口"的东西用的，不是给"还没做完"用的。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function read(p) {
  return readFileSync(resolve(root, p), 'utf8');
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out') continue;
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/* ---------------- 1. 路由 ↔ api 方法 ---------------- */

const serverSrc = read('packages/helper/src/server.ts');
const apiSrc = read('packages/plugin/src/app/api.ts');

const routes = [...serverSrc.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/g)].map((m) => ({
  method: m[1].toUpperCase(),
  path: m[2]
}));

/**
 * 这些路由不需要 api.* 方法，原因逐条写明。
 * 想往里加东西之前先问一句：是真的不需要界面，还是只是还没接？
 */
const ROUTE_EXEMPT = new Map([
  ['GET /v1/health', '由 api.ts 的 health() 单独导出，不走 api.* 命名空间（它必须免鉴权）'],
  ['POST /v1/pair/request', '配对握手由 repairPairing() 内联调用'],
  ['POST /v1/pair/confirm', '配对握手由 repairPairing() 内联调用'],
  ['GET /v1/assets/:id', '结果图由 <img src> 直接取，见 assetImgSrc()'],
  ['POST /v1/assets', '多段上传走原生 FormData，不经过 request()，见 uploadAsset()']
]);

/** 路由路径 → 在 api.ts 里出现过就算接上了（模板串里带参数，做模糊匹配）。 */
function routeIsWired(path) {
  // /v1/jobs/:id/cancel → 匹配 `/v1/jobs/${...}/cancel`
  const literal = path.replace(/:[a-zA-Z]+/g, '§');
  const parts = literal.split('§').filter(Boolean);
  return parts.every((seg) => apiSrc.includes(seg));
}

for (const r of routes) {
  const key = `${r.method} ${r.path}`;
  if (ROUTE_EXEMPT.has(key)) {
    notes.push(`豁免路由 ${key} —— ${ROUTE_EXEMPT.get(key)}`);
    continue;
  }
  if (!routeIsWired(r.path)) {
    problems.push(`后端路由 ${key} 在插件侧没有任何 api.* 方法调用它 —— 要么补上入口，要么删掉路由`);
  }
}

/* ---------------- 2. api 方法 ↔ 界面调用 ---------------- */

const uiFiles = walk(resolve(root, 'packages/plugin/src')).filter((f) => !f.endsWith('api.ts'));
const uiSrc = uiFiles.map((f) => read(relative(root, f))).join('\n');

const apiBlock = apiSrc.slice(apiSrc.indexOf('export const api = {'));
const apiMethods = [...apiBlock.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]);

/** 这些 api 方法界面暂时不用，原因逐条写明。 */
const API_EXEMPT = new Map([
  ['assetBytes', '资产占用统计，供「关于」页的存储信息用（走的是 system()），保留给诊断导出']
]);

for (const name of apiMethods) {
  if (API_EXEMPT.has(name)) {
    notes.push(`豁免 api.${name} —— ${API_EXEMPT.get(name)}`);
    continue;
  }
  const used = new RegExp(`\\bapi\\.${name}\\s*\\(`).test(uiSrc);
  if (!used) {
    problems.push(`api.${name}() 定义了却没有任何界面调用 —— 要么接上界面，要么删掉`);
  }
}

/* ---------------- 3. 空壳事件处理器 ---------------- */

for (const f of uiFiles) {
  const rel = relative(root, f).replaceAll('\\', '/');
  const src = read(rel);
  // onclick: () => {}   /  onclick: () => undefined  /  onclick() {}
  const empties = [
    /on[a-z]+:\s*\(\s*\)\s*=>\s*\{\s*\}/g,
    /on[a-z]+:\s*\(\s*\)\s*=>\s*undefined\s*[,}]/g,
    /on[a-z]+:\s*function\s*\([^)]*\)\s*\{\s*\}/g
  ];
  for (const re of empties) {
    for (const m of src.matchAll(re)) {
      problems.push(`${rel}: 空的事件处理器 \`${m[0].replace(/\s+/g, ' ')}\` —— 按钮点了不做事，比没有按钮更糟`);
    }
  }
}

/* ---------------- 4. 设置字段 ↔ 界面读写 ---------------- */

const settingsSrc = read('packages/shared/src/settings.ts');
const defaultsBlock = settingsSrc.slice(
  settingsSrc.indexOf('export function defaultSettings()'),
  settingsSrc.indexOf('export const SETTINGS_SCHEMA_VERSION') >= 0 ? undefined : undefined
);
const settingFields = [...defaultsBlock.matchAll(/^\s{6}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]);

/** 这些设置字段没有界面入口，原因逐条写明。 */
const SETTING_EXEMPT = new Map([
  ['schemaVersion', '迁移用的内部字段，不该给用户改'],
  ['lastFeatureId', '记住上次停留的功能，由生成页自动写入'],
  ['language', 'i18n 尚未开放切换，界面只有中文；开放前不摆一个改了没反应的下拉'],
  ['advancedExpanded', '高级参数折叠状态，由参数面板自己记'],
  ['runninghubWorkflowId', '云端默认工作流 id，设置页「云端」分节在用'],
  ['serverCommand', 'localServer 模式下才显示，见设置页 renderLocal'],
  ['serverWorkingDir', 'localServer 模式下才显示，见设置页 renderLocal']
]);

for (const field of new Set(settingFields)) {
  if (SETTING_EXEMPT.has(field)) {
    notes.push(`豁免设置项 ${field} —— ${SETTING_EXEMPT.get(field)}`);
    continue;
  }
  if (!new RegExp(`\\b${field}\\b`).test(uiSrc)) {
    problems.push(`设置项 ${field} 存在于 AppSettings，但界面上没有任何地方读或写它`);
  }
}

/* ---------------- 5. 只写不读的数据表 ---------------- */

/*
 * 建了表、也一直在往里写，却从来没有谁读过 —— 这种表不会报错，
 * 只会安静地长大，然后在某次排查时让人以为"这里应该有数据可以看"。
 * 要么给它接个消费者，要么承认它没用。
 */
const dbSrc = read('packages/helper/src/db.ts');
const helperSrc = walk(resolve(root, 'packages/helper/src'))
  .map((f) => read(relative(root, f)))
  .join('\n');

/** 允许只写不读的表，逐个说明理由。 */
const TABLE_EXEMPT = new Map([
  [
    'documents',
    '记录哪些文档产生过任务。历史页的「仅当前文档」筛选直接用 Photoshop 给的 documentId，' +
      '不需要查这张表；留着是为了在文档被改名/移动后还能还原当时的名字与路径。'
  ]
]);

const tables = [...dbSrc.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
for (const t of tables) {
  const readRe = new RegExp(`FROM ${t}\\b|JOIN ${t}\\b`);
  const writeRe = new RegExp(`INTO ${t}\\b|UPDATE ${t}\\b`);
  const isRead = readRe.test(helperSrc);
  const isWritten = writeRe.test(helperSrc);
  if (isWritten && !isRead) {
    if (TABLE_EXEMPT.has(t)) {
      notes.push(`豁免只写不读的表 ${t} —— ${TABLE_EXEMPT.get(t)}`);
      continue;
    }
    problems.push(`数据表 ${t} 一直在写却从来没被读过 —— 要么接个消费者，要么别写了`);
  }
}

/* ---------------- 输出 ---------------- */

if (process.argv.includes('--verbose')) {
  for (const n of notes) console.log(`      ${n}`);
  console.log('');
}

console.log(`审计范围：${routes.length} 条路由 · ${apiMethods.length} 个 api 方法 · ${uiFiles.length} 个界面文件`);

if (problems.length) {
  console.error('');
  for (const p of problems) console.error(`FAIL  ${p}`);
  console.error(`\n${problems.length} 处接线问题。`);
  process.exit(1);
}
console.log(`AUDIT-OK  路由、api 方法、事件处理器、设置项全部接上了（${notes.length} 条已记录的豁免）`);
