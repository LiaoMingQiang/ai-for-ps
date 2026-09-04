/**
 * 上一版生成页里还在飞的取图，不许落进这一版。
 *
 * 这条错路完全不需要用户做错什么：
 *
 *   他在生成页点「从 Photoshop 取图」→ 捕获要花点时间（合并图层、读遮罩，
 *   几百毫秒到几秒）→ 这期间他切走看一眼历史、又切回来
 *   → 页面重渲染，输入框是新的、**空的**
 *   → 那次捕获这时候才回来，照样往 currentImages 里写
 *
 * 于是界面上是空输入框，而「开始处理」却是能点的，点下去提交的是
 * 那几张他以为没选上的图 —— 而且它们很可能取自一个已经关掉或改过的文档。
 * 全程没有任何提示。界面显示的东西和实际提交的东西必须是同一份。
 *
 * 这里把取图那一步换成可控的桩，好把"还在飞"这个状态捏在手里；
 * 其余全是真代码：真 Helper、真 DOM、真的 renderGeneratePage。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

import { startHelper } from '../../helper/dist/index.js';
import { startComfyStub } from '../../../tools/comfy-stub.mjs';
import { installUxpDom } from './uxp-dom.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FEATURE = 'comfy.wash.portrait';

let helper;
let comfy;
let dataDir;
let ui;
let dom;
let PORT = 0;
let token;

/**
 * 图像输入框的桩。
 *
 * 只桩掉这一个模块：它是"取图"的入口，而取图正是那个会飞很久的动作。
 * 桩把每次创建时拿到的 onChange 记下来，测试就能在**任意时刻**
 * 让某一版的取图"回来"—— 包括那一版早就被换掉之后。
 */
const imageInputStub = `
  export function createImageInput(spec, onChange) {
    const el = globalThis.document.createElement('section');
    el.className = 'card img-stub';
    let images = [];
    const handle = {
      el,
      getValue: () => images.slice(),
      clear: () => { images = []; onChange([]); },
      /** 测试用：模拟一次**这一版**的取图回来了 */
      __deliver: (imgs) => { images = imgs.slice(); onChange(images.slice()); }
    };
    (globalThis.__psaiInputHandles ??= []).push(handle);
    return handle;
  }
  export function validateImages(spec, imgs) {
    const min = spec.kind === 'imageList' ? spec.min : spec.required ? 1 : 0;
    if (imgs.length < min) return \`「\${spec.label}」至少需要 \${min} 张图\`;
    return null;
  }
`;

async function bundleForTest(outfile) {
  const entry = join(here, '.stale-input-entry.mjs');
  writeFileSync(
    entry,
    [
      "export { renderGeneratePage, detachGenerateResults } from '../src/ui/page-generate.js';",
      "export { setState, getState, setParams } from '../src/app/store.js';",
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
    plugins: [
      {
        name: 'stubs',
        setup(b) {
          b.onResolve({ filter: /imageinput\.js$/ }, () => ({ path: 'psai-imageinput', namespace: 'stub' }));
          b.onResolve({ filter: /^(photoshop|uxp|os|fs)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
            if (a.path === 'psai-imageinput') return { contents: imageInputStub, loader: 'js' };
            return {
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
            };
          });
        }
      }
    ],
    logLevel: 'silent'
  });
  rmSync(entry, { force: true });
}

async function api(method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (!Number.isInteger(PORT) || PORT <= 0) {
    throw new Error(`测试用的 Helper 端口无效：PORT=${PORT}。多半是某次启动 Helper 没成功，或者在赋值前就发了请求。`);
  }
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: payload });
  return res.json();
}

function testWorkflow() {
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'stub_model.safetensors' } },
    2: { class_type: 'LoadImage', inputs: { image: 'example.png' } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: 'a', clip: ['1', 1] }, _meta: { title: 'Positive' } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: 'b', clip: ['1', 1] }, _meta: { title: 'Negative' } },
    6: { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['1', 2] } },
    3: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        seed: 1,
        steps: 4,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        denoise: 1
      }
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['1', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'psai' } }
  };
}

