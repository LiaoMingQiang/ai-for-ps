/**
 * 页面渲染冒烟测试：在 UXP 的 DOM **子集**上，把每个页面、每个功能都渲染一遍。
 *
 * 这个测试是补票补出来的。生成页曾经整页白屏，原因是代码里调了
 * `Element.toggleAttribute` —— 浏览器有、jsdom 有、UXP 没有。
 * typecheck 过、lint 过、bundle 也构建成功，只有装进 Photoshop 点开那一页才炸。
 *
 * 所以这里刻意不用 jsdom：用 test/uxp-dom.mjs 那个只提供 UXP 确实有的 API 的实现，
 * 页面碰了不该碰的东西就当场抛，CI 就能在进 Photoshop 之前拦住。
 *
 * Helper 是真起的进程、真发 HTTP、真读 SQLite —— 页面拿到的功能列表、
 * 参数 schema、工作流、绑定状态全部来自真实接口，不是编出来的假数据。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';

import { startHelper } from '../../helper/dist/index.js';
import { installUxpDom } from './uxp-dom.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// 端口用 0 让系统分配：写死端口时，上一次跑崩留下的进程会一直占着，
// 后面每次 npm test 都报 EADDRINUSE，看起来像测试坏了，其实是环境脏了。
let PORT = 0;

let helper;
let dataDir;
let ui;
let dom;
let pairToken;

/** 把插件源码打成 ESM，好在 Node 里直接 import 页面模块。 */
async function bundlePagesForTest(outfile) {
  const entry = join(here, '.pages-entry.mjs');
  writeFileSync(
    entry,
    [
      "export * from '../src/ui/page-generate.js';",
      "export { renderHistoryPage } from '../src/ui/page-history.js';",
      "export { renderSettingsPage } from '../src/ui/page-settings.js';",
      "export { renderComfyWebPage } from '../src/ui/page-comfyweb.js';",
      "export { setState, getState, paramsOf, setParams } from '../src/app/store.js';",
      "export { api, useHelperAt } from '../src/app/api.js';"
    ].join('\n'),
    'utf8'
  );
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: ['es2022'],
    // UXP 的宿主模块在 Node 里不存在，用桩顶上；写回能力本来就只能在 PS 里验
    plugins: [
      {
        name: 'uxp-stub',
        setup(b) {
          b.onResolve({ filter: /^(photoshop|uxp|os|fs)$/ }, (a) => ({ path: a.path, namespace: 'uxp-stub' }));
          b.onLoad({ filter: /.*/, namespace: 'uxp-stub' }, () => ({
            contents: `
              const notInPs = () => { throw new Error('UXP-ONLY'); };
              export const app = { get documents() { return []; }, activeDocument: null };
              export const action = { batchPlay: notInPs };
              export const core = { executeAsModal: notInPs };
              export const constants = {};
              export const imaging = {};
              export const storage = { localFileSystem: {} };
              export const shell = { openExternal: () => {} };
              export const versions = { uxp: '8.0.0', photoshop: '26.0.0' };
              export default { app, action, core, constants, imaging, storage, shell, versions };
            `,
            loader: 'js'
          }));
        }
      }
    ],
    logLevel: 'silent'
  });
  rmSync(entry, { force: true });
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-pages-'));
  helper = await startHelper({ port: 0, dataDir, workflowsDir: resolve(here, '../../../workflows') });
  PORT = Number(new URL(helper.url).port);

  dom = installUxpDom();

  const outfile = join(dataDir, 'pages.test.mjs');
  await bundlePagesForTest(outfile);
  ui = await import(pathToFileURL(outfile).href);

  // 真配对，拿真 token，页面走的是真实鉴权路径
  const req = await fetch(`http://127.0.0.1:${PORT}/v1/pair/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: 'pages-test' })
  });
  const { challenge } = await req.json();
  const con = await fetch(`http://127.0.0.1:${PORT}/v1/pair/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge })
  });
  const { token } = await con.json();
  pairToken = token;
  ui.useHelperAt(`http://127.0.0.1:${PORT}`, token);
});

