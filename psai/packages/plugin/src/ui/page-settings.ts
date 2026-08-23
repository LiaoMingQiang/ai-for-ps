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
  rhPostUrl
} from '@psai/shared';
import type { AppSettings, WritebackMode, ComfyMode } from '@psai/shared';
import { h, clear, formatBytes, toggleClass } from '../app/dom.js';
import { api, ApiError, clearToken, ensurePaired, CLIENT_VERSION } from '../app/api.js';
import type { ProviderView, WorkflowSummary, FeatureView } from '../app/api.js';
import { getState, setState, toast } from '../app/store.js';
import * as bridge from '../ps/bridge.js';

type Section = 'local' | 'cloud' | 'bindings' | 'workflows' | 'platforms' | 'defaults' | 'about';

let section: Section = 'local';

export async function renderSettingsPage(host: HTMLElement): Promise<void> {
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
            void renderSettingsPage(host);
          }
        },
        t.label
      )
    );
  }
  host.appendChild(tabBar);
  host.appendChild(body);

  const settings = getState().settings ?? (await api.settings());
  setState({ settings });

  switch (section) {
    case 'local':
      await renderLocal(body, settings);
      break;
    case 'cloud':
      await renderCloud(body, settings);
      break;
    case 'bindings':
      await renderBindings(body);
      break;
    case 'workflows':
      await renderWorkflows(body);
      break;
    case 'platforms':
      await renderPlatforms(body);
      break;
    case 'defaults':
      await renderDefaults(body, settings);
      break;
    case 'about':
      await renderAbout(body);
      break;
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

async function patch(patchObj: Partial<AppSettings>): Promise<void> {
  const next = await api.patchSettings(patchObj);
  setState({ settings: next });
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
            await patch({ comfy: { ...settings.comfy, mode: m as ComfyMode } });
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
      await patch({ comfy: { ...settings.comfy, baseUrl: (e.target as HTMLInputElement).value.trim() } });
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
            patch({ comfy: { ...settings.comfy, serverCommand: (e.target as HTMLInputElement).value } })
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
            patch({ comfy: { ...settings.comfy, serverWorkingDir: (e.target as HTMLInputElement).value } })
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
          await patch({ comfy: { ...settings.comfy, timeoutMs: n } });
        }
      }),
      '毫秒'
    )
  );

  host.appendChild(card('ComfyUI 连接', ...items, h('div', { class: 'row gap' }, testBtn), result));
}

/* ---------------- 云端 ---------------- */

async function renderCloud(host: HTMLElement, settings: AppSettings): Promise<void> {
  const providers = await api.providers();
  const rh = providers.find((p) => p.id === 'runninghub');

  const keyInput = h('input', {
    class: 'input',
    type: 'password',
    placeholder: rh?.credentialFields[0]?.masked ?? 'RunningHub API Key'
  }) as HTMLInputElement;

  const wfInput = h('input', {
    class: 'input',
    type: 'text',
    value: settings.cloud.runninghubWorkflowId,
    placeholder: '云端工作流 ID',
    onchange: async (e: Event) => {
      await patch({ cloud: { runninghubWorkflowId: (e.target as HTMLInputElement).value.trim() } });
    }
  });

  const result = h('div', { class: 'test-result muted' }, rh?.configured ? '已配置' : (rh?.reason ?? '未配置'));

  const saveBtn = h(
    'button',
    {
      class: 'btn-primary',
      type: 'button',
      onclick: async () => {
        if (!keyInput.value.trim()) {
          toast('请先填写 API Key', '', 'warn');
          return;
        }
        try {
          await api.setCredentials('runninghub', { apiKey: keyInput.value.trim() });
          keyInput.value = '';
          toast('API Key 已保存', '只保存在本机 Helper（DPAPI 加密）');
          await renderSettingsPage(host.parentElement as HTMLElement);
        } catch (e) {
          toast('保存失败', e instanceof ApiError ? e.display : String(e), 'error');
        }
      }
    },
    '保存 Key'
  );

  const verifyBtn = h(
    'button',
    {
      class: 'btn-ghost',
      type: 'button',
      onclick: async () => {
        result.className = 'test-result muted';
        result.textContent = '正在验证…';
        try {
          const res = await api.testProvider('runninghub');
          result.className = `test-result ${res.result.ok ? 'ok' : 'err'}`;
          result.textContent = res.result.detail;
        } catch (e) {
          result.className = 'test-result err';
          result.textContent = e instanceof ApiError ? e.display : String(e);
        }
      }
    },
    '验证'
  );

  host.appendChild(
    card(
      'RunningHub 云端',
      h('p', { class: 'muted' }, '把 ComfyUI 工作流放到云端跑，不占用本机显卡。'),
      fieldRow('API Key', keyInput, rh?.credentialFields[0]?.masked ? `当前：${rh.credentialFields[0].masked}` : undefined),
      fieldRow('默认工作流 ID', wfInput, '可被单个功能的绑定覆盖'),
      h('div', { class: 'row gap' }, saveBtn, verifyBtn),
      result,
      h('div', { class: 'notice' }, 'RunningHub 没有提供取消接口。任务提交后无法中止，取消只会让本地丢弃结果，费用仍会产生。')
    )
  );
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

  for (const f of features) {
    if (f.id === 'comfy.custom') continue;

    const providerSelect = h('select', {
      class: 'input select',
      onchange: async (e: Event) => {
        await api.setBinding(f.id, { providerId: (e.target as HTMLSelectElement).value });
        await renderSettingsPage(host.parentElement as HTMLElement);
      }
    }) as HTMLSelectElement;

    const candidates = f.branch === 'comfyui' ? providers.filter((p) => p.id === 'comfyui' || p.id === 'runninghub') : providers.filter((p) => p.kind !== 'comfyui' && p.kind !== 'runninghub');
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
      for (const w of workflows) {
        const opt = h('option', { value: w.id }, `${w.name} v${w.version}${w.source === 'builtin' ? '（内置）' : ''}`) as HTMLOptionElement;
        if (w.id === f.workflowId) opt.setAttribute('selected', '');
        wfSelect.appendChild(opt);
      }
      detailControl = wfSelect;
    } else if (f.providerId === 'runninghub') {
      detailControl = renderRunningHubPicker(f);
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

    table.appendChild(
      h(
        'div',
        { class: 'binding-row' },
        h('span', { class: 'binding-feature' }, breadcrumb(f.id).slice(1).join(' / ')),
        providerSelect,
        detailControl,
        status,
        actions
      )
    );
  }

  host.appendChild(card('固定功能 ↔ 工作流绑定', table));
}

