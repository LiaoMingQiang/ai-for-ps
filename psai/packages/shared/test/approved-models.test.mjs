/**
 * 出厂认可的生图模型名单 —— 以及"认可"到底意味着什么。
 *
 * 这份名单不是按名字好看挑的，每一族都在真机上（Comfly 真账号，858 个模型的目录）
 * 跑出过图，协议也一起钉死了：
 *   gpt-image-2        /v1/images/generations  200 ·  41s
 *   nano-banana-pro    /v1/images/generations  200 ·  33s
 *   gemini-3-pro-image /v1/chat/completions    200 ·  27s
 *   midjourney         /mj/submit/imagine      SUCCESS · 54s
 *
 * 所以这里要守住的不只是"哪些名字在名单里"，还有"每个名字配哪条路"。
 * 名单和路由分家的那一刻，用户就会选中一个列出来却打不通的模型 ——
 * 那正是这轮要修掉的老毛病。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVED_IMAGE_FAMILIES,
  isApprovedImageModel,
  imageRouteFor,
  approvedFamilyOf,
  filterModelsByScope,
  isLikelyImageModel,
  midjourneyVersionOf,
  normalizeMidjourneyPrompt,
  MJ_MIN_VERSION,
  pickPromptModel,
  PROMPT_MODEL_PREFERENCE,
  DEFAULT_PROMPT_MODEL,
  isModelScope
} from '../dist/providers.js';

/* ---------------- 名单本身 ---------------- */

test('四族认可模型都认得出来，且各自配了正确的协议', () => {
  const cases = [
    // 真机验证过的那几个
    ['gpt-image-2', 'images'],
    ['gpt-image-2-all', 'images'],
    ['nano-banana-pro', 'images'],
    ['nano-banana-pro-2k', 'images'],
    ['nano-banana-pro-4k', 'images'],
    ['gemini-3-pro-image', 'chat'],
    ['gemini-3-pro-image-2k', 'chat'],
    ['gemini-3-pro-image-preview', 'chat'],
    ['gemini-3.1-flash-image', 'chat'],
    ['gemini-3.1-flash-image-512px', 'chat'],
    ['gemini-2.5-flash-image', 'chat'],
    ['gemini-2.0-flash-exp-image-generation', 'chat'],
    ['midjourney', 'mj']
  ];
  for (const [id, route] of cases) {
    assert.equal(isApprovedImageModel(id), true, `${id} 应该在认可名单里`);
    assert.equal(imageRouteFor(id), route, `${id} 应该走 ${route} 这条路`);
  }
});

test('名单外的模型不会被误收，也不会被派到某条协议上', () => {
  const outside = [
    // 认可名单从 gpt-image-2 起，1 代不在内
    'gpt-image-1',
    'gpt-image-1.5',
    'gpt-image-1.5-2025-12-16',
    // Nano-Banana 只认 Pro
    'nano-banana',
    'nano-banana-2',
    'nano-banana-2-4k',
    'nano-banana-hd',
    // 名字里没有 image 的 gemini 全是纯文本模型
    'gemini-3-pro-preview',
    'gemini-2.5-flash',
    'gemini-3.5-flash',
    // 这些能生图，但不在出厂认可名单里（用户可以拉全量后自己选）
    'flux-2-max',
    'dall-e-3',
    'doubao-seedream-4-0-250828',
    // MJ 的动作端点与计费 SKU，不是"选中就能文生图"的东西
    'mj_fast_imagine',
    'mj_relax_imagine',
    'mj_fast_upscale',
    'mj_relax_blend',
    // 版本号不在模型名里，midjourney-v7 这个 id 在平台上根本不存在
    'midjourney-v7',
    // 纯聊天
    'gpt-5.6-terra',
    'claude-opus-4-20250514'
  ];
  for (const id of outside) {
    assert.equal(isApprovedImageModel(id), false, `${id} 不该在认可名单里`);
    assert.equal(imageRouteFor(id), null, `${id} 不该被派到任何协议上`);
  }
});

