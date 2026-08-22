/**
 * 生成 11 份内置工作流（graph.json + binding.json + meta.json）。
 *
 * 用脚本生成而不是手写 11 份 JSON：节点 id 约定、绑定表、模型选择都集中在这里，
 * 改一处全体一致，也方便在 docs/WORKFLOWS.md 里说明每个滑杆到底接到了哪个节点输入。
 *
 * 节点 id 约定（所有工作流共用，便于对照）：
 *   1  CheckpointLoaderSimple      10 LoadAndApplyICLightUnet
 *   2  LoadImage（主图）            11 LoadImage（背景）
 *   3  KSampler                    12 ImageScale（背景）
 *   4  CLIPTextEncode 正向          13 VAEEncode（背景）
 *   5  CLIPTextEncode 负向          15 ICLightConditioning
 *   6  VAEEncode（主图）             20 ImageScaleBy（放大）
 *   7  ImageScale（主图缩放）
 *   8  VAEDecode
 *   9  SaveImage
 *
 * 用法：node tools/author-builtin-workflows.mjs
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = resolve(here, '../workflows');

/* ---------------- 模型选择 ---------------- */

/**
 * 出厂模型。都是 SD1.5 系：显存友好、出图快、IC-Light 只支持 SD1.5。
 * 用户可以在「设置 → 工作流」里改 ckpt_name，或导入自己的工作流。
 */
const CKPT_PHOTO = 'majicmix_realistic_v7.safetensors'; // 人像/产品写实
const CKPT_BASE = 'v1-5-pruned-emaonly-fp16.safetensors'; // 通用、最轻
const ICLIGHT_FBC = 'IC-Light\\iclight_sd15_fbc.safetensors'; // 前景+背景条件重打光

const NEG_DEFAULT = 'lowres, blurry, jpeg artifacts, watermark, text, logo, deformed, extra limbs';

/* ---------------- 图构造 ---------------- */

function checkpoint(name) {
  return { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: name }, _meta: { title: '基础模型' } };
}

function textEncode(text, title) {
  return { class_type: 'CLIPTextEncode', inputs: { text, clip: ['1', 1] }, _meta: { title } };
}

function ksampler(overrides = {}) {
  return {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0],
      seed: 0,
      steps: 24,
      cfg: 7,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['6', 0],
      denoise: 0.3,
      ...overrides
    },
    _meta: { title: '采样器' }
  };
}

/** 主图链：LoadImage → ImageScale（缩到目标尺寸）→ VAEEncode */
function imageChain() {
  return {
    2: { class_type: 'LoadImage', inputs: { image: 'example.png' }, _meta: { title: '输入图' } },
    7: {
      class_type: 'ImageScale',
      inputs: { image: ['2', 0], upscale_method: 'lanczos', width: 1024, height: 1024, crop: 'disabled' },
      _meta: { title: '缩放到目标尺寸' }
    },
    6: { class_type: 'VAEEncode', inputs: { pixels: ['7', 0], vae: ['1', 2] }, _meta: { title: '编码主图' } }
  };
}

function decodeAndSave(prefix) {
  return {
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['1', 2] }, _meta: { title: '解码' } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: prefix }, _meta: { title: '输出' } }
  };
}

/* ---------------- 绑定片段 ---------------- */

