/**
 * 生成页：5 级导航 + 图像输入 + 参数面板 + 结果 + 底部主行动按钮。
 * 页面结构对所有 17 个功能都一样，差异全部来自功能目录。
 */

import { defaultValues, isTerminal, rhPresetByWorkflowId, filterImageModels } from '@psai/shared';
import type { ParamSpec, WritebackMode, JobRecord } from '@psai/shared';
import { h, clear, setAttr, toggleClass } from '../app/dom.js';
import { api, ApiError } from '../app/api.js';
import type { FeatureView } from '../app/api.js';
import { getState, setState, setParam, paramsOf, setParams, toast, featureView, jobById } from '../app/store.js';
import { renderNav, renderBreadcrumb } from './nav.js';
import { renderParams, refreshAspectHints } from './params.js';
import type { ParamContext } from './params.js';
import { createImageInput, validateImages } from './imageinput.js';
import type { PickedImage, ImageInputHandle } from './imageinput.js';
import { renderResults } from './results.js';
import * as bridge from '../ps/bridge.js';

/** 每个功能页各自的图像输入实例，切页时重建 */
const inputHandles = new Map<string, ImageInputHandle>();
let currentImages: Record<string, PickedImage[]> = {};
let runtimeOptions: Record<string, string[]> = {};
let presetCache: Record<string, ParamContext['presets']> = {};

/**
 * 只重画「结果」那一块的回调，由当前挂载的生成页登记。
 *
 * 作业状态每变一次就整页重建是不行的：生成过程中 WebSocket 进度事件加上
 * 1.2 秒一轮的轮询，一秒能来好几次，而整页重建要重新渲染导航、图像输入、
 * 全部参数控件和那个 SVG 立方体 —— 面板卡顿、掉帧就是这么来的，
 * 顺带还会把正在输入的提示词和刚选好的图冲掉。
 * 任务变化真正会影响的只有结果区和提交按钮的可用状态，重画这两块就够了。
 */
let repaintResults: (() => void) | null = null;

/** 作业更新时调用：只刷新结果区，不动页面其余部分。返回是否真的刷新了。 */
export function refreshGenerateResults(): boolean {
  if (!repaintResults) return false;
  repaintResults();
  return true;
}

/**
 * @param host       滚动区，参数面板和结果都画在这里
 * @param actionHost 滚动区外面那一行，放主行动按钮。不传就退回画在 host 末尾
 *                   （页面渲染冒烟测试是这么用的，那里没有面板外壳）。
 */
