/**
 * RunningHub 内置预设的**离线**自洽性检查。
 *
 * 「绑定的节点在云端还在不在」要打真接口，那是 npm run verify:rh 的活。
 * 这里只查不用联网就能查的：预设自身是否自相矛盾，以及它和功能目录对不对得上。
 *
 * 最要紧的一条是必填绑定的参数覆盖：预设写了 required 的绑定，
 * 如果它推荐挂载的功能压根没有这个参数，取值永远是 undefined，
 * 提交时必然抛 JOB_PARAM_INVALID —— 这个功能等于配了个用不了的后端，
 * 而且要等用户真的点一次生成才会发现。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RUNNINGHUB_PRESETS,
  RH_CATEGORY_LABELS,
  rhPreset,
  rhPresetByWorkflowId,
  rhPresetsForFeature,
  rhPostUrl,
  findFeature
} from '../dist/index.js';

/**
 * 图像类绑定用的是语义名，Helper 的 imageAliases() 会把功能目录里的
 * image / images / background 都对到这几个名字上，所以不按功能参数名去查。
 */
const IMAGE_ALIASES = new Set(['image', 'images', 'reference', 'background']);

test('每条预设的必填字段都齐全且合法', () => {
  assert.ok(RUNNINGHUB_PRESETS.length >= 10, `预设太少：${RUNNINGHUB_PRESETS.length}`);
  for (const p of RUNNINGHUB_PRESETS) {
    assert.match(p.id, /^rh\./, `${p.id} 的 id 应以 rh. 开头`);
    assert.match(p.workflowId, /^\d{15,}$/, `${p.id} 的 workflowId 不像 RunningHub 的 id：${p.workflowId}`);
    assert.ok(p.label.trim(), `${p.id} 缺 label`);
    assert.ok(p.description.trim().length > 8, `${p.id} 的说明太短，用户看不懂它做什么`);
    assert.ok(p.stack.trim(), `${p.id} 缺 stack（用户靠它判断风格）`);
    assert.ok(p.nodeCount > 0, `${p.id} 的 nodeCount 没填`);
    assert.ok(RH_CATEGORY_LABELS[p.category], `${p.id} 的 category ${p.category} 没有中文名`);
    assert.ok(p.bindings.length > 0, `${p.id} 没有任何绑定 —— 空 nodeInfoList 会让云端拿作者的示例图出图`);
    assert.ok(p.outputNodeIds.length > 0, `${p.id} 没有出图节点`);
    assert.ok(p.featureIds.length > 0, `${p.id} 没有挂到任何功能上，用户在设置里选不到它`);
  }
});

test('预设 id 与云端工作流 id 都不重复', () => {
  const ids = RUNNINGHUB_PRESETS.map((p) => p.id);
  const wfs = RUNNINGHUB_PRESETS.map((p) => p.workflowId);
  assert.equal(new Set(ids).size, ids.length, `预设 id 有重复：${ids.join(', ')}`);
  assert.equal(new Set(wfs).size, wfs.length, `云端工作流 id 有重复：${wfs.join(', ')}`);
});

test('每条绑定内部自洽', () => {
  for (const p of RUNNINGHUB_PRESETS) {
    const seen = new Set();
    for (const b of p.bindings) {
      assert.ok(b.paramId, `${p.id} 有绑定缺 paramId`);
      assert.match(String(b.nodeId), /^\d+$/, `${p.id} 的 nodeId ${b.nodeId} 不是数字`);
      assert.ok(b.input, `${p.id}.${b.paramId} 缺 input 字段名`);
      const key = `${b.nodeId}.${b.input}`;
      assert.ok(!seen.has(key), `${p.id} 把 ${key} 绑了两次，后一条会覆盖前一条`);
      seen.add(key);
    }
  }
});

test('预设挂载的功能都真实存在', () => {
  for (const p of RUNNINGHUB_PRESETS) {
    for (const fid of p.featureIds) {
      assert.ok(findFeature(fid), `${p.id} 挂到了不存在的功能 ${fid}`);
    }
  }
});

test('必填绑定的参数在它挂载的每个功能上都存在', () => {
  const problems = [];
  for (const p of RUNNINGHUB_PRESETS) {
    const required = p.bindings.filter((b) => b.required);
    for (const fid of p.featureIds) {
      const feature = findFeature(fid);
      if (!feature) continue;
      const paramIds = new Set(feature.params.map((x) => x.id));
      for (const b of required) {
        if (IMAGE_ALIASES.has(b.paramId)) {
          // 图像参数按语义名对齐；只要功能确实有个图输入就算数
          const hasImage = feature.params.some((x) => x.kind === 'image' || x.kind === 'imageList');
          if (!hasImage) problems.push(`${p.id} 需要图像输入，但功能 ${fid} 没有任何图像参数`);
          continue;
        }
        // 以 __ 开头的是我们自己塞的常量（比如把作者的风格 LoRA 置零），不来自用户参数
        if (b.paramId.startsWith('__')) continue;
        if (!paramIds.has(b.paramId)) {
          problems.push(`${p.id} 的必填绑定 ${b.paramId} 在功能 ${fid} 上不存在，提交必然失败`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('用 const 变换的绑定不需要用户参数', () => {
  for (const p of RUNNINGHUB_PRESETS) {
    for (const b of p.bindings) {
      if (!b.paramId.startsWith('__')) continue;
      assert.equal(
        b.transform?.type,
        'const',
        `${p.id}.${b.paramId} 是内部固定值，必须配 const 变换，否则取不到值会被静默跳过`
      );
    }
  }
});

test('查询函数都能用', () => {
  const first = RUNNINGHUB_PRESETS[0];
  assert.equal(rhPreset(first.id)?.id, first.id);
  assert.equal(rhPreset('不存在'), null);
  assert.equal(rhPresetByWorkflowId(first.workflowId)?.id, first.id);
  assert.equal(rhPresetByWorkflowId('  '), null, '空字符串不该匹配到任何预设');
  assert.equal(rhPresetByWorkflowId('0000000000000000000'), null);
  assert.ok(rhPresetsForFeature(first.featureIds[0]).some((p) => p.id === first.id));
  assert.deepEqual(rhPresetsForFeature('不存在的功能'), []);
  assert.equal(rhPostUrl('123'), 'https://www.runninghub.cn/post/123');
});

test('用户最关心的几类能力都有预设覆盖', () => {
  // 这几类是产品答应过要开箱可用的，缺一类就是承诺没兑现
  const must = ['textToImage', 'imageToImage', 'matting', 'background', 'inpaint', 'outpaint', 'upscale', 'relight'];
  const have = new Set(RUNNINGHUB_PRESETS.map((p) => p.category));
  const missing = must.filter((c) => !have.has(c));
  assert.deepEqual(missing, [], `以下能力没有任何云端预设：${missing.map((c) => RH_CATEGORY_LABELS[c]).join('、')}`);
});

test('声明需要遮罩的预设，必须挂在能拿到选区的功能上', () => {
  for (const p of RUNNINGHUB_PRESETS.filter((x) => x.needsMask)) {
    for (const fid of p.featureIds) {
      const feature = findFeature(fid);
      if (!feature) continue;
      const img = feature.params.find((x) => x.kind === 'image');
      assert.ok(img, `${p.id} 需要遮罩，但功能 ${fid} 没有单图输入`);
      assert.ok(
        img.sources.includes('selection'),
        `${p.id} 需要遮罩，功能 ${fid} 的图像输入却不支持从选区取图，用户没法产生遮罩`
      );
    }
  }
});
