/**
 * 「不留死旋钮」的界面侧强制检查。
 *
 * 项目第一条纪律是：面板上不能有转不动的旋钮。
 * builtin-workflows.test.mjs 管的是另一半 —— 参数在**工作流**里有没有落点；
 * 这里管的是这一半 —— 控件在**界面**上动了之后，值有没有真的进到提交用的那份参数里。
 *
 * 这两件事都能独立地静悄悄坏掉：
 *   - 渲染器忘了调 ctx.set，控件看着能动，提交时用的还是默认值
 *   - 某个 kind 在 renderParam 的 switch 里没分支，直接返回 null，控件根本不存在
 * 两种都不会让 typecheck 或别的测试变红，只会让用户觉得"我调了没用啊"。
 *
 * 做法：把每个功能的每个参数都真的渲染出来，对着控件派发真实事件，
 * 然后断言 store 里那个参数的值变了。改不动的就是死旋钮。
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
// 端口用 0 让系统分配：写死端口时，上一次跑崩留下的进程会一直占着，
// 后面每次 npm test 都报 EADDRINUSE，看起来像测试坏了，其实是环境脏了。
let PORT = 0;

let helper;
let dataDir;
let ui;
let dom;

async function bundle(outfile) {
  const entry = join(here, '.controls-entry.mjs');
  writeFileSync(
    entry,
    [
      "export { renderParams } from '../src/ui/params.js';",
      "export { setParams, paramsOf, setState } from '../src/app/store.js';",
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
        name: 'uxp-stub',
        setup(b) {
          b.onResolve({ filter: /^(photoshop|uxp|os|fs)$/ }, (a) => ({ path: a.path, namespace: 'uxp-stub' }));
          b.onLoad({ filter: /.*/, namespace: 'uxp-stub' }, () => ({
            contents: `
              const no = () => { throw new Error('UXP-ONLY'); };
              export const app = { get documents() { return []; }, activeDocument: null };
              export const action = { batchPlay: no };
              export const core = { executeAsModal: no };
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
  dataDir = mkdtempSync(join(tmpdir(), 'psai-controls-'));
  helper = await startHelper({ port: 0, dataDir, workflowsDir: resolve(here, '../../../workflows') });
  PORT = Number(new URL(helper.url).port);
  dom = installUxpDom();
  const outfile = join(dataDir, 'controls.test.mjs');
  await bundle(outfile);
  ui = await import(pathToFileURL(outfile).href);

  const req = await fetch(`http://127.0.0.1:${PORT}/v1/pair/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: 'controls-test' })
  });
  const { challenge } = await req.json();
  const con = await fetch(`http://127.0.0.1:${PORT}/v1/pair/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge })
  });
  const { token } = await con.json();
  ui.useHelperAt(`http://127.0.0.1:${PORT}`, token);
});

