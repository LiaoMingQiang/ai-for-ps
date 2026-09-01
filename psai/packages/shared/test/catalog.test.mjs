/**
 * 目录完整性测试。
 * 这套测试的存在意义：保证「功能不遗漏」不是一句口号 ——
 * 参考图谱里数出来的每一个叶子功能，必须在 catalog 里有条目、有参数、有验收标准，
 * 并且必须在 PRD 里被写到。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATALOG,
  allFeatures,
  fixedComfyFeatures,
  findFeature,
  breadcrumb,
  featureDefaults,
  walkCatalog,
  PROMPT_PRESETS,
  presetsForFeature,
  PROVIDERS
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const PRD = readFileSync(resolve(here, '../../../docs/PRD.md'), 'utf8');

/** 从参考图谱里逐个数出来的功能清单 —— 改这份清单前请先回去核对图谱。 */
const EXPECTED_FEATURES = [
  'comfy.wash.portrait',
  'comfy.wash.scene',
  'comfy.relight.fixed',
  'comfy.relight.adaptive',
  'comfy.edit.texture',
  // 本地抠图 / 白底图 —— 给原本只有闭源实现的 cloud.product.whitebg 提供本机替代
  'comfy.edit.matting',
  'comfy.misc.upscale.general',
  'comfy.misc.upscale.lossless',
  'comfy.misc.retouch.product',
  'comfy.misc.retouch.person',
  'comfy.misc.retouch.scene',
  'comfy.misc.viewpoint.orbit',
  'comfy.custom',
  'cloud.wash',
  'cloud.t2i',
  'cloud.i2i',
  'cloud.product.multiview',
  'cloud.product.whitebg'
];

test('目录包含图谱里的全部功能，且没有多余项', () => {
  const ids = allFeatures().map((f) => f.id).sort();
  assert.deepEqual(ids, [...EXPECTED_FEATURES].sort());
});

test('一级导航是 ComfyUI / 生成 / 历史 / 设置', () => {
  const l1 = CATALOG.filter((n) => n.level === 1).map((n) => n.id);
  assert.deepEqual(l1, ['comfyWeb', 'generate', 'history', 'settings']);
});

test('生成页的二级导航是 comfyui / 闭源模型', () => {
  const gen = CATALOG.find((n) => n.id === 'generate');
  assert.ok(gen?.children);
  assert.deepEqual(
    gen.children.map((c) => c.id),
    ['generate.comfyui', 'generate.cloud']
  );
});

test('导航层级连续：子节点的 level 必须是父节点 + 1', () => {
  const check = (node) => {
    for (const child of node.children ?? []) {
      assert.equal(child.level, node.level + 1, `${child.id} 的 level 应为 ${node.level + 1}`);
      check(child);
    }
  };
  CATALOG.forEach(check);
});

test('目录最深达到 5 级', () => {
  const maxLevel = Math.max(...walkCatalog().map((n) => n.level));
  assert.equal(maxLevel, 5);
});

