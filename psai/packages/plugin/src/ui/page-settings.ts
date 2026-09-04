/**
 * 设置页：本地 / 云端 / 固定功能绑定 / 工作流 / 推荐平台 / 生成默认值 / 关于。
 * 所有设置的真相源都在 Helper，这里只是编辑器。
 */

import {
  COMFY_MODE_LABELS,
  COMFY_MODES,
  COMFY_MODE_HINTS,
  WRITEBACK_MODE_LABELS,
  WRITEBACK_MODES,
  breadcrumb,
  RUNNINGHUB_PRESETS,
  RH_CATEGORY_LABELS,
  rhPresetsForFeature,
  rhPresetByWorkflowId,
  rhPostUrl,
  findProvider,
  BINDABLE_PARAMS,
  SEMANTIC_TO_PARAM
} from '@psai/shared';
import type { AppSettings, SettingsPatch, WritebackMode, ComfyMode } from '@psai/shared';
import { h, clear, formatBytes, formatDuration, formatTime, toggleClass } from '../app/dom.js';
import { api, ApiError, clearToken, ensurePaired, CLIENT_VERSION } from '../app/api.js';
import type { ProviderView, WorkflowSummary, FeatureView } from '../app/api.js';
import { getState, setState, toast } from '../app/store.js';
import * as bridge from '../ps/bridge.js';

type Section = 'local' | 'cloud' | 'bindings' | 'workflows' | 'platforms' | 'defaults' | 'about';

let section: Section = 'local';

/** 分节的中文名，只用于报错文案。 */
const SECTION_LABELS: Record<Section, string> = {
  local: '本地',
  cloud: '云端',
  bindings: '固定功能',
  workflows: '工作流',
  platforms: '推荐平台',
  defaults: '生成默认值',
  about: '关于'
};

/**
 * 当前挂着设置页的那个容器。
 *
 * 存一份是为了在"保存失败"之后能把这一页重画回真实状态 ——
 * 那条路径不在任何一个控件的闭包里，拿不到 host。
 */
let currentHost: HTMLElement | null = null;

export async function renderSettingsPage(host: HTMLElement): Promise<void> {
  currentHost = host;
  clear(host);
  host.appendChild(h('header', { class: 'page-head' }, h('h2', { class: 'page-title' }, '设置')));

  const tabs: Array<{ id: Section; label: string }> = [
    { id: 'local', label: '本地' },
    { id: 'cloud', label: '云端' },
    { id: 'bindings', label: '固定功能' },
    { id: 'workflows', label: '工作流' },
    { id: 'platforms', label: '推荐平台' },
    { id: 'defaults', label: '生成默认值' },
    { id: 'about', label: '关于' }
  ];
  const tabBar = h('div', { class: 'subtabs' });
  const body = h('div', { class: 'settings-body' });

  for (const t of tabs) {
    tabBar.appendChild(
      h(
        'button',
        {
          class: `subtab ${section === t.id ? 'active' : ''}`,
          type: 'button',
          onclick: () => {
            section = t.id;
            /*
             * 这里以前是 `void renderSettingsPage(host)`。
             *
             * 分节渲染里任何一处抛错，都会变成一条没人接的 rejection ——
             * 用户看到的是**一片空白**，没有任何提示，也没法把错误告诉别人。
             * 「固定功能」那一页就是这么消失的：页签在、标题在、内容没了。
             *
             * 空白比报错糟得多：报错至少说得出是哪儿坏了。
             */
            void renderSettingsPage(host).catch((e) => {
              const body = host.querySelector('.settings-body');
              const msg = e instanceof Error ? e.message : String(e);
              if (body) {
                clear(body);
                body.appendChild(
                  h(
                    'div',
                    { class: 'notice warn' },
                    h('div', {}, `「${t.label}」这一页没能画出来：${msg}`),
                    h('div', { class: 'muted' }, '这是个 bug，请把这句话反馈给开发者。')
                  )
                );
              }
            });
          }
        },
        t.label
      )
    );
  }
  host.appendChild(tabBar);
  host.appendChild(body);

  /*
   * 先放一个"正在载入"，再去取数据。
   *
   * 各分节都要 await 后端。慢一点（甚至挂住）时，这块本来是**一片空白**——
   * 用户看不出是在加载、还是坏了、还是这一页本来就没内容。
   * 实测 /v1/providers 要 435ms，闭源模型那条路更是十几秒；
   * 而只要一直没回来，界面就一直空着，不给任何交代。
   *
   * 占位符先垫上，分节画完会把它整个换掉。
   */
  const loading = h('div', { class: 'muted pad' }, '正在载入…');
  body.appendChild(loading);

  const settings = getState().settings ?? (await api.settings());
  setState({ settings });

  /*
   * 分节自己往 body 里 append。占位符要在**第一段内容画进去之前**移走，
   * 否则会和真内容并排显示。各分节都是"算完再 append"，
   * 所以在 switch 之前清掉最安全 —— 从这里到 append 之间没有 await。
   */
  const dropLoading = (): void => {
    if (loading.parentElement === body) body.removeChild(loading);
  };

  switch (section) {
    case 'local':
      await renderLocal(body, settings);
      dropLoading();
      break;
    case 'cloud':
      await renderCloud(body, settings);
      dropLoading();
      break;
    case 'bindings':
      await renderBindings(body);
      dropLoading();
      break;
    case 'workflows':
      await renderWorkflows(body);
      dropLoading();
      break;
    case 'platforms':
      await renderPlatforms(body);
      dropLoading();
      break;
    case 'defaults':
      await renderDefaults(body, settings);
      dropLoading();
      break;
    case 'about':
      await renderAbout(body);
      dropLoading();
      break;
  }

  /*
   * 兜底：分节跑完了，却什么都没画出来。
   *
   * 这不是假设 —— 「固定功能」真机上就是这样：没抛错、也没内容，
   * 一片空白。空白说不出任何信息，用户没法反馈，我也没法查。
   * 宁可摆一句难看的话，也不要让一页假装自己不存在。
   */
  if (body.children.length === 0) {
    body.appendChild(
      h(
        'div',
        { class: 'notice warn' },
        h('div', {}, `「${SECTION_LABELS[section] ?? section}」这一节渲染完是空的。`),
        h('div', { class: 'muted' }, '这是个 bug（不是没配置）。请把这句话反馈给开发者。')
      )
    );
  }
}

function card(title: string, ...children: (Node | string | null)[]): HTMLElement {
  return h('section', { class: 'card' }, h('h3', { class: 'card-title' }, title), ...children);
}

function fieldRow(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    'div',
    { class: 'setting' },
    h('div', { class: 'setting-label' }, label),
    h('div', { class: 'setting-control' }, control),
    hint ? h('div', { class: 'setting-hint muted' }, hint) : null
  );
}

/**
 * 存一项设置。
 *
 * **只传变了的那一个字段**，别把整组展开发上去。
 *
 * 这里踩过一次，而且很难发现：渲染时把 `settings.generation` 抓在闭包里，
 * 每个控件 onchange 都发 `{ ...g, 我这一项: 新值 }`。而 `g` 是渲染那一刻的
 * 快照 —— 改设置不触发重画，它永远不会更新。于是：
 *
 *   用户关掉「自动写回」→ 存下 false
 *   用户接着改「图层命名模板」→ 整组里 autoWriteback 还是旧的 true
 *   → 自动写回自己开回去了，而界面上那个开关还显示着"关"
 *
 * 下一次生成，图就自己进了他的文档 —— 他明明关过。
 *
 * Helper 按分组浅合并，所以逐字段发是安全的，也是唯一正确的做法。
 */
async function patch(patchObj: SettingsPatch): Promise<void> {
  try {
    const next = await api.patchSettings(patchObj);
    setState({ settings: next });
  } catch (e) {
    /*
     * 存不上必须说，而且要让界面退回真实状态。
     *
     * 原来这里一个 try 都没有：Helper 掉线、鉴权过期、参数被拒 ——
     * 请求失败的 promise 直接变成一条没人接的 rejection，
     * 用户什么都看不到，而那个控件还显示着他刚改的值。
     * 他会以为存上了，然后对着一个**根本没生效**的设置继续用，
     * 直到某天行为不对再回来找半天。
     *
     * 重画那一下也是必须的：光弹个提示、控件还停在假的新值上，
     * 等于让界面继续骗人。重画会从 Helper 重新拉一份，
     * 界面回到真正存着的样子。
     */
    const msg = e instanceof ApiError ? e.display : e instanceof Error ? e.message : String(e);
    toast('设置没保存上', msg, 'error');
    await refreshFromHelper();
  }
}

/**
 * 丢掉本地那份、从 Helper 重新拉一份，然后重画当前分节。
 *
 * 存失败之后必须走一趟：本地 store 里那份可能已经被别的成功修改
 * 更新过，不能拿它当真 —— 要看的是 Helper 上真正存着的东西。
 */