/**
 * 一张"传到一半、页面换掉之后才传完"的图。
 *
 * 用**上传**而不是从图层取：上传来的图不属于任何文档，
 * 因此不会先被"输入图和写回目标不是同一个文档"那道检查挡住 ——
 * 这里要验的是陈旧输入，不是文档不匹配，两道防线得分开验。
 */
function ghostImage() {
  return {
    assetId: 'as_ghost',
    width: 64,
    height: 64,
    bytes: 100,
    source: 'upload',
    selectionBounds: null,
    previewSrc: '',
    sourceDocumentId: null,
    sourceDocumentName: null
  };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-stale-'));
  comfy = await startComfyStub(0, { runMs: 50 });
  helper = await startHelper({
    port: 0,
    dataDir,
    ephemeral: true,
    workflowsDir: resolve(here, '../../../workflows')
  });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;

  dom = installUxpDom();

  const outfile = join(dataDir, 'stale.test.mjs');
  await bundleForTest(outfile);
  ui = await import(pathToFileURL(outfile).href);
  ui.useHelperAt(`http://127.0.0.1:${PORT}`, token);

  await api('PATCH', '/v1/settings', { comfy: { baseUrl: comfy.url } });
  const wf = (await api('POST', '/v1/workflows/import', { json: testWorkflow(), name: '陈旧输入测试用' })).workflow;
  await api('PUT', `/v1/features/${FEATURE}/binding`, { providerId: 'comfyui', workflowId: wf.id, enabled: true });

  // 页面要用到的那几份数据，跟真实启动路径一样从 Helper 拉
  const features = (await api('GET', '/v1/features')).features;
  ui.setState({
    booted: true,
    features,
    featureId: FEATURE,
    health: { online: true, version: 'test', paired: true, activeJobs: 0, comfyui: null, reason: null },
    doc: { documentId: 1, documentName: '早就关掉的那份.psd', width: 512, height: 512, hasSelection: false }
  });
});

after(async () => {
  await helper?.stop();
  await comfy?.stop();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

/** 渲染一次生成页，返回这一版的输入框句柄和主按钮。 */
async function renderOnce() {
  globalThis.__psaiInputHandles = [];
  const host = dom.document.createElement('div');
  const actionHost = dom.document.createElement('div');
  dom.root.appendChild(host);
  dom.root.appendChild(actionHost);
  await ui.renderGeneratePage(host, actionHost);
  return {
    host,
    actionHost,
    handles: globalThis.__psaiInputHandles.slice(),
    submitBtn: actionHost.querySelector('.btn-submit'),
    reason: actionHost.querySelector('.submit-reason')
  };
}

test('前提：功能是就绪的，缺图时才会是"缺图"在挡着', async () => {
  // 不先确认这一点的话，下面两条可能是被「功能未就绪」挡住的，
  // 那它们对陈旧输入这件事一个字都没说。
  const v1 = await renderOnce();
  assert.ok(v1.submitBtn, '应该画得出主按钮');
  assert.ok(v1.handles.length >= 1, '这个功能应该有图像输入框');
  assert.match(v1.reason.textContent, /至少需要/, `挡着的理由应该是缺图，实际是「${v1.reason.textContent}」`);

  // 这一版自己取到图，按钮就该放开 —— 证明这条路本来是通的
  v1.handles[0].__deliver([ghostImage()]);
  assert.equal(v1.submitBtn.hasAttribute('disabled'), false, '本版取到图之后就该能提交');
});

/**
 * 数一数这段时间里"建任务"这个请求发出去过几次。
 *
 * 不能改数库里的任务行数：拿一张不存在的资产去建任务，Helper 会拒掉，
 * 库里同样是零 —— 那样的话有没有把幽灵图带上根本分不出来。
 * 要看的是**这一下到底有没有提交出去**。
 */
async function countSubmits(fn) {
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url, init) => {
    if ((init?.method ?? 'GET') === 'POST' && /\/v1\/jobs$/.test(String(url))) n++;
    return realFetch(url, init);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return n;
}

test('上一版的取图回来之后，这一版点提交不许把它带上', async () => {
  /*
   * 这是这条错路真正伤人的那一步：界面上一张图都没有，
   * 用户点下去，提交的却是他以为没选上的那几张，
   * 而且很可能取自一个已经关掉的文档。
   */
  const v1 = await renderOnce();
  const stale = v1.handles[0];

  // 页面被换掉（切走再切回来、或者换了个功能）
  const v2 = await renderOnce();
  assert.match(v2.reason.textContent, /至少需要/, '前提：新一版是空的，按钮该是灰的');
  assert.equal(v2.submitBtn.hasAttribute('disabled'), true);

  // 上一版那次取图**现在**才回来
  stale.__deliver([ghostImage()]);

  const submits = await countSubmits(async () => {
    v2.submitBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 300));
  });
  assert.equal(submits, 0, '界面上没有图，就不该有任何东西被提交出去');
});