export async function renderGeneratePage(host: HTMLElement, actionHost?: HTMLElement): Promise<void> {
  const state = getState();
  const view = featureView(state.featureId);

  clear(host);

  const nav = renderNav({
    featureId: state.featureId,
    features: state.features,
    width: host.clientWidth || 460,
    onSelect: (id) => {
      setState({ featureId: id, activeJobId: null });
    },
    onFixReason: (id) => {
      const f = featureView(id);
      toast('这个功能还不能用', f?.reason ?? '', 'warn');
      setState({ page: 'settings' });
    }
  });
  host.appendChild(nav);

  if (!view) {
    host.appendChild(h('div', { class: 'muted pad' }, '正在载入功能目录…'));
    return;
  }

  /* ---- 标题 ---- */
  host.appendChild(
    h(
      'header',
      { class: 'page-head' },
      renderBreadcrumb(view),
      h('h2', { class: 'page-title' }, view.label),
      h('p', { class: 'page-desc' }, view.description)
    )
  );

  if (!view.ready) {
    host.appendChild(
      h(
        'div',
        { class: 'notice warn' },
        h('strong', {}, '这个功能还不能用：'),
        h('span', {}, view.reason ?? '未知原因'),
        h(
          'button',
          { class: 'link', type: 'button', onclick: () => setState({ page: 'settings' }) },
          '去设置'
        )
      )
    );
  }

  /* ---- 参数取值初始化 ---- */
  // 绑了云端预设时，用预设推荐的取值盖掉功能默认值。
  // 同一个功能挂不同预设，合适的默认值能差很远：「质感加强」默认重绘幅度 0.22 是对的，
  // 但挂上局部重绘就意味着遮罩区几乎不变 —— 用户点了生成什么也没发生。
  // 这些值照常显示在参数面板里，用户随时能改，不是背着他改。
  if (!getState().paramValues[view.id]) {
    const preset = rhPresetByWorkflowId(view.binding?.remoteWorkflowId ?? '');
    setParams(view.id, {
      ...(view.defaults as Record<string, unknown>),
      ...(preset?.paramDefaults ?? {})
    });
  }

  /* ---- 图像输入 ---- */
  const imageSpecs = view.params.filter(
    (p): p is Extract<ParamSpec, { kind: 'image' | 'imageList' }> => p.kind === 'image' || p.kind === 'imageList'
  );
  currentImages[view.id] ??= [];
  for (const spec of imageSpecs) {
    const key = `${view.id}:${spec.id}`;
    const handle = createImageInput(spec, (imgs) => {
      currentImages[key] = imgs;
      updateSubmitState();
    });
    inputHandles.set(key, handle);
    currentImages[key] ??= [];
    host.appendChild(handle.el);
  }

  /* ---- 参数面板 ---- */
  await ensurePresets(view.id);
  await ensureRuntimeOptions(view);

  const paramCtx: ParamContext = {
    get: (id) => paramsOf(view.id)[id],
    set: (id, value) => {
      setParam(view.id, id, value);
      if (id === 'resolution') {
        refreshAspectHints(paramsCard, Number(value));
      }
      updateSubmitState();
    },
    options: runtimeOptions,
    presets: presetCache[view.id] ?? [],
    onEnhance: async (paramId) => {
      const text = String(paramsOf(view.id)[paramId] ?? '');
      if (!text.trim()) {
        toast('提示词是空的', '先写点东西再优化', 'warn');
        return null;
      }
      try {
        const res = await api.textComplete({
          presetId: 'preset.skills.promptEnhance',
          userText: text,
          featureId: view.id
        });
        toast('提示词已优化', `使用 ${res.providerId}`);
        return res.text;
      } catch (e) {
        const msg = e instanceof ApiError ? e.display : String(e);
        toast('优化失败', msg, 'error');
        return null;
      }
    }
  };

  const paramsCard = h(
    'section',
    { class: 'card' },
    h('h3', { class: 'card-title' }, '参数设置'),
    renderParams(view.params, paramCtx)
  );
  host.appendChild(paramsCard);
  refreshAspectHints(paramsCard, Number(paramsOf(view.id)['resolution'] ?? 1024));

  /* ---- 结果 ---- */
  const resultsHost = h('div', { class: 'results-host' });
  host.appendChild(resultsHost);

  function firstPreview(): string | null {
    const key = `${view!.id}:${imageSpecs[0]?.id ?? 'image'}`;
    return currentImages[key]?.[0]?.previewSrc ?? null;
  }

  function paintResults(): void {
    const job = jobById(getState().activeJobId);
    clear(resultsHost);
    resultsHost.appendChild(
      renderResults({
        job,
        inputPreview: firstPreview(),
        availableModes: view!.writeback.modes,
        onWriteback: (mode, layerName) => void doWriteback(job!, mode, layerName),
        onCancel: () => void doCancel(job!),
        onDiscard: () => void doDiscard(job!),
        onRetry: () => void doRetry(job!)
      })
    );
  }
  paintResults();

  // 登记给外部：任务更新时只重画这一块
  repaintResults = () => {
    paintResults();
    updateSubmitState();
  };

  /* ---- 主行动按钮 ---- */
  // 按钮上直接写清楚这一步要做什么，而不是笼统的「开始处理」——
  // 用户传完图之后要一眼看到"接下来点这里"。
  const submitBtn = h('button', { class: 'btn-primary btn-submit', type: 'button' }, `开始${view.label}`);
  const submitReason = h('div', { class: 'submit-reason muted' });
  const bar = h('div', { class: 'submitbar' }, submitBtn, submitReason);
  // 优先挂到滚动区外面那一行，保证参数再多也不用滚动就能看到它
  if (actionHost) {
    clear(actionHost);
    actionHost.appendChild(bar);
  } else {
    host.appendChild(bar);
  }

  function blockingReason(): string | null {
    const s = getState();
    if (!s.health.online) return s.health.reason ?? 'Helper 未运行';
    if (!view!.ready) return view!.reason ?? '功能未就绪';
    for (const spec of imageSpecs) {
      const imgs = currentImages[`${view!.id}:${spec.id}`] ?? [];
      const err = validateImages(spec, imgs);
      if (err) return err;
    }
    const promptSpec = view!.params.find((p) => p.kind === 'prompt');
    if (promptSpec?.kind === 'prompt' && promptSpec.required) {
      const v = String(paramsOf(view!.id)['prompt'] ?? '').trim();
      if (!v) return `「${promptSpec.label}」是必填项`;
    }
    return null;
  }

  function updateSubmitState(): void {
    const reason = blockingReason();
    setAttr(submitBtn, 'disabled', !!reason);
    submitReason.textContent = reason ?? `将使用 ${view!.providerId ?? '默认后端'}${view!.workflowName ? ` · ${view!.workflowName}` : ''}`;
    toggleClass(submitReason, 'err', !!reason);
  }
  updateSubmitState();

  submitBtn.addEventListener('click', () => void submit());

  /* ---- 动作 ---- */

  async function submit(): Promise<void> {
    const reason = blockingReason();
    if (reason) {
      toast('还不能提交', reason, 'warn');
      return;
    }
    submitBtn.setAttribute('disabled', '');
    submitBtn.textContent = '提交中…';

    try {
      const inputs: Array<{ paramId: string; assetId: string; index: number; source: string }> = [];
      let selectionBounds: PickedImage['selectionBounds'] = null;
      for (const spec of imageSpecs) {
        const imgs = currentImages[`${view!.id}:${spec.id}`] ?? [];
        imgs.forEach((img, i) => {
          inputs.push({ paramId: spec.id, assetId: img.assetId, index: i, source: img.source });
          if (img.selectionBounds && !selectionBounds) selectionBounds = img.selectionBounds;
        });
      }

      // 冻结 Photoshop 上下文（PRD G-02）
      const ctx = bridge.getContext();
      const target = ctx ? bridge.buildTarget(ctx, selectionBounds) : null;

      const settings = getState().settings;
      const mode: WritebackMode = target ? (settings?.generation.writebackMode ?? view!.writeback.default) : 'assetOnly';

      const job = await api.createJob({
        featureId: view!.id,
        params: paramsOf(view!.id),
        inputs,
        target,
        writeback: { mode, layerName: `AI · ${view!.label}` }
      });

      setState({ activeJobId: job.id, jobs: [job, ...getState().jobs.filter((j) => j.id !== job.id)] });
      paintResults();
    } catch (e) {
      const msg = e instanceof ApiError ? e.display : e instanceof Error ? e.message : String(e);
      toast('提交失败', msg, 'error');
    } finally {
      submitBtn.textContent = '开始处理';
      updateSubmitState();
    }
  }

  async function doCancel(job: JobRecord): Promise<void> {
    try {
      const res = await api.cancelJob(job.id);
      if (!res.ok) toast('取消未生效', res.reason, 'warn');
      setState({ jobs: getState().jobs.map((j) => (j.id === res.job.id ? res.job : j)) });
      paintResults();
    } catch (e) {
      toast('取消失败', e instanceof ApiError ? e.display : String(e), 'error');
    }
  }

  async function doDiscard(job: JobRecord): Promise<void> {
    const next = await api.discardJob(job.id);
    setState({ jobs: getState().jobs.map((j) => (j.id === next.id ? next : j)) });
    paintResults();
  }

  async function doRetry(job: JobRecord): Promise<void> {
    try {
      const next = await api.retryJob(job.id);
      setState({ activeJobId: next.id, jobs: [next, ...getState().jobs.filter((j) => j.id !== next.id)] });
      paintResults();
    } catch (e) {
      toast('重试失败', e instanceof ApiError ? e.display : String(e), 'error');
    }
  }

  async function doWriteback(job: JobRecord, mode: WritebackMode, layerName: string): Promise<void> {
    await performWriteback(job, mode, layerName);
    paintResults();
  }
}