const B = {
  image: { paramId: 'image', nodeId: '2', input: 'image', required: true },
  prompt: { paramId: 'prompt', nodeId: '4', input: 'text', required: false },
  negative: { paramId: 'negativePrompt', nodeId: '5', input: 'text', required: false },
  seed: { paramId: 'seed', nodeId: '3', input: 'seed', required: true },
  steps: { paramId: 'steps', nodeId: '3', input: 'steps', required: false },
  cfg: { paramId: 'cfg', nodeId: '3', input: 'cfg', required: false },
  denoise: { paramId: 'denoise', nodeId: '3', input: 'denoise', required: false },
  sampler: { paramId: 'sampler', nodeId: '3', input: 'sampler_name', required: false },
  scheduler: { paramId: 'scheduler', nodeId: '3', input: 'scheduler', required: false },
  width: { paramId: 'resolution', nodeId: '7', input: 'width', required: false, transform: { type: 'sizeWidth' } },
  height: { paramId: 'resolution', nodeId: '7', input: 'height', required: false, transform: { type: 'sizeHeight' } },
  /** 机位片段追加到正向提示词后面 */
  camera: {
    paramId: 'camera',
    nodeId: '4',
    input: 'text',
    required: false,
    transform: { type: 'appendText', separator: ', ' }
  },
  /** 真实感 → CFG：越高越贴合"写实细节"这组提示词 */
  realismToCfg: {
    paramId: 'realism',
    nodeId: '3',
    input: 'cfg',
    required: false,
    transform: { type: 'linear', inMin: 0, inMax: 1, outMin: 4.5, outMax: 9 }
  },
  /** 质感强度 → CFG */
  textureToCfg: {
    paramId: 'texture',
    nodeId: '3',
    input: 'cfg',
    required: false,
    transform: { type: 'linear', inMin: 0, inMax: 1, outMin: 5, outMax: 10 }
  },
  /** 精修强度 → 重绘幅度，量程收窄到只收拾不重画 */
  retouchToDenoise: {
    paramId: 'strength',
    nodeId: '3',
    input: 'denoise',
    required: false,
    transform: { type: 'linear', inMin: 0, inMax: 1, outMin: 0.05, outMax: 0.5 }
  },
  /** 视角改动幅度 → 重绘幅度，量程偏高才推得动机位 */
  viewpointToDenoise: {
    paramId: 'strength',
    nodeId: '3',
    input: 'denoise',
    required: false,
    transform: { type: 'linear', inMin: 0, inMax: 1, outMin: 0.4, outMax: 0.95 }
  },
  /** 光影 → IC-Light 的 multiplier */
  lightingToMultiplier: {
    paramId: 'lighting',
    nodeId: '15',
    input: 'multiplier',
    required: false,
    transform: { type: 'linear', inMin: 0, inMax: 1, outMin: 0.1, outMax: 1 }
  },
  background: { paramId: 'background', nodeId: '11', input: 'image', required: true },
  scaleBy: {
    paramId: 'upscaleFactor',
    nodeId: '20',
    input: 'scale_by',
    required: true,
    transform: { type: 'number' }
  },
  scaleMethod: { paramId: 'upscaleMethod', nodeId: '20', input: 'upscale_method', required: false }
};

const COMMON_SAMPLER_BINDINGS = [B.seed, B.steps, B.sampler, B.scheduler];

/* ---------------- 11 份工作流 ---------------- */

function img2img({ id, name, featureId, ckpt, positiveSeed, denoise, cfg, extraBindings = [], notes }) {
  return {
    id,
    name,
    featureId,
    notes,
    graph: {
      1: checkpoint(ckpt),
      ...imageChain(),
      4: textEncode(positiveSeed, '正向提示词'),
      5: textEncode(NEG_DEFAULT, 'Negative 负向提示词'),
      3: ksampler({ denoise, cfg }),
      ...decodeAndSave(`psai/${id}`)
    },
    bindings: [
      B.image,
      B.prompt,
      B.negative,
      ...COMMON_SAMPLER_BINDINGS,
      B.width,
      B.height,
      ...extraBindings
    ]
  };
}

const WORKFLOWS = [];

/* 1-2 洗图 */
WORKFLOWS.push(
  img2img({
    id: 'wf.wash.portrait',
    name: '洗图 · 人像',
    featureId: 'comfy.wash.portrait',
    ckpt: CKPT_PHOTO,
    positiveSeed:
      'photorealistic portrait, natural skin texture with visible pores, detailed hair strands, soft studio lighting, sharp focus, high dynamic range',
    denoise: 0.28,
    cfg: 7,
    extraBindings: [B.denoise, B.realismToCfg],
    notes: '真实感滑杆映射到 KSampler.cfg（4.5–9），重绘幅度直连 KSampler.denoise。'
  }),
  img2img({
    id: 'wf.wash.scene',
    name: '洗图 · 场景',
    featureId: 'comfy.wash.scene',
    ckpt: CKPT_PHOTO,
    positiveSeed:
      'photorealistic environment, rich atmospheric depth, natural global illumination, detailed materials, sharp focus',
    denoise: 0.4,
    cfg: 7,
    extraBindings: [B.denoise, B.realismToCfg],
    notes: '与人像同构，提示词种子与默认重绘幅度偏向环境重绘。'
  })
);