test('这一版自己取的图当然算数 —— 这道防线不能把正常路挡住', async () => {
  const v = await renderOnce();
  v.handles[0].__deliver([ghostImage()]);
  assert.equal(v.submitBtn.hasAttribute('disabled'), false, '本版取到图就该能提交');

  const submits = await countSubmits(async () => {
    v.submitBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 300));
  });
  assert.equal(submits, 1, '本版的图必须提交得出去');
});

/* ==================== 没有模型目录的平台，别摆转不动的旋钮 ==================== */

test('平台没有模型目录时，不画空下拉，而是说清该去哪儿改', async () => {
  /*
   * 真机上踩到的：图生图（cloud.i2i）和精修白底图（cloud.product.whitebg）
   * 绑在 RunningHub 上，而 RunningHub 以**云端工作流**为单位，
   * 压根没有模型目录 —— `/v1/providers/runninghub/models` 直接 501。
   *
   * 插件把这个异常吞掉，于是：
   *   · 模型下拉只剩一个「（尚未拉取模型列表）」，点一百次也不会有内容
   *   · modelsMeta 是模块级的、没被清掉，还留着上一个平台（comfly）的数字，
   *     提示里于是写着「该平台共 861 个」—— 那是**另一个平台**的总数
   *
   * 一个永远转不动的旋钮，加一句误导的数字。用户会一直去点「拉取模型」，
   * 而真正该改的是设置里的工作流绑定。
   */
  // 先把图生图绑到 RunningHub 上 —— 真机上就是这么配的，
  // 而没有绑定的话这个功能连 providerId 都没有，根本不会去拉模型。
  await api('PUT', '/v1/features/cloud.i2i/binding', { providerId: 'runninghub', enabled: true });
  ui.setState({ features: (await api('GET', '/v1/features')).features });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/\/v1\/providers\/[^/]+\/models/.test(String(url))) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: 'PROVIDER_UNSUPPORTED',
            message: '该平台不支持这个操作',
            details: 'RunningHub 以云端工作流为单位，没有可拉取的模型列表',
            retryable: false
          }
        }),
        { status: 501, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return realFetch(url, init);
  };

  let host;
  try {
    // 换到一个**有模型参数**的云端功能上（图生图就是真机出问题的那个）。
    // ComfyUI 分支根本没有模型下拉，用它验不到这条。
    ui.setState({ featureId: 'cloud.i2i' });
    globalThis.__psaiInputHandles = [];
    host = dom.document.createElement('div');
    const actionHost = dom.document.createElement('div');
    dom.root.appendChild(host);
    dom.root.appendChild(actionHost);
    await ui.renderGeneratePage(host, actionHost);
    // 模型那一拉是异步补上的，等它回来
    await new Promise((r) => setTimeout(r, 600));
  } finally {
    globalThis.fetch = realFetch;
  }

  ui.setState({ featureId: FEATURE });
  const text = host.textContent ?? '';
  assert.ok(
    !text.includes('尚未拉取模型列表'),
    '平台没有模型目录时，不该再说"尚未拉取"—— 那会让人一直去点拉取'
  );
  assert.match(text, /工作流/, '要说清这个平台是按工作流走的');
  assert.match(text, /固定功能/, '要指出去哪儿改');
  assert.ok(!/共\s*\d+\s*个/.test(text), `不许显示别的平台的模型总数：${text.slice(0, 200)}`);
});