async function refreshFromHelper(): Promise<void> {
  try {
    const fresh = await api.settings();
    setState({ settings: fresh });
  } catch {
    // 连读都读不回来（Helper 掉线）——那就别再动界面了，
    // 上面那条错误提示已经把情况说清楚了。
    return;
  }
  if (currentHost) await renderSettingsPage(currentHost);
}

/* ---------------- 本地 ---------------- */

async function renderLocal(host: HTMLElement, settings: AppSettings): Promise<void> {
  const modeSeg = h('div', { class: 'segmented' });
  for (const m of COMFY_MODES) {
    modeSeg.appendChild(
      h(
        'button',
        {
          class: `seg ${settings.comfy.mode === m ? 'active' : ''}`,
          type: 'button',
          title: COMFY_MODE_HINTS[m],
          onclick: async () => {
            await patch({ comfy: { mode: m as ComfyMode } });
            await renderSettingsPage(host.parentElement as HTMLElement);
          }
        },
        COMFY_MODE_LABELS[m]
      )
    );
  }

  const urlInput = h('input', {
    class: 'input',
    type: 'text',
    value: settings.comfy.baseUrl,
    onchange: async (e: Event) => {
      await patch({ comfy: { baseUrl: (e.target as HTMLInputElement).value.trim() } });
      toast('地址已保存');
    }
  });

  const result = h('div', { class: 'test-result muted' }, COMFY_MODE_HINTS[settings.comfy.mode]);
  const testBtn = h(
    'button',
    {
      class: 'btn-primary',
      type: 'button',
      onclick: async () => {
        clear(result);
        result.className = 'test-result muted';
        result.textContent = '正在测试…';
        try {
          const res = await api.testProvider('comfyui');
          result.className = `test-result ${res.result.ok ? 'ok' : 'err'}`;
          result.textContent = res.result.detail;
        } catch (e) {
          result.className = 'test-result err';
          result.textContent = e instanceof ApiError ? e.display : String(e);
        }
      }
    },
    '测试连接'
  );

  const items: HTMLElement[] = [fieldRow('模式', modeSeg, COMFY_MODE_HINTS[settings.comfy.mode]), fieldRow('地址', urlInput)];

  if (settings.comfy.mode === 'localServer') {
    items.push(
      fieldRow(
        '启动命令',
        h('input', {
          class: 'input',
          type: 'text',
          value: settings.comfy.serverCommand,
          placeholder: '例如 python main.py',
          onchange: async (e: Event) =>
            patch({ comfy: { serverCommand: (e.target as HTMLInputElement).value } })
        }),
        'Helper 会用它拉起 ComfyUI 进程'
      )
    );
    items.push(
      fieldRow(
        '工作目录',
        h('input', {
          class: 'input',
          type: 'text',
          value: settings.comfy.serverWorkingDir,
          onchange: async (e: Event) =>
            patch({ comfy: { serverWorkingDir: (e.target as HTMLInputElement).value } })
        })
      )
    );
  }

  items.push(
    fieldRow(
      '连接超时',
      h('input', {
        class: 'input',
        type: 'text',
        value: String(settings.comfy.timeoutMs),
        onchange: async (e: Event) => {
          const n = Number((e.target as HTMLInputElement).value.replace(/[^0-9]/g, '')) || 15000;
          await patch({ comfy: { timeoutMs: n } });
        }
      }),
      '毫秒'
    )
  );

  /*
   * 「独占实例」。
   *
   * 唯一的作用是：允许取消**已经在执行**的任务。
   * ComfyUI 的中断接口（/interrupt）是全局的 —— 它掐掉的是这台机器当前
   * 正在跑的那一个，而不是我们指定的那一个。所以没有这个声明，
   * 我们只敢取消还在排队的；一旦开跑就只能等它完。
   *
   * 不能靠"先查队列确认正在跑的就是这条"来代替：查完到发出去之间
   * ComfyUI 完全可能已经切到下一个任务了，那一刀就砍在别人身上，
   * 而且不会有任何地方报错。这种事只能由知道情况的人来担保。
   */
  const exclusiveBox = h('input', {
    type: 'checkbox',
    class: 'checkbox',
    onchange: async (e: Event) => {
      await patch({ comfy: { exclusive: (e.target as HTMLInputElement).checked } });
    }
  }) as HTMLInputElement;
  exclusiveBox.checked = settings.comfy.exclusive === true;
  items.push(
    fieldRow(
      '独占实例',
      h('label', { class: 'checkline' }, exclusiveBox, '这台 ComfyUI 只跑本插件的任务'),
      '勾选后才能取消已经在执行的任务：ComfyUI 的中断接口是全局的，共用时会打断别人正在跑的活'
    )
  );

  host.appendChild(card('ComfyUI 连接', ...items, h('div', { class: 'row gap' }, testBtn), result));
}

/* ---------------- 云端 ---------------- */

/**
 * 「云端」分组：所有工作流型云平台，用的是**和别处一样的** Provider 卡片。
 *
 * 这里以前是一张手写死的 RunningHub 卡片 —— 自己的 Key 输入框、自己的验证按钮、
 * 自己的工作流 ID 字段，和「推荐平台」里那套通用卡片完全是两套代码。
 * 于是 RunningHub 和别的平台在产品上就长得不一样：改一处要改两遍，
 * 而第二个工作流平台（LiblibAI）进来时只能再手写第三套。
 *
 * 现在按能力筛出工作流型平台，交给同一个 providerCard 渲染。
 * RunningHub 和 LiblibAI 从此是两个可互换的云端算力提供方，
 * 而不是两套互不相干的集成。
 */
async function renderCloud(host: HTMLElement, _settings: AppSettings): Promise<void> {
  const providers = await api.providers();
  const cloudWorkflow = providers.filter((p) => p.capabilities.includes('workflow') && p.kind !== 'comfyui');

  if (cloudWorkflow.length === 0) {
    host.appendChild(card('云端算力', h('p', { class: 'muted' }, '没有可用的云端工作流平台。')));
    return;
  }

  host.appendChild(
    card(
      '云端算力',
      h('p', { class: 'muted' }, '把 ComfyUI 工作流放到云端跑，不占用本机显卡。工作流 ID 从各平台网站上你自己的应用页面复制。'),
      ...cloudWorkflow.map((p) => providerCard(p, host))
    )
  );

  // 取消能力是产品语义，不是实现细节 —— 会产生费用，必须在配置的地方就说清楚
  const noCancel = cloudWorkflow.filter((p) => p.cancelSupport === 'none').map((p) => p.label);
  if (noCancel.length > 0) {
    host.appendChild(
      h('div', { class: 'notice' }, `${noCancel.join(' / ')} 没有提供取消接口。任务提交后无法中止，取消只会让本地丢弃结果，费用仍会产生。`)
    );
  }
}

/* ---------------- 固定功能绑定 ---------------- */

