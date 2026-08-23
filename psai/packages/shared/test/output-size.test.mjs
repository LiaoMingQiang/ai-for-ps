/**
 * 出图尺寸规则。
 *
 * 一句话：**非放大类功能，出图就该和原图一样大**；平台做不到精确的，至少 2K。
 *
 * 这条规则之所以要用一整个文件守着，是因为它坏掉的时候完全不出错 ——
 * 任务成功、结果有图、状态是绿的，只有图小了一圈。用户要到贴回 Photoshop、
 * 放到 100% 才发现糊了，那时候原图分辨率已经找不回来了。
 * 静默降质是最难被当成 bug 报上来的一类问题，所以只能靠测试拦。
 *
 * 尺寸档位全部来自真机实测（Comfly 真账号），不是照文档抄的：
 *   gpt-image-2        size=3000x1777 → 3008x1792   认尺寸
 *   nano-banana-pro    size=3000x1777 → 1376x768    不认，只跟比例
 *   nano-banana-pro-2k                → 2752x1536
 *   nano-banana-pro-4k                → 5504x3072
 *   gemini-3-pro-image    (chat)      → 1024x1024
 *   gemini-3-pro-image-2k (chat)      → 2048x2048
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveOutputSize,
  RESOLUTION_SOURCE,
  ASPECT_SOURCE_ID,
  MIN_OUTPUT_LONG_EDGE
} from '../dist/params.js';
import { planImageSize, sizeProfileOf, stripSizeTier } from '../dist/providers.js';

/* ---------------- 目标尺寸 ---------------- */

test('有输入图时默认照抄原图尺寸，一个像素都不改', () => {
  const got = resolveOutputSize({ resolution: RESOLUTION_SOURCE, inputSize: { width: 4000, height: 3000 } });
  assert.equal(got.width, 4000);
  assert.equal(got.height, 3000);
  assert.equal(got.followedSource, true);
});

test('跟随原图时不做 8 的倍数对齐', () => {
  // 对齐会把 4001 变成 4000，写回 Photoshop 就差一个像素对不上。
  // 真需要对齐的是工作流和平台，让它们自己去 snap。
  const got = resolveOutputSize({ resolution: RESOLUTION_SOURCE, inputSize: { width: 4001, height: 2999 } });
  assert.equal(got.width, 4001);
  assert.equal(got.height, 2999);
});

test('aspect 选「跟随原图」和分辨率选「原图」是同一个意思', () => {
  const a = resolveOutputSize({ aspect: { id: ASPECT_SOURCE_ID }, resolution: 1280, inputSize: { width: 1600, height: 900 } });
  assert.deepEqual([a.width, a.height, a.followedSource], [1600, 900, true]);
});

test('用户显式选了比例就按他选的来，不再照抄原图', () => {
  // 跟随原图是默认，不是强制。用户点了 1:1 就该给正方形。
  const got = resolveOutputSize({ aspect: { id: '1:1' }, resolution: 1024, inputSize: { width: 1600, height: 900 } });
  assert.equal(got.followedSource, false);
  assert.equal(got.width, 1024);
  assert.equal(got.height, 1024);
});

test('用户把分辨率从「原图」挪开时，保持原图长宽比缩到他选的长边', () => {
  // 没有比例控件的 ComfyUI 功能走这一支：他要 1024，就给 1024 长边的同比例图
  const got = resolveOutputSize({ resolution: 1024, inputSize: { width: 4000, height: 3000 } });
  assert.equal(got.followedSource, false);
  assert.equal(got.width, 1024);
  assert.equal(got.height, 768);
});

test('没有输入图时分辨率当正方形，不会因为 inputSize 缺失就崩', () => {
  const got = resolveOutputSize({ resolution: 1280 });
  assert.deepEqual([got.width, got.height, got.followedSource], [1280, 1280, false]);
});

test('输入尺寸不合法时不当成原图用', () => {
  // 0×0 / 负数是解码失败的产物，照抄它等于请求一张 0 像素的图
  for (const bad of [{ width: 0, height: 0 }, { width: -1, height: 100 }, { width: 100, height: 0 }]) {
    const got = resolveOutputSize({ resolution: RESOLUTION_SOURCE, inputSize: bad });
    assert.equal(got.followedSource, false, `${JSON.stringify(bad)} 不该被当成有效原图`);
    assert.ok(got.width > 0 && got.height > 0);
  }
});

/* ---------------- 平台能力 ---------------- */

test('只有 gpt-image-2 这一族真正认尺寸', () => {
  assert.equal(sizeProfileOf('gpt-image-2').exact, true);
  assert.equal(sizeProfileOf('gpt-image-2-all').exact, true);
  // 1 代只认固定档位，不算"认尺寸"
  assert.equal(sizeProfileOf('gpt-image-1').exact, false);
  assert.equal(sizeProfileOf('nano-banana-pro').exact, false);
  assert.equal(sizeProfileOf('gemini-3-pro-image').exact, false);
  assert.equal(sizeProfileOf('midjourney').exact, false);
});