/* 3-4 光影溶图（IC-Light） */
function relight({ id, name, featureId, denoise, extraBindings = [], notes }) {
  return {
    id,
    name,
    featureId,
    notes,
    graph: {
      1: checkpoint(CKPT_BASE),
      10: {
        class_type: 'LoadAndApplyICLightUnet',
        inputs: { model: ['1', 0], model_path: ICLIGHT_FBC },
        _meta: { title: 'IC-Light 重打光模型' }
      },
      ...imageChain(),
      11: { class_type: 'LoadImage', inputs: { image: 'example.png' }, _meta: { title: '背景 / 参考光图' } },
      12: {
        class_type: 'ImageScale',
        inputs: { image: ['11', 0], upscale_method: 'lanczos', width: 768, height: 768, crop: 'center' },
        _meta: { title: '缩放背景' }
      },
      13: { class_type: 'VAEEncode', inputs: { pixels: ['12', 0], vae: ['1', 2] }, _meta: { title: '编码背景' } },
      4: textEncode('natural lighting, seamless composite, consistent shadows and reflections', '正向提示词'),
      5: textEncode(NEG_DEFAULT + ', flat lighting, cut-out look', 'Negative 负向提示词'),
      15: {
        class_type: 'ICLightConditioning',
        inputs: {
          positive: ['4', 0],
          negative: ['5', 0],
          vae: ['1', 2],
          foreground: ['6', 0],
          multiplier: 0.7,
          opt_background: ['13', 0]
        },
        _meta: { title: 'IC-Light 条件' }
      },
      3: {
        class_type: 'KSampler',
        inputs: {
          model: ['10', 0],
          seed: 0,
          steps: 24,
          cfg: 2.5,
          sampler_name: 'dpmpp_2m',
          scheduler: 'karras',
          positive: ['15', 0],
          negative: ['15', 1],
          latent_image: ['15', 2],
          denoise
        },
        _meta: { title: '采样器' }
      },
      ...decodeAndSave(`psai/${id}`)
    },
    bindings: [
      B.image,
      B.background,
      B.prompt,
      B.negative,
      ...COMMON_SAMPLER_BINDINGS,
      B.cfg,
      B.denoise,
      B.width,
      B.height,
      { paramId: 'resolution', nodeId: '12', input: 'width', required: false, transform: { type: 'sizeWidth' } },
      { paramId: 'resolution', nodeId: '12', input: 'height', required: false, transform: { type: 'sizeHeight' } },
      B.lightingToMultiplier,
      ...extraBindings
    ]
  };
}

WORKFLOWS.push(
  relight({
    id: 'wf.relight.fixed',
    name: '光影溶图 · 固定视角',
    featureId: 'comfy.relight.fixed',
    denoise: 0.9,
    notes: '光影滑杆映射到 ICLightConditioning.multiplier（0.1–1.0），机位不动。'
  }),
  relight({
    id: 'wf.relight.adaptive',
    name: '光影溶图 · 自适应视角',
    featureId: 'comfy.relight.adaptive',
    denoise: 0.95,
    extraBindings: [B.camera],
    notes: '在固定视角基础上，把摄像机立方体翻译出的英文机位片段追加到正向提示词。'
  })
);

/* 5 质感加强 */
WORKFLOWS.push(
  img2img({
    id: 'wf.edit.texture',
    name: '图像编辑 · 质感加强',
    featureId: 'comfy.edit.texture',
    ckpt: CKPT_PHOTO,
    positiveSeed:
      'ultra detailed surface microstructure, crisp material definition, fine grain, tactile texture, macro sharpness',
    denoise: 0.22,
    cfg: 7.5,
    extraBindings: [B.denoise, B.textureToCfg],
    notes: '质感强度映射到 KSampler.cfg（5–10）；默认低重绘幅度以保住形体。'
  })
);

/* 6 通用放大 */
WORKFLOWS.push({
  id: 'wf.upscale.general',
  name: '放大 · 通用放大',
  featureId: 'comfy.misc.upscale.general',
  notes: '先 ImageScaleBy 按倍数重采样，再低重绘幅度过一遍扩散模型补细节。',
  graph: {
    1: checkpoint(CKPT_PHOTO),
    2: { class_type: 'LoadImage', inputs: { image: 'example.png' }, _meta: { title: '输入图' } },
    20: {
      class_type: 'ImageScaleBy',
      inputs: { image: ['2', 0], upscale_method: 'lanczos', scale_by: 2 },
      _meta: { title: '按倍数放大' }
    },
    6: { class_type: 'VAEEncode', inputs: { pixels: ['20', 0], vae: ['1', 2] }, _meta: { title: '编码' } },
    4: textEncode('sharp details, clean edges, high resolution photograph', '正向提示词'),
    5: textEncode(NEG_DEFAULT + ', oversharpened, halo artifacts', 'Negative 负向提示词'),
    3: ksampler({ denoise: 0.25, cfg: 6, steps: 16 }),
    ...decodeAndSave('psai/wf.upscale.general')
  },
  bindings: [B.image, B.scaleBy, B.prompt, B.negative, ...COMMON_SAMPLER_BINDINGS, B.cfg, B.denoise]
});

