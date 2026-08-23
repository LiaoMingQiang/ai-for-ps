/**
 * 参数值域 —— 所有 UI 控件与工作流绑定共用的取值定义。
 * 单一事实源：UI 渲染、参数校验、工作流注入都读这里。
 */

/* ============================ 图像输入 ============================ */

/** 图像来源。对应参考图谱「上传图片 → 粘贴 / 上传 / 图层」。 */
export const INPUT_SOURCES = ['layer', 'selection', 'mergedVisible', 'paste', 'upload'] as const;
export type InputSource = (typeof INPUT_SOURCES)[number];

export const INPUT_SOURCE_LABELS: Record<InputSource, string> = {
  layer: '当前图层',
  selection: '当前选区',
  mergedVisible: '合并可见',
  paste: '粘贴',
  upload: '上传'
};

/** 图生图最多可上传的参考图数量（参考图谱：可上传最多 10 张图）。 */
export const MAX_REFERENCE_IMAGES = 10;

/** 单个上传文件的大小上限。 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/* ============================ 写回方式 ============================ */

export const WRITEBACK_MODES = ['smartObject', 'pixelLayer', 'inPlaceSelection', 'assetOnly'] as const;
export type WritebackMode = (typeof WRITEBACK_MODES)[number];

export const WRITEBACK_MODE_LABELS: Record<WritebackMode, string> = {
  smartObject: '新建智能对象图层',
  pixelLayer: '新建像素图层',
  inPlaceSelection: '选区原位替换',
  assetOnly: '仅存资产库（不写回）'
};

/* ============================ 随机种子 ============================ */

export const SEED_MODES = ['autoRandom', 'random', 'fixed'] as const;
export type SeedMode = (typeof SEED_MODES)[number];

export const SEED_MODE_LABELS: Record<SeedMode, string> = {
  autoRandom: '自动随机',
  random: '随机',
  fixed: '固定'
};

export const SEED_MAX = 0xffffffff;

export interface SeedValue {
  mode: SeedMode;
  value: number;
}

/** 按种子模式解析出本次提交实际使用的 seed。 */
export function resolveSeed(seed: SeedValue, rng: () => number = Math.random): number {
  if (seed.mode === 'fixed') return clampInt(seed.value, 0, SEED_MAX);
  return Math.floor(rng() * (SEED_MAX + 1)) % (SEED_MAX + 1);
}

/* ============================ 生图比例 ============================ */

export interface AspectRatio {
  id: string;
  label: string;
  w: number;
  h: number;
}

/** 参考图谱给出的 10 个固定比例 + 自定义。 */
export const ASPECT_RATIOS: readonly AspectRatio[] = [
  { id: '1:1', label: '1 : 1', w: 1, h: 1 },
  { id: '4:5', label: '4 : 5', w: 4, h: 5 },
  { id: '3:4', label: '3 : 4', w: 3, h: 4 },
  { id: '2:3', label: '2 : 3', w: 2, h: 3 },
  { id: '3:2', label: '3 : 2', w: 3, h: 2 },
  { id: '4:3', label: '4 : 3', w: 4, h: 3 },
  { id: '5:4', label: '5 : 4', w: 5, h: 4 },
  { id: '16:9', label: '16 : 9', w: 16, h: 9 },
  { id: '9:16', label: '9 : 16', w: 9, h: 16 },
  { id: '21:9', label: '21 : 9', w: 21, h: 9 },
  { id: 'custom', label: '自定义', w: 0, h: 0 }
];

/**
 * 「跟随原图」——有输入图的功能，出图尺寸默认就等于原图尺寸。
 *
 * 这不是一个普通的比例档位，所以它不在 ASPECT_RATIOS 里（那份表是给
 * 「按比例推导宽高」用的，w/h 是常量；跟随原图的宽高要等运行时拿到图才知道）。
 * 单独拎出来，是为了让「按比例算」和「照抄原图」在类型上就分得开，
 * 而不是塞一个 w:0,h:0 的假档位进去再到处特判。
 */
export const ASPECT_SOURCE_ID = 'source';
export const ASPECT_SOURCE_LABEL = '跟随原图';

/** 分辨率滑杆上的哨兵值：0 = 用原图尺寸，不缩放。 */
export const RESOLUTION_SOURCE = 0;

/**
 * 保不住原尺寸时的兜底下限：长边至少 2K。
 *
 * 出现在两种情况：平台压根不认 size 参数（nano-banana-pro 实测无论要多大
 * 都只给 1376×768），或者只认固定几档。这时候与其默默给一张比原图小一半的图，
 * 不如至少保证 2K —— 拿回 Photoshop 还能用，缩小永远比放大安全。
 */
export const MIN_OUTPUT_LONG_EDGE = 2048;

export interface AspectValue {
  id: string;
  /** id === 'custom' 时使用 */
  customW?: number;
  customH?: number;
}

/**
 * 由「比例 + 分辨率(长边基准)」推导出实际出图宽高。
 * 结果按 multiple 对齐（扩散模型通常要求 8 或 16 的倍数）。
 */
