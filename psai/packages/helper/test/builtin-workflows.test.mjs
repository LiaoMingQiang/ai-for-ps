/**
 * 内置工作流的静态校验 —— 不需要 ComfyUI，纯查文件。
 *
 * 这套测试守的是一条产品规则：**面板上不能有转不动的旋钮**。
 * 每个功能声明的参数，都必须在它绑定的工作流里落到某个真实的节点输入上；
 * 反过来，绑定也不能指向不存在的节点、不存在的输入、或者被连线占用的输入。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixedComfyFeatures, findFeature } from '../../shared/dist/index.js';
import { validateBindings } from '../dist/workflows/bindings.js';
import { scanApiGraph } from '../dist/workflows/scanner.js';

const here = dirname(fileURLToPath(import.meta.url));
const WF_ROOT = resolve(here, '../../../workflows');

function loadWorkflow(id) {
  const dir = join(WF_ROOT, id);
  return {
    graph: JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8')),
    bindings: JSON.parse(readFileSync(join(dir, 'binding.json'), 'utf8')).bindings,
    meta: JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  };
}

/** 这些参数是给 Helper 自己用的，不需要在工作流里有落点。 */
const HELPER_ONLY_PARAMS = new Set([
  'promptEnhance', // 提交前调文本模型，不进图
  'model', // 闭源分支才用
  'reversePrompt',
  'stylePreset',
  'structurePrompt',
  'outputType',
  'aspect'
]);

test('11 个固定功能都有对应的内置工作流目录', () => {
  const features = fixedComfyFeatures();
  assert.equal(features.length, 11);
  for (const f of features) {
    const dir = join(WF_ROOT, f.defaultWorkflowId);
    assert.ok(existsSync(dir), `缺少工作流目录 ${f.defaultWorkflowId}`);
    for (const file of ['graph.json', 'binding.json', 'meta.json']) {
      assert.ok(existsSync(join(dir, file)), `${f.defaultWorkflowId} 缺少 ${file}`);
    }
  }
});

test('workflows 目录下没有多余的工作流', () => {
  const expected = new Set(fixedComfyFeatures().map((f) => f.defaultWorkflowId));
  const actual = readdirSync(WF_ROOT);
  for (const dir of actual) {
    assert.ok(expected.has(dir), `多余的工作流目录: ${dir}`);
  }
  assert.equal(actual.length, expected.size);
});

test('meta 里的 featureId 与目录名互相对得上', () => {
  for (const f of fixedComfyFeatures()) {
    const { meta } = loadWorkflow(f.defaultWorkflowId);
    assert.equal(meta.id, f.defaultWorkflowId);
    assert.equal(meta.featureId, f.id, `${f.defaultWorkflowId} 的 featureId 不对`);
    assert.ok(meta.name.length > 0);
    assert.ok(meta.notes.length > 10, `${f.defaultWorkflowId} 应说明参数映射关系`);
  }
});

test('每份工作流都有输出节点，且能被扫描器解析', () => {
  for (const f of fixedComfyFeatures()) {
    const { graph } = loadWorkflow(f.defaultWorkflowId);
    const scan = scanApiGraph(graph);
    assert.ok(scan.ok, `${f.defaultWorkflowId} 没有输出节点`);
    assert.ok(scan.outputNodeIds.length > 0);
    assert.equal(scan.warnings.length, 0, `${f.defaultWorkflowId} 有结构告警: ${scan.warnings.join('; ')}`);
  }
});

test('绑定全部指向真实存在的节点与输入', () => {
  for (const f of fixedComfyFeatures()) {
    const { graph, bindings } = loadWorkflow(f.defaultWorkflowId);
    const problems = validateBindings(graph, bindings);
    assert.deepEqual(problems, [], `${f.defaultWorkflowId} 的绑定有问题`);
  }
});

test('每个功能参数都有落点 —— 面板上没有转不动的旋钮', () => {
  const dead = [];
  for (const f of fixedComfyFeatures()) {
    const { bindings } = loadWorkflow(f.defaultWorkflowId);
    const bound = new Set(bindings.map((b) => b.paramId));
    for (const p of f.params) {
      if (HELPER_ONLY_PARAMS.has(p.id)) continue;
      if (!bound.has(p.id)) dead.push(`${f.id}.${p.id}（${p.label}）`);
    }
  }
  assert.deepEqual(dead, [], '以下参数在工作流里没有任何落点，等于摆了个假控件');
});

test('绑定引用的参数都真实存在于功能定义里', () => {
  const ghosts = [];
  for (const f of fixedComfyFeatures()) {
    const { bindings } = loadWorkflow(f.defaultWorkflowId);
    const known = new Set(f.params.map((p) => p.id));
    for (const b of bindings) {
      if (!known.has(b.paramId)) ghosts.push(`${f.defaultWorkflowId} 绑定了不存在的参数 ${b.paramId}`);
    }
  }
  assert.deepEqual(ghosts, []);
});

