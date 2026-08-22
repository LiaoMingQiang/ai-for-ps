/**
 * 校验 UXP manifest 与插件入口的一致性。
 * 任何不一致都会让插件在 Photoshop 里静默不出现，所以这里全部当作硬错误。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = resolve(root, 'packages/plugin');

const problems = [];
const notes = [];

function fail(msg) {
  problems.push(msg);
}

const manifestPath = resolve(pluginDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  fail('缺少 packages/plugin/manifest.json');
} else {
  let m;
  try {
    m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    fail(`manifest.json 不是合法 JSON: ${e.message}`);
  }

  if (m) {
    if (m.manifestVersion !== 5) fail(`manifestVersion 必须是 5，当前 ${m.manifestVersion}`);
    if (!m.id) fail('缺少 id');
    if (!m.version) fail('缺少 version');
    if (m.host?.app !== 'PS') fail('host.app 必须是 PS');
    if (!m.host?.minVersion) fail('缺少 host.minVersion');

    const main = m.main;
    if (!main) fail('缺少 main');
    else if (!existsSync(resolve(pluginDir, main))) fail(`main 指向的文件不存在: ${main}`);

    const eps = m.entrypoints ?? [];
    if (eps.length === 0) fail('至少要有一个 entrypoint');
    const ids = new Set();
    for (const ep of eps) {
      if (!ep.id) fail('entrypoint 缺少 id');
      if (ids.has(ep.id)) fail(`entrypoint id 重复: ${ep.id}`);
      ids.add(ep.id);
      if (!['panel', 'command'].includes(ep.type)) fail(`entrypoint ${ep.id} 的 type 非法: ${ep.type}`);
      if (!ep.label?.default) fail(`entrypoint ${ep.id} 缺少 label.default`);
    }

    // 图标文件必须真实存在，否则 Photoshop 面板会显示空白图标
    const iconPaths = new Set();
    for (const list of [m.icons ?? [], ...eps.map((e) => e.icons ?? [])]) {
      for (const icon of list) iconPaths.add(icon.path);
    }
    for (const p of iconPaths) {
      if (!existsSync(resolve(pluginDir, p))) fail(`图标文件不存在: ${p}`);
    }

    // 入口 id 必须在源码里被真正注册
    const entrySrc = resolve(pluginDir, 'src/entry.ts');
    if (!existsSync(entrySrc)) {
      notes.push('尚未创建 src/entry.ts（P6 阶段建立）');
    } else {
      const src = readFileSync(entrySrc, 'utf8');
      for (const ep of eps) {
        // 入口 id 可能是带引号的字符串，也可能是对象字面量里的裸键（panels: { psaiMain: {...} }），
        // 所以按整词匹配，不要只找带引号的写法。
        const escaped = ep.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`\\b${escaped}\\b`).test(src)) {
          fail(`entrypoint ${ep.id} 未在 src/entry.ts 中注册`);
        }
      }
    }

    // 网络白名单必须覆盖 Helper 端口
    const sharedIndex = resolve(root, 'packages/shared/src/index.ts');
    if (existsSync(sharedIndex)) {
      const portMatch = readFileSync(sharedIndex, 'utf8').match(/HELPER_DEFAULT_PORT\s*=\s*(\d+)/);
      if (portMatch) {
        const port = portMatch[1];
        const domains = m.requiredPermissions?.network?.domains ?? [];
        const covered = domains.some((d) => d.includes(`:${port}`));
        if (!covered) fail(`network.domains 未覆盖 Helper 端口 ${port}`);
        const wsCovered = domains.some((d) => d.startsWith('ws://') && d.includes(`:${port}`));
        if (!wsCovered) fail(`network.domains 缺少 ws:// 条目（端口 ${port}）`);
      }
    }

    // 版本必须与 shared 的 PSAI_VERSION 一致
    if (existsSync(sharedIndex)) {
      const v = readFileSync(sharedIndex, 'utf8').match(/PSAI_VERSION\s*=\s*'([^']+)'/);
      if (v && v[1] !== m.version) fail(`manifest.version(${m.version}) 与 PSAI_VERSION(${v[1]}) 不一致`);
    }

    if (m.requiredPermissions?.webview?.allow !== 'yes') {
      notes.push('webview 权限未开启：ComfyUI Web 内嵌路径将不可用');
    }
  }
}

for (const n of notes) console.log(`NOTE  ${n}`);
if (problems.length) {
  for (const p of problems) console.error(`FAIL  ${p}`);
  process.exit(1);
}
console.log('VALIDATE-OK  manifest 与入口一致性检查通过');