export function resolveSize(
  aspect: AspectValue,
  baseLongEdge: number,
  multiple = 8
): { width: number; height: number } {
  let w: number;
  let h: number;
  if (aspect.id === 'custom') {
    w = Math.max(1, aspect.customW ?? baseLongEdge);
    h = Math.max(1, aspect.customH ?? baseLongEdge);
  } else {
    const preset = ASPECT_RATIOS.find((a) => a.id === aspect.id) ?? ASPECT_RATIOS[0]!;
    w = preset.w;
    h = preset.h;
  }
  const scale = baseLongEdge / Math.max(w, h);
  return {
    width: roundTo(Math.max(multiple, w * scale), multiple),
    height: roundTo(Math.max(multiple, h * scale), multiple)
  };
}

/**
 * 决定这次出图的目标尺寸。
 *
 * 优先级是有意这样排的：
 *   1. 用户显式选了比例/分辨率 —— 他说了算，我们不替他改
 *   2. 有输入图 —— 默认照抄原图尺寸
 *   3. 都没有 —— 分辨率当正方形
 *
 * 第 2 条是这次改掉的老行为。以前无论原图多大，都会被
 * `resolveSize(..., baseEdge)` 把长边压到分辨率滑杆的值（默认 1024）——
 * 一张 4000×3000 的产品图洗完回来只有 1024×768，贴回 Photoshop 就是一团糊。
 * 用户没有要求缩小，是我们自作主张缩的，而且缩完还不可逆。
 */
export function resolveOutputSize(
  opts: {
    aspect?: AspectValue | undefined;
    /** 分辨率滑杆的值；RESOLUTION_SOURCE(0) 表示跟随原图 */
    resolution?: number | undefined;
    /** 输入图的原始宽高，没有输入图时不传 */
    inputSize?: { width: number; height: number } | undefined;
  },
  multiple = 8
): { width: number; height: number; followedSource: boolean } {
  const input = opts.inputSize && opts.inputSize.width > 0 && opts.inputSize.height > 0 ? opts.inputSize : null;
  const base = opts.resolution && opts.resolution > 0 ? opts.resolution : RESOLUTION_DEFAULT;
  // 只认两个显式信号，不拿「没有比例控件」当默认跟随 ——
  // 那样用户在 ComfyUI 功能上把分辨率滑杆挪到 1536，我们还是照抄原图，
  // 他会以为滑杆坏了。有输入图的功能，出厂默认就把这两个值设成「跟随原图」。
  const wantsSource = opts.aspect?.id === ASPECT_SOURCE_ID || opts.resolution === RESOLUTION_SOURCE;

  // 跟随原图：原样照抄，连 multiple 对齐都不做 —— 对齐会让 4001 变成 4000，
  // 写回 Photoshop 时就对不齐一个像素。真需要对齐的是工作流/平台，让它们自己去 snap。
  if (wantsSource && input) {
    return { width: input.width, height: input.height, followedSource: true };
  }
  if (opts.aspect && opts.aspect.id !== ASPECT_SOURCE_ID) {
    const size = resolveSize(opts.aspect, base, multiple);
    return { ...size, followedSource: false };
  }
  if (input) {
    // 用户把分辨率从「原图」挪开了，但没有比例控件：保持原图长宽比，长边缩到他选的值
    const size = resolveSize({ id: 'custom', customW: input.width, customH: input.height }, base, multiple);
    return { ...size, followedSource: false };
  }
  return { width: base, height: base, followedSource: false };
}

/* ============================ 分辨率 ============================ */

export const RESOLUTION_MIN = 512;
export const RESOLUTION_MAX = 2048;
export const RESOLUTION_STEP = 64;
export const RESOLUTION_DEFAULT = 1024;

/* ============================ 采样器 / 调度器 ============================ */

/**
 * 推荐采样器（本机 ComfyUI 0.30.1 KSampler 实测子集）。
 * 完整列表在设置里由 Provider 的 /object_info 实时拉取后覆盖。
 */
export const SAMPLERS_RECOMMENDED = [
  'euler',
  'euler_ancestral',
  'dpmpp_2m',
  'dpmpp_2m_sde',
  'dpmpp_3m_sde',
  'res_multistep',
  'ddim',
  'uni_pc',
  'lcm'
] as const;

export type SamplerName = string;

export const SCHEDULERS_RECOMMENDED = [
  'simple',
  'normal',
  'karras',
  'sgm_uniform',
  'exponential',
  'beta',
  'ddim_uniform'
] as const;

/* ============================ 放大 ============================ */

export const UPSCALE_FACTORS = [1.5, 2, 3, 4] as const;
export type UpscaleFactor = (typeof UPSCALE_FACTORS)[number];

/* ============================ 3D 取景立方体 ============================ */

/**
 * 摄像机取景。yaw = 水平角，pitch = 垂直角。
 * 符号约定（与参考图一致）：yaw 为负 → 露出产品右侧（右前视角）；pitch 为正 → 俯视机位。
 */