after(async () => {
  await helper?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

/** 深比较够用了：参数值都是标量或小对象。 */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 这些控件写入 store 前有 150ms 防抖，断言前必须等。 */
const DEBOUNCED = new Set(['prompt', 'negativePrompt', 'text']);

/**
 * 对着一个已渲染的参数容器，列出所有**可以独立拨动的子控件**。
 *
 * 一个参数常常由不止一个控件驱动：滑杆是「滑轨 + 数字框」，种子是「模式分段 + 数值框」。
 * 它们各有各的写入路径，任何一条断掉都是一个死旋钮。
 * 如果把它们一起拨然后只看最终结果，坏掉的那个会被好的那个盖住 —— 测试照样绿。
 * 所以这里返回一组 { label, apply }，测试逐个拨、逐个验。
 */
function subControls(spec, el) {
  const fire = (node, type) => node.dispatchEvent({ type, target: node, currentTarget: node });

  const inputs = el.querySelectorAll('input');
  const textareas = el.querySelectorAll('textarea');
  const selects = el.querySelectorAll('select');
  const buttons = el.querySelectorAll('button');

  switch (spec.kind) {
    case 'prompt':
    case 'negativePrompt': {
      const ta = textareas[0];
      if (!ta) return [];
      return [{ label: '文本框', apply: () => { ta.value = '端到端测试写进去的提示词'; fire(ta, 'input'); } }];
    }
    case 'text': {
      const inp = inputs[0];
      if (!inp) return [];
      return [{ label: '输入框', apply: () => { inp.value = '端到端测试文本'; fire(inp, 'input'); } }];
    }
    case 'slider':
    case 'resolution': {
      const range = inputs.find((i) => i.getAttribute('type') === 'range');
      const num = inputs.find((i) => i.getAttribute('type') !== 'range');
      const lo = spec.min ?? 0;
      const hi = spec.max ?? 100;
      const out = [];
      if (range) {
        out.push({
          label: '滑轨',
          apply: () => {
            range.value = String(lo + (hi - lo) * 0.23);
            fire(range, 'input');
          }
        });
      }
      if (num) {
        out.push({
          label: '数字框',
          apply: () => {
            num.value = String(lo + (hi - lo) * 0.61);
            fire(num, 'change');
          }
        });
      }
      return out;
    }
    case 'select':
    case 'model': {
      const sel = selects[0];
      if (!sel) return [];
      const opts = sel.querySelectorAll('option');
      // 必须挑一个和当前值**不同**的选项，否则选完值没变，
      // 分不清是控件没接上还是根本没拨动。
      const now = String(sel.value ?? '');
      const target = opts.map((o) => o.getAttribute('value') ?? '').find((v) => v !== now);
      if (target === undefined) return [];
      return [{ label: '下拉', apply: () => { sel.value = target; fire(sel, 'change'); } }];
    }
    case 'segmented': {
      // 挑一个当前没被选中的分段，理由同上
      const segs = buttons.filter((b) => b.classList.contains('seg'));
      const target = segs.find((b) => !b.classList.contains('active'));
      if (!target) return [];
      return [{ label: '分段', apply: () => fire(target, 'click') }];
    }
    case 'toggle': {
      const sw = buttons.find((b) => b.classList.contains('switch')) ?? buttons[0];
      if (!sw) return [];
      return [{ label: '开关', apply: () => fire(sw, 'click') }];
    }
    case 'seed': {
      const out = [];
      const num = inputs[0];
      if (num) {
        out.push({
          label: '数值框',
          apply: () => {
            num.value = '123456';
            fire(num, 'change');
          }
        });
      }
      const modeBtn = buttons.filter((b) => b.classList.contains('seg')).find((b) => !b.classList.contains('active'));
      if (modeBtn) out.push({ label: '模式分段', apply: () => fire(modeBtn, 'click') });
      return out;
    }
    case 'presetPrompt': {
      const out = [];
      const sel = selects[0];
      if (sel) {
        const now = String(sel.value ?? '');
        const target = sel
          .querySelectorAll('option')
          .map((o) => o.getAttribute('value') ?? '')
          .find((v) => v !== now);
        if (target !== undefined) {
          out.push({ label: '预设下拉', apply: () => { sel.value = target; fire(sel, 'change'); } });
        }
      }
      const sw = buttons.find((b) => b.classList.contains('switch'));
      if (sw) out.push({ label: '启用开关', apply: () => fire(sw, 'click') });
      return out;
    }
    case 'aspect': {
      const chips = buttons.filter((b) => b.classList.contains('aspect'));
      const target = chips.find((b) => !b.classList.contains('active'));
      if (!target) return [];
      return [{ label: '比例按钮', apply: () => fire(target, 'click') }];
    }
    case 'camera': {
      // 取景立方体是拖出来的，不是点出来的。按下再移动，模拟一次真实拖拽。
      const stage = el.querySelectorAll('div').find((d) => d.classList.contains('cube-stage'));
      if (!stage) return [];
      return [
        {
          label: '立方体拖拽',
          apply: () => {
            stage.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100, target: stage, currentTarget: stage });
            stage.dispatchEvent({ type: 'pointermove', clientX: 160, clientY: 130, target: stage, currentTarget: stage });
            stage.dispatchEvent({ type: 'pointerup', clientX: 160, clientY: 130, target: stage, currentTarget: stage });
          }
        }
      ];
    }
    default:
      return [];
  }
}