test('节点 id 全局唯一', () => {
  const ids = walkCatalog().map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('每个功能都有描述、参数、验收标准与写回方式', () => {
  for (const f of allFeatures()) {
    assert.ok(f.description.length > 8, `${f.id} 缺少描述`);
    assert.ok(f.params.length > 0, `${f.id} 没有任何参数`);
    assert.ok(f.acceptance.length >= 3, `${f.id} 的验收标准少于 3 条`);
    assert.ok(f.writeback.modes.length > 0, `${f.id} 没有可用写回方式`);
    assert.ok(
      f.writeback.modes.includes(f.writeback.default),
      `${f.id} 的默认写回方式不在可选列表里`
    );
  }
});

test('每个功能的参数 id 在功能内唯一，且都有默认值', () => {
  for (const f of allFeatures()) {
    const ids = f.params.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, `${f.id} 存在重复参数 id`);
    const defaults = featureDefaults(f.id);
    for (const id of ids) {
      assert.ok(id in defaults, `${f.id} 的参数 ${id} 没有默认值`);
    }
  }
});

test('参数的 visibleWhen 只能引用同一功能里存在的参数', () => {
  for (const f of allFeatures()) {
    const ids = new Set(f.params.map((p) => p.id));
    for (const p of f.params) {
      if (p.visibleWhen) {
        assert.ok(ids.has(p.visibleWhen.param), `${f.id}.${p.id} 的 visibleWhen 指向不存在的 ${p.visibleWhen.param}`);
      }
    }
  }
});

test('12 个 ComfyUI 固定功能全部预绑定了内置工作流', () => {
  const fixed = fixedComfyFeatures();
  assert.equal(fixed.length, 12);
  for (const f of fixed) {
    assert.ok(f.defaultWorkflowId, `${f.id} 没有出厂内置工作流`);
    assert.ok(f.requiredNodeTypes.length > 0, `${f.id} 没有声明依赖节点`);
  }
});

test('内置工作流 id 互不重复', () => {
  const ids = fixedComfyFeatures().map((f) => f.defaultWorkflowId);
  assert.equal(new Set(ids).size, ids.length);
});

test('自定义工作流功能不预绑定工作流', () => {
  assert.equal(findFeature('comfy.custom').defaultWorkflowId, null);
});

test('闭源分支功能都带模型选择，且不绑定 ComfyUI 工作流', () => {
  for (const f of allFeatures().filter((x) => x.branch === 'cloud')) {
    assert.equal(f.defaultWorkflowId, null, `${f.id} 不应绑定内置工作流`);
    assert.ok(f.params.some((p) => p.kind === 'model'), `${f.id} 缺少模型选择`);
  }
});

test('图生图与产品多视角的上传上限是 10 张', () => {
  for (const id of ['cloud.i2i', 'cloud.product.multiview']) {
    const list = findFeature(id).params.find((p) => p.kind === 'imageList');
    assert.ok(list, `${id} 没有图像列表参数`);
    assert.equal(list.max, 10);
  }
});

test('带摄像机控件的功能就是图谱标注的那三个', () => {
  const withCamera = allFeatures()
    .filter((f) => f.params.some((p) => p.kind === 'camera'))
    .map((f) => f.id)
    .sort();
  assert.deepEqual(withCamera, ['cloud.product.multiview', 'comfy.misc.viewpoint.orbit', 'comfy.relight.adaptive']);
});

test('放大类功能不提供选区原位写回（尺寸已变）', () => {
  for (const id of ['comfy.misc.upscale.general', 'comfy.misc.upscale.lossless']) {
    assert.ok(!findFeature(id).writeback.modes.includes('inPlaceSelection'), `${id} 不该允许选区原位`);
  }
});

test('无损放大不含任何随机性参数', () => {
  const f = findFeature('comfy.misc.upscale.lossless');
  const kinds = f.params.map((p) => p.kind);
  assert.ok(!kinds.includes('seed'), '无损放大不应有随机种子');
  assert.ok(!f.params.some((p) => p.id === 'denoise'), '无损放大不应有重绘幅度');
});

test('面包屑可以还原到 5 级路径', () => {
  assert.deepEqual(breadcrumb('comfy.misc.upscale.general'), ['生成', 'comfyui', '其他功能', '放大', '通用放大']);
  assert.deepEqual(breadcrumb('comfy.wash.portrait'), ['生成', 'comfyui', '洗图', '人像']);
  assert.deepEqual(breadcrumb('cloud.t2i'), ['生成', '闭源模型', '文生图']);
});

test('每个功能都写进了 PRD', () => {
  for (const f of allFeatures()) {
    assert.ok(PRD.includes(f.id), `PRD 里没有 ${f.id}`);
    assert.ok(PRD.includes(f.label), `PRD 里没有 ${f.id} 的标签「${f.label}」`);
  }
});

test('PRD 的参数表与目录严格一致，不允许漂移', () => {
  // §4.2 是从 catalog 生成的；这条测试防止有人手改了 PRD 却没改代码（或反过来）
  for (const f of allFeatures().filter((x) => x.engine === 'comfy-workflow' && x.id !== 'comfy.custom')) {
    const escapedId = f.id.replaceAll('.', '\\.');
    const heading = new RegExp('#### 4\\.2\\.\\d+ [^\\n]*`' + escapedId + '`');
    const m = heading.exec(PRD);
    assert.ok(m, `PRD 里没有 ${f.id} 的小节`);

    const rest = PRD.slice(m.index + m[0].length);
    const nextIdx = rest.search(/\n#### |\n### /);
    const section = nextIdx >= 0 ? rest.slice(0, nextIdx) : rest;

    // 表格首列形如：| 真实感 `realism` | ...
    const listed = new Set([...section.matchAll(/^\| [^|]*`([a-zA-Z]+)` \|/gm)].map((x) => x[1]));
    const declared = new Set(f.params.map((p) => p.id));

    for (const id of declared) {
      assert.ok(listed.has(id), `PRD 的 ${f.id} 参数表缺少 ${id}`);
    }
    for (const id of listed) {
      assert.ok(declared.has(id), `PRD 的 ${f.id} 参数表多出了 ${id}（目录里没有这个参数）`);
    }
  }
});

test('内置工作流 id 全部写进了 PRD', () => {
  for (const f of fixedComfyFeatures()) {
    assert.ok(PRD.includes(f.defaultWorkflowId), `PRD 里没有工作流 ${f.defaultWorkflowId}`);
  }
});

test('内置提示词预设齐全且 scope 指向真实功能', () => {
  assert.equal(PROMPT_PRESETS.length, 10);
  const ids = new Set(allFeatures().map((f) => f.id));
  for (const p of PROMPT_PRESETS) {
    assert.ok(p.prompt.length > 20, `${p.id} 的提示词太短`);
    for (const s of p.scope) {
      const ok = ids.has(s) || [...ids].some((i) => i.startsWith(s.replace('*', '')));
      assert.ok(ok, `${p.id} 的 scope ${s} 不是有效功能 id`);
    }
  }
});

test('洗图/去噪 能选到全部 6 个稿型预设', () => {
  const stylize = presetsForFeature('cloud.wash', 'stylize').map((p) => p.id);
  assert.deepEqual(stylize.sort(), [
    'preset.depth.bw',
    'preset.flat.solid',
    'preset.lineart.bw',
    'preset.normal',
    'preset.whitemodel.plain',
    'preset.whitemodel.textured'
  ]);
});

test('Provider 注册表覆盖图谱里的推荐平台', () => {
  const ids = PROVIDERS.map((p) => p.id);
  for (const need of ['comfyui', 'runninghub', 'comfly', 'modelscope', 'volcengine', 'bailian']) {
    assert.ok(ids.includes(need), `缺少 Provider ${need}`);
  }
  // 取消语义必须如实标注
  assert.equal(PROVIDERS.find((p) => p.id === 'runninghub').cancelSupport, 'none');
  // ComfyUI 是 queuedOnly 而不是 full：它的 /interrupt 是**全局**的，
  // 中断的是"这台机器当前正在执行的那一个"，不是我们指定的那一个。
  // 独占实例上等同于 full，但只要那台机器上还有别人，已在执行的任务就取消不了 ——
  // 承诺不了就别承诺。
  assert.equal(PROVIDERS.find((p) => p.id === 'comfyui').cancelSupport, 'queuedOnly');
});

test('需要密钥的 Provider 都把密钥字段标成了 secret', () => {
  for (const p of PROVIDERS) {
    for (const c of p.credentials) {
      if (c.key.toLowerCase().includes('key') || c.key.toLowerCase().includes('token')) {
        assert.ok(c.secret, `${p.id}.${c.key} 必须标记为 secret`);
      }
    }
  }
});