export interface CameraValue {
  /** 水平角，[-180, 180]，步进 15 */
  yaw: number;
  /** 垂直角，[-90, 90]，步进 15 */
  pitch: number;
}

export const CAMERA_DEFAULT: CameraValue = { yaw: 0, pitch: 0 };
export const CAMERA_YAW_STEP = 15;
export const CAMERA_PITCH_STEP = 15;

/** 稳定度等级：模型对该机位的可靠程度。 */
export const CAMERA_STABILITY = ['S+', 'A', 'B', 'C'] as const;
export type CameraStability = (typeof CAMERA_STABILITY)[number];

export const CAMERA_STABILITY_LABELS: Record<CameraStability, string> = {
  'S+': '最稳定',
  A: '稳定可用',
  B: '可能偏差',
  C: '高风险'
};

export interface CameraDescriptor {
  yaw: number;
  pitch: number;
  /** 水平方位中文名，例：右前 30 度视角 */
  horizontalName: string;
  /** 机位中文名，例：俯视机位 */
  verticalName: string;
  /** 组合显示名，例：右前 30 度视角 / 俯视机位 */
  name: string;
  stability: CameraStability;
  stabilityLabel: string;
  /** 注入工作流提示词的英文片段 */
  promptFragment: string;
}

function horizontalName(yaw: number): { zh: string; en: string } {
  const a = normalizeYaw(yaw);
  const abs = Math.abs(a);
  const side = a < 0 ? '右' : '左';
  const sideEn = a < 0 ? 'right' : 'left';
  if (abs === 0) return { zh: '正视图', en: 'front view' };
  if (abs === 180) return { zh: '背面视图', en: 'rear view' };
  if (abs === 90) return { zh: side + '侧视图', en: sideEn + ' side view' };
  if (abs < 90) {
    return { zh: side + '前 ' + abs + ' 度视角', en: abs + '-degree ' + sideEn + ' three-quarter front view' };
  }
  return {
    zh: side + '后 ' + (180 - abs) + ' 度视角',
    en: 180 - abs + '-degree ' + sideEn + ' three-quarter rear view'
  };
}

function verticalName(pitch: number): { zh: string; en: string } {
  const p = clampInt(pitch, -90, 90);
  if (p === 0) return { zh: '平视机位', en: 'eye-level camera' };
  if (p >= 75) return { zh: '顶视机位', en: 'top-down camera' };
  if (p <= -75) return { zh: '底视机位', en: 'worm-eye camera' };
  if (p > 0) return { zh: '俯视机位', en: 'high-angle camera ' + p + ' degrees above' };
  return { zh: '仰视机位', en: 'low-angle camera ' + Math.abs(p) + ' degrees below' };
}

export function cameraStability(cam: CameraValue): CameraStability {
  const yaw = normalizeYaw(cam.yaw);
  const pitch = clampInt(cam.pitch, -90, 90);
  const yawCanonical = Math.abs(yaw) % 90 === 0;
  if (pitch === 0 && yawCanonical) return 'S+';
  if (Math.abs(pitch) <= 45 && yaw % CAMERA_YAW_STEP === 0) return 'A';
  if (Math.abs(pitch) <= 75) return 'B';
  return 'C';
}

/** 把一个机位翻译成显示名、稳定度与提示词片段。 */
export function describeCamera(cam: CameraValue): CameraDescriptor {
  const yaw = normalizeYaw(cam.yaw);
  const pitch = clampInt(cam.pitch, -90, 90);
  const h = horizontalName(yaw);
  const v = verticalName(pitch);
  const stability = cameraStability({ yaw, pitch });
  return {
    yaw,
    pitch,
    horizontalName: h.zh,
    verticalName: v.zh,
    name: h.zh + ' / ' + v.zh,
    stability,
    stabilityLabel: CAMERA_STABILITY_LABELS[stability],
    promptFragment: h.en + ', ' + v.en
  };
}

/** 立方体各面标签（参考图：FRONT / 正面 / 产品主视图）。 */
export const CUBE_FACE_LABELS = {
  front: { code: 'FRONT', zh: '正面 / 产品主视图' },
  back: { code: 'BACK', zh: '背面' },
  left: { code: 'LEFT', zh: '左侧' },
  right: { code: 'RIGHT', zh: '右侧' },
  top: { code: 'TOP', zh: '顶部' },
  bottom: { code: 'BOTTOM', zh: '底部' }
} as const;

/* ============================ 通用数值工具 ============================ */

export function clampInt(v: number, min: number, max: number): number {
  const n = Math.round(Number.isFinite(v) ? v : min);
  return Math.min(max, Math.max(min, n));
}

export function clamp(v: number, min: number, max: number): number {
  const n = Number.isFinite(v) ? v : min;
  return Math.min(max, Math.max(min, n));
}

export function roundTo(v: number, multiple: number): number {
  return Math.max(multiple, Math.round(v / multiple) * multiple);
}

export function normalizeYaw(yaw: number): number {
  let a = Math.round(Number.isFinite(yaw) ? yaw : 0);
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
}