async function renderBindings(host: HTMLElement): Promise<void> {
  const [{ features }, workflows, providers] = await Promise.all([api.features(), api.workflows(), api.providers()]);
  setState({ features });

  const table = h('div', { class: 'bindings' });
  const head = h(
    'div',
    { class: 'binding-row binding-head' },
    h('span', {}, '功能'),
    h('span', {}, '执行后端'),
    h('span', {}, '工作流 / 模型'),
    h('span', {}, '状态'),
    h('span', {}, '')
  );
  table.appendChild(head);

  /*
   * 每一行的控件**按需构建**。
   *
   * 全部一次性建出来的话：13 个功能 ×（后端下拉 + 工作流下拉 3~13 项
   * + RunningHub 预设下拉 13 项）≈ 几百个节点，而且都是 <select>。
   * 真机上滚动这一页会出现重绘残留 —— 行与行叠在一起、左右两列显示的
   * 是不同滚动位置的内容。那是渲染器跟不上，不是布局算错，
   * CSS 治不了，只能把要画的东西减下来。
   *
   * 现在每行先只有一句摘要，点「编辑」才把那一行的下拉建出来。
   * 同一时刻通常只有一行是展开的。
   */
  const buildControls = (f: FeatureView): HTMLElement => {
    const providerSelect = h('select', {
      class: 'input select',
      onchange: async (e: Event) => {
        await api.setBinding(f.id, { providerId: (e.target as HTMLSelectElement).value });
        await renderSettingsPage(host.parentElement as HTMLElement);
      }
    }) as HTMLSelectElement;

    /**
     * 这个功能能挂在哪些 Provider 上 —— 按**能力**筛，不按 id。
     *
     * 以前写死成 `p.id === 'comfyui' || p.id === 'runninghub'`，
     * 于是每加一个云端平台就要回来改这一行；漏改的话新平台配好了也选不着，
     * 用户会以为是没配对。
     *
     * 现在：工作流类功能要 'workflow' 能力，闭源模型类功能要出图能力。
     * LiblibAI 两种能力都有，所以两边都能选到 —— 这正是它和 RunningHub
     * 的差别所在，靠能力表达出来，不用在 UI 里特判。
     */
    const candidates =
      f.branch === 'comfyui'
        ? providers.filter((p) => p.capabilities.includes('workflow'))
        : providers.filter((p) => p.capabilities.includes('textToImage') || p.capabilities.includes('imageToImage'));
    for (const p of candidates) {
      const opt = h('option', { value: p.id }, p.label + (p.configured ? '' : '（未配置）')) as HTMLOptionElement;
      if (p.id === f.providerId) opt.setAttribute('selected', '');
      providerSelect.appendChild(opt);
    }

    let detailControl: HTMLElement;
    if (f.branch === 'comfyui' && f.providerId === 'comfyui') {
      const wfSelect = h('select', {
        class: 'input select',
        onchange: async (e: Event) => {
          await api.setBinding(f.id, { workflowId: (e.target as HTMLSelectElement).value });
          toast('绑定已更新', f.label);
          await renderSettingsPage(host.parentElement as HTMLElement);
        }
      }) as HTMLSelectElement;
      // 本机 ComfyUI 只能跑本机的图。云端条目在这个下拉里出现的话，
      // 选中后提交会被 ComfyUI 直接拒 —— 它拿到的是一份空图。
      for (const w of workflows.filter((x) => x.kind !== 'cloud')) {
        const opt = h('option', { value: w.id }, `${w.name} v${w.version}${w.source === 'builtin' ? '（内置）' : ''}`) as HTMLOptionElement;
        if (w.id === f.workflowId) opt.setAttribute('selected', '');
        wfSelect.appendChild(opt);
      }
      detailControl = wfSelect;
    } else if (f.providerId === 'runninghub') {
      detailControl = renderRunningHubPicker(f, workflows);
    } else {
      detailControl = h('input', {
        class: 'input',
        type: 'text',
        placeholder: '模型名（留空用默认）',
        value: f.binding?.model ?? '',
        onchange: async (e: Event) => {
          await api.setBinding(f.id, { model: (e.target as HTMLInputElement).value.trim() });
        }
      });
    }

    const status = f.ready
      ? h('span', { class: 'ok' }, '✅ 就绪')
      : h('span', { class: 'warn', title: f.reason ?? '' }, `⚠ ${f.reason ?? '未配置'}`);

    const actions = h('div', { class: 'row gap' });
    if (f.branch === 'comfyui' && f.workflowId) {
      actions.appendChild(
        h(
          'button',
          {
            class: 'btn-ghost',
            type: 'button',
            title: '对着当前 ComfyUI 检查节点与模型是否齐全',
            onclick: async () => {
              try {
                const rep = await api.dependencies(f.workflowId!);
                if (rep.ok) toast('依赖齐全', `${f.label} 可以直接用`);
                else
                  toast(
                    '缺少依赖',
                    `缺节点 ${rep.missingNodes.join(', ') || '无'}；缺模型 ${rep.missingModels.map((m) => m.name).join(', ') || '无'}`,
                    'warn'
                  );
              } catch (e) {
                toast('依赖检查失败', e instanceof ApiError ? e.display : String(e), 'error');
              }
            }
          },
          '依赖检查'
        )
      );
    }
    actions.appendChild(
      h(
        'button',
        {
          class: 'btn-ghost',
          type: 'button',
          onclick: async () => {
            await api.resetBinding(f.id);
            toast('已恢复出厂绑定', f.label);
            await renderSettingsPage(host.parentElement as HTMLElement);
          }
        },
        '恢复默认'
      )
    );

    return h('div', { class: 'binding-edit' }, providerSelect, detailControl, actions);
  };

  for (const f of features) {
    if (f.id === 'comfy.custom') continue;

    const status = f.ready
      ? h('span', { class: 'ok' }, '✅ 就绪')
      : h('span', { class: 'warn', title: f.reason ?? '' }, `⚠ ${f.reason ?? '未配置'}`);

    const slot = h('div', { class: 'binding-slot hidden' });
    let built = false;

    const editBtn = h(
      'button',
      {
        class: 'btn-ghost',
        type: 'button',
        onclick: () => {
          if (!built) {
            slot.appendChild(buildControls(f));
            built = true;
          }
          const nowHidden = slot.classList.contains('hidden');
          toggleClass(slot, 'hidden', !nowHidden);
          editBtn.textContent = nowHidden ? '收起' : '编辑';
        }
      },
      '编辑'
    );

    table.appendChild(
      h(
        'div',
        { class: 'binding-row' },
        h('span', { class: 'binding-feature' }, breadcrumb(f.id).slice(1).join(' / ')),
        h('span', { class: 'binding-sum muted' }, bindingSummary(f, workflows)),
        status,
        editBtn,
        slot
      )
    );
  }

  host.appendChild(card('固定功能 ↔ 工作流绑定', table));
}

/* ---------------- 工作流 ---------------- */

/**
 * 括号有没有配平（字符串内部的括号不算）。
 *
 * 只用来判断「是不是粘了半截」，所以不追求是个完整的 JSON 校验器：
 * 深度收不回 0 就说明后半截没了。字符串状态和转义要处理 —— ComfyUI 的
 * 提示词里出现 `{` `}` 很常见（权重语法），不排除的话正常的图会被误判成截断。
 */