test('认可名单里的每一族都写清楚了它凭什么在名单里', () => {
  // note 是真机结论，不是装饰。空着就说明有人加模型时没验证过就加了。
  for (const f of APPROVED_IMAGE_FAMILIES) {
    assert.ok(f.note.trim().length > 0, `${f.id} 缺少真机验证结论`);
    assert.ok(['images', 'chat', 'mj'].includes(f.route), `${f.id} 的 route 不合法`);
    assert.ok(f.label.trim().length > 0, `${f.id} 缺少展示名`);
  }
});

test('approvedFamilyOf 能定位到具体是哪一族', () => {
  assert.equal(approvedFamilyOf('gemini-3-pro-image-4k')?.id, 'gemini-image');
  assert.equal(approvedFamilyOf('nano-banana-pro-4k')?.id, 'nano-banana-pro');
  assert.equal(approvedFamilyOf('midjourney')?.id, 'midjourney');
  assert.equal(approvedFamilyOf('gpt-4o'), null);
});

test('大小写和首尾空格不影响判断', () => {
  assert.equal(isApprovedImageModel('  GPT-IMAGE-2  '), true);
  assert.equal(imageRouteFor('  Gemini-3-Pro-Image  '), 'chat');
  assert.equal(imageRouteFor(' MidJourney '), 'mj');
});

/* ---------------- 三档口径 ---------------- */

/** 从真机那 858 个里截下来的一小片，保留了各类模型的真实比例。 */
const REAL_SAMPLE = [
  'chatgpt-4o-latest',
  'gpt-3.5-turbo',
  'gpt-image-1',
  'gpt-image-2',
  'gpt-image-2-all',
  'nano-banana',
  'nano-banana-pro',
  'nano-banana-pro-4k',
  'gemini-3-pro-image',
  'gemini-3-pro-preview',
  'gemini-2.5-flash',
  'midjourney',
  'mj_fast_imagine',
  'flux-2-max',
  'dall-e-3',
  'whisper-1',
  'text-embedding-3-large',
  'wanx2.1-i2v-plus',
  'gpt-5.6-terra'
];

test('默认口径只放出认可名单里的那几个', () => {
  const got = filterModelsByScope(REAL_SAMPLE, 'approved');
  assert.equal(got.scope, 'approved');
  assert.equal(got.total, REAL_SAMPLE.length);
  assert.deepEqual(got.models, [
    'gpt-image-2',
    'gpt-image-2-all',
    'nano-banana-pro',
    'nano-banana-pro-4k',
    'gemini-3-pro-image',
    'midjourney'
  ]);
});

test('image 口径更宽，但仍然挡掉聊天 / 语音 / 嵌入 / 视频', () => {
  const got = filterModelsByScope(REAL_SAMPLE, 'image');
  assert.equal(got.scope, 'image');
  for (const dropped of ['chatgpt-4o-latest', 'gpt-3.5-turbo', 'whisper-1', 'text-embedding-3-large', 'gpt-5.6-terra']) {
    assert.ok(!got.models.includes(dropped), `${dropped} 不该出现在 image 口径里`);
  }
  assert.ok(!got.models.includes('wanx2.1-i2v-plus'), '视频模型不该出现在 image 口径里');
  assert.ok(!got.models.includes('mj_fast_imagine'), 'MJ 动作端点不该出现在 image 口径里');
  // 认可名单是 image 的子集：认可的一定也算"像生图"
  for (const m of filterModelsByScope(REAL_SAMPLE, 'approved').models) {
    assert.ok(got.models.includes(m), `${m} 在认可名单里，却没进 image 口径`);
  }
  // 名单外但确实能生图的，这一档要放出来
  for (const m of ['gpt-image-1', 'nano-banana', 'flux-2-max', 'dall-e-3']) {
    assert.ok(got.models.includes(m), `${m} 应该出现在 image 口径里`);
  }
});

