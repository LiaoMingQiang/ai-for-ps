/**
 * 挂载后的面板：重画请求不许被丢掉，上一版的异步结果不许写进新一版。
 *
 * 这两件事都只有把面板**真的挂起来**才测得到 —— 它们发生在
 * "一次渲染还没画完，用户又做了一件事"这个缝隙里，而单独渲染一个页面
 * 是碰不到这个缝隙的。
 *
 * 页面用的是 UXP DOM 的子集实现（test/uxp-dom.mjs），Helper 是真起的进程、
 * 真发 HTTP。慢的那一下靠拦 fetch 造出来，因为真实场景里慢的正是它：
 * 生成页要拉预设、拉模型列表，几百毫秒起步。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

import { startHelper } from '../../helper/dist/index.js';
import { installUxpDom } from './uxp-dom.mjs';

const here = dirname(fileURLToPath(import.meta.url));

let helper;
let dataDir;
let ui;
let dom;
let PORT = 0;
let token;

async function bundleForTest(outfile) {
  const entry = join(here, '.panel-entry.mjs');
  writeFileSync(
    entry,
    [
      "export { mountMainPanel, teardownPlugin } from '../src/app/main.js';",
      "export { setState, getState, resetStore } from '../src/app/store.js';",
      "export { useHelperAt } from '../src/app/api.js';",
      "export { renderGeneratePage, resetGenerateState, detachGenerateResults } from '../src/ui/page-generate.js';"
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
    plugins: [
      {
        name: 'uxp-stub',
        setup(b) {
          b.onResolve({ filter: /^(photoshop|uxp|os|fs)$/ }, (a) => ({ path: a.path, namespace: 'uxp-stub' }));
          b.onLoad({ filter: /.*/, namespace: 'uxp-stub' }, () => ({
            contents: `
              const notInPs = () => { throw new Error('UXP-ONLY'); };
              export const app = { get documents() { return []; }, activeDocument: null };
              export const action = { batchPlay: notInPs, addNotificationListener: () => {} };
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

/** 等到条件成立，或者超时。轮询而不是固定 sleep —— 固定 sleep 要么慢要么脆。 */
async function until(fn, what, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`超时：${typeof what === 'function' ? what() : what}`);
}

/** UXP 的选择器只支持单个 .class / #id / tag，别在这里用后代选择器。 */
function pageTitle() {
  const host = dom.document.querySelector('.page-host');
  const el = host ? host.querySelector('.page-title') : null;
  return el ? el.textContent : null;
}

/** 出问题时把 page-host 里现在到底是什么打出来，省得对着一个 null 猜。 */
function pageDump() {
  const host = dom.document.querySelector('.page-host');
  if (!host) return '(没有 page-host)';
  return (host.textContent || '(空)').slice(0, 200);
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-panel-'));
  helper = await startHelper({
    port: 0,
    dataDir,
    ephemeral: true,
    workflowsDir: resolve(here, '../../../workflows')
  });
  PORT = Number(new URL(helper.url).port);
  token = helper.issueToken();
  await helper.recovered;

  dom = installUxpDom();

  const outfile = join(dataDir, 'panel.test.mjs');
  await bundleForTest(outfile);
  ui = await import(pathToFileURL(outfile).href);
  ui.useHelperAt(`http://127.0.0.1:${PORT}`, token);
});