/* ---------------- 工作流 ---------------- */

async function renderWorkflows(host: HTMLElement): Promise<void> {
  const workflows = await api.workflows();
  setState({ workflows });

  const list = h('div', { class: 'wf-list' });
  for (const w of workflows) list.appendChild(workflowRow(w, host));

  const importBox = h('div', { class: 'wf-import' });
  const nameInput = h('input', { class: 'input', type: 'text', placeholder: '工作流名称' }) as HTMLInputElement;
  const jsonArea = h('textarea', {
    class: 'input textarea',
    rows: '6',
    placeholder: '把 ComfyUI 导出的 JSON 粘贴到这里（推荐用「导出(API)」格式）'
  }) as HTMLTextAreaElement;
  const scanOut = h('div', { class: 'muted' });

  const scanBtn = h(
    'button',
    {
      class: 'btn-ghost',
      type: 'button',
      onclick: async () => {
        scanOut.className = 'muted';
        scanOut.textContent = '正在扫描…';
        try {
          const scan = await api.scanWorkflow(JSON.parse(jsonArea.value));
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
          const res = await api.importWorkflow(JSON.parse(jsonArea.value), nameInput.value.trim());
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
  importBox.appendChild(h('div', { class: 'row gap' }, scanBtn, importBtn));
  importBox.appendChild(scanOut);

  host.appendChild(card(`工作流（${workflows.length}）`, list));
  host.appendChild(card('导入工作流', importBox));
}

function workflowRow(w: WorkflowSummary, host: HTMLElement): HTMLElement {
  const actions = h('div', { class: 'row gap' });
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
              rep.ok ? w.name : `缺节点 ${rep.missingNodes.join(', ') || '无'}；缺模型 ${rep.missingModels.map((m) => m.name).join(', ') || '无'}`,
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
  if (w.source === 'imported') {
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
      h('div', { class: 'wf-name' }, `${w.name} `, h('span', { class: 'muted' }, `v${w.version}`)),
      h(
        'div',
        { class: 'muted wf-sub' },
        `${w.source === 'builtin' ? '内置' : '导入'} · ${w.nodeCount} 节点 · ${w.bindingCount} 条绑定` +
          (w.featureId ? ` · 绑定 ${breadcrumb(w.featureId).slice(1).join('/')}` : '')
      ),
      w.notes ? h('div', { class: 'muted wf-notes' }, w.notes) : null
    ),
    actions
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
  const keyField = p.credentialFields.find((f) => f.secret);
  const keyInput = keyField
    ? (h('input', { class: 'input', type: 'password', placeholder: keyField.masked ?? keyField.placeholder }) as HTMLInputElement)
    : null;

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
  modelSelect.appendChild(h('option', { value: '' }, '（尚未拉取模型）'));

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
    }
  );

  const actions = h('div', { class: 'row gap' });

  if (keyInput) {
    actions.appendChild(
      h(
        'button',
        {
          class: 'btn-primary',
          type: 'button',
          onclick: async () => {
            if (!keyInput.value.trim()) {
              toast('请先填写 API Key', '', 'warn');
              return;
            }
            try {
              await api.setCredentials(p.id, { [keyField!.key]: keyInput.value.trim() });
              keyInput.value = '';
              toast('已保存', `${p.label} 的 Key 只存在本机 Helper`);
              await renderSettingsPage(host.parentElement as HTMLElement);
            } catch (e) {
              toast('保存失败', e instanceof ApiError ? e.display : String(e), 'error');
            }
          }
        },
        '保存 Key'
      )
    );
    if (keyField?.masked) {
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

  actions.appendChild(
    h(
      'button',
      {
        class: 'btn-ghost',
        type: 'button',
        onclick: async () => {
          result.className = 'test-result muted';
          result.textContent = '正在拉取模型…';
          try {
            const models = await api.listModels(p.id);
            clear(modelSelect);
            modelSelect.appendChild(h('option', { value: '' }, '（使用默认模型）'));
            for (const m of models) modelSelect.appendChild(h('option', { value: m }, m));
            result.className = 'test-result ok';
            result.textContent = `拉到 ${models.length} 个模型`;
          } catch (e) {
            result.className = 'test-result err';
            result.textContent = e instanceof ApiError ? e.display : String(e);
          }
        }
      },
      '拉取模型'
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
    keyInput ? fieldRow('API Key', keyInput, keyField?.masked ? `当前：${keyField.masked}` : '只保存在本机 Helper') : null,
    fieldRow('默认模型', modelSelect),
    actions,
    result,
    p.cancelSupport === 'none' ? h('div', { class: 'muted small' }, '该平台不支持取消已提交的任务') : null
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
    onchange: async (e: Event) => patch({ generation: { ...g, writebackMode: (e.target as HTMLSelectElement).value as WritebackMode } })
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
        onchange: async (e: Event) => patch({ generation: { ...g, layerNameTemplate: (e.target as HTMLInputElement).value } })
      }),
      '支持 {feature} {date} {seed}'
    ),
    fieldRow(
      '自动写回',
      h('button', {
        class: `switch ${g.autoWriteback ? 'on' : ''}`,
        type: 'button',
        role: 'switch',
        'aria-checked': String(g.autoWriteback),
        onclick: async (e: Event) => {
          const next = !(e.currentTarget as HTMLElement).classList.contains('on');
          toggleClass(e.currentTarget as HTMLElement, 'on', next);
          await patch({ generation: { ...g, autoWriteback: next } });
        }
      }),
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
          await patch({ generation: { ...g, maxConcurrency: n } });
        }
      }),
      '本地 ComfyUI 建议保持 1，同一张卡上并行只会更慢'
    ),
    fieldRow(
      '输入图最长边上限',
      h('input', {
        class: 'input',
        type: 'text',
        value: String(g.inputMaxEdge),
        onchange: async (e: Event) => {
          const n = Number((e.target as HTMLInputElement).value.replace(/[^0-9]/g, '')) || 0;
          await patch({ generation: { ...g, inputMaxEdge: n } });
        }
      }),
      '0 表示不缩放'
    )
  ];

  host.appendChild(card('生成默认值', ...items));

  /* 内置提示词 */
  const presets = await api.prompts();
  const list = h('div', { class: 'preset-list' });
  for (const p of presets) {
    const ta = h('textarea', { class: 'input textarea', rows: '3' }) as HTMLTextAreaElement;
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
          : null
      )
    );
    list.appendChild(row);
  }
  host.appendChild(card(`内置提示词（${presets.length}）`, list));
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
function renderRunningHubPicker(f: FeatureView): HTMLElement {
  const wrap = h('div', { class: 'rh-picker' });
  const current = f.binding?.remoteWorkflowId ?? '';
  const recommended = rhPresetsForFeature(f.id);
  const others = RUNNINGHUB_PRESETS.filter((p) => !recommended.includes(p));
  const known = rhPresetByWorkflowId(current);
  const isCustom = !!current && !known;

  const select = h('select', { class: 'input select' }) as HTMLSelectElement;
  const addOption = (value: string, label: string, selected: boolean): void => {
    const opt = h('option', { value }, label) as HTMLOptionElement;
    if (selected) opt.setAttribute('selected', '');
    select.appendChild(opt);
  };

  addOption('', '未绑定', !current);
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
          '自定义工作流没有内置绑定表：需要先在「工作流」里导入同一份图并完成参数绑定，否则提交会被拦下。'
        )
      );
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