test('all 口径一个都不筛', () => {
  const got = filterModelsByScope(REAL_SAMPLE, 'all');
  assert.equal(got.scope, 'all');
  assert.deepEqual(got.models, REAL_SAMPLE);
});

test('逐级兜底：认可名单没命中退到 image，再没有才退全量', () => {
  // 平台上一个认可模型都没有，但有别的生图模型
  const noApproved = ['gpt-4o', 'flux-2-max', 'dall-e-3', 'whisper-1'];
  const a = filterModelsByScope(noApproved, 'approved');
  assert.equal(a.scope, 'image', '要如实报告退了档，不能假装还是 approved');
  assert.deepEqual(a.models, ['flux-2-max', 'dall-e-3']);

  // 命名完全陌生的平台：两档都没命中，只能全列出来让用户自己试
  const exotic = ['厂商专用-001', '厂商专用-002'];
  const b = filterModelsByScope(exotic, 'approved');
  assert.equal(b.scope, 'all');
  assert.deepEqual(b.models, exotic);
});

test('空列表不会崩，也不会假装筛出了东西', () => {
  const got = filterModelsByScope([], 'approved');
  assert.deepEqual(got.models, []);
  assert.equal(got.total, 0);
  assert.equal(got.scope, 'all');
});

test('筛选只过滤，不排序也不去重', () => {
  const dup = ['gpt-image-2', 'gpt-4o', 'midjourney', 'gpt-image-2'];
  assert.deepEqual(filterModelsByScope(dup, 'approved').models, ['gpt-image-2', 'midjourney', 'gpt-image-2']);
});

test('isModelScope 只认这三个值', () => {
  assert.equal(isModelScope('approved'), true);
  assert.equal(isModelScope('image'), true);
  assert.equal(isModelScope('all'), true);
  assert.equal(isModelScope('APPROVED'), false, '大小写不宽容，免得 query 里写错了却静默生效');
  assert.equal(isModelScope('everything'), false);
  assert.equal(isModelScope(''), false);
});

/* ---------------- Midjourney 版本 ---------------- */

test('MJ 版本要从提示词里读，因为模型名里根本没有版本号', () => {
  assert.equal(midjourneyVersionOf('a teapot --v 7'), 7);
  assert.equal(midjourneyVersionOf('a teapot --version 7.2'), 7.2);
  assert.equal(midjourneyVersionOf('a teapot --V 6'), 6);
  assert.equal(midjourneyVersionOf('a teapot --ar 16:9'), null, '没写版本就是没写');
  assert.equal(midjourneyVersionOf('a teapot'), null);
});

test('没写版本就补到认可下限，而不是听凭账号默认值', () => {
  // 不补的话用的是账号默认版本，可能是 v6 甚至更早 ——
  // 那跟"认可名单是 v7+"对不上，而用户完全看不出自己拿到的是哪一版。
  const got = normalizeMidjourneyPrompt('a red teapot --ar 1:1');
  assert.equal(got.error, null);
  assert.equal(got.prompt, `a red teapot --ar 1:1 --v ${MJ_MIN_VERSION}`);
});

test('显式写了低于 v7 的版本要如实拒绝，不能偷偷改成 7', () => {
  const got = normalizeMidjourneyPrompt('a red teapot --v 6');
  assert.ok(got.error, '必须报错');
  assert.match(got.error, /v7/, '错误里要说清楚下限是多少');
  assert.match(got.error, /--v 6/, '错误里要指出用户写的是什么');
  // 静默改写等于替用户改需求，静默照发等于违反名单，两个都不能干
  assert.equal(got.prompt, 'a red teapot --v 6', '拒绝时不改动原提示词');
});

