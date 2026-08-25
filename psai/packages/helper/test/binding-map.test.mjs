/**
 * map 变换：把界面上的取值换成节点认识的枚举词。
 *
 * 存在的理由很具体：BiRefNetRMBG 的 background 只认 'Alpha' / 'Color'，
 * 而面板上该写「纯白底（电商主图）」「透明」。没有这层映射就只能二选一 ——
 * 要么把 'Color' 直接摆到用户面前，要么给每个枚举单独写一个工作流。
 *
 * 真机踩过：没有这个变换时，'white' 被原样发给 ComfyUI，
 * 提交阶段整个被拒（value_not_in_list），而错误信息里看不出是哪个参数干的。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bindingsToNodeInfoList } from '../dist/workflows/bindings.js';

/** 一张最小的图：一个带枚举输入的节点。 */
function graph() {
  return {
    '2': {
      class_type: 'BiRefNetRMBG',
      inputs: { image: ['1', 0], background: 'Alpha', mask_blur: 0 }
    }
  };
}

const bg = (map) => [
  { paramId: 'mattingBackground', nodeId: '2', input: 'background', required: false, transform: { type: 'map', map } }
];
const MAP = { white: 'Color', alpha: 'Alpha' };

test('界面取值被换成节点认识的枚举词', () => {
  const { nodeInfoList } = bindingsToNodeInfoList(graph(), bg(MAP), { mattingBackground: 'white' });
  const hit = nodeInfoList.find((n) => n.fieldName === 'background');
  assert.ok(hit, 'background 没有被写进去');
  assert.equal(hit.fieldValue, 'Color');
});

test('另一个分支也要映射正确', () => {
  // 注意图里 background 的原值就是 'Alpha'，而 nodeInfoList 只装**改动过**的字段
  // （这是有意的：空改动提交上去等于让远端跑作者的默认值）。
  // 所以要验 alpha 这一支，得让图的原值和目标值不同。
  const g = { '2': { class_type: 'BiRefNetRMBG', inputs: { image: ['1', 0], background: 'Color' } } };
  const { nodeInfoList } = bindingsToNodeInfoList(g, bg(MAP), { mattingBackground: 'alpha' });
  assert.equal(nodeInfoList.find((n) => n.fieldName === 'background')?.fieldValue, 'Alpha');
});

test('映射结果和图里原值相同时不重复下发', () => {
  // 少一条 nodeInfoList 就少一次覆盖，语义完全一样，但请求更小、更好读
  const { nodeInfoList } = bindingsToNodeInfoList(graph(), bg(MAP), { mattingBackground: 'alpha' });
  assert.equal(nodeInfoList.find((n) => n.fieldName === 'background'), undefined);
});

test('映射不中时不写这个字段，让节点保持默认值', () => {
  // 硬塞一个不在枚举里的值，ComfyUI 会在提交时整个拒绝，
  // 而且报错指不到是哪个参数 —— 那比"这个参数没生效"难查得多。
  const { nodeInfoList } = bindingsToNodeInfoList(graph(), bg(MAP), { mattingBackground: '不存在的取值' });
  assert.equal(nodeInfoList.find((n) => n.fieldName === 'background'), undefined, '不该写入非法枚举值');
});

test('取值为空时同样不写', () => {
  for (const v of ['', null, undefined]) {
    const { nodeInfoList } = bindingsToNodeInfoList(graph(), bg(MAP), { mattingBackground: v });
    assert.equal(nodeInfoList.find((n) => n.fieldName === 'background'), undefined, `${JSON.stringify(v)} 不该写入`);
  }
});

test('原型链上的键不算命中', () => {
  // map 是个普通对象，'toString' 这种键在原型上存在。
  // 用 in / [] 取值会把它当成命中，然后把一个函数塞进 fieldValue。
  const { nodeInfoList } = bindingsToNodeInfoList(graph(), bg(MAP), { mattingBackground: 'toString' });
  assert.equal(nodeInfoList.find((n) => n.fieldName === 'background'), undefined, '原型键不该被当成映射项');
});

test('数字与布尔目标值也支持', () => {
  const g = { '5': { class_type: 'X', inputs: { steps: 1, flag: false } } };
  const b = [
    { paramId: 'q', nodeId: '5', input: 'steps', required: false, transform: { type: 'map', map: { high: 40, low: 8 } } },
    { paramId: 'f', nodeId: '5', input: 'flag', required: false, transform: { type: 'map', map: { on: true } } }
  ];
  const { nodeInfoList } = bindingsToNodeInfoList(g, b, { q: 'high', f: 'on' });
  assert.equal(nodeInfoList.find((n) => n.fieldName === 'steps')?.fieldValue, 40);
  assert.equal(nodeInfoList.find((n) => n.fieldName === 'flag')?.fieldValue, true);
});