after(async () => {
  await helper?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

test('每个功能的生成页都能在 UXP DOM 子集上渲染出来', async () => {
  const { features } = await ui.api.features();
  assert.ok(features.length >= 17, `功能数应为 17 个以上，实际 ${features.length}`);
  ui.setState({ features });

  const failures = [];
  for (const f of features) {
    const host = dom.document.createElement('div');
    dom.root.appendChild(host);
    ui.setState({ featureId: f.id, activeJobId: null });
    try {
      await ui.renderGeneratePage(host);
    } catch (e) {
      failures.push(`${f.id}: ${e?.message ?? e}`);
      continue;
    }
    // 渲染出来必须真的有内容，不能是个空壳
    if (host.children.length === 0) failures.push(`${f.id}: 渲染完是空的`);
    // 页面里如果画出了渲染出错字样，说明它自己吞了异常，同样算失败
    if (host.textContent.includes('渲染出错')) failures.push(`${f.id}: 页面内部报错`);
    dom.root.removeChild(host);
  }
  assert.deepEqual(failures, [], `以下功能的生成页渲染失败：\n${failures.join('\n')}`);
});

test('生成页画出了图像输入、参数控件和提交按钮', async () => {
  const { features } = await ui.api.features();
  ui.setState({ features });
  // 挑一个参数最全的功能：有图输入、提示词、种子、滑块
  const rich = features.find((f) => f.id === 'comfy.relight.adaptive') ?? features[0];
  ui.setState({ featureId: rich.id, activeJobId: null });

  const host = dom.document.createElement('div');
  dom.root.appendChild(host);
  await ui.renderGeneratePage(host);

  const html = host.outerHTML;
  assert.ok(host.querySelector('.featnav'), '缺少功能导航');
  assert.ok(/提交|生成/.test(html), '缺少主行动按钮');
  assert.ok(host.querySelectorAll('.param').length > 0 || /param/.test(html), '一个参数控件都没画出来');
  dom.root.removeChild(host);
});

test('历史页 / 设置页 / ComfyUI Web 页都能渲染', async () => {
  for (const [name, render] of [
    ['历史页', ui.renderHistoryPage],
    ['设置页', ui.renderSettingsPage],
    ['ComfyUI Web 页', ui.renderComfyWebPage]
  ]) {
    const host = dom.document.createElement('div');
    dom.root.appendChild(host);
    await render(host);
    assert.ok(host.children.length > 0, `${name}渲染完是空的`);
    assert.ok(!host.textContent.includes('渲染出错'), `${name}内部报错`);
    dom.root.removeChild(host);
  }
});

test('UXP DOM 子集会挡住 toggleAttribute 与两参数 classList.toggle', () => {
  const el = dom.document.createElement('div');
  assert.equal(typeof el.toggleAttribute, 'undefined', 'UXP 没有 toggleAttribute，桩里也不该有');
  assert.throws(() => el.classList.toggle('x', true), /两参数/, '两参数 toggle 必须报错');
  // 单参数是 UXP 支持的，不该被挡
  assert.doesNotThrow(() => el.classList.toggle('x'));
});

test('设置页在绑定 RunningHub 时画出预设选择器而不是裸输入框', async () => {
  // 先把一个功能绑到 RunningHub 的内置预设上
  const put = await fetch(`http://127.0.0.1:${PORT}/v1/features/cloud.product.whitebg/binding`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pairToken}` },
    body: JSON.stringify({ providerId: 'runninghub', remoteWorkflowId: '1897193863243878401', enabled: true })
  });
  assert.ok(put.ok, `绑定接口返回 ${put.status}`);

  // 设置页默认停在「本地」页签，得先切到「固定功能」
  const host = dom.document.createElement('div');
  dom.root.appendChild(host);
  await ui.renderSettingsPage(host);
  const tab = host.querySelectorAll('.subtab').find((b) => b.textContent === '固定功能');
  assert.ok(tab, '找不到「固定功能」页签');
  tab.dispatchEvent({ type: 'click' });
  // 页签切换是异步重绘，等一轮微任务 + 网络往返
  await new Promise((r) => setTimeout(r, 300));

  const picker = host.querySelector('.rh-picker');
  assert.ok(picker, '绑到 RunningHub 后应该出现预设选择器 .rh-picker');
  const text = picker.textContent;
  assert.ok(text.includes('BiRefNet'), `选择器里应显示预设名，实际：${text.slice(0, 120)}`);
  assert.ok(text.includes('节点'), '应显示节点数等元信息');
  dom.root.removeChild(host);
});

test('token 失效时请求层会自动重新配对并重放，而不是一直 401', async () => {
  // 装一个假 token，模拟「Helper 换过数据目录 / 用户点过重新配对」之后的状态
  ui.useHelperAt(`http://127.0.0.1:${PORT}`, 'this-token-is-not-in-the-database');

  // 这一句以前会抛 HELPER_UNAUTHORIZED：/v1/health 免鉴权所以状态条显示已连接，
  // 但每个卡片都是「未配对或配对已失效」，界面说连上了、功能全是坏的。
  const settings = await ui.api.settings();
  assert.ok(settings?.comfy, '自动重配对后应该能正常拿到设置');

  // 重放用的必须是新换来的 token，不是那个假的
  const jobs = await ui.api.jobs({ limit: 1 });
  assert.ok(Array.isArray(jobs), '重新配对后其它接口也应该可用');
});

test('并发的多个 401 只会触发一次重新配对', async () => {
  const countPairings = () => {
    const db = new DatabaseSync(join(dataDir, 'psai.sqlite'), { readOnly: true });
    try {
      return db.prepare('SELECT COUNT(*) AS n FROM pairing WHERE revoked = 0').get().n;
    } finally {
      db.close();
    }
  };

  const before = countPairings();
  ui.useHelperAt(`http://127.0.0.1:${PORT}`, 'another-bogus-token');

  // 六个请求同时撞上 401。每个各配一次的话会凭空多出六条配对记录，
  // 数据库里堆一堆没人用的长期 token —— 既是垃圾也是攻击面。
  const results = await Promise.all([
    ui.api.settings(),
    ui.api.providers(),
    ui.api.workflows(),
    ui.api.features(),
    ui.api.jobs({ limit: 1 }),
    ui.api.settings()
  ]);
  assert.ok(results.every((r) => r !== undefined && r !== null), '六个请求都应该成功');
  assert.equal(countPairings(), before + 1, `六个并发 401 只该产生 1 条新配对，实际多了 ${countPairings() - before} 条`);
});

test('导入的工作流可以在设置页改参数绑定，并且真的存回后端', async () => {
  // 造一份最小可用的 API 格式工作流：一个 LoadImage + 一个 CLIPTextEncode + SaveImage
  const graph = {
    1: { class_type: 'LoadImage', inputs: { image: 'sample.png', upload: 'image' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: '一只猫' } },
    3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, denoise: 1, sampler_name: 'euler', scheduler: 'normal' } },
    4: { class_type: 'SaveImage', inputs: { filename_prefix: 'x', images: ['1', 0] } }
  };
  const imported = await ui.api.importWorkflow(graph, '绑定编辑器测试用');
  const id = imported.workflow.id;

  // 扫描器先猜一套绑定
  const before = await ui.api.workflow(id);
  assert.ok(before.bindings.length > 0, '导入时应该自动带上扫描器猜的绑定');

  // 用户把「重绘幅度」改绑到 KSampler.denoise，并把提示词那条去掉
  const corrected = [
    { paramId: 'image', nodeId: '1', input: 'image', required: false },
    { paramId: 'denoise', nodeId: '3', input: 'denoise', required: false },
    { paramId: 'steps', nodeId: '3', input: 'steps', required: false }
  ];
  const saved = await ui.api.saveWorkflowBindings(id, corrected);
  assert.equal(saved.bindings.length, 3, '保存后的绑定条数应该是 3');

  const after = await ui.api.workflow(id);
  const keys = after.bindings.map((b) => `${b.paramId}->${b.nodeId}.${b.input}`).sort();
  assert.deepEqual(keys, ['denoise->3.denoise', 'image->1.image', 'steps->3.steps'], `实际存下来的是 ${keys.join(', ')}`);
  assert.ok(!after.bindings.some((b) => b.paramId === 'prompt'), '被用户去掉的提示词绑定不该还在');

  await ui.api.deleteWorkflow(id);
});

