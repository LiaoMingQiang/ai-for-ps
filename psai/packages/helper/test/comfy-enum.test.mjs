/**
 * ComfyUI `/object_info` 的枚举解析。
 *
 * 这个 bug 的形态值得记一笔：它**不报错**。枚举读成空数组之后，
 * 界面上就是一个空下拉、依赖体检里就是"缺模型"，没有任何异常、日志里一个字都没有。
 * 真机上 models/upscale_models 里躺着 5 个权重（4x-UltraSharp、RealESRGAN_x4plus…），
 * 而 enumOf('UpscaleModelLoader','model_name') 返回 [] —— 我自己也被它骗过一轮，
 * 在审计报告里写下了"本机没有任何放大模型"。
 *
 * 起因是 ComfyUI 0.30 换了枚举的返回形状，而解析只认老的那种。
 * 两种形状都要认，并且要有测试钉住 —— 下次对端再换形状时，
 * 我们该收到的是一条失败的断言，而不是一个安静变空的下拉框。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComfyUiAdapter } from '../dist/providers/comfyui.js';

/** 造一个只回放固定 object_info 的适配器，不碰网络。 */
function adapterWith(objectInfo) {
  const a = new ComfyUiAdapter({ baseUrl: 'http://127.0.0.1:8188', timeoutMs: 1000 }, {
    debug() {}, info() {}, warn() {}, error() {}, throttled() {}
  });
  a.objectInfo = async () => objectInfo;
  return a;
}

test('老写法 [[...], {...}] 能读出枚举', () => {
  const a = adapterWith({
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors'], {}] } } }
  });
  return a.enumOf('CheckpointLoaderSimple', 'ckpt_name').then((v) => {
    assert.deepEqual(v, ['a.safetensors', 'b.safetensors']);
  });
});

test('新写法 ["COMBO", { options: [...] }] 也能读出枚举', async () => {
  // ComfyUI 0.30.1 真机返回的就是这个形状 —— 上一版解析在这里返回空数组
  const a = adapterWith({
    UpscaleModelLoader: {
      input: {
        required: {
          model_name: ['COMBO', { multiselect: false, options: ['4x-UltraSharp.pth', 'RealESRGAN_x4plus.pth'] }]
        }
      }
    }
  });
  assert.deepEqual(await a.enumOf('UpscaleModelLoader', 'model_name'), [
    '4x-UltraSharp.pth',
    'RealESRGAN_x4plus.pth'
  ]);
});

test('optional 里的枚举同样要认', async () => {
  const a = adapterWith({
    N: { input: { optional: { m: ['COMBO', { options: ['x'] }] } } }
  });
  assert.deepEqual(await a.enumOf('N', 'm'), ['x']);
});

test('节点或字段不存在时返回空数组，不抛', async () => {
  const a = adapterWith({ N: { input: { required: {} } } });
  assert.deepEqual(await a.enumOf('NoSuchNode', 'x'), []);
  assert.deepEqual(await a.enumOf('N', 'nope'), []);
});

test('形状怪异时返回空数组，不崩', async () => {
  // 对端换形状是它的自由，我们可以读不出来，但不能整个挂掉
  for (const slot of [null, 'COMBO', ['COMBO'], ['COMBO', {}], ['COMBO', { options: 'not-an-array' }], [123, {}]]) {
    const a = adapterWith({ N: { input: { required: { f: slot } } } });
    assert.deepEqual(await a.enumOf('N', 'f'), [], `slot=${JSON.stringify(slot)}`);
  }
});

test('枚举值一律转成字符串', async () => {
  // 有些节点的枚举是数字（比如某些档位选择），下游按字符串用
  const a = adapterWith({ N: { input: { required: { f: ['COMBO', { options: [1, 2.5] }] } } } });
  assert.deepEqual(await a.enumOf('N', 'f'), ['1', '2.5']);
});