/* 7 无损放大 —— 没有 KSampler，纯重采样，结果完全确定 */
WORKFLOWS.push({
  id: 'wf.upscale.lossless',
  name: '放大 · 无损放大',
  featureId: 'comfy.misc.upscale.lossless',
  notes:
    '纯 ImageScaleBy 重采样，不经过扩散模型，同输入必得同输出。装了 ESRGAN 类放大模型后可换成 ImageUpscaleWithModel 获得更好效果。',
  graph: {
    2: { class_type: 'LoadImage', inputs: { image: 'example.png' }, _meta: { title: '输入图' } },
    20: {
      class_type: 'ImageScaleBy',
      inputs: { image: ['2', 0], upscale_method: 'lanczos', scale_by: 2 },
      _meta: { title: '按倍数放大' }
    },
    9: { class_type: 'SaveImage', inputs: { images: ['20', 0], filename_prefix: 'psai/wf.upscale.lossless' }, _meta: { title: '输出' } }
  },
  bindings: [B.image, B.scaleBy, B.scaleMethod]
});

/* 8-10 精修 */
for (const [id, name, featureId, seedPrompt] of [
  [
    'wf.retouch.product',
    '精修 · 产品',
    'comfy.misc.retouch.product',
    'clean product surface, flawless finish, even studio lighting, crisp edges, commercial product photography'
  ],
  [
    'wf.retouch.person',
    '精修 · 人物',
    'comfy.misc.retouch.person',
    'clean natural skin, even skin tone, retained pores, tidy hair, soft beauty lighting, high-end retouching'
  ],
  [
    'wf.retouch.scene',
    '精修 · 场景',
    'comfy.misc.retouch.scene',
    'tidy scene, clean props, balanced exposure, coherent lighting, decluttered composition'
  ]
]) {
  WORKFLOWS.push(
    img2img({
      id,
      name,
      featureId,
      ckpt: CKPT_PHOTO,
      positiveSeed: seedPrompt,
      denoise: 0.2,
      cfg: 7,
      extraBindings: [B.cfg, B.retouchToDenoise],
      notes: '精修强度映射到 KSampler.denoise（0.05–0.5），保证只收拾细节不重画。'
    })
  );
}

/* 11 视角转换 */
WORKFLOWS.push(
  img2img({
    id: 'wf.viewpoint.orbit',
    name: '视角转换 · 360° 旋转',
    featureId: 'comfy.misc.viewpoint.orbit',
    ckpt: CKPT_PHOTO,
    positiveSeed: 'same object, consistent identity, product photography, plain background, studio lighting',
    denoise: 0.7,
    cfg: 7,
    extraBindings: [B.camera, B.cfg, B.viewpointToDenoise],
    notes: '机位片段追加到正向提示词；视角改动幅度映射到 KSampler.denoise（0.4–0.95）。'
  })
);

/* ---------------- 落盘 ---------------- */

if (existsSync(OUT_ROOT)) rmSync(OUT_ROOT, { recursive: true, force: true });
mkdirSync(OUT_ROOT, { recursive: true });

for (const wf of WORKFLOWS) {
  const dir = join(OUT_ROOT, wf.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(wf.graph, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, 'binding.json'), JSON.stringify({ bindings: wf.bindings }, null, 2) + '\n', 'utf8');
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify(
      { id: wf.id, name: wf.name, version: '1.0.0', featureId: wf.featureId, notes: wf.notes },
      null,
      2
    ) + '\n',
    'utf8'
  );
}

console.log(`AUTHOR-OK  写出 ${WORKFLOWS.length} 份内置工作流到 ${OUT_ROOT}`);
for (const wf of WORKFLOWS) {
  console.log(`  ${wf.id.padEnd(28)} ${Object.keys(wf.graph).length} 节点 · ${wf.bindings.length} 条绑定`);
}