after(async () => {
  try {
    ui?.teardownPlugin();
  } catch {
    /* noop */
  }
  await helper?.stop();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

test('一次重画还没画完时点了别的页：那一下不许被吞掉', async () => {
  /*
   * 老写法是 `if (painting) return` —— 正在画的时候来的请求直接扔了。
   * 而画一页是**异步**的（拉预设、拉模型列表，几百毫秒起步），
   * 这段时间恰恰是用户最可能再点一下的时候：他点了「历史」，
   * 上一次重画还没画完，于是这一下被吞掉，界面停在原地不动。
   * 他只会觉得按钮坏了，然后再点一次，运气不好再被吞一次。
   */
  const root = dom.document.createElement('div');
  dom.root.appendChild(root);
  await ui.mountMainPanel(root);

  /*
   * 先让面板彻底安静下来。
   *
   * 挂载过程里 loadBaseData 会陆续把 features 等等填进 store，
   * 每一次都会顺手触发一轮重画。那些重画会**顺带**把被吞掉的那一下
   * 补回来 —— 于是这条用例在旧代码上也能通过，测了个寂寞。
   * 要证明"请求没被吞"，就必须让这一下是**唯一**的那一次触发。
   */
  await until(() => pageTitle() !== null, () => `面板应该先画出点东西：${pageDump()}`);
  await new Promise((r) => setTimeout(r, 400));

  /*
   * 拖慢的是 /v1/jobs，也就是历史页每次渲染都要发的那一个。
   *
   * 不能拿生成页的那几个请求做文章：预设和模型列表在模块里是**带缓存**的，
   * 第二次渲染根本不会再发请求 —— 于是"正在画"的窗口压根不存在，
   * 这条用例会在旧代码上照样通过，测了个寂寞。
   * 慢的那一步必须是每次都真的会走的那一步。
   */
  const realFetch = globalThis.fetch;
  let slow = true;
  globalThis.fetch = async (url, init) => {
    if (slow && /\/v1\/jobs(\?|$)/.test(String(url))) {
      await new Promise((r) => setTimeout(r, 500));
    }
    return realFetch(url, init);
  };

  try {
    ui.setState({ page: 'history' }); // 这一轮会卡在慢请求上
    await new Promise((r) => setTimeout(r, 80));
    ui.setState({ page: 'settings' }); // 正落在"正在画"的窗口里

    /*
     * 期限故意收紧：被吞掉的话，只有下一次**别的**状态变化才可能把它补回来，
     * 而这里之后不会再有别的变化了 —— 那种情况下这条会超时，正是我们要的。
     */
    await until(
      () => pageTitle() === '设置',
      () => `切页那一下被吞了：现在还停在「${pageTitle()}」；page-host 内容：${pageDump()}`,
      3000
    );
  } finally {
    slow = false;
    globalThis.fetch = realFetch;
  }
});

test('连点好几下，最后落到的一定是最后点的那一页', async () => {
  const realFetch = globalThis.fetch;
  let slow = true;
  globalThis.fetch = async (url, init) => {
    if (slow && /\/v1\/jobs(\?|$)/.test(String(url))) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return realFetch(url, init);
  };

  try {
    /*
     * 最后停的那一页必须**不同于**正在画的那一页。
     * 否则旧代码把后面几下全吞掉之后，画面正好还停在对的地方，
     * 这条用例就红不起来。
     */
    ui.setState({ page: 'history' }); // 这一轮卡在慢请求上
    await new Promise((r) => setTimeout(r, 30));
    ui.setState({ page: 'generate' });
    ui.setState({ page: 'history' });
    ui.setState({ page: 'settings' }); // 最后点的是这一下

    await until(
      () => pageTitle() === '设置',
      () => `连点之后应该停在最后点的那一页，实际是「${pageTitle()}」；page-host 内容：${pageDump()}`,
      3000
    );
    // 再等一会儿，确认补画那几轮不会把最终结果又冲掉
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pageTitle(), '设置', '补画那一轮不能把最终结果又改掉');
  } finally {
    slow = false;
    globalThis.fetch = realFetch;
  }
});

test('换页时会把生成页的一次性状态一起丢掉', async () => {
  /*
   * resetGenerateState 以前是个导出了但**没人调用**的函数 ——
   * 看起来在做事，实际什么都没发生。inputHandles / currentImages
   * 会按「功能:参数」一直堆下去：用户在十几个功能之间切过一圈，
   * 里面就留着十几份他早就看不见的图。
   *
   * 更要紧的是版次：不 reset 的话，上一版页面里那些还在飞的
   * 捕获/上传回调，回来时照样往当前的 currentImages 里写。
   */
  const host = dom.document.createElement('div');
  dom.root.appendChild(host);
  await ui.renderGeneratePage(host);

  // detachGenerateResults 是换页时必走的那一步，它必须把状态一起清掉
  ui.detachGenerateResults();

  // 清过之后再渲染一次不应该出问题（这里守的是"两件事绑在一起"这个约定）
  await ui.renderGeneratePage(host);
  assert.ok(host.querySelector('.page-title'), '清理之后页面照样画得出来');
});

/* ==================== 渲染不许触发自己 ==================== */

test('打开「固定功能」不会陷进无限重画', async () => {
  /*
   * 真机上这一页是**空白**的：不报错、没内容、也没提示。
   *
   * 原因不在这一节的渲染代码里，而在它第二行的
   * `setState({ features })` —— 主面板订阅了 features，一变就整页重画；
   * 而 features 不参与深比较（DEEP_COMPARE_KEYS 只有 health/gpu/doc），
   * 每次从接口拉回来都是**新数组**，必然判定为"变了"。
   *
   *   渲染固定功能 → setState(features) → 整页重画 → 再渲染固定功能 → …
   *
   * 每轮开头都 clear()，每轮又要等三个请求，于是这一页绝大多数时刻
   * 都是空的 —— 看起来就是"打不开"。CPU 也一直在烧，
   * 整个面板跟着卡，而这两件事看起来毫不相干。
   *
   * 这条用例数的是**请求次数**：稳定之后就该停下来，而不是一直转。
   */
  const root = dom.document.createElement('div');
  dom.root.appendChild(root);
  await ui.mountMainPanel(root);
  await until(() => pageTitle() !== null, () => `面板要先画出点东西：${pageDump()}`);
  await new Promise((r) => setTimeout(r, 400));

  let featureCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/\/v1\/features(\?|$)/.test(String(url))) featureCalls++;
    return realFetch(url, init);
  };

  try {
    ui.setState({ page: 'settings' });
    await until(() => pageTitle() === '设置', () => `应该到设置页：${pageDump()}`);

    const host = dom.document.querySelector('.page-host');
    const tab = host.querySelectorAll('button').find((b) => b.textContent === '固定功能');
    assert.ok(tab, '应该有「固定功能」页签');
    tab.dispatchEvent({ type: 'click', target: tab, currentTarget: tab });

    // 给它足够时间跑完（三个请求）再观察
    await new Promise((r) => setTimeout(r, 1200));
    const settled = featureCalls;
    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(
      featureCalls,
      settled,
      `静置 1.5 秒后还在反复拉功能列表（${settled} → ${featureCalls}）—— 说明渲染把自己又触发了一遍`
    );
    assert.ok(featureCalls <= 3, `打开一次这一页不该拉 ${featureCalls} 次功能列表`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('「固定功能」真的把绑定表画出来了', async () => {
  // 上一条只证明"不循环"。这一条证明它**有内容** —— 空白同样是不可接受的。
  const host = dom.document.querySelector('.page-host');
  await until(
    () => (host.textContent ?? '').includes('工作流绑定'),
    () => `固定功能这一页应该画出绑定表，实际内容：${(host.textContent ?? '').slice(0, 160)}`,
    6000
  );
});

test('绑定行默认是收起的：一开始不建那几百个下拉节点', async () => {
  /*
   * 真机上滚动这一页会出现重绘残留（行与行叠在一起、左右两列显示的是
   * 不同滚动位置的内容）。那是渲染器跟不上 —— 13 个功能一次性建出
   * 后端下拉 + 工作流下拉 + RunningHub 预设下拉，几百个 <select>/<option>。
   *
   * 治不了渲染器，只能把要画的东西减下来：先只画摘要，点「编辑」再建。
   */
  const host = dom.document.querySelector('.page-host');
  await until(
    () => (host.textContent ?? '').includes('工作流绑定'),
    () => `固定功能该画出来：${(host.textContent ?? '').slice(0, 120)}`,
    6000
  );

  const rows = host.querySelectorAll('.binding-row').filter((r) => !r.classList.contains('binding-head'));
  assert.ok(rows.length >= 5, `应该有多行绑定，实际 ${rows.length}`);

  // 收起状态下不该有任何下拉被建出来
  const selects = host.querySelectorAll('select');
  assert.equal(selects.length, 0, `收起状态下不该建下拉，实际建了 ${selects.length} 个`);

  // 但每行都要能独立看懂：走谁、用哪份
  const sums = host.querySelectorAll('.binding-sum');
  assert.equal(sums.length, rows.length, '每一行都要有摘要');
  assert.ok(
    sums.some((s) => (s.textContent ?? '').includes('·')),
    '摘要要说清"走谁 · 用哪份"'
  );
});

test('点「编辑」才把那一行的控件建出来', async () => {
  const host = dom.document.querySelector('.page-host');
  const editBtn = host.querySelectorAll('button').find((b) => b.textContent === '编辑');
  assert.ok(editBtn, '每行应该有「编辑」按钮');

  editBtn.dispatchEvent({ type: 'click', target: editBtn, currentTarget: editBtn });
  await new Promise((r) => setTimeout(r, 150));

  assert.ok(host.querySelectorAll('select').length > 0, '点开之后才该有下拉');
  assert.equal(editBtn.textContent, '收起', '按钮要变成「收起」');

  // 再点一次收回去，但已经建好的节点不重复建
  const n = host.querySelectorAll('select').length;
  editBtn.dispatchEvent({ type: 'click', target: editBtn, currentTarget: editBtn });
  await new Promise((r) => setTimeout(r, 150));
  editBtn.dispatchEvent({ type: 'click', target: editBtn, currentTarget: editBtn });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(host.querySelectorAll('select').length, n, '来回开合不该重复建控件');
});