test('绑定编辑器只对导入的工作流出现，内置工作流不给改', async () => {
  const workflows = await ui.api.workflows();
  const builtin = workflows.find((w) => w.source === 'builtin');
  const host = dom.document.createElement('div');
  dom.root.appendChild(host);
  await ui.renderSettingsPage(host);
  const tab = host.querySelectorAll('.subtab').find((b) => b.textContent === '工作流');
  tab.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(builtin, '前置条件：应该有内置工作流');
  const rows = host.querySelectorAll('.wf-row');
  assert.ok(rows.length > 0, '工作流列表应该有内容');
  // 内置工作流那一行不该有「参数绑定」按钮
  const builtinRow = rows.find((r) => r.textContent.includes(builtin.name) && r.textContent.includes('内置'));
  assert.ok(builtinRow, '找不到内置工作流那一行');
  assert.ok(!builtinRow.textContent.includes('参数绑定'), '内置工作流不该出现参数绑定入口');
  dom.root.removeChild(host);
});

test('用量接口真的在汇总 usage 表，「关于」页会把它显示出来', async () => {
  // usage 表以前只写不读 —— 一直在长大，界面上却没有任何地方能看到。
  // 这里既验接口的聚合是对的，也验「关于」页确实消费了它。
  const db = new DatabaseSync(join(dataDir, 'psai.sqlite'));
  try {
    const ins = db.prepare('INSERT INTO usage(job_id, provider_id, at, gpu_ms, note) VALUES(?, ?, ?, ?, ?)');
    ins.run('job_a', 'comfyui', 1000, 5000, '本地 GPU 时长');
    ins.run('job_b', 'comfyui', 2000, 7000, '本地 GPU 时长');
    ins.run('job_c', 'runninghub', 3000, null, '云端调用');
  } finally {
    db.close();
  }

  const usage = await ui.api.usage();
  const comfy = usage.find((u) => u.providerId === 'comfyui');
  const rh = usage.find((u) => u.providerId === 'runninghub');
  assert.ok(comfy, '应该聚合出 comfyui 一行');
  assert.equal(comfy.runs, 2, 'comfyui 应该是 2 次');
  assert.equal(comfy.gpuMs, 12000, 'GPU 时长应该累加成 12000');
  assert.equal(comfy.lastAt, 2000, '最近一次应该取最大的 at');
  assert.ok(rh, '应该聚合出 runninghub 一行');
  assert.equal(rh.gpuMs, 0, '云端没有本地 GPU 时长，SUM(NULL) 要归零而不是 null');

  // 「关于」页必须真的把它画出来
  const host = dom.document.createElement('div');
  dom.root.appendChild(host);
  await ui.renderSettingsPage(host);
  const tab = host.querySelectorAll('.subtab').find((b) => b.textContent === '关于');
  tab.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 400));
  assert.match(host.textContent, /用量/, '关于页应该显示用量');
  dom.root.removeChild(host);
});