test('工作流声明的依赖节点与图里实际用到的一致', () => {
  for (const f of fixedComfyFeatures()) {
    const { graph } = loadWorkflow(f.defaultWorkflowId);
    const actual = new Set(Object.values(graph).map((n) => n.class_type));
    for (const declared of f.requiredNodeTypes) {
      assert.ok(actual.has(declared), `${f.id} 声明依赖 ${declared}，但工作流里没用到`);
    }
    for (const used of actual) {
      assert.ok(
        f.requiredNodeTypes.includes(used),
        `${f.id} 的工作流用到了 ${used}，但没有写进 requiredNodeTypes（依赖预检会漏掉它）`
      );
    }
  }
});

test('输入图绑定是必填的，种子绑定在需要随机性的工作流里也是必填', () => {
  for (const f of fixedComfyFeatures()) {
    const { bindings, graph } = loadWorkflow(f.defaultWorkflowId);
    const image = bindings.find((b) => b.paramId === 'image');
    assert.ok(image, `${f.id} 没有绑定输入图`);
    assert.equal(image.required, true, `${f.id} 的输入图绑定应为必填`);

    const hasSampler = Object.values(graph).some((n) => n.class_type === 'KSampler');
    const seed = bindings.find((b) => b.paramId === 'seed');
    if (hasSampler) {
      assert.ok(seed, `${f.id} 有采样器却没绑定种子`);
      assert.equal(seed.required, true, `${f.id} 的种子绑定应为必填`);
    } else {
      assert.equal(seed, undefined, `${f.id} 没有采样器就不该绑定种子`);
    }
  }
});

test('无损放大不含任何随机来源', () => {
  const { graph, bindings } = loadWorkflow('wf.upscale.lossless');
  const classes = Object.values(graph).map((n) => n.class_type);
  assert.ok(!classes.includes('KSampler'), '无损放大不应有采样器');
  assert.ok(!bindings.some((b) => b.paramId === 'seed'), '无损放大不应有种子');
  assert.ok(!bindings.some((b) => b.paramId === 'denoise'), '无损放大不应有重绘幅度');
});

test('语义滑杆的线性映射区间都是有意义的', () => {
  const checks = [
    ['wf.wash.portrait', 'realism', 'cfg'],
    ['wf.edit.texture', 'texture', 'cfg'],
    ['wf.retouch.product', 'strength', 'denoise'],
    ['wf.viewpoint.orbit', 'strength', 'denoise'],
    ['wf.relight.fixed', 'lighting', 'multiplier']
  ];
  for (const [wfId, paramId, input] of checks) {
    const { bindings } = loadWorkflow(wfId);
    const b = bindings.find((x) => x.paramId === paramId);
    assert.ok(b, `${wfId} 没有绑定 ${paramId}`);
    assert.equal(b.input, input, `${paramId} 应该映射到 ${input}`);
    assert.equal(b.transform?.type, 'linear', `${paramId} 应使用线性映射`);
    assert.ok(b.transform.outMin < b.transform.outMax, `${paramId} 的映射区间方向不对`);
    assert.equal(b.transform.inMin, 0);
    assert.equal(b.transform.inMax, 1);
  }
});

test('分辨率绑定用的是尺寸变换，不是把数字直接塞进宽高', () => {
  for (const f of fixedComfyFeatures()) {
    const { bindings } = loadWorkflow(f.defaultWorkflowId);
    const sizeBindings = bindings.filter((b) => b.paramId === 'resolution');
    if (sizeBindings.length === 0) continue;
    for (const b of sizeBindings) {
      assert.ok(
        ['sizeWidth', 'sizeHeight'].includes(b.transform?.type),
        `${f.defaultWorkflowId} 的分辨率绑定应使用 sizeWidth/sizeHeight 变换`
      );
    }
  }
});

test('放大倍数绑定会把字符串转成数字', () => {
  for (const id of ['wf.upscale.general', 'wf.upscale.lossless']) {
    const { bindings } = loadWorkflow(id);
    const b = bindings.find((x) => x.paramId === 'upscaleFactor');
    assert.ok(b, `${id} 没有绑定放大倍数`);
    assert.equal(b.input, 'scale_by');
    assert.equal(b.transform?.type, 'number', '分段控件的值是字符串，必须转成数字');
  }
});

test('带摄像机的功能会把机位片段追加到提示词而不是覆盖它', () => {
  for (const id of ['wf.relight.adaptive', 'wf.viewpoint.orbit']) {
    const { bindings } = loadWorkflow(id);
    const cam = bindings.find((b) => b.paramId === 'camera');
    assert.ok(cam, `${id} 没有绑定摄像机`);
    assert.equal(cam.transform?.type, 'appendText', '机位必须是追加，不能覆盖用户提示词');

    const prompt = bindings.find((b) => b.paramId === 'prompt');
    assert.ok(prompt, `${id} 没有绑定提示词`);
    assert.equal(cam.nodeId, prompt.nodeId, '机位应追加到正向提示词那个节点');
  }
});

test('负向提示词绑定的是标题含 Negative 的那个节点', () => {
  for (const f of fixedComfyFeatures()) {
    const { graph, bindings } = loadWorkflow(f.defaultWorkflowId);
    const neg = bindings.find((b) => b.paramId === 'negativePrompt');
    if (!neg) continue;
    const node = graph[neg.nodeId];
    assert.ok(
      /negative/i.test(node._meta?.title ?? ''),
      `${f.defaultWorkflowId} 的负向提示词绑到了 ${node._meta?.title}，可能接反了`
    );
  }
});