/** 写回流程：校验 → 取字节 → 调 bridge → 把结果如实回报给 Helper。 */
export async function performWriteback(job: JobRecord, mode: WritebackMode, layerName: string): Promise<boolean> {
  if (!job.target) {
    toast('无法写回', '该任务没有记录 Photoshop 目标', 'warn');
    return false;
  }
  if (!bridge.isAvailable()) {
    toast('无法写回', bridge.reason(), 'error');
    return false;
  }

  const check = bridge.validateWritebackTarget(job.target);
  if (!check.ok) {
    await api.reportWriteback(job.id, false, check.message ?? '写回前校验未通过', check.code);
    toast('写回被拦截', check.message ?? '', 'warn');
    const fresh = await api.job(job.id);
    setState({ jobs: getState().jobs.map((j) => (j.id === fresh.id ? fresh : j)) });
    return false;
  }

  try {
    await api.requestWriteback(job.id, mode, layerName);
    const bytes = await api.assetBytes(job.results[0]!.assetId);
    const res = await bridge.writeback({ bytes, mode, layerName, target: job.target });
    const fresh = await api.reportWriteback(job.id, res.ok, res.detail, res.code);
    setState({ jobs: getState().jobs.map((j) => (j.id === fresh.id ? fresh : j)) });
    toast(res.ok ? '已写回 Photoshop' : '写回失败', res.detail, res.ok ? 'info' : 'error');
    return res.ok;
  } catch (e) {
    const msg = e instanceof ApiError ? e.display : e instanceof Error ? e.message : String(e);
    await api.reportWriteback(job.id, false, msg, 'WRITEBACK_FAILED');
    toast('写回失败', msg, 'error');
    return false;
  }
}

