/**
 * 生成页：5 级导航 + 图像输入 + 参数面板 + 结果 + 底部主行动按钮。
 * 页面结构对所有 17 个功能都一样，差异全部来自功能目录。
 */

import { defaultValues, isTerminal, rhPresetByWorkflowId, paramsForWorkflowBindings } from '@psai/shared';
import type { ModelScope } from '@psai/shared';
import type { ParamSpec, WritebackMode, JobRecord, PhotoshopTarget } from '@psai/shared';
import { h, clear, setAttr, toggleClass } from '../app/dom.js';
import { api, ApiError } from '../app/api.js';
import type { FeatureView } from '../app/api.js';
import { getState, setState, setParam, paramsOf, setParams, toast, featureView, jobById } from '../app/store.js';
import { renderNav, renderBreadcrumb } from './nav.js';
import { renderParams, refreshAspectHints } from './params.js';
import type { ParamContext } from './params.js';
import { createImageInput, validateImages } from './imageinput.js';
import type { PickedImage, ImageInputHandle } from './imageinput.js';
import { documentMismatch } from './input-guards.js';
import { renderResults } from './results.js';
import * as bridge from '../ps/bridge.js';
import { withPhotoshopLock, reportOutcome, recordIntent } from './writeback-queue.js';

/** 每个功能页各自的图像输入实例，切页时重建 */
const inputHandles = new Map<string, ImageInputHandle>();

/**
 * 这一版生成页的版次。
 *
 * 每渲染一次就 +1。图像输入框的回调、以及渲染过程中每一个 await 之后，
 * 都要拿自己那一版去比一比 —— 对不上就说明这一版已经被换掉了，
 * 什么都不该再做。
 *
 * 没有它的话有一条很难查的错路：用户在生成页点了「从 Photoshop 取图」，
 * 捕获还没回来（合并图层、读遮罩，几百毫秒到几秒），他切走又切回来。
 * 页面重渲染，输入框是新的、空的 —— 而那次捕获**还在跑**，
 * 回来时照样往 currentImages 里写。用户看到的是空输入框，
 * 点提交却提交了那几张他以为没选上的图，而且它们来自一次
 * 可能已经关掉或改过的文档。界面显示的和实际提交的必须是同一份。
 */
let generateRevision = 0;
let currentImages: Record<string, PickedImage[]> = {};
let runtimeOptions: Record<string, string[]> = {};
/**
 * 模型下拉旁边那句「只列出 N 个 / 平台共 M 个」的数据。
 * 跟 runtimeOptions 分开放：那个是 Record<string, string[]>，
 * 塞一个计数进去只能编成假数组，读的地方还得再解一次 —— 不如单独一份。
 */
let modelsMeta: { total: number; scope: ModelScope } | null = null;
/** 当前功能所在平台没有模型目录时的说明；有值就不画模型下拉 */
let modelsUnsupported: { reason: string } | null = null;
const modelsMetaByProvider: Record<string, { total: number; scope: ModelScope }> = {};
let presetCache: Record<string, ParamContext['presets']> = {};
/**
 * 「自定义工作流」当前选中的那一份（工作流库里的 id）。
 *
 * 放模块级而不是每次渲染新建：切到历史页再切回来，用户不用重选一次。
 * 只在插件重载时清空，这跟其它运行期缓存（runtimeOptions / presetCache）一致。
 */
let customWorkflowId: string | null = null;
/**
 * 当前那份自定义工作流按绑定算出来的参数控件。
 *
 * 缓存住，切页回来不用重拉一次 —— 也让重渲染的首帧就画对，
 * 而不是先闪一下空的「参数设置」再补上。
 */
