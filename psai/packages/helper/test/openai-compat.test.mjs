/**
 * 闭源模型（OpenAI 兼容族）适配器的回归测试。
 *
 * 这一族踩过四个坑，每一个都会让用户看到「闭源模型没有任何结果」：
 *
 *  1. 无条件发 response_format —— gpt-image-* 直接 400 拒收，
 *     而那恰好是画得最好的一批模型，等于整族不可用
 *  2. 尺寸不吸附 —— 面板算出 1280×1280，gpt-image-* 只认三种尺寸，400
 *  3. 错误映射太粗 —— 上游明明回了一句「该模型无可用渠道」，
 *     我们却报「服务返回了无法解析的响应」，把排查方向带偏
 *  4. 反推提示词用生图默认模型 —— 拿 flux 去发 chat/completions，
 *     报一个和反推毫不相干的错
 *
 * 这里全部用纯函数级别的断言，不打网络：真接口的验证在 test:cloud:real。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { snapSize, pickVisionModel } from '../dist/providers/openai.js';

test('gpt-image 1 代会被吸附到它认的档位', () => {
  // 面板的分辨率滑杆能算出任意尺寸，1 代只认这三种
  assert.equal(snapSize('gpt-image-1', 1280, 1280), '1024x1024');
  assert.equal(snapSize('gpt-image-1.5', 2048, 2048), '1024x1024');
});

test('gpt-image-2 认任意尺寸，不能再被吸附', () => {
  // 真机实测：size=3000x1777 → 3008x1792、size=2048x2048 → 2048x2048。
  // 以前这里按 /^gpt-image/ 一刀切，把 2 代也按死在 1536 以内 ——
  // 用户拿 4000px 原图去洗，回来最多 1536px，还找不到是谁砍的。
  assert.equal(snapSize('gpt-image-2', 512, 512), '512x512');
  assert.equal(snapSize('gpt-image-2', 3000, 1777), '3000x1777');
  assert.equal(snapSize('gpt-image-2-all', 2048, 2048), '2048x2048');
});

test('吸附时按长宽比挑，竖图不会被换成横图', () => {
  // 用户选了竖构图就该给竖的，不能因为面积接近给个横的
  assert.equal(snapSize('gpt-image-1', 960, 1280), '1024x1536', '竖图应吸附到竖的档位');
  assert.equal(snapSize('gpt-image-1', 1280, 960), '1536x1024', '横图应吸附到横的档位');
  assert.equal(snapSize('dall-e-3', 720, 1280), '1024x1792');
  assert.equal(snapSize('dall-e-3', 1280, 720), '1792x1024');
});

test('不认识的模型原样透传，不替它做限制', () => {
  // 各家 flux / seedream 大多接受任意尺寸，我们不了解就不该越俎代庖
  assert.equal(snapSize('flux-2-max', 1280, 1280), '1280x1280');
  assert.equal(snapSize('doubao-seedream-4-0-250828', 1536, 864), '1536x864');
  assert.equal(snapSize('某个没见过的模型', 777, 333), '777x333');
});

test('dall-e-2 的小尺寸档位也对得上', () => {
  assert.equal(snapSize('dall-e-2', 300, 300), '256x256');
  assert.equal(snapSize('dall-e-2', 900, 900), '1024x1024');
});

test('从平台的模型列表里挑得出视觉模型', () => {
  // 反推提示词要走 chat/completions，必须是看得懂图的模型
  assert.equal(pickVisionModel(['flux-2-max', 'gpt-4o-mini', 'dall-e-3']), 'gpt-4o-mini');
  assert.equal(pickVisionModel(['dall-e-3', 'gpt-4o']), 'gpt-4o');
  assert.equal(pickVisionModel(['qwen-vl-max', 'flux-dev']), 'qwen-vl-max');
});

test('偏好顺序：小而快的优先，反推不值得用最贵的', () => {
  assert.equal(pickVisionModel(['gpt-4o', 'gpt-4o-mini']), 'gpt-4o-mini');
  assert.equal(pickVisionModel(['gpt-5', 'gpt-5-mini']), 'gpt-5-mini');
});

test('全是生图模型时挑不出来，如实返回 null', () => {
  // 挑不出来要让调用方走兜底，而不是随便塞一个生图模型去发聊天请求
  assert.equal(pickVisionModel(['flux-2-max', 'dall-e-3', 'doubao-seedream-4-0-250828']), null);
  assert.equal(pickVisionModel([]), null);
});

test('视觉模型匹配不会误伤同名前缀', () => {
  // gpt-4o-mini-tts 不是视觉模型，别因为前缀像就选中
  assert.equal(pickVisionModel(['gpt-4o-mini-tts', 'gpt-4o-mini-audio']), null);
  assert.equal(pickVisionModel(['gpt-4o-mini-tts', 'gpt-4o-mini']), 'gpt-4o-mini');
});