/* ---------------- 运行时数据 ---------------- */

async function ensurePresets(featureId: string): Promise<void> {
  if (presetCache[featureId]) return;
  try {
    presetCache[featureId] = await api.prompts(featureId);
  } catch {
    presetCache[featureId] = [];
  }
}

async function ensureRuntimeOptions(view: FeatureView): Promise<void> {
  if (view.branch === 'comfyui') {
    if (runtimeOptions['samplers']) return;
    try {
      const oi = await api.comfyObjectInfo();
      runtimeOptions = {
        ...runtimeOptions,
        samplers: oi.samplers,
        schedulers: oi.schedulers,
        checkpoints: oi.checkpoints,
        upscaleModels: oi.upscaleModels
      };
    } catch {
      /* ComfyUI 没连上就用出厂推荐列表 */
    }
  } else if (view.providerId) {
    const key = `models:${view.providerId}`;
    if (runtimeOptions[key]) {
      runtimeOptions = { ...runtimeOptions, models: runtimeOptions[key]!, modelsTotal: runtimeOptions[`${key}:total`] ?? [] };
      return;
    }
    try {
      const all = await api.listModels(view.providerId);
      // 聚合网关会把平台上所有模型都列出来（Comfly 实测 858 个），
      // 里面绝大多数是对话/音频/视频模型，选中就是一次必然失败。
      // 生成页只列适合生图的那些，并如实告诉用户筛掉了多少。
      const models = filterImageModels(all);
      runtimeOptions = { ...runtimeOptions, [key]: models, models, [`${key}:total`]: all, modelsTotal: all };
    } catch {
      runtimeOptions = { ...runtimeOptions, models: [] };
    }
  }
}

/** 生成页被换下去时调用，免得外部还拿着一个指向已销毁 DOM 的回调。 */
export function detachGenerateResults(): void {
  repaintResults = null;
}

/** 切换功能时重置该页的一次性状态。 */
export function resetGenerateState(): void {
  inputHandles.clear();
  currentImages = {};
}

export { defaultValues, isTerminal };