let customParamSpecs: ParamSpec[] | null = null;
/** 选中的自定义工作流是云端条目时，它跑在哪个 Provider 上；本机图为 null。 */
let customWorkflowProvider: string | null = null;

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
  const rev = ++generateRevision;
  /** 这一版还是不是当前那一版。await 之后一律先问它。 */
  const current = (): boolean => rev === generateRevision;

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
      // 上一版页面里那次还没回来的捕获/上传，不许再写进来
      if (!current()) return;
      currentImages[key] = imgs;
      updateSubmitState();
    });
    inputHandles.set(key, handle);
    /*
     * 新建的输入框是**空的**，所以这里必须跟着清空，不能 `??=` 保留旧值。
     *
     * 旧写法留下的是一种看不见的残留：用户在这个功能上取过图，切走再切回来，
     * 界面上的输入框是空的（handle 是新建的），而 currentImages 里那几张还在。
     * 他以为自己什么都没选，点提交 —— 提交上去的是上一次那几张图，
     * 而且很可能取自一个已经关掉或者改过的文档。
     * 界面显示的东西和实际提交的东西必须是同一份。
     */
    currentImages[key] = [];
    host.appendChild(handle.el);
  }

  /* ---- 参数面板 ---- */

  /*
   * 提示词预设很快（实测 4ms），等它无所谓。
   */
  await ensurePresets(view.id);
  if (!current()) return; // 拉预设的这段时间里页面被换掉了，别再往一个已经废弃的 DOM 上画

  /*
   * 模型列表**不等**。
   *
   * 实测：闭源模型分支要向平台拉一次模型列表，comfly 这条路要 10.6 秒，
   * 而且现在还返回 502。ComfyUI 分支的 object-info 也要 2 秒。
   * 原来是 `await` 在这儿 —— 于是这十秒里整个参数区、提交按钮一个都没有，
   * 用户看到的是一页只有标题的空白，还以为插件坏了。
   *
   * 现在先按手上已有的选项把界面画全（模型下拉先显示"正在载入"），
   * 列表回来了再刷新那一块。慢的是网络，不该让整页陪着它等。
   */
  const runtimeReady = ensureRuntimeOptions(view);

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
    modelsMeta,
    modelsUnsupported,
    // 首帧多半还没有列表 —— 告诉界面"在载入"，别说成"尚未拉取"
    modelsLoading: true,
    hasImageInput: imageSpecs.length > 0,
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
        // 内置模型是我们自己挑的，用户在设置里看不到 —— 那就用完之后如实报出来，
        // 否则「优化」就成了一个说不清用了什么的黑箱。
        toast('提示词已优化', res.model ? `${res.providerId} · ${res.model}` : res.providerId);
        return res.text;
      } catch (e) {
        const msg = e instanceof ApiError ? e.display : String(e);
        toast('优化失败', msg, 'error');
        return null;
      }
    }
  };

  /*
   * 「自定义工作流」的工作流选择器。
   *
   * 在这之前，这个功能是**跑不起来的**：它的 defaultWorkflowId 是 null，
   * 设置页的「固定功能」又明确跳过它（那一节 `if (f.id === 'comfy.custom') continue`），
   * 生成页也不发 workflowId —— 于是三条路都不通，导入的工作流没有任何途径
   * 被选中执行。页面上只有一个空的「参数设置」，看起来像功能没做完。
   *
   * 只列本机图：这个功能挂在 comfyui 分支下，跑的是本机 ComfyUI。
   * 云端工作流属于云端平台，在「设置 → 固定功能」里按功能绑定。
   */
  /**
   * 选中的那份工作流决定参数区长什么样，所以选择器要能回头改参数区。
   *
   * 用一个后填的回调而不是直接闭包引用 paramsCard：卡片是在参数区之前
   * 建出来的（它在页面上排在参数区上面），那时候 paramsCard 还不存在。
   */
  let applyCustomParams: ((specs: ParamSpec[]) => void) | null = null;
  if (view.id === 'comfy.custom') {
    host.appendChild(
      customWorkflowCard((specs) => {
        if (!current()) return;
        applyCustomParams?.(specs);
      })
    );
  }

  let paramsBody = renderParams(customParamSpecs ?? view.params, paramCtx);
  const paramsCard = h('section', { class: 'card' }, h('h3', { class: 'card-title' }, '参数设置'), paramsBody);
  host.appendChild(paramsCard);

  applyCustomParams = (specs) => {
    customParamSpecs = specs;
    /*
     * 新出现的控件要有初值，否则滑杆停在 0、下拉停在空 ——
     * 用户会以为这份工作流"参数是空的"，其实只是没人给默认值。
     * 已经有值的键不动：他可能刚在上一份工作流里敲过提示词。
     */
    const have = paramsOf(view.id);
    const fill: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(defaultValues(specs))) {
      if (have[k] === undefined) fill[k] = v;
    }
    if (Object.keys(fill).length) setParams(view.id, { ...have, ...fill });

    try {
      const fresh = renderParams(specs, { ...paramCtx, options: runtimeOptions, modelsLoading: false });
      // insertBefore + removeChild：UXP 没有 replaceChild，见下面那段注释
      paramsCard.insertBefore(fresh, paramsBody);
      paramsCard.removeChild(paramsBody);
      paramsBody = fresh;
      updateSubmitState();
    } catch {
      /* 换不上去就维持现状，至少界面是完整的 */
    }
  };
  refreshAspectHints(paramsCard, Number(paramsOf(view.id)['resolution'] ?? 1024));

  /*
   * 模型列表到了再把参数区重画一遍。
   *
   * 只换 card 里的那一块，不整页重画 —— 整页重画会把用户已经敲进去的
   * 提示词和刚选好的图冲掉，而他这十秒里很可能正在输入。
   */
  void runtimeReady.then(() => {
    if (!current()) return;
    try {
      const fresh = renderParams(view.params, {
        ...paramCtx,
        options: runtimeOptions,
        modelsMeta,
        modelsUnsupported,
        modelsLoading: false
      });
      /*
       * 用 insertBefore + removeChild，**不能用 replaceChild** ——
       * UXP 的 DOM 里没有那个方法（test/uxp-dom.mjs 照着真机能力做的替身
       * 也没有，就是它把这行照出来的）。
       *
       * 之前这里写的是 replaceChild：真机上它会抛，而这个 catch 把异常吞了，
       * 于是模型列表回来了也永远刷不上去 —— 下拉一直停在「正在载入模型列表…」。
       * 一个只在 Photoshop 里出现、而且不留任何痕迹的故障。
       */
      paramsCard.insertBefore(fresh, paramsBody);
      paramsCard.removeChild(paramsBody);
      paramsBody = fresh;
      refreshAspectHints(paramsCard, Number(paramsOf(view.id)['resolution'] ?? 1024));
      updateSubmitState();
    } catch {
      /* 刷新失败就维持现状，至少界面是完整的 */
    }
  });

  /* ---- 结果 ---- */
  const resultsHost = h('div', { class: 'results-host' });
  host.appendChild(resultsHost);

  function firstInput(): { previewSrc: string; assetId: string } | null {
    const key = `${view!.id}:${imageSpecs[0]?.id ?? 'image'}`;
    const img = currentImages[key]?.[0];
    return img ? { previewSrc: img.previewSrc, assetId: img.assetId } : null;
  }

  function paintResults(): void {
    const job = jobById(getState().activeJobId);
    clear(resultsHost);
    resultsHost.appendChild(
      renderResults({
        job,
        inputPreview: firstInput()?.previewSrc ?? null,
        // 对比区要拿它去取清晰的那一档；缩略图只是占位
        inputAssetId: firstInput()?.assetId ?? null,
        availableModes: view!.writeback.modes,
        onWriteback: (mode, layerName, assetId) =>
          // 把这个功能允许的写回方式一起带下去 —— 越权的模式要在动文档之前挡住
          void doWriteback(job!, mode, layerName, assetId, view!.writeback.modes),
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

      /*
       * 输入图取自哪个文档，写回就得回哪个文档。
       *
       * 这两者很容易对不上，而且完全不需要用户做错什么：
       * 从 A 取了图，中间切到 B 看一眼，回来点「开始处理」——
       * 输入是 A 的内容，写回目标却被冻结成当前的 B。
       * 结果是 A 的图被贴进 B 的文档，而两边都不会报错，
       * 用户只会看到自己的文档里凭空多了一张不相干的图。
       *
       * 拦下来而不是自动改用 A：A 可能已经关了，而且"我要写回哪里"
       * 是用户的意图，不该由我们替他猜。说清楚，让他自己决定。
       */
      /*
       * 写回方式要在**检查之前**定下来。
       *
       * assetOnly 压根不写文档，拿"输入图和当前文档对不上"去挡它是无中生有 ——
       * 而"没有打开的文档"恰恰是最常落到 assetOnly 的情形，
       * 那时候用户要的只是把图存进资产库。
       */
      const target = ctx ? bridge.buildTarget(ctx, selectionBounds) : null;
      const settings = getState().settings;
      const mode: WritebackMode = target ? (settings?.generation.writebackMode ?? view!.writeback.default) : 'assetOnly';

      const picked = imageSpecs.flatMap((spec) => currentImages[`${view!.id}:${spec.id}`] ?? []);
      const mismatch = documentMismatch(picked, ctx, mode);
      if (mismatch) {
        toast(mismatch.title, mismatch.detail, 'warn');
        return;
      }

      /*
       * 「自定义工作流」必须带上选中的那一份。
       *
       * 不带的话 Helper 那边解析出来是 null（这个功能的 defaultWorkflowId 就是 null，
       * 也没有固定功能绑定），提交会被 WORKFLOW_NOT_BOUND 拦下 ——
       * 而用户明明在上面的下拉里选了一个，只是这个选择从来没被发出去。
       */
      if (view!.id === 'comfy.custom' && !customWorkflowId) {
        toast('还没选工作流', '在上面的「选择工作流」里挑一份再提交', 'warn');
        return;
      }

      const job = await api.createJob({
        featureId: view!.id,
        params: paramsOf(view!.id),
        inputs,
        target,
        writeback: { mode, layerName: `AI · ${view!.label}` },
        ...(view!.id === 'comfy.custom' && customWorkflowId ? { workflowId: customWorkflowId } : {}),
        // 云端条目要连后端一起指名：这个功能挂在 comfyui 分支下，
        // 不指名会被解析成本机 ComfyUI，而要跑的图在平台那边。
        ...(view!.id === 'comfy.custom' && customWorkflowProvider ? { providerId: customWorkflowProvider } : {})
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
      // ok 只说明请求成功了；取消到底生没生效看 cancelled。
      // pending 表示提交还在飞，结论稍后会通过任务状态推过来。
      if (res.pending) toast('正在取消', res.reason);
      else if (!res.cancelled) toast('取消未生效', res.reason, 'warn');
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

  async function doWriteback(
    job: JobRecord,
    mode: WritebackMode,
    layerName: string,
    assetId?: string,
    allowedModes?: WritebackMode[]
  ): Promise<void> {
    await performWriteback(job, mode, layerName, {
      ...(assetId ? { assetId } : {}),
      ...(allowedModes ? { allowedModes } : {})
    });
    paintResults();
  }
}

/**
 * 写回流程：领执行权 → 校验 → 取字节 → 调 bridge → 把结果如实回报给 Helper。
 *
 * `opts.auto` 表示这次是自动写回触发的。它只影响两件事：
 * 记账（Helper 那边会记下这一次是不是用户点的）和提示的措辞 ——
 * 自动写回成功时不该弹一个需要用户注意的 toast，他并没有做什么。
 */
/** 写回途中每隔多久续一次租。租约 2 分钟，这里留足余量。 */
const WRITEBACK_HEARTBEAT_MS = 20_000;

/**
 * 写回的结果。
 *
 * busy 要和 ok=false 分开：撞上别人正在写**不是**失败，那次写回可能几秒后
 * 就完了。调用方（自动写回）据此决定是"永久放弃"还是"稍后再试"——
 * 靠事后去看任务状态来猜是不准的：撞车时我们根本没碰过那条任务，
 * store 里那份可能是任意时刻的旧快照。
 */
/**
 * 排队期间租约被顶替了。
 *
 * 单独一个类型，是为了让下面的 catch 能把它和"真的写失败了"分开 ——
 * 这两种情况该做的事正好相反：前者必须**什么都不报**（那张凭据
 * 已经有结论了，再报会覆盖掉别人成功的那一次），后者必须如实上报。
 */
class LeaseLostError extends Error {}

export interface WritebackOutcome {
  ok: boolean;
  busy: boolean;
  detail: string;
}

/** 保留布尔返回值给老调用方；需要区分 busy 的用 performWritebackDetailed。 */
export async function performWriteback(
  job: JobRecord,
  mode: WritebackMode,
  layerName: string,
  opts: { auto?: boolean; assetId?: string; rebindTarget?: PhotoshopTarget | null } = {}
): Promise<boolean> {
  return (await performWritebackDetailed(job, mode, layerName, opts)).ok;
}

export async function performWritebackDetailed(
  job: JobRecord,
  mode: WritebackMode,
  layerName: string,
  opts: {
    auto?: boolean;
    assetId?: string;
    allowedModes?: WritebackMode[];
    /**
     * 把这条任务的写回目标改绑到另一份文档。
     *
     * 只有用户在历史页明确选了"写进当前这份文档"时才传。
     * 传了就用它当目标，而不是任务上冻结的那个 —— 那个可能压根没有
     * （提交时没打开文档），也可能指向一份已经关掉的文档。
     */
    rebindTarget?: PhotoshopTarget | null;
  } = {}
): Promise<WritebackOutcome> {
  const allowedModes = opts.allowedModes;
  const effectiveTarget = opts.rebindTarget ?? job.target;

  /*
   * assetOnly 要在**这两道检查之前**就分出来。
   *
   * 它压根不碰文档 —— 结果落资产库就完事了，既不需要目标文档，
   * 也不需要 Photoshop 在线。而这两种情况恰恰是最该退到「仅存资产库」的：
   * 提交时没有打开的文档（于是 job.target 是空的）、
   * Photoshop 崩过一次（于是桥不可用）。
   *
   * 老代码把它排在后面，于是一个**必定能成功**的操作报了
   * 「该任务没有记录 Photoshop 目标」。用户要的只是把图存下来，
   * 得到的却是一句他既看不懂、也无从下手的拒绝。
   */
  const isAssetOnly = mode === 'assetOnly';

  if (!isAssetOnly) {
    if (!effectiveTarget) {
      if (!opts.auto) toast('无法写回', '该任务没有记录 Photoshop 目标', 'warn');
      return { ok: false, busy: false, detail: '该任务没有记录 Photoshop 目标' };
    }
    if (!bridge.isAvailable()) {
      if (!opts.auto) toast('无法写回', bridge.reason(), 'error');
      return { ok: false, busy: false, detail: bridge.reason() };
    }
  }

  /*
   * 先领执行权，再做任何实际动作。
   *
   * 顺序很关键：校验和取字节都要花时间，那段时间里另一个面板实例
   * （或者一次手抖的双击）可能已经开始写了。先领权就只会有一个赢家，
   * 输的那个拿到 WRITEBACK_IN_PROGRESS，什么也不做。
   */
  /*
   * 写哪一张，要在这里定下来并一路带到底。
   *
   * 以前是走到取字节那一步才 `job.results[0]` —— 用户在多图结果里
   * 点开 #3 觉得最好、点写回，进文档的却是 #1，而界面上没有任何提示。
   * 他只会觉得写回坏了。
   *
   * 传进来的 id 必须真的属于这条任务：不属于就当没传，退回第一张，
   * 而不是拿一个别的任务的资产往用户文档里写。
   */
  const wanted = opts.assetId && job.results.some((r) => r.assetId === opts.assetId) ? opts.assetId : null;
  const assetId = wanted ?? job.results[0]!.assetId;
  const resultIndex = job.results.findIndex((r) => r.assetId === assetId);

  let attemptId: string;
  try {
    const lease = await api.requestWriteback(
      job.id,
      mode,
      layerName,
      opts.auto,
      assetId,
      opts.rebindTarget ?? null
    );
    attemptId = lease.attemptId;
  } catch (e) {
    const msg = e instanceof ApiError ? e.display : String(e);
    if (e instanceof ApiError && e.shape.code === 'WRITEBACK_IN_PROGRESS') {
      // 不是错误，是"有人已经在写了"。自动写回时连提示都不该有。
      if (!opts.auto) toast('已经在写回了', msg);
      return { ok: false, busy: true, detail: msg };
    }
    if (!opts.auto) toast('写回失败', msg, 'error');
    return { ok: false, busy: false, detail: msg };
  }

  // 校验按写回方式分档：新建图层不存在错位问题，不该被画布变了挡住。
  // assetOnly 在 validateWritebackTarget 里第一句就放行，不看目标也不看桥。
  const check = bridge.validateWritebackTarget(effectiveTarget ?? null, mode);
  if (!check.ok) {
    // 还没碰过 Photoshop，直接回报即可
    await reportOutcome({
      jobId: job.id,
      attemptId,
      ok: false,
      detail: check.message ?? '写回前校验未通过',
      ...(check.code ? { code: check.code } : {})
    });
    toast('写回被拦截', check.message ?? '', 'warn');
    const fresh = await api.job(job.id);
    setState({ jobs: getState().jobs.map((j) => (j.id === fresh.id ? fresh : j)) });
    return { ok: false, busy: false, detail: check.message ?? '写回前校验未通过' };
  }

  /*
   * 从这里往下分成两段，中间那条线非常要紧：
   *
   *   第一段：改 Photoshop。全局排队（executeAsModal 是独占的），
   *          期间定期续租（写一张 8K 智能对象可能几十秒，超过租约就会被顶替）。
   *   第二段：把结果报回去。这一段**只是通知**，失败了就重试通知，
   *          绝不重做第一段。
   *
   * 混在一起写过一版，后果是最坑的一种：Photoshop 已经改完了，
   * 回报因为一次网络抖动失败，我们把它记成"写回失败"。
   * 用户看到失败就去点「再次写回」—— 文档里于是出现第二个一模一样的图层。
   * 图已经进了用户的文档，这件事一旦发生就不可撤销，
   * 所以它必须是整个流程里唯一不能重来的那一步。
   */
  let mutation: { ok: boolean; detail: string; code?: string };

  /*
   * 续租要从**现在**开始，不是等抢到 Photoshop 之后。
   *
   * executeAsModal 是全局独占的，所以写回要排队。排在前面的可能是
   * 另一条任务的 8K 智能对象，几十秒起步 —— 而租约只有两分钟。
   * 把心跳放在锁**里面**的话，这一整段排队时间是没人续租的：
   * 轮到我们时租约可能早就过期，Helper 已经把这次写回标成
   * 「等待插件回报超时」并允许别人接手。接下来两边都会往文档里放一张图。
   *
   * 心跳本身很便宜（20 秒一次的 HTTP），排队期间白跳几次没有代价，
   * 而漏跳一次的代价是用户文档里多一个图层。
   */
  const beat = setInterval(() => {
    void api.renewWriteback(job.id, attemptId).catch(() => undefined);
  }, WRITEBACK_HEARTBEAT_MS);

  try {
    const bytes = await api.assetBytes(assetId);

    /*
     * 动 Photoshop **之前**先落一条意图。
     *
     * 从这一行往后，任何时刻断电/崩溃/面板重载，我们都还能在下次启动时
     * 知道"有过这么一次写回"，然后拿这条记录里的出处标记去文档里核对。
     * 不落这一条的话，被打断之后只剩两个都错的选择：
     * 当它没发生（再写一次，多一个图层）或者当它成功了（用户白等）。
     *
     * 落不下去就**不动手** —— 宁可这次写回失败（文档没被动过、可以重试），
     * 也不要留下一次说不清的写回。
     */
    await recordIntent({
      attemptId,
      jobId: job.id,
      assetId,
      mode,
      layerName,
      documentId: effectiveTarget?.documentId ?? null,
      documentName: effectiveTarget?.documentName ?? null,
      documentPath: effectiveTarget?.documentPath ?? null,
      provenanceTag: bridge.provenanceTag({ jobId: job.id, attemptId, assetId }),
      startedAt: Date.now()
    });

    mutation = await withPhotoshopLock(async () => {
      /*
       * 排到了。动文档之前再确认一次这张凭据还是我们的 ——
       * 排队期间它可能已经被顶替（我们这边心跳断过、或者用户
       * 在另一个面板实例里点了「再次写回」）。
       * 不确认的话，两次写回都会各放一张图进去，而两次都报成功。
       *
       * 注意续租接口在"租约没了"时返回的是 200 + renewed:false，
       * 不是抛错 —— 只 await 不看返回值等于没查。
       */
      const still = await api.renewWriteback(job.id, attemptId);
      if (!still.renewed) throw new LeaseLostError(still.reason || '写回凭据已失效');

      return await bridge.writeback({
        bytes,
        mode,
        layerName,
        ...(effectiveTarget ? { target: effectiveTarget } : {}),
        /*
         * 出处：下一次同一条任务的写回靠它认出上一次那个图层。
         * 认标记而不是图层名 —— 名字是用户随手就能占用的，
         * 他自己建一个叫「AI 结果」的图层太正常了。
         */
        provenance: { jobId: job.id, attemptId, assetId },
        // 功能自己声明允许哪几种；越权的模式要挡在动文档之前
        ...(allowedModes ? { allowedModes } : {})
      });
    });
  } catch (e) {
    /*
     * 租约丢了是**另一回事**，不能按失败上报。
     *
     * 那张凭据在 Helper 那边已经有结论了（被顶替 / 超时），
     * 拿它去报一次"写回失败"，覆盖掉的可能是另一个写手
     * 刚刚成功的那一次 —— 用户看到"失败"，然后再写一遍，
     * 文档里多一个图层。而我们这边其实一个字节都没动过。
     */
    if (e instanceof LeaseLostError) {
      if (!opts.auto) toast('已经在写回了', e.message);
      return { ok: false, busy: true, detail: e.message };
    }
    // 走到这里说明**没有**改成文档（取字节失败、或者 bridge 自己抛了）
    const msg = e instanceof ApiError ? e.display : e instanceof Error ? e.message : String(e);
    await reportOutcome({ jobId: job.id, attemptId, ok: false, detail: msg, code: 'WRITEBACK_FAILED' });
    toast('写回失败', msg, 'error');
    return { ok: false, busy: false, detail: msg };
  } finally {
    clearInterval(beat);
  }

  // Photoshop 那边已成定局。下面无论怎么失败，都不许再动文档。
  const acked = await reportOutcome({
    jobId: job.id,
    attemptId,
    ok: mutation.ok,
    detail: mutation.detail,
    ...(mutation.code ? { code: mutation.code } : {})
  });

  try {
    const fresh = await api.job(job.id);
    setState({ jobs: getState().jobs.map((j) => (j.id === fresh.id ? fresh : j)) });
  } catch {
    /* 状态拉不回来不影响已经发生的事实 */
  }

  if (mutation.ok) {
    // 多图结果时点明写的是第几张 —— 用户挑了半天，得让他确认没挑错
    const which = job.results.length > 1 ? `（第 ${resultIndex + 1} 张）` : '';
    if (!acked) {
      // 图确实进去了，只是 Helper 还不知道。说清楚，别让用户以为要重来。
      toast('已写回 Photoshop', `结果${which}已经写入文档；状态还没同步到 Helper，会自动重试`);
    } else if (!opts.auto) {
      toast('已写回 Photoshop', `${mutation.detail}${which}`);
    }
  } else {
    // 失败一定要说，哪怕是自动触发的 —— 用户以为图进文档了，其实没有
    toast('写回失败', mutation.detail, 'error');
  }
  return { ok: mutation.ok, busy: false, detail: mutation.detail };
}

/**
 * 「自定义工作流」的工作流选择卡片。
 *
 * 列表异步填：拉工作流要走一次 Helper，让它挡住首帧的话，慢的时候
 * 用户看到的又是一张空白页 —— 那是上一版模型列表踩过的坑，不重复。
 * 先画出卡片和「正在载入」，回来了再把下拉塞进去。
 *
 * 用 insertBefore + removeChild 换节点，不用 replaceChild —— UXP 的 DOM
 * 子集里没有那个方法，调了会静默失败，界面就永远停在「正在载入」。
 */
function customWorkflowCard(onPick: (specs: ParamSpec[]) => void): HTMLElement {
  const body = h('div', { class: 'wf-pick-body' });
  let slot: HTMLElement = h('div', { class: 'muted' }, '正在载入工作流列表…');
  body.appendChild(slot);

  const swap = (next: HTMLElement): void => {
    body.insertBefore(next, slot);
    body.removeChild(slot);
    slot = next;
  };

  void api
    .workflows()
    .then((local) => {
      if (!local.length) {
        swap(
          h(
            'div',
            { class: 'muted' },
            '工作流库是空的。到「设置 → 工作流」里导入一份 ComfyUI 的图，或者登记一条云端工作流。'
          )
        );
        return;
      }
      // 上次选的那份可能已经被删了，别让选择器指着一个不存在的 id
      if (customWorkflowId && !local.some((w) => w.id === customWorkflowId)) customWorkflowId = null;
      if (!customWorkflowId) customWorkflowId = local[0]!.id;

      const select = h('select', { class: 'input select' }) as HTMLSelectElement;
      for (const w of local) {
        // 两类混在一张单子里，所以每一项都要标清楚跑在哪儿 ——
        // 否则用户没法判断这一份要不要占本机显卡。
        const label =
          w.kind === 'cloud'
            ? `${w.name} v${w.version}（云端 · ${w.providerId ?? '未知平台'}）`
            : `${w.name} v${w.version}（${w.source === 'builtin' ? '内置' : '导入'} · ${w.nodeCount} 节点）`;
        const opt = h('option', { value: w.id }, label) as HTMLOptionElement;
        if (w.id === customWorkflowId) opt.setAttribute('selected', '');
        select.appendChild(opt);
      }

      /** 选中的那份跑在哪个后端；云端条目要把它一起发出去。 */
      const syncProvider = (): void => {
        const w = local.find((x) => x.id === customWorkflowId);
        customWorkflowProvider = w?.kind === 'cloud' ? (w.providerId ?? null) : null;
      };
      const detail = h('div', { class: 'muted hint' });

      /*
       * 参数控件跟着选中的这份图走。
       *
       * 要拿完整记录（api.workflow）而不是列表里的摘要 —— 摘要只有
       * bindingCount 一个数字，画不出控件；控件是由每条绑定的 paramId
       * 决定的：绑了提示词就有提示词框，绑了重绘幅度就有那根滑杆。
       *
       * 拉不到就保持现状而不是清空：让用户对着一个空参数区，
       * 比让他对着上一份的控件更没法办事。
       */
      const loadParams = (id: string): void => {
        void api
          .workflow(id)
          .then((rec) => {
            if (customWorkflowId !== id) return; // 期间又换了一份，这次的结果作废
            onPick(paramsForWorkflowBindings(rec.bindings));
          })
          .catch(() => {
            /* 保持现状 */
          });
      };

      const paint = (): void => {
        const w = local.find((x) => x.id === customWorkflowId);
        clear(detail);
        if (!w) return;
        if (w.kind === 'cloud') {
          detail.appendChild(h('div', {}, `跑在 ${w.providerId ?? '云端平台'} 上 · ID ${w.remoteId ?? '—'}，不占用本机显卡。`));
          detail.appendChild(
            h('div', {}, '参数由平台侧的工作流自己决定，本机这里只发图 —— 所以下面的参数区是空的。')
          );
        } else {
          detail.appendChild(
            h(
              'div',
              {},
              w.bindingCount
                ? `这份图有 ${w.bindingCount} 条参数绑定，下面的参数区会按它们生成。`
                : '这份图没有参数绑定：会按导入时的原样跑，只把图填进去。绑定在「设置 → 工作流 → 参数绑定」里改。'
            )
          );
        }
        if (w.notes) detail.appendChild(h('div', {}, w.notes));
      };
      select.onchange = (e: Event): void => {
        customWorkflowId = (e.target as HTMLSelectElement).value;
        syncProvider();
        paint();
        loadParams(customWorkflowId);
      };
      const wrap = h('div', { class: 'wf-pick' }, select, detail);
      swap(wrap);
      syncProvider();
      paint();
      loadParams(customWorkflowId);
    })
    .catch((e: unknown) => {
      swap(h('div', { class: 'err' }, `工作流列表拉取失败：${e instanceof ApiError ? e.display : String(e)}`));
    });

  return h('section', { class: 'card' }, h('h3', { class: 'card-title' }, '选择工作流'), body);
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
      runtimeOptions = { ...runtimeOptions, models: runtimeOptions[key]! };
      modelsMeta = modelsMetaByProvider[view.providerId] ?? null;
      return;
    }
    try {
      // 口径由 Helper 定（默认 approved：只给真机验证过的认可生图模型）。
      // 聚合网关会把平台上所有模型都列出来 —— Comfly 实测 858 个，
      // 绝大多数是对话/音频/视频模型，选中就是一次必然失败。
      // 生成页不做二次筛选：筛选规则只有一份，在 @psai/shared 里。
      const res = await api.listModels(view.providerId);
      runtimeOptions = { ...runtimeOptions, [key]: res.models, models: res.models };
      modelsMeta = { total: res.total, scope: res.scope };
      modelsMetaByProvider[view.providerId] = modelsMeta;
      modelsUnsupported = null;
    } catch (e) {
      /*
       * 分两种，处理方式完全不同：
       *
       *   平台没有模型目录（PROVIDER_UNSUPPORTED）—— 比如 RunningHub
       *     以云端工作流为单位。再拉一百次也不会有列表，
       *     该去改的是「设置 → 固定功能」里的工作流绑定。
       *   真的拉失败 —— 网络、鉴权、限流，重试有意义。
       *
       * 而且**必须把 modelsMeta 清掉**。它是模块级的：上一个平台
       * （comfly，861 个）留下的数字会原样显示在这个平台的提示里，
       * 变成「该平台共 861 个」—— 那是另一个平台的数字，纯属误导。
       * 真机上就是这么出现的：图生图和精修白底图绑在 RunningHub 上，
       * 却显示着 comfly 的模型总数。
       */
      modelsUnsupported =
        e instanceof ApiError && e.shape.code === 'PROVIDER_UNSUPPORTED' ? { reason: e.display } : null;
      modelsMeta = null;
      runtimeOptions = { ...runtimeOptions, models: [] };
    }
  }
}

/** 生成页被换下去时调用，免得外部还拿着一个指向已销毁 DOM 的回调。 */
export function detachGenerateResults(): void {
  repaintResults = null;
  // 页面要被换掉了 —— 顺手把这一页的一次性状态也丢掉。
  // 这两件事从来都该一起发生：留着回调却清了 DOM（或者反过来）
  // 都会让上一版的异步结果落到一个已经不存在的界面上。
  resetGenerateState();
}

/**
 * 丢掉这一页的一次性状态。
 *
 * 换页时必须调用（main.ts 的 detachGenerateResults 里会走到）：
 * 版次一变，上一版那些还在飞的回调就再也写不进来了。
 * 不清的话 inputHandles / currentImages 会按 `功能:参数` 一直堆下去，
 * 用户在十几个功能之间切过一圈，里面就留着十几份他早就看不见的图。
 */
export function resetGenerateState(): void {
  generateRevision++;
  inputHandles.clear();
  currentImages = {};
}

export { defaultValues, isTerminal };