function unbalanced(text: string): boolean {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (const ch of text) {
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return depth > 0 || inStr;
}

/** Provider id → 中文名。认不出来就原样显示 id，总比显示 undefined 强。 */
function providerLabel(id: string | null): string {
  if (!id) return '未知平台';
  return findProvider(id)?.label ?? id;
}

/**
 * 把用户粘进文本框的东西解析成一份工作流图。
 *
 * 原来这里是裸的 `JSON.parse(jsonArea.value)`。文本框空着时它抛的是
 * `Unexpected end of JSON input` —— 一句 V8 的英文内部错误，直接被当成
 * 「导入失败」的副标题显示出来。用户看到的是插件坏了，而不是「你还没粘东西」。
 * 扫描按钮同一个毛病。
 *
 * 所以这里把几种真实会发生的情况分开说清楚，而不是把异常原样端上去：
 *   什么都没粘 · 粘的是网页而不是 JSON · 粘到一半被截断 · 顶层不是对象
 *
 * 顺手容错两种常见的粘贴污染：BOM，以及从聊天窗口复制时带出来的 ``` 围栏。
 * 这两个都会让 JSON.parse 失败，但用户看着自己粘的内容是对的，很难自查。
 */
export function parseGraphInput(raw: string): unknown {
  let text = raw.replace(/^﻿/, '').trim();
  if (!text) throw new Error('请先把 ComfyUI 导出的 JSON 粘贴到下面的框里。');

  // ```json … ``` 围栏
  const fenced = /^```[a-zA-Z]*\s*\r?\n([\s\S]*?)\r?\n?```$/.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  if (text.startsWith('<')) {
    throw new Error('粘进来的是网页内容，不是 JSON。请在 ComfyUI 里用「导出(API)」保存成文件，再把文件内容粘过来。');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    /*
     * 「粘贴时被截断」是这里最常见的失败，值得单独说 —— 用户会以为
     * 自己粘的是完整的，只有点破了才会回去重新复制。
     *
     * 不能靠匹配 V8 的错误文案来判断：断在 token 中间（`"seed": 12`）时
     * 它报的是 "Expected ',' or '}'"，只有断在结构边界才报 "Unexpected end"。
     * 所以直接数括号 —— 没配平就是缺了后半截，这个判据跟引擎的措辞无关。
     */
    if (unbalanced(text)) {
      throw new Error(
        `JSON 不完整，像是粘贴时被截断了（当前 ${text.length} 个字符）。ComfyUI 导出的图通常有几十 KB，检查一下是不是只粘进来一部分。`
      );
    }
    throw new Error(`这段文本不是合法的 JSON：${msg}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('这不是一份工作流：顶层应该是一个对象。ComfyUI 的「导出(API)」格式是 { 节点 id: {…} }。');
  }
  if (Object.keys(parsed as object).length === 0) {
    throw new Error('这份 JSON 是空的，里面没有任何节点。');
  }
  return parsed;
}

async function renderWorkflows(host: HTMLElement): Promise<void> {
  const workflows = await api.workflows();
  setState({ workflows });

  const list = h('div', { class: 'wf-list' });
  for (const w of workflows) list.appendChild(workflowRow(w, host));

  const importBox = h('div', { class: 'wf-import' });
  const nameInput = h('input', { class: 'input', type: 'text', placeholder: '工作流名称' }) as HTMLInputElement;
  const jsonArea = h('textarea', {
    class: 'input textarea json-area',
    rows: '14',
    placeholder: '把 ComfyUI 导出的 JSON 粘贴到这里（推荐用「导出(API)」格式），或者用下面的「选择 JSON 文件」'
  }) as HTMLTextAreaElement;
  const scanOut = h('div', { class: 'muted' });

  /*
   * 字符数。
   *
   * 用户反馈"粘贴不进全部字符"。粘贴到底进去了多少，光看一个高度固定的
   * 文本框是判断不出来的 —— 它只显示末尾几行，看起来永远像是"只有这些"。
   * 报出字符数，用户拿它跟源文件一比就知道全没全。
   */
  const sizeOut = h('div', { class: 'muted hint' });
  const showSize = (): void => {
    const n = jsonArea.value.length;
    sizeOut.textContent = n ? `当前 ${n.toLocaleString()} 个字符` : '';
  };
  jsonArea.oninput = showSize;

  const fileBtn = h(
    'button',
    {
      class: 'btn-ghost',
      type: 'button',
      onclick: async () => {
        try {
          const picked = await bridge.pickJsonFile();
          if (!picked) return; // 用户取消了
          jsonArea.value = picked.text;
          showSize();
          // 文件名去掉扩展名当默认名字，省一次手打
          if (!nameInput.value.trim()) nameInput.value = picked.name.replace(/\.json$/i, '');
          scanOut.className = 'ok';
          scanOut.textContent = `已读入 ${picked.name}（${picked.text.length.toLocaleString()} 个字符）`;
        } catch (e) {
          scanOut.className = 'err';
          scanOut.textContent = `读文件失败：${e instanceof Error ? e.message : String(e)}`;
        }
      }
    },
    '选择 JSON 文件'
  );

  const scanBtn = h(
    'button',
    {
      class: 'btn-ghost',
      type: 'button',
      onclick: async () => {
        scanOut.className = 'muted';
        scanOut.textContent = '正在扫描…';
        try {
          const scan = await api.scanWorkflow(parseGraphInput(jsonArea.value));
          const semantics = scan.fields.filter((f) => f.semantic).map((f) => f.semantic);
          scanOut.className = 'ok';
          scanOut.textContent = `格式 ${scan.format} · ${scan.nodeCount} 节点 · 输出节点 ${scan.outputNodeIds.join(',')} · 识别出 ${new Set(semantics).size} 类可绑定字段`;
        } catch (e) {
          scanOut.className = 'err';
          scanOut.textContent = e instanceof ApiError ? e.display : e instanceof Error ? e.message : String(e);
        }
      }
    },
    '扫描'
  );

  const importBtn = h(
    'button',
    {
      class: 'btn-primary',
      type: 'button',
      onclick: async () => {
        if (!nameInput.value.trim()) {
          toast('请先填写名称', '', 'warn');
          return;
        }
        try {
          const res = await api.importWorkflow(parseGraphInput(jsonArea.value), nameInput.value.trim());
          toast(res.versionBumped ? `已导入为 v${res.workflow.version}` : '已导入', res.workflow.name);
          jsonArea.value = '';
          nameInput.value = '';
          await renderSettingsPage(host.parentElement as HTMLElement);
        } catch (e) {
          toast('导入失败', e instanceof ApiError ? e.display : e instanceof Error ? e.message : String(e), 'error');
        }
      }
    },
    '导入'
  );

  importBox.appendChild(fieldRow('名称', nameInput));
  importBox.appendChild(fieldRow('JSON', jsonArea));
  importBox.appendChild(sizeOut);
  importBox.appendChild(h('div', { class: 'row gap' }, fileBtn, scanBtn, importBtn));
  importBox.appendChild(scanOut);

  host.appendChild(card(`工作流（${workflows.length}）`, list));
  host.appendChild(card('导入 ComfyUI 工作流（本机）', importBox));
  host.appendChild(card('添加云端工作流', await cloudWorkflowBox(host)));
}

/**
 * 「添加云端工作流」表单。
 *
 * 为什么需要它：以前云端工作流 ID 只能在两个地方手打 —— Provider 卡片上的
 * 「默认工作流 ID」，和某个功能绑定里的「自定义工作流 ID…」。打完不留痕，
 * 换个功能要再打一遍 19 位数字，也没有任何地方能看到「我一共加过哪些」。
 *
 * 登记之后，这条会和本机工作流并排出现在上面的列表里（带「云端」徽章），
 * 并且出现在「固定功能」的下拉里 —— 用户不用再记 ID。
 *
 * 这里**不**做联网验证：登记和验证是两件事。断网、平台抽风、key 还没填，
 * 任何一个都不该挡着用户先把 ID 记下来。验证在列表行上单独做。
 */
async function cloudWorkflowBox(host: HTMLElement): Promise<HTMLElement> {
  const box = h('div', { class: 'wf-import' });

  // 只列以工作流为单位的云端平台。ComfyUI 是本机跑的，不在此列；
  // 以模型为单位的平台（Comfly 之类）也没有「工作流 ID」这个概念。
  const providers = (await api.providers()).filter((p) => p.capabilities.includes('workflow') && p.kind !== 'comfyui');

  if (!providers.length) {
    box.appendChild(h('div', { class: 'muted' }, '还没有以工作流为单位的云端平台。先在「推荐平台」里启用 RunningHub 或 LiblibAI。'));
    return box;
  }

  const nameInput = h('input', { class: 'input', type: 'text', placeholder: '给它起个名字，比如「老照片修复」' }) as HTMLInputElement;
  const providerSelect = h('select', { class: 'input select' }) as HTMLSelectElement;
  for (const p of providers) providerSelect.appendChild(h('option', { value: p.id }, p.label));
  const idInput = h('input', { class: 'input', type: 'text', placeholder: '平台上的工作流 / webapp ID' }) as HTMLInputElement;
  const out = h('div', { class: 'muted' });

  /*
   * RunningHub 上「ComfyUI 工作流」和「AI 应用」是两种不同的东西，
   * 接口也完全不同。实测拿 AI 应用的 ID 去打工作流接口，回的是
   * 380 WORKFLOW_NOT_EXISTS —— 工作流接口根本不认识它。
   *
   * 所以登记时必须问清是哪一类，否则提交时才发现发错了地方，
   * 而那时候报出来的错会指向"没有参数绑定"这种完全不相干的原因。
   */
  const kindSelect = h('select', { class: 'input select' }) as HTMLSelectElement;
  kindSelect.appendChild(h('option', { value: 'workflow' }, 'ComfyUI 工作流（地址里带 /workflow/）'));
  kindSelect.appendChild(h('option', { value: 'aiApp' }, 'AI 应用（地址里带 /ai-detail/）'));

  const nodeInfoArea = h('textarea', {
    class: 'input textarea json-area',
    rows: '10',
    placeholder: '把应用 API 页面上「提交请求 → 请求示例」那段 curl 整个粘贴到这里'
  }) as HTMLTextAreaElement;
  const nodeInfoRow = fieldRow(
    '请求示例',
    nodeInfoArea,
    'AI 应用的节点号没有任何接口能查到，只能从平台的 API 页面复制过来 —— 少了它，提交会拿作者的示例图出图，结果和你的输入无关。'
  );
  const kindHint = h('div', { class: 'muted hint' });

  const paintKind = (): void => {
    const isApp = kindSelect.value === 'aiApp';
    toggleClass(nodeInfoRow, 'hidden', !isApp);
    clear(kindHint);
    kindHint.textContent = isApp
      ? '在应用页点右上角「API」进到接口页，那里有这段 curl。'
      : '工作流要先在 RunningHub 上保存并成功跑过一次，平台才会给出它的接口格式；否则登记后提交会报「尚未保存或未运行」。';
  };
  kindSelect.onchange = paintKind;

  const addBtn = h(
    'button',
    {
      class: 'btn-primary',
      type: 'button',
      onclick: async () => {
        out.className = 'muted';
        out.textContent = '';
        try {
          const res = await api.addCloudWorkflow({
            name: nameInput.value.trim(),
            providerId: providerSelect.value,
            remoteId: idInput.value.trim(),
            remoteKind: kindSelect.value as 'workflow' | 'aiApp',
            ...(kindSelect.value === 'aiApp' ? { nodeInfoRaw: nodeInfoArea.value } : {})
          });
          toast(res.versionBumped ? `已登记为 v${res.workflow.version}` : '已登记', res.workflow.name);
          nameInput.value = '';
          idInput.value = '';
          nodeInfoArea.value = '';
          await renderSettingsPage(host.parentElement as HTMLElement);
        } catch (e) {
          out.className = 'err';
          out.textContent = e instanceof ApiError ? e.display : e instanceof Error ? e.message : String(e);
        }
      }
    },
    '登记'
  );

  box.appendChild(fieldRow('名称', nameInput));
  box.appendChild(fieldRow('平台', providerSelect));
  box.appendChild(fieldRow('类型', kindSelect));
  box.appendChild(kindHint);
  box.appendChild(fieldRow('ID', idInput, '在平台页面的地址栏里，末尾那串 19 位数字。'));
  box.appendChild(nodeInfoRow);
  box.appendChild(h('div', { class: 'row gap' }, addBtn));
  box.appendChild(out);
  box.appendChild(
    h(
      'div',
      { class: 'muted hint' },
      '登记不会联网检查。登记完这条就会出现在上面的列表里，也能在「固定功能」和「自定义工作流」的下拉里选到。'
    )
  );
  paintKind();
  return box;
}

function workflowRow(w: WorkflowSummary, host: HTMLElement): HTMLElement {
  const actions = h('div', { class: 'row gap' });
  /*
   * 云端工作流跑在平台上：本机没有图，节点和模型也都在那边。
   * 「依赖检查」和「参数绑定」这两件事对它没有意义 —— 摆一个点下去
   * 必然报错的按钮，等于让用户去撞一堵墙。所以只给本机图。
   */
  const isCloud = w.kind === 'cloud';
  if (!isCloud)
    actions.appendChild(
      h(
        'button',
        {
          class: 'btn-ghost',
          type: 'button',
          onclick: async () => {
            try {
              const rep = await api.dependencies(w.id);
              toast(
                rep.ok ? '依赖齐全' : '缺少依赖',
                rep.ok
                  ? w.name
                  : `缺节点 ${rep.missingNodes.join(', ') || '无'}；缺模型 ${rep.missingModels.map((m) => m.name).join(', ') || '无'}`,
                rep.ok ? 'info' : 'warn'
              );
            } catch (e) {
              toast('依赖检查失败', e instanceof ApiError ? e.display : String(e), 'error');
            }
          }
        },
        '依赖检查'
      )
    );
  // 绑定编辑只对导入的工作流开放：内置工作流的绑定是随内置图一起版本化的，
  // 让用户改它等于改出厂配置，出了问题谁也说不清是哪一版的行为。
  const editorHost = h('div', { class: 'wf-bindings-host hidden' });
  if (w.source === 'imported') {
    let loaded = false;
    if (!isCloud)
      actions.appendChild(
        h(
          'button',
          {
            class: 'btn-ghost',
            type: 'button',
            onclick: async (e: Event) => {
              const btn = e.currentTarget as HTMLElement;
              const open = editorHost.classList.contains('hidden');
              toggleClass(editorHost, 'hidden', !open);
              btn.textContent = open ? '收起绑定' : '参数绑定';
              if (open && !loaded) {
                loaded = true;
                clear(editorHost);
                editorHost.appendChild(await renderBindingEditor(w, host));
              }
            }
          },
          '参数绑定'
        )
      );
    actions.appendChild(
      h(
        'button',
        {
          class: 'btn-ghost danger',
          type: 'button',
          onclick: async () => {
            try {
              await api.deleteWorkflow(w.id);
              await renderSettingsPage(host.parentElement as HTMLElement);
            } catch (e) {
              toast('删除失败', e instanceof ApiError ? e.display : String(e), 'error');
            }
          }
        },
        '删除'
      )
    );
  }

  return h(
    'div',
    { class: 'wf-row' },
    h(
      'div',
      { class: 'wf-meta' },
      h(
        'div',
        { class: 'wf-name' },
        // 徽章放在名字最前面：一眼分清这条是跑在本机还是跑在平台上。
        // 这是用户提的第一个问题 ——「怎么区分新添加的是本地还是云端的」。
        h('span', { class: isCloud ? 'wf-tag cloud' : 'wf-tag local' }, isCloud ? '云端' : '本机'),
        ` ${w.name} `,
        h('span', { class: 'muted' }, `v${w.version}`)
      ),
      h(
        'div',
        { class: 'muted wf-sub' },
        isCloud
          ? // 云端条目没有节点数和绑定数可言，显示 0 只会让人以为导入失败了。
            // 真正该给的信息是：跑在哪个平台、平台上的哪个 ID。
            `${providerLabel(w.providerId)} · ID ${w.remoteId ?? '—'}`
          : `${w.source === 'builtin' ? '内置' : '导入'} · ${w.nodeCount} 节点 · ${w.bindingCount} 条绑定` +
            (w.featureId ? ` · 绑定 ${breadcrumb(w.featureId).slice(1).join('/')}` : '')
      ),
      w.notes ? h('div', { class: 'muted wf-notes' }, w.notes) : null
    ),
    actions,
    editorHost
  );
}

/* ---------------- 推荐平台 ---------------- */

async function renderPlatforms(host: HTMLElement): Promise<void> {
  const providers = await api.providers();
  const recommended = providers.filter((p) => p.recommended);
  const others = providers.filter((p) => !p.recommended && p.kind !== 'comfyui');

  host.appendChild(card('推荐平台', ...recommended.map((p) => providerCard(p, host))));
  host.appendChild(card('其他', ...others.map((p) => providerCard(p, host))));
}

function providerCard(p: ProviderView, host: HTMLElement): HTMLElement {
  /**
   * 凭据字段：**全部**渲染，不是只渲染第一个。
   *
   * 以前这里是 `credentialFields.find(f => f.secret)` —— 只取第一个密文字段。
   * 单密钥的平台没问题，但 LiblibAI 要 AccessKey + SecretKey 两段，
   * 少了 SecretKey 就签不出名字。只渲染一个的话，用户填完保存、验证失败，
   * 而界面上根本没有第二个输入框可填 —— 他会以为是 Key 给错了。
   * 注册表里本来就是数组，把它当数组用。
   */
  const credInputs = p.credentialFields.map((f) => ({
    field: f,
    input: h('input', {
      class: 'input',
      type: f.secret ? 'password' : 'text',
      placeholder: f.masked ?? f.placeholder
    }) as HTMLInputElement
  }));
  const hasCreds = credInputs.length > 0;

  /**
   * 默认工作流 ID。
   *
   * 和「默认模型」是一对：以模型为单位的平台用后者，以工作流为单位的平台用前者。
   * 以前 RunningHub 的这个字段单独长在设置页的「云端」分组里，是一张手写的卡片；
   * 现在它就是 Provider 卡片上的一行，RunningHub 和 LiblibAI 走同一套。
   */
  const workflowInput = h('input', {
    class: 'input',
    type: 'text',
    value: p.defaultWorkflowId ?? '',
    placeholder: '云端工作流 / 应用 ID',
    onchange: async (e: Event) => {
      await api.patchProvider(p.id, { defaultWorkflowId: (e.target as HTMLInputElement).value.trim() });
      toast('已保存', `${p.label} 默认工作流`);
    }
  }) as HTMLInputElement;

  const urlInput = h('input', {
    class: 'input',
    type: 'text',
    value: p.baseUrl,
    onchange: async (e: Event) => {
      await api.patchProvider(p.id, { baseUrl: (e.target as HTMLInputElement).value.trim() });
      toast('地址已保存', p.label);
    }
  });

  const modelSelect = h('select', {
    class: 'input select',
    onchange: async (e: Event) => {
      await api.patchProvider(p.id, { defaultModel: (e.target as HTMLSelectElement).value });
    }
  }) as HTMLSelectElement;
  /**
   * 把模型列表填进下拉，并把当前配置的那个标成选中。
   *
   * 以前这里只塞一个「（尚未拉取模型）」占位，拉取之后也不标选中 ——
   * 于是用户配过的模型在界面上根本看不出来，只能凭记忆。
   */
  const fillModels = (models: readonly string[]): void => {
    clear(modelSelect);
    const cur = p.defaultModel ?? '';
    const placeholder = h('option', { value: '' }, models.length ? '（使用该平台的默认模型）' : '（尚未拉取模型）');
    if (!cur) placeholder.setAttribute('selected', '');
    modelSelect.appendChild(placeholder);
    // 已配置的模型即使不在列表里也要列出来，否则显示成"没配过"就更误导了
    const all = cur && !models.includes(cur) ? [cur, ...models] : models;
    for (const m of all) {
      const opt = h('option', { value: m }, m) as HTMLOptionElement;
      if (m === cur) opt.setAttribute('selected', '');
      modelSelect.appendChild(opt);
    }
  };
  fillModels(p.models ?? []);

  const result = h('div', { class: `test-result ${p.configured ? '' : 'muted'}` }, p.configured ? (p.reason ?? '已配置') : (p.reason ?? '未配置'));

  const enableToggle = h(
    'button',
    {
      class: `switch ${p.enabled ? 'on' : ''}`,
      type: 'button',
      role: 'switch',
      'aria-checked': String(p.enabled),
      onclick: async (e: Event) => {
        const next = !(e.currentTarget as HTMLElement).classList.contains('on');
        await api.patchProvider(p.id, { enabled: next });
        toggleClass(e.currentTarget as HTMLElement, 'on', next);
      }
    },
    // 滑块必须是**真实子元素**，不能靠 ::after —— 见 app.css 里的说明
    h('span', { class: 'switch-knob' })
  );

  const actions = h('div', { class: 'row gap' });

  if (hasCreds) {
    actions.appendChild(
      h(
        'button',
        {
          class: 'btn-primary',
          type: 'button',
          onclick: async () => {
            // 必填项一个都不能少。LiblibAI 这种两段式密钥，只填一半保存下去
            // 会得到一个"已配置但永远验证失败"的状态 —— 最难自查的一种。
            const missing = credInputs.filter((c) => c.field.required && !c.input.value.trim() && !c.field.masked);
            if (missing.length > 0) {
              toast('还有必填项没填', missing.map((m) => m.field.label).join('、'), 'warn');
              return;
            }
            const payload: Record<string, string> = {};
            for (const c of credInputs) {
              const v = c.input.value.trim();
              // 空着的字段不提交：用户只想改其中一个时，另一个保持原样，
              // 而不是被一个空串覆盖掉。
              if (v) payload[c.field.key] = v;
            }
            if (Object.keys(payload).length === 0) {
              toast('没有要保存的内容', '所有字段都是空的', 'warn');
              return;
            }
            try {
              // Helper 存完密钥会顺手拉一次模型，这里直接把结果报出来 ——
              // 「配好接口就该知道有哪些模型可用」是这一步的题中之义，
              // 不该让用户再想起来去点一次「拉取模型」。
              const res = await api.setCredentials(p.id, payload);
              for (const c of credInputs) c.input.value = '';
              if (res.modelsError) {
                // 密钥是存住了的。这里说成"保存失败"会让用户把 Key 重填一遍，
                // 而真正的问题在网络或平台那边。
                toast('Key 已保存，但没拉到模型', res.modelsError, 'warn');
              } else {
                toast('已保存', `${p.label} 的 Key 只存在本机 Helper · 已拉到 ${res.models.length} 个认可生图模型（平台共 ${res.total} 个）`);
              }
              await renderSettingsPage(host.parentElement as HTMLElement);
            } catch (e) {
              toast('保存失败', e instanceof ApiError ? e.display : String(e), 'error');
            }
          }
        },
        '保存 Key'
      )
    );
    if (credInputs.some((c) => c.field.masked)) {
      actions.appendChild(
        h(
          'button',
          {
            class: 'btn-ghost danger',
            type: 'button',
            onclick: async () => {
              await api.clearCredentials(p.id);
              await renderSettingsPage(host.parentElement as HTMLElement);
            }
          },
          '清除'
        )
      );
    }
  }

  actions.appendChild(
    h(
      'button',
      {
        class: 'btn-ghost',
        type: 'button',
        onclick: async () => {
          result.className = 'test-result muted';
          result.textContent = '正在验证…';
          try {
            const res = await api.testProvider(p.id);
            result.className = `test-result ${res.result.ok ? 'ok' : 'err'}`;
            result.textContent = res.result.detail;
          } catch (e) {
            result.className = 'test-result err';
            result.textContent = e instanceof ApiError ? e.display : String(e);
          }
        }
      },
      '验证'
    )
  );

  /**
   * 拉模型的两个档位。
   *
   * 默认那个只给出厂认可的生图模型 —— 平台目录动辄几百个，绝大多数拿去生图
   * 一律失败，全塞进下拉等于让用户在里面猜。
   * 「全部」是逃生门：认可名单之外的模型也想试就点它，我们如实标明
   * 这些没验证过。收窄默认口径不等于锁死选择，两者得同时成立。
   */
  const fetchModels = async (scope: 'approved' | 'all', label: string): Promise<void> => {
    result.className = 'test-result muted';
    result.textContent = '正在拉取模型…';
    try {
      const res = await api.listModels(p.id, scope);
      fillModels(res.models);
      result.className = 'test-result ok';
      result.textContent =
        res.scope === 'approved'
          ? `拉到 ${res.models.length} 个认可生图模型（平台共 ${res.total} 个）`
          : res.scope === 'image'
            ? `认可名单一个都没命中，退回列出像生图的 ${res.models.length} 个（平台共 ${res.total} 个），能不能出图要自己试`
            : `${label}：${res.models.length} 个（未经筛选，多数不能生图）`;
    } catch (e) {
      result.className = 'test-result err';
      result.textContent = e instanceof ApiError ? e.display : String(e);
    }
  };

  actions.appendChild(
    h(
      'button',
      { class: 'btn-ghost', type: 'button', onclick: () => void fetchModels('approved', '认可生图模型') },
      '拉取模型'
    )
  );

  actions.appendChild(
    h(
      'button',
      { class: 'btn-ghost', type: 'button', onclick: () => void fetchModels('all', '全部模型') },
      '拉取全部模型'
    )
  );

  if (p.consoleUrl) {
    actions.appendChild(
      h(
        'button',
        {
          class: 'btn-ghost',
          type: 'button',
          onclick: () => openExternal(p.consoleUrl!)
        },
        '前往申请'
      )
    );
  }

  return h(
    'div',
    { class: 'provider' },
    h(
      'div',
      { class: 'provider-head' },
      h('div', {}, h('strong', {}, p.label), h('div', { class: 'muted' }, p.description)),
      enableToggle
    ),
    fieldRow('接口地址', urlInput),
    // 有几个凭据字段就画几行。单密钥平台看起来和以前一模一样，
    // 两段式密钥的平台（LiblibAI）终于有地方填第二段了。
    ...credInputs.map((c) =>
      fieldRow(c.field.label, c.input, c.field.masked ? `当前：${c.field.masked}` : '只保存在本机 Helper')
    ),
    // 工作流型平台（RunningHub / LiblibAI）多一行「默认工作流」。
    // 按**能力**判断而不是按 id —— 这样再来一个工作流平台不用改这里。
    p.capabilities.includes('workflow') && p.kind !== 'comfyui'
      ? fieldRow(
          '默认工作流 ID',
          workflowInput,
          '兜底值：某个功能在「固定功能」里没有单独绑云端工作流时，才用这里的 ID 提交。绑了就用绑的那个。留空也可以 —— 前提是每个功能都各自绑好。'
        )
      : null,
    fieldRow('默认模型', modelSelect),
    actions,
    result,
    p.cancelSupport === 'none' ? h('div', { class: 'muted small' }, '该平台不支持取消已提交的任务') : null,
    // queuedOnly 也得说 —— 用户点了"取消"却没取消掉时，得知道这是已知限制而不是坏了
    p.cancelSupport === 'queuedOnly'
      ? h(
          'div',
          { class: 'muted small' },
          p.id === 'comfyui'
            ? '排队中的任务可以取消；已经在执行的只有在这台 ComfyUI 只跑本插件的任务时才能中断（它的中断接口是全局的）'
            : '排队中的任务可以取消；已经在执行的不保证'
        )
      : null
  );
}

function openExternal(url: string): void {
  try {
    const shell = (globalThis as { require?: (m: string) => { shell?: { openExternal(u: string): void } } }).require?.('uxp')?.shell;
    if (shell) shell.openExternal(url);
    else toast('无法打开链接', url, 'warn');
  } catch {
    toast('无法打开链接', url, 'warn');
  }
}

/* ---------------- 生成默认值 ---------------- */

async function renderDefaults(host: HTMLElement, settings: AppSettings): Promise<void> {
  const g = settings.generation;

  const modeSelect = h('select', {
    class: 'input select',
    onchange: async (e: Event) => patch({ generation: { writebackMode: (e.target as HTMLSelectElement).value as WritebackMode } })
  }) as HTMLSelectElement;
  for (const m of WRITEBACK_MODES) {
    const opt = h('option', { value: m }, WRITEBACK_MODE_LABELS[m]) as HTMLOptionElement;
    if (m === g.writebackMode) opt.setAttribute('selected', '');
    modeSelect.appendChild(opt);
  }

  const items = [
    fieldRow('默认写回方式', modeSelect),
    fieldRow(
      '图层命名模板',
      h('input', {
        class: 'input',
        type: 'text',
        value: g.layerNameTemplate,
        onchange: async (e: Event) => patch({ generation: { layerNameTemplate: (e.target as HTMLInputElement).value } })
      }),
      '支持 {feature} {date} {seed}'
    ),
    fieldRow(
      '自动写回',
      h(
        'button',
        {
          class: `switch ${g.autoWriteback ? 'on' : ''}`,
          type: 'button',
          role: 'switch',
          'aria-checked': String(g.autoWriteback),
          onclick: async (e: Event) => {
            const btn = e.currentTarget as HTMLElement;
            const next = !btn.classList.contains('on');
            toggleClass(btn, 'on', next);
            btn.setAttribute('aria-checked', String(next));
            await patch({ generation: { autoWriteback: next } });
          }
        },
        h('span', { class: 'switch-knob' })
      ),
      '关闭后结果会停在「等待写回」，由你点确认'
    ),
    fieldRow(
      '本地并发上限',
      h('input', {
        class: 'input',
        type: 'text',
        value: String(g.maxConcurrency),
        onchange: async (e: Event) => {
          const n = Math.min(8, Math.max(1, Number((e.target as HTMLInputElement).value.replace(/[^0-9]/g, '')) || 1));
          (e.target as HTMLInputElement).value = String(n);
          await patch({ generation: { maxConcurrency: n } });
        }
      }),
      '本地 ComfyUI 建议保持 1，同一张卡上并行只会更慢'
    )
  ];

  host.appendChild(card('生成默认值', ...items));

  /* 内置提示词 */
  const presets = await api.prompts();
  const list = h('div', { class: 'preset-list' });
  for (const p of presets) {
    // rows 从 3 提到 8：这些提示词本来就是几百字的整段文字，
    // 三行的框里改它等于隔着门缝看，用户反馈过输入区太小。
    const ta = h('textarea', { class: 'input textarea', rows: '8' }) as HTMLTextAreaElement;
    ta.value = p.prompt;
    const row = h(
      'details',
      { class: 'preset-item' },
      h(
        'summary',
        {},
        p.label,
        p.customized ? h('span', { class: 'chip on small' }, '已自定义') : null,
        p.builtin ? null : h('span', { class: 'chip small' }, '自定义')
      ),
      h('div', { class: 'muted' }, p.description),
      ta,
      h(
        'div',
        { class: 'row gap' },
        h(
          'button',
          {
            class: 'btn-ghost',
            type: 'button',
            onclick: async () => {
              await api.updatePrompt(p.id, { prompt: ta.value });
              toast('已保存', p.label);
            }
          },
          '保存'
        ),
        p.builtin
          ? h(
              'button',
              {
                class: 'btn-ghost',
                type: 'button',
                onclick: async () => {
                  await api.updatePrompt(p.id, { restore: true });
                  toast('已恢复出厂文本', p.label);
                  await renderSettingsPage(host.parentElement as HTMLElement);
                }
              },
              '恢复默认'
            )
          : // 出厂预设删不掉（服务端也会拒绝），自己加的才给删除按钮 ——
            // 否则这一页就成了只进不出，加错一条就永远留在列表里。
            h(
              'button',
              {
                class: 'btn-ghost danger',
                type: 'button',
                onclick: async () => {
                  try {
                    await api.deletePrompt(p.id);
                    toast('已删除', p.label);
                    await renderSettingsPage(host.parentElement as HTMLElement);
                  } catch (e) {
                    toast('删除失败', e instanceof ApiError ? e.display : String(e), 'error');
                  }
                }
              },
              '删除'
            )
      )
    );
    list.appendChild(row);
  }
  host.appendChild(card(`提示词（${presets.length}）`, list));
  host.appendChild(card('新增提示词', promptCreateBox(host)));
}

/**
 * 「新增提示词」表单。
 *
 * 后端的 POST /v1/prompts 一直都在，设置页却从来没给过入口 —— 于是这一页
 * 只能改现成的和恢复出厂文本，加不了自己的。用户直接反馈了这件事。
 *
 * scope 先固定为 ['*']（所有功能都能选到）。按功能限定作用域是另一件事，
 * 需要一个功能多选控件，那个值得单独做；现在先让"能加"这条路通。
 */
function promptCreateBox(host: HTMLElement): HTMLElement {
  const box = h('div', { class: 'wf-import' });
  const label = h('input', { class: 'input', type: 'text', placeholder: '名字，比如「反推材质」' }) as HTMLInputElement;
  const kind = h('select', { class: 'input select' }) as HTMLSelectElement;
  for (const [v, t] of [
    ['reverse', '反推（图 → 文）：让视觉模型描述输入图'],
    ['stylize', '风格化：把输入图转成某种稿型'],
    ['skill', '技能：给视觉模型的系统级指令']
  ] as const) {
    kind.appendChild(h('option', { value: v }, t));
  }
  const desc = h('input', { class: 'input', type: 'text', placeholder: '一句话说明它是干什么的（可留空）' }) as HTMLInputElement;
  const text = h('textarea', {
    class: 'input textarea',
    rows: '8',
    placeholder: '提示词正文'
  }) as HTMLTextAreaElement;
  const out = h('div', { class: 'muted' });

  const addBtn = h(
    'button',
    {
      class: 'btn-primary',
      type: 'button',
      onclick: async () => {
        out.className = 'muted';
        out.textContent = '';
        if (!label.value.trim() || !text.value.trim()) {
          out.className = 'err';
          out.textContent = '名字和正文都要填。';
          return;
        }
        try {
          const res = await api.createPrompt({
            label: label.value.trim(),
            kind: kind.value,
            scope: ['*'],
            prompt: text.value,
            ...(desc.value.trim() ? { description: desc.value.trim() } : {})
          });
          toast('已新增', res.preset.label);
          await renderSettingsPage(host.parentElement as HTMLElement);
        } catch (e) {
          out.className = 'err';
          out.textContent = e instanceof ApiError ? e.display : e instanceof Error ? e.message : String(e);
        }
      }
    },
    '新增'
  );

  box.appendChild(fieldRow('名字', label));
  box.appendChild(fieldRow('类型', kind));
  box.appendChild(fieldRow('说明', desc));
  box.appendChild(fieldRow('正文', text));
  box.appendChild(h('div', { class: 'row gap' }, addBtn));
  box.appendChild(out);
  box.appendChild(h('div', { class: 'muted hint' }, '新增的预设所有功能都能选到；出厂预设改坏了可以用它自己的「恢复默认」退回去。'));
  return box;
}

/* ---------------- 关于 ---------------- */

async function renderAbout(host: HTMLElement): Promise<void> {
  const state = getState();
  const rows: HTMLElement[] = [];

  const kv = (k: string, v: string, cls = ''): HTMLElement =>
    h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: `v ${cls}` }, v));

  rows.push(kv('插件版本', CLIENT_VERSION));
  rows.push(kv('Helper 版本', state.health.version ?? '未连接', state.health.version === CLIENT_VERSION ? 'ok' : 'warn'));
  if (state.health.version && state.health.version !== CLIENT_VERSION) {
    rows.push(h('div', { class: 'notice warn' }, '插件与 Helper 版本不一致，可能出现无法预期的行为，建议升级到同一版本。'));
  }
  rows.push(kv('Photoshop 环境', bridge.isAvailable() ? '已连接' : bridge.reason(), bridge.isAvailable() ? 'ok' : 'warn'));

  try {
    const sys = await api.system();
    rows.push(kv('数据目录', sys.dataDir));
    rows.push(kv('日志目录', sys.logsDir));
    rows.push(kv('资产占用', formatBytes(sys.assetBytes)));
    if (sys.freeBytes !== null) rows.push(kv('磁盘剩余', formatBytes(sys.freeBytes)));
  } catch {
    rows.push(kv('系统信息', '读取失败', 'err'));
  }

  // 用量：本地跑还是云端跑，用户是靠这组数字决定的
  try {
    const usage = await api.usage();
    if (usage.length > 0) {
      for (const u of usage) {
        const label = findProvider(u.providerId)?.label ?? u.providerId;
        const gpuPart = u.gpuMs > 0 ? ` · GPU 累计 ${formatDuration(u.gpuMs)}` : '';
        rows.push(kv(`用量 · ${label}`, `${u.runs} 次${gpuPart} · 最近 ${formatTime(u.lastAt)}`));
      }
    }
  } catch {
    /* 用量读不到不影响别的信息，静默跳过 */
  }

  const gpu = state.gpu;
  if (gpu) {
    rows.push(
      gpu.available
        ? kv('GPU', `${gpu.name} · ${gpu.vramUsedMb}/${gpu.vramTotalMb} MB · ${gpu.utilizationPct}%`)
        : kv('GPU', gpu.reason ?? '不可用', 'warn')
    );
  }

  rows.push(
    h(
      'div',
      { class: 'row gap' },
      h(
        'button',
        {
          class: 'btn-ghost',
          type: 'button',
          onclick: async () => {
            await clearToken();
            try {
              await ensurePaired();
              toast('已重新配对');
            } catch (e) {
              toast('重新配对失败', e instanceof ApiError ? e.display : String(e), 'error');
            }
          }
        },
        '重新配对'
      )
    )
  );

  host.appendChild(card('关于与诊断', ...rows));
}

/**
 * RunningHub 云端工作流选择器。
 *
 * 以前这里是个纯文本框，让用户自己去 runninghub.cn 抄一串 19 位数字 —— 抄对了也未必能用：
 * 云端工作流不带参数绑定表，我们不知道该把图和提示词写进哪个节点，
 * 提交上去只会拿作者的示例图出图，出来一张跟用户输入毫无关系却"成功了"的图。
 * 所以默认给内置预设（节点绑定都对着云端真图核对过），
 * 手填 ID 作为高级选项保留，但会明确提示它需要自行完成绑定。
 */
function renderRunningHubPicker(f: FeatureView, workflows: WorkflowSummary[]): HTMLElement {
  const wrap = h('div', { class: 'rh-picker' });
  const current = f.binding?.remoteWorkflowId ?? '';
  const recommended = rhPresetsForFeature(f.id);
  const others = RUNNINGHUB_PRESETS.filter((p) => !recommended.includes(p));
  const known = rhPresetByWorkflowId(current);
  /*
   * 用户在「工作流」页登记过的 RunningHub 条目。
   *
   * 以前这个下拉里只有出厂预设，用户自己的工作流永远只能走
   * 「自定义工作流 ID…」那条路 —— 每次换个功能就要重新手打 19 位数字，
   * 打错了也没有任何提示。登记过的现在直接出现在这里，按名字选。
   */
  const mine = workflows.filter((w) => w.kind === 'cloud' && w.providerId === 'runninghub' && w.remoteId);
  const mineHit = mine.find((w) => w.remoteId === current);
  // 「自定义」现在只剩真正没登记过的那种情况
  const isCustom = !!current && !known && !mineHit;

  const select = h('select', { class: 'input select' }) as HTMLSelectElement;
  const addOption = (value: string, label: string, selected: boolean): void => {
    const opt = h('option', { value }, label) as HTMLOptionElement;
    if (selected) opt.setAttribute('selected', '');
    select.appendChild(opt);
  };

  addOption('', '未绑定', !current);
  // 自己登记的排在最前面：那是用户主动加的，比出厂预设更可能是他要的
  for (const w of mine) addOption(w.remoteId!, `我的 · ${w.name}`, w.remoteId === current);
  if (recommended.length) {
    for (const p of recommended) addOption(p.workflowId, `★ ${p.label}`, p.workflowId === current);
  }
  for (const p of others) addOption(p.workflowId, `${RH_CATEGORY_LABELS[p.category]} · ${p.label}`, p.workflowId === current);
  addOption('__custom__', '自定义工作流 ID…', isCustom);

  const detail = h('div', { class: 'rh-detail muted' });
  const customInput = h('input', {
    class: 'input rh-custom',
    type: 'text',
    placeholder: '云端工作流 ID（19 位数字）'
  }) as HTMLInputElement;
  customInput.value = isCustom ? current : '';

  const paint = (): void => {
    const v = select.value;
    const showCustom = v === '__custom__';
    toggleClass(customInput, 'hidden', !showCustom);
    clear(detail);
    if (showCustom) {
      detail.appendChild(
        h(
          'span',
          { class: 'warn-text' },
          '临时填一个 ID 只对这一个功能生效，别处看不到也选不到。要反复用的话，去「工作流」页的「添加云端工作流」登记一次，之后在这个下拉里按名字选。'
        )
      );
      return;
    }
    // 用户自己登记的条目：出厂预设表里查不到它，但我们知道它的名字和 ID
    const own = mine.find((w) => w.remoteId === v);
    if (own) {
      detail.appendChild(h('div', {}, `已登记的云端工作流 · ID ${own.remoteId}`));
      if (own.notes) detail.appendChild(h('div', { class: 'rh-meta' }, own.notes));
      return;
    }
    const p = rhPresetByWorkflowId(v);
    if (!p) return;
    detail.appendChild(h('div', {}, p.description));
    const bits = [`${p.nodeCount} 节点`, p.stack];
    if (p.needsMask) bits.push('需要选区/蒙版（输入图必须带透明通道）');
    detail.appendChild(h('div', { class: 'rh-meta' }, bits.join(' · ')));
    detail.appendChild(
      h(
        'button',
        {
          class: 'btn-link',
          type: 'button',
          onclick: () => openExternal(rhPostUrl(p.workflowId))
        },
        '在 RunningHub 查看这个工作流'
      )
    );
  };

  select.addEventListener('change', () => {
    paint();
    if (select.value === '__custom__') return;
    void api.setBinding(f.id, { remoteWorkflowId: select.value });
  });
  customInput.addEventListener('change', () => {
    void api.setBinding(f.id, { remoteWorkflowId: customInput.value.trim() });
  });

  wrap.appendChild(select);
  wrap.appendChild(customInput);
  wrap.appendChild(detail);
  paint();
  return wrap;
}

/**
 * 导入工作流的参数绑定编辑器。
 *
 * 导入时扫描器会**猜**一套绑定（按节点类型和字段名猜语义）。猜得不错，
 * 但猜错的时候后果很隐蔽：那个参数的滑杆照样显示、照样能拖，
 * 提交时却落不到任何节点上 —— 一个转不动的旋钮，正是本项目第一条纪律要杜绝的。
 *
 * 后端一直有 PUT /v1/workflows/:id/bindings 可以存修正后的绑定，
 * 只是界面上没有入口，用户没法改。这里把入口补上。
 *
 * 交互方向是「一行一个可写字段，选它由哪个参数驱动」，
 * 而不是「一行一个参数，选它写到哪个节点」—— 因为可写字段是工作流客观存在的，
 * 而参数列表是我们定义的；顺着客观的那一侧列，用户不会看到不存在的选项。
 */
async function renderBindingEditor(w: WorkflowSummary, host: HTMLElement): Promise<HTMLElement> {
  const box = h('div', { class: 'wf-bindings' });
  box.appendChild(h('div', { class: 'muted' }, '正在读取工作流…'));

  try {
    const record = await api.workflow(w.id);
    const scan = await api.scanWorkflow(record.graph);
    clear(box);

    if (scan.fields.length === 0) {
      box.appendChild(h('div', { class: 'muted' }, '这份工作流里没有扫描到可绑定的字段。'));
      return box;
    }

    // nodeId.input → 当前绑到哪个参数
    const current = new Map<string, string>();
    for (const b of record.bindings) current.set(`${b.nodeId}.${b.input}`, b.paramId);

    const picks = new Map<string, string>();
    const rows = h('div', { class: 'wf-binding-rows' });

    for (const f of scan.fields) {
      const key = `${f.nodeId}.${f.input}`;
      const preset = current.get(key) ?? (f.semantic ? SEMANTIC_TO_PARAM[f.semantic] : undefined) ?? '';
      picks.set(key, preset);

      const select = h('select', { class: 'input select' }) as HTMLSelectElement;
      const addOpt = (value: string, label: string): void => {
        const o = h('option', { value }, label) as HTMLOptionElement;
        if (value === preset) o.setAttribute('selected', '');
        select.appendChild(o);
      };
      addOpt('', '不绑定（用工作流里的固定值）');
      for (const p of BINDABLE_PARAMS) addOpt(p.id, p.label);
      select.addEventListener('change', () => picks.set(key, select.value));

      rows.appendChild(
        h(
          'div',
          { class: 'wf-binding-row' },
          h(
            'div',
            { class: 'wf-binding-field' },
            h('div', { class: 'wf-binding-node' }, `节点 ${f.nodeId} · ${f.input}`),
            h('div', { class: 'muted wf-binding-sub' }, `${f.classType}${f.title && f.title !== f.classType ? ` · ${f.title}` : ''} · 当前值 ${JSON.stringify(f.value).slice(0, 40)}`)
          ),
          select
        )
      );
    }

    const status = h('div', { class: 'muted' });
    const saveBtn = h(
      'button',
      {
        class: 'btn-primary',
        type: 'button',
        onclick: async () => {
          const bindings = [...picks.entries()]
            .filter(([, paramId]) => paramId)
            .map(([key, paramId]) => {
              const dot = key.lastIndexOf('.');
              return { paramId, nodeId: key.slice(0, dot), input: key.slice(dot + 1), required: false };
            });
          try {
            const saved = await api.saveWorkflowBindings(w.id, bindings);
            status.className = 'ok';
            status.textContent = `已保存 ${saved.bindings.length} 条绑定`;
            toast('绑定已保存', `${saved.name} · ${saved.bindings.length} 条`);
            await renderSettingsPage(host.parentElement as HTMLElement);
          } catch (e) {
            status.className = 'err';
            status.textContent = e instanceof ApiError ? e.display : String(e);
          }
        }
      },
      '保存绑定'
    );

    box.appendChild(
      h('div', { class: 'muted' }, `扫描到 ${scan.fields.length} 个可写字段。留空表示这个字段用工作流里的固定值。`)
    );
    box.appendChild(rows);
    box.appendChild(h('div', { class: 'row gap' }, saveBtn, status));
  } catch (e) {
    clear(box);
    box.appendChild(h('div', { class: 'err' }, e instanceof ApiError ? e.display : String(e)));
  }
  return box;
}

/**
 * 绑定行的摘要：一句话说清这个功能现在走谁、用哪份工作流/模型。
 *
 * 摘要要能独立看懂 —— 收起状态下这是用户唯一能看到的信息。
 */
function bindingSummary(f: FeatureView, workflows: WorkflowSummary[]): string {
  const backend =
    f.providerId === 'comfyui'
      ? 'ComfyUI'
      : f.providerId === 'runninghub'
        ? 'RunningHub 云端'
        : (f.providerId ?? '未选后端');

  if (f.branch === 'comfyui' && f.providerId === 'comfyui') {
    const w = workflows.find((x) => x.id === f.workflowId);
    return `${backend} · ${w ? `${w.name} v${w.version}` : '未绑定工作流'}`;
  }
  if (f.providerId === 'runninghub') {
    const id = f.binding?.remoteWorkflowId ?? '';
    const preset = id ? rhPresetByWorkflowId(id) : null;
    return `${backend} · ${preset ? preset.label : id ? `自定义 ${id}` : '未绑定工作流'}`;
  }
  return `${backend} · ${f.binding?.model || '默认模型'}`;
}
