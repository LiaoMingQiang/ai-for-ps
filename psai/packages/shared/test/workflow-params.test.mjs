/**
 * 导入工作流的绑定 → 生成页要画的参数控件。
 *
 * 「自定义工作流」的参数是跟着选中的那份图走的：这份图绑了提示词和步数，
 * 界面就该有这两个控件。在这之前它一个控件都没有 —— 那个功能的参数表
 * 里只有一个图像位，所以页面上永远是一个空的「参数设置」。
 *
 * 这一组钉死两件事：控件由绑定决定，以及控件的取值范围和内置功能一致。
 * 后者容易被忽略：如果这里另写一套，同一个「步数」在内置功能里是 1~100、
 * 在自定义工作流里可能变成 1~50，而用户没有任何理由预期这种差别。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paramsForWorkflowBindings, BINDABLE_PARAMS, allFeatures } from '../dist/index.js';

const b = (paramId) => ({ paramId, nodeId: '1', field: 'x', transform: 'none', required: false });

test('没有绑定就没有控件', () => {
  assert.deepEqual(paramsForWorkflowBindings([]), []);
});

test('绑了什么就出什么控件', () => {
  const specs = paramsForWorkflowBindings([b('prompt'), b('steps'), b('denoise')]);
  assert.deepEqual(
    specs.map((s) => s.id),
    ['prompt', 'steps', 'denoise'],
    '顺序按 BINDABLE_PARAMS 走，不按绑定的保存顺序'
  );
  assert.equal(specs.find((s) => s.id === 'prompt').kind, 'prompt');
  assert.equal(specs.find((s) => s.id === 'steps').kind, 'slider');
});

test('同一个参数绑到多个节点上，界面只出一个控件', () => {
  // 正向提示词同时喂两个 CLIPTextEncode 是很常见的写法。
  // 那是绑定层的事，界面上出两个提示词框就成了"填哪个才算数"。
  const specs = paramsForWorkflowBindings([b('prompt'), b('prompt'), b('prompt')]);
  assert.equal(specs.length, 1);
});

test('绑定顺序变了，界面顺序不变', () => {
  // 同一份图换个顺序保存一次绑定，控件就跟着重排的话，
  // 用户会以为界面出错了。
  const a = paramsForWorkflowBindings([b('cfg'), b('prompt'), b('seed')]).map((s) => s.id);
  const c = paramsForWorkflowBindings([b('seed'), b('cfg'), b('prompt')]).map((s) => s.id);
  assert.deepEqual(a, c);
});

test('认不出的 paramId 静默跳过，不至于让整个参数区画不出来', () => {
  const specs = paramsForWorkflowBindings([b('prompt'), b('这个不存在'), b('seed')]);
  assert.deepEqual(
    specs.map((s) => s.id),
    ['prompt', 'seed']
  );
});

test('图像位不在这里出', () => {
  // 图由功能自己的图像输入区提供。参数区再画一个图片框，
  // 就成了两个都能放图、而只有一个算数的输入口。
  const specs = paramsForWorkflowBindings([b('image'), b('reference'), b('prompt')]);
  assert.deepEqual(
    specs.map((s) => s.id),
    ['prompt']
  );
});

test('控件的取值范围和内置功能里的同名控件一致', () => {
  /*
   * 拿内置功能里真实用着的那些控件来比。范围、步长、精度、是否收进「高级」
   * 都是调出来的取值，两边各写一套迟早会分叉。
   */
  const builtinById = new Map();
  for (const f of allFeatures()) {
    for (const p of f.params) if (!builtinById.has(p.id)) builtinById.set(p.id, p);
  }

  const ids = ['steps', 'cfg', 'denoise', 'seed', 'sampler', 'scheduler'];
  const specs = paramsForWorkflowBindings(ids.map(b));
  let compared = 0;
  for (const s of specs) {
    const ref = builtinById.get(s.id);
    if (!ref) continue;
    compared++;
    assert.equal(s.kind, ref.kind, `${s.id} 的控件类型和内置功能不一致`);
    if (s.kind === 'slider') {
      assert.equal(s.min, ref.min, `${s.id} 的下限不一致`);
      assert.equal(s.max, ref.max, `${s.id} 的上限不一致`);
      assert.equal(s.step, ref.step, `${s.id} 的步长不一致`);
    }
  }
  assert.ok(compared >= 4, `至少该比到 4 个同名控件，实际只比了 ${compared} 个`);
});

test('每个可绑定参数要么能画出控件，要么是图像位', () => {
  /*
   * 结构性检查：BINDABLE_PARAMS 里新加一项而忘了给它控件的话，
   * 用户在设置里能把参数绑上去，生成页却永远不出这个控件 ——
   * 绑了等于没绑，而且没有任何提示。这跟 RunningHub 那个死字段是同一类毛病。
   */
  const imageish = new Set(['image', 'reference']);
  const missing = [];
  for (const p of BINDABLE_PARAMS) {
    if (imageish.has(p.id)) continue;
    if (paramsForWorkflowBindings([b(p.id)]).length === 0) missing.push(`${p.id}（${p.label}）`);
  }
  assert.deepEqual(missing, [], `这些参数能在设置里绑，但生成页画不出控件：${missing.join('、')}`);
});