test('生成页的主行动按钮在滚动区外面，参数再多也不用滚就能看到', async () => {
  // 以前它在 page-host 里靠 position: sticky 钉底部：浏览器没问题，
  // 但 UXP 不支持 sticky，退化成 static 之后又被 -90px 的负边距吃掉了可滚动高度，
  // 在 Photoshop 里怎么滚都滚不到「开始处理」，等于没有提交入口。
  const { features } = await ui.api.features();
  ui.setState({ features });
  // 挑一个参数最多的功能，最能暴露"要滚很久"的问题
  const rich = features.find((f) => f.id === 'comfy.relight.adaptive') ?? features[0];
  ui.setState({ featureId: rich.id, activeJobId: null });

  const host = dom.document.createElement('div');
  const actionHost = dom.document.createElement('div');
  dom.root.appendChild(host);
  dom.root.appendChild(actionHost);
  await ui.renderGeneratePage(host, actionHost);

  const bar = actionHost.querySelector('.submitbar');
  assert.ok(bar, '主行动按钮必须挂在滚动区外面的 actionHost 上');
  assert.equal(host.querySelector('.submitbar'), null, '滚动区里不该再有一份');

  const btn = actionHost.querySelectorAll('button').find((b) => b.classList.contains('btn-submit'));
  assert.ok(btn, '找不到提交按钮');
  assert.match(btn.textContent, /开始/, `按钮文案应说明这一步做什么，实际：${btn.textContent}`);

  dom.root.removeChild(host);
  dom.root.removeChild(actionHost);
});

test('没有 actionHost 时按钮退回画在页面里，不会凭空消失', async () => {
  const { features } = await ui.api.features();
  ui.setState({ features, featureId: features[0].id, activeJobId: null });
  const host = dom.document.createElement('div');
  dom.root.appendChild(host);
  await ui.renderGeneratePage(host);
  assert.ok(host.querySelector('.submitbar'), '不传 actionHost 时必须退回画在 host 里');
  dom.root.removeChild(host);
});

test('云端功能即使没有显式绑定，也能解析出可用的 Provider', async () => {
  // /v1/features 以前自己算 providerId，少了「按能力挑一个已配置 Provider」的兜底，
  // 于是没绑定过的云端功能一律被判成「未配置任何闭源模型 Provider」并禁用 ——
  // 而提交路径其实是能跑通的。界面说不能用、后端说能用，两边各算各的。
  await ui.api.setCredentials('comfly', { apiKey: 'sk-FAKEtest0000000000000000' });
  await ui.api.patchProvider('comfly', { enabled: true });

  const { features } = await ui.api.features();
  // 只看**没有显式绑定**的云端功能 —— 这正是当初出问题的那一类。
  // 显式绑到某个没配 Key 的后端上而不可用，是正确行为，不该混进来。
  const cloud = features.filter((f) => f.branch === 'cloud' && !f.binding?.providerId);
  assert.ok(cloud.length > 0, '前置条件：应该有没绑定过的云端功能');

  const unresolved = cloud.filter((f) => !f.providerId);
  assert.deepEqual(
    unresolved.map((f) => f.id),
    [],
    `配了闭源 Provider 之后，这些云端功能仍然解析不出后端：${unresolved.map((f) => f.id).join(', ')}`
  );
  // 解析得出来，生成页才会去拉模型列表 —— 否则模型下拉永远停在「尚未拉取模型列表」
  const notReady = cloud.filter((f) => !f.ready).map((f) => `${f.id}: ${f.reason}`);
  assert.deepEqual(notReady, [], `这些未绑定的云端功能应该可用：${notReady.join(' | ')}`);
});