test('已经是 v7 及以上就原样放行，不重复追加参数', () => {
  for (const p of ['a teapot --v 7', 'a teapot --v 7.2', 'a teapot --version 8']) {
    const got = normalizeMidjourneyPrompt(p);
    assert.equal(got.error, null);
    assert.equal(got.prompt, p, `${p} 不该被改写`);
  }
});

/* ---------------- 内置提示词模型 ---------------- */

test('提示词优化内置挑 GPT-5.6 一族', () => {
  // 真机上这三个变体文本与视觉都正常；顺序上快的优先（terra 2.2s < luna 2.8s < sol 7.0s）
  assert.equal(pickPromptModel(['gpt-4o', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5']), 'gpt-5.6-terra');
  assert.equal(pickPromptModel(['gpt-4o', 'gpt-5.6-sol', 'gpt-5.6-luna']), 'gpt-5.6-luna');
  assert.equal(pickPromptModel(['gpt-4o', 'gpt-5.6-sol']), 'gpt-5.6-sol');
});

test('平台没有 5.6 就如实降级，而不是硬发一个不存在的名字', () => {
  // 真机实测：直接发裸的 gpt-5.6 会 503「所有分组对于模型 gpt-5.6 无可用渠道」。
  // 网关上根本没有这个 id，写死它等于每次都撞墙。
  assert.equal(pickPromptModel(['gpt-4o', 'gpt-4o-mini', 'gpt-5.5']), 'gpt-5.5');
  assert.equal(pickPromptModel(['gpt-4o', 'gpt-4o-mini']), 'gpt-4o-mini');
  assert.equal(pickPromptModel(['gpt-4o']), 'gpt-4o');
  assert.equal(pickPromptModel(['deepseek-chat']), null, '一个都挑不出来时要如实说没有');
  assert.equal(pickPromptModel([]), null);
});

test('偏好表里不能只写裸的 gpt-5.6', () => {
  // 这条是防回归：有人"简化"成 /^gpt-5\.6$/ 的话，真机上一个都匹配不上。
  const hitsVariant = PROMPT_MODEL_PREFERENCE.some((re) => re.test('gpt-5.6-terra'));
  assert.ok(hitsVariant, '偏好表必须能匹配到 5.6 的变体名');
  assert.ok(PROMPT_MODEL_PREFERENCE.some((re) => re.test('gpt-5.6-sol')));
  assert.ok(PROMPT_MODEL_PREFERENCE.some((re) => re.test('gpt-5.6-luna')));
});

test('兜底模型是真实存在的 5.6 变体', () => {
  // 拉不到模型列表时会直接发这个 id，它必须是平台上真有的那个名字
  assert.equal(DEFAULT_PROMPT_MODEL, 'gpt-5.6-terra');
  assert.ok(pickPromptModel([DEFAULT_PROMPT_MODEL]) === DEFAULT_PROMPT_MODEL);
});

test('生图模型绝不会被当成提示词模型挑走', () => {
  // 这是老毛病：优化提示词跟着「生图默认模型」走，
  // 用户把默认模型设成 flux-2-max，这一步就拿生图模型去发 chat 请求。
  assert.equal(pickPromptModel(['flux-2-max', 'gpt-image-2', 'nano-banana-pro', 'midjourney']), null);
});

test('认可的生图模型不会被 isLikelyImageModel 漏掉', () => {
  // approved ⊂ image 这个包含关系要一直成立，否则退档时会把认可模型也筛没
  for (const f of APPROVED_IMAGE_FAMILIES) {
    const sample = { 'gpt-image': 'gpt-image-2', 'nano-banana-pro': 'nano-banana-pro', 'gemini-image': 'gemini-3-pro-image', midjourney: 'midjourney' }[f.id];
    assert.ok(sample, `${f.id} 没有对应的抽样 id，测试要跟着名单一起更新`);
    assert.equal(isLikelyImageModel(sample), true, `${sample} 是认可模型，image 口径不该把它滤掉`);
  }
});
