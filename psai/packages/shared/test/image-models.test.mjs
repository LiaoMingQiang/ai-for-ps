/**
 * 生图模型筛选的回归测试。
 *
 * Comfly 的 /models 一次返回 858 个模型，里面绝大多数是聊天、语音、
 * 嵌入、重排序模型 —— 拿去 /images/generations 一律失败。
 * 用户在「参数设置 → 模型」里翻这个下拉，随手点中一个非生图模型，
 * 看到的就是「没有任何结果」，而问题其实出在选项本身不该出现在那里。
 *
 * 筛选必须两头都稳：
 *   - 该留的不能漏（漏了等于把能用的模型藏起来）
 *   - 该滤的不能留（留了就是给用户递一把会炸的枪）
 * 拿不准的时候宁可留着 —— 少一个选项是功能缺失，多一个只是多试一次。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLikelyImageModel } from '../dist/providers.js';

test('主流生图模型都认得出来', () => {
  const shouldKeep = [
    'gpt-image-1',
    'gpt-image-1.5',
    'dall-e-3',
    'dall-e-2',
    'flux-2-max',
    'flux-kontext-pro',
    'doubao-seedream-4-0-250828',
    'gemini-3-pro-image',
    'qwen-image-edit',
    'stable-diffusion-3.5-large',
    'nano-banana',
    'wanx2.1-t2i-turbo',
    'irag-1.0',
    'kolors-2.0'
  ];
  for (const m of shouldKeep) {
    assert.equal(isLikelyImageModel(m), true, `${m} 是生图模型，不该被滤掉`);
  }
});

test('聊天 / 语音 / 嵌入模型会被滤掉', () => {
  const shouldDrop = [
    'gpt-4o',
    'gpt-5-mini',
    'claude-opus-4-20250514',
    'deepseek-chat',
    'text-embedding-3-large',
    'bge-reranker-v2-m3',
    'whisper-1',
    'tts-1-hd',
    'gpt-4o-mini-tts',
    'sora-2',
    'moonshot-v1-128k'
  ];
  for (const m of shouldDrop) {
    assert.equal(isLikelyImageModel(m), false, `${m} 不是生图模型，不该出现在下拉里`);
  }
});

test('名字带 image 但走不通 /images/generations 的要排掉', () => {
  // 这几个真机上试过：模型确实存在，但接口路径不同，点了必然失败。
  // 注意 mj_* 是 MJ 的动作端点与计费 SKU（upscale / blend 都要先有一个已存在的任务），
  // 真正能文生图的入口是认可名单里那个裸的 `midjourney`，它走 /mj/submit/imagine。
  assert.equal(isLikelyImageModel('mj_imagine'), false, 'MJ 动作端点不是"选中就能生图"的东西');
  assert.equal(isLikelyImageModel('mj_blend'), false);
  assert.equal(isLikelyImageModel('midjourney-v7'), false, '平台上没有这个 id，版本在提示词里');
  assert.equal(isLikelyImageModel('kolors-virtual-try-on-v1'), false, '虚拟试衣是专用接口');
});

test('视频模型不能混进生图下拉', () => {
  // wanx 系列里一半是视频：i2v = 图生视频，t2v = 文生视频。
  // 出的不是图，写不回 Photoshop 图层，摆在这里纯粹是误导。
  const video = [
    'wanx2.1-i2v-plus',
    'wanx2.1-i2v-turbo',
    'wanx2.1-t2v-plus',
    'wanx2.1-t2v-turbo',
    'wanx2.1-kf2v-plus',
    'wanx2.1-vace-plus'
  ];
  for (const m of video) {
    assert.equal(isLikelyImageModel(m), false, `${m} 出的是视频，不该出现在生图下拉里`);
  }
  // 但同族的生图模型要留下
  assert.equal(isLikelyImageModel('wanx2.1-t2i-turbo'), true);
  assert.equal(isLikelyImageModel('sora_image'), true, 'sora_image 是 sora 的生图变体，能出图');
});

test('gpt-4o-image 这类多模态生图要留下', () => {
  // 名字前缀像聊天模型，但确实能出图 —— 前缀匹配不能一刀切
  assert.equal(isLikelyImageModel('gpt-4o-image'), true);
  assert.equal(isLikelyImageModel('gpt-4o-image-vip'), true);
});

test('大小写和空格不影响判断', () => {
  assert.equal(isLikelyImageModel('  FLUX-2-MAX  '), true);
  assert.equal(isLikelyImageModel('DALL-E-3'), true);
  assert.equal(isLikelyImageModel('  GPT-4O  '), false);
});