test('每个功能的每个参数控件都真的写进提交用的参数里（没有死旋钮）', async () => {
  const { features } = await ui.api.features();
  const dead = [];
  const missing = [];
  const notDriven = [];

  for (const f of features) {
    // 图像输入不由 renderParams 负责（走 imageinput.ts），单独在别处验
    const specs = f.params.filter((p) => p.kind !== 'image' && p.kind !== 'imageList');
    if (specs.length === 0) continue;

    ui.setParams(f.id, { ...f.defaults });

    const ctx = {
      get: (id) => ui.paramsOf(f.id)[id],
      set: (id, value) => ui.setParams(f.id, { ...ui.paramsOf(f.id), [id]: value }),
      // 模型列表是运行时从 Provider 拉的；这里喂两个进去，才能验证「选了之后写不写进参数」
      // 模型下拉读的是固定的 options.models（运行时从 Provider 拉），
      // 采样器/调度器读 spec.dynamicSource。都喂上，才能验证「选了之后写不写进参数」。
      options: {
        models: ['模型甲', '模型乙'],
        samplers: ['euler', 'dpmpp_2m'],
        schedulers: ['normal', 'karras'],
        checkpoints: ['a.safetensors', 'b.safetensors'],
        upscaleModels: ['x.pth', 'y.pth']
      },
      presets: [],
      onEnhance: async () => null
    };

    const container = ui.renderParams(f.params, ctx);
    dom.root.appendChild(container);

    for (const spec of specs) {
      // 找到这个参数对应的那块 DOM
      const block = container.querySelectorAll('.param').find((p) => p.getAttribute('data-param') === spec.id);
      if (!block) {
        missing.push(`${f.id}.${spec.id}（kind=${spec.kind}）压根没渲染出来`);
        continue;
      }
      // 深拷贝：渲染器里 ctx.get() 拿到的是 store 里那个对象本身，
      // 直接留引用的话，对象被就地改掉时 before 会跟着变，比较就永远相等。
      const subs = subControls(spec, block);
      if (subs.length === 0) {
        notDriven.push(`${f.id}.${spec.id}（kind=${spec.kind}）测试没能拨动它`);
        continue;
      }
      for (const sub of subs) {
        // 深拷贝：渲染器里 ctx.get() 拿到的是 store 里那个对象本身，
        // 直接留引用的话，对象被就地改掉时 before 会跟着变，比较就永远相等。
        const before = structuredClone(ui.paramsOf(f.id)[spec.id] ?? null);
        sub.apply();
        // 提示词类控件是防抖写入的（150ms），等它落地再看
        if (DEBOUNCED.has(spec.kind)) await new Promise((r) => setTimeout(r, 220));
        const after = ui.paramsOf(f.id)[spec.id];
        if (same(before, after)) {
          dead.push(
            `${f.id}.${spec.id}（kind=${spec.kind} · ${sub.label}）前=${JSON.stringify(before)} 后=${JSON.stringify(after)}`
          );
        }
      }
    }
    dom.root.removeChild(container);
  }

  assert.deepEqual(missing, [], `以下参数没有渲染出控件：\n${missing.join('\n')}`);
  assert.deepEqual(dead, [], `以下控件是死旋钮（动了但参数没变）：\n${dead.join('\n')}`);
  assert.deepEqual(notDriven, [], `以下控件测试没能驱动，需要补 nudge() 分支，不能当成通过：\n${notDriven.join('\n')}`);
});