test('不认识的模型按「认尺寸」处理', () => {
  // 猜错的代价是尺寸不对；猜成"不认"则会替一个我们不了解的平台砍掉分辨率，后者严重得多
  assert.equal(sizeProfileOf('flux-2-max').exact, true);
  assert.equal(sizeProfileOf('厂商专用-001').exact, true);
});

test('分辨率后缀能被正确剥离，好重新拼档位', () => {
  assert.equal(stripSizeTier('nano-banana-pro-2k'), 'nano-banana-pro');
  assert.equal(stripSizeTier('nano-banana-pro-4k'), 'nano-banana-pro');
  assert.equal(stripSizeTier('nano-banana-pro'), 'nano-banana-pro');
  assert.equal(stripSizeTier('gemini-3-pro-image-preview-2k'), 'gemini-3-pro-image-preview');
  // 512px 不是我们管理的档位后缀，别乱剥
  assert.equal(stripSizeTier('gemini-3.1-flash-image-512px'), 'gemini-3.1-flash-image-512px');
});

/* ---------------- 尺寸落地方案 ---------------- */

const CATALOG = [
  'gpt-image-2',
  'nano-banana-pro',
  'nano-banana-pro-2k',
  'nano-banana-pro-4k',
  'gemini-3-pro-image',
  'gemini-3-pro-image-2k',
  'gemini-3-pro-image-4k',
  'midjourney'
];

test('认尺寸的模型直接按目标尺寸请求', () => {
  const p = planImageSize('gpt-image-2', { width: 4000, height: 3000 }, CATALOG);
  assert.equal(p.model, 'gpt-image-2', '不该改写模型名');
  assert.equal(p.size, '4000x3000');
});

test('不认尺寸的模型靠改写模型名够到 2K', () => {
  // 这是这条规则真正的实现方式：nano-banana-pro 无论 size 写多大都只给 1376×768，
  // 想要 2K 只能把请求发给 -2k 那个 id。
  const p = planImageSize('nano-banana-pro', { width: 2400, height: 1600 }, CATALOG);
  assert.equal(p.model, 'nano-banana-pro-2k');
  assert.match(p.note, /2k/i);
});

test('原图很小也要够 2K，不能给一张比 2K 还小的图', () => {
  const p = planImageSize('gemini-3-pro-image', { width: 800, height: 600 }, CATALOG);
  assert.equal(p.model, 'gemini-3-pro-image-2k', `2K 是下限，实际给了 ${p.model}`);
});

test('原图很大时挑最接近的档位，而不是无脑上顶格', () => {
  // 4096 档比 2048 档贵得多，3000px 的原图用 2752 就够贴近了
  const p = planImageSize('nano-banana-pro', { width: 3000, height: 2000 }, CATALOG);
  assert.equal(p.model, 'nano-banana-pro-2k');
});

test('已经在合适档位上就不折腾', () => {
  const p = planImageSize('nano-banana-pro-2k', { width: 2600, height: 1400 }, CATALOG);
  assert.equal(p.model, 'nano-banana-pro-2k');
});

test('平台没有那个档位时保持原模型，绝不升到一个不存在的名字', () => {
  // 升到不存在的 id 换来的是 503「无可用渠道」—— 比尺寸小糟糕得多
  const thin = ['nano-banana-pro'];
  const p = planImageSize('nano-banana-pro', { width: 3000, height: 2000 }, thin);
  assert.equal(p.model, 'nano-banana-pro');
  assert.match(p.note, /没有这个模型/);
});

test('拿不到模型列表时不冒险改写模型名', () => {
  const p = planImageSize('nano-banana-pro', { width: 3000, height: 2000 }, []);
  assert.equal(p.model, 'nano-banana-pro');
  assert.match(p.note, /拿不到模型列表/);
});

test('没有档位可切的模型如实说明尺寸由平台定', () => {
  const p = planImageSize('midjourney', { width: 3000, height: 2000 }, CATALOG);
  assert.equal(p.model, 'midjourney');
  assert.match(p.note, /平台决定/);
});

test('2K 下限就是 2048，改了要有人知道', () => {
  assert.equal(MIN_OUTPUT_LONG_EDGE, 2048);
});

test('升档后的模型名一定在平台目录里', () => {
  // 遍历一遍：任何一次改写都必须落在真实存在的 id 上
  for (const m of CATALOG) {
    for (const size of [{ width: 600, height: 400 }, { width: 3000, height: 2000 }, { width: 6000, height: 4000 }]) {
      const p = planImageSize(m, size, CATALOG);
      assert.ok(CATALOG.includes(p.model), `${m} @ ${size.width}x${size.height} 升到了不存在的 ${p.model}`);
    }
  }
});
