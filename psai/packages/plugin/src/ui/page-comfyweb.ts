/**
 * ComfyUI Web 面板。
 *
 * UXP 的 <webview> 对 http://127.0.0.1 的放行策略需要在真机上验证，
 * 所以这里做**能力探测 + 两条路径**（PRD §4.5）：
 *   路径 A 内嵌：webview 能加载本机 ComfyUI，面板内直接显示完整编辑器
 *   路径 B 降级：webview 被拦，就提供「浏览器打开」+ 面板内的队列视图与工作流浏览
 * 无论走哪条，W-01~W-05 五项能力都必须可用。
 */

import { h, clear, formatTime } from '../app/dom.js';
import { api, ApiError } from '../app/api.js';
import { getState, toast, setState } from '../app/store.js';

type Path = 'unknown' | 'embedded' | 'fallback';

let detected: Path = 'unknown';
let detectDetail = '';

/**
 * 内嵌区的高度，用户拖过就记住（模块级，面板活着期间一直有效）。
 *
 * 0 表示"还没拖过，用样式表里的默认值"。不写进设置是有意的：
 * 这是个随手调的视图偏好，不值得为它多一次落盘和一次迁移。
 */
let frameHeight = 0;

/** 内嵌区下沿的拖动条：按住上下拖，改的是一个确定的像素高度。 */
function makeResizer(frameBox: HTMLElement): HTMLElement {
  const bar = h('div', { class: 'comfy-resize', title: '按住上下拖，调整 ComfyUI 区域高度' }, '⋯');

  let startY = 0;
  let startH = 0;
  let dragging = false;

  const onMove = (ev: PointerEvent): void => {
    if (!dragging) return;
    const next = Math.max(220, Math.min(2400, startH + (ev.clientY - startY)));
    frameHeight = next;
    frameBox.style.height = `${next}px`;
  };
  const onUp = (): void => {
    dragging = false;
    try {
      window.removeEventListener('pointermove', onMove as EventListener);
      window.removeEventListener('pointerup', onUp);
    } catch {
      /* UXP 上 window 事件不一定挂得住，下面还有一层保底 */
    }
  };

  bar.addEventListener('pointerdown', (ev: Event) => {
    const pe = ev as PointerEvent;
    dragging = true;
    startY = pe.clientY;
    // 拖之前先把当前实际高度定下来：样式表里的默认值读不到 style.height
    startH = frameBox.offsetHeight || frameHeight || 640;
    try {
      window.addEventListener('pointermove', onMove as EventListener);
      window.addEventListener('pointerup', onUp);
    } catch {
      /* noop */
    }
  });
  // 保底：有些 UXP 版本 window 上收不到，元素自己也挂一份
  bar.addEventListener('pointermove', onMove as EventListener);
  bar.addEventListener('pointerup', onUp);
  bar.addEventListener('pointerleave', onUp);

  return bar;
}

/** webview 是否可用：元素能创建、且 manifest 放行了目标域。 */
function probeWebview(): { supported: boolean; detail: string } {
  try {
    const el = document.createElement('webview');
    if (!el || el.tagName?.toLowerCase() !== 'webview') {
      return { supported: false, detail: '当前 UXP 版本没有实现 <webview> 元素' };
    }
    return { supported: true, detail: '' };
  } catch (e) {
    return { supported: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function renderComfyWebPage(host: HTMLElement): Promise<void> {
  clear(host);
  const settings = getState().settings ?? (await api.settings().catch(() => null));
  const baseUrl = settings?.comfy.baseUrl ?? 'http://127.0.0.1:8188';

  /* ---- W-01 / W-02 顶部工具条 ---- */
  const urlInput = h('input', { class: 'input', type: 'text', value: baseUrl }) as HTMLInputElement;
  const statusChip = h('span', { class: 'chip' }, '检查中…');

  const bar = h(
    'div',
    { class: 'comfy-bar' },
    urlInput,
    h(
      'button',
      {
        class: 'btn-ghost',
        type: 'button',
        onclick: async () => {
          await api.patchSettings({ comfy: { ...(settings!.comfy), baseUrl: urlInput.value.trim() } });
          toast('地址已保存');
          await renderComfyWebPage(host);
        }
      },
      '连接'
    ),
    h('button', { class: 'btn-ghost', type: 'button', onclick: () => void renderComfyWebPage(host) }, '刷新'),
    h(
      'button',
      {
        class: 'btn-ghost',
        type: 'button',
        title: '在系统浏览器里打开 ComfyUI',
        onclick: () => openExternal(urlInput.value.trim())
      },
      '在浏览器中打开'
    ),
    statusChip
  );
  host.appendChild(bar);

  /* ---- 连接状态 ---- */
  try {
    const res = await api.testProvider('comfyui');
    statusChip.className = `chip ${res.result.ok ? 'on' : 'off'}`;
    statusChip.textContent = res.result.ok ? res.result.detail : '离线';
    if (!res.result.ok) {
      host.appendChild(
        h(
          'div',
          { class: 'notice warn' },
          h('strong', {}, 'ComfyUI 没连上：'),
          h('span', {}, res.result.detail),
          h('div', { class: 'muted' }, '先启动 ComfyUI（默认 127.0.0.1:8188），再点上面的「刷新」。')
        )
      );
    }
  } catch (e) {
    statusChip.className = 'chip off';
    statusChip.textContent = '离线';
    host.appendChild(h('div', { class: 'notice warn' }, e instanceof ApiError ? e.display : String(e)));
  }

  /* ---- 路径判定 ---- */
  if (detected === 'unknown') {
    const probe = probeWebview();
    detected = probe.supported ? 'embedded' : 'fallback';
    detectDetail = probe.detail;
  }

  if (detected === 'embedded') {
    const frame = document.createElement('webview');
    frame.setAttribute('src', urlInput.value.trim());
    frame.setAttribute('class', 'comfy-webview');
    frame.setAttribute('width', '100%');
    frame.setAttribute('height', '100%');
    // UXP 的 webview 加载失败不会抛异常，靠事件回落
    frame.addEventListener('loaderror', () => {
      detected = 'fallback';
      detectDetail = 'webview 加载本机地址被拦截';
      void renderComfyWebPage(host);
    });
    const frameBox = h('div', { class: 'comfy-frame' }, frame);
    if (frameHeight > 0) frameBox.style.height = `${frameHeight}px`;
    host.appendChild(frameBox);
    host.appendChild(makeResizer(frameBox));
    host.appendChild(
      h('div', { class: 'muted small pad' }, '内嵌模式。若这里长时间空白，说明 UXP 拦了本机地址，请点「在浏览器中打开」。')
    );
  } else {
    host.appendChild(
      h(
        'div',
        { class: 'notice' },
        h('strong', {}, '当前使用降级模式：'),
        h('span', {}, detectDetail || 'UXP 未放行内嵌本机地址'),
        h('div', { class: 'muted' }, '编辑节点图请点「在浏览器中打开」；下面的队列与工作流浏览在面板内可用。')
      )
    );
  }

  /* ---- W-03 队列视图 ---- */
  host.appendChild(await renderQueue());

  /* ---- W-04 工作流浏览 ---- */
  host.appendChild(await renderWorkflowBrowser(host));

  /* ---- W-05 发送当前图到 ComfyUI ---- */
  host.appendChild(renderSendImage());
}

async function renderQueue(): Promise<HTMLElement> {
  const card = h('section', { class: 'card' }, h('h3', { class: 'card-title' }, '任务队列'));
  try {
    const jobs = await api.jobs({ limit: 50 });
    const active = jobs.filter((j) => !['succeeded', 'failed', 'cancelled', 'lost'].includes(j.state));
    if (active.length === 0) {
      card.appendChild(h('div', { class: 'muted' }, '当前没有进行中的任务'));
    } else {
      for (const j of active) {
        card.appendChild(
          h(
            'div',
            { class: 'queue-row' },
            h('span', { class: 'queue-state' }, j.state),
            h('span', { class: 'queue-feature' }, j.featureId),
            h('span', { class: 'muted' }, j.progress.message || ''),
            h(
              'button',
              {
                class: 'btn-ghost',
                type: 'button',
                onclick: async () => {
                  const res = await api.cancelJob(j.id);
                  if (res.pending) toast('正在取消', res.reason);
                  else if (!res.cancelled) toast('取消未生效', res.reason, 'warn');
                }
              },
              '取消'
            )
          )
        );
      }
    }
  } catch (e) {
    card.appendChild(h('div', { class: 'err' }, e instanceof ApiError ? e.display : String(e)));
  }
  return card;
}

async function renderWorkflowBrowser(host: HTMLElement): Promise<HTMLElement> {
  const card = h('section', { class: 'card' }, h('h3', { class: 'card-title' }, '工作流'));
  try {
    const workflows = await api.workflows();
    for (const w of workflows) {
      card.appendChild(
        h(
          'div',
          { class: 'wf-row' },
          h(
            'div',
            { class: 'wf-meta' },
            h('div', { class: 'wf-name' }, `${w.name} `, h('span', { class: 'muted' }, `v${w.version}`)),
            h('div', { class: 'muted wf-sub' }, `${w.source === 'builtin' ? '内置' : '导入'} · ${w.nodeCount} 节点 · 更新于 ${formatTime(w.updatedAt)}`)
          ),
          h(
            'button',
            {
              class: 'btn-ghost',
              type: 'button',
              onclick: async () => {
                try {
                  const rep = await api.dependencies(w.id);
                  toast(rep.ok ? '依赖齐全' : '缺少依赖', rep.ok ? w.name : rep.missingNodes.join(', '), rep.ok ? 'info' : 'warn');
                } catch (e) {
                  toast('检查失败', e instanceof ApiError ? e.display : String(e), 'error');
                }
              }
            },
            '依赖检查'
          )
        )
      );
    }
    card.appendChild(
      h(
        'button',
        { class: 'btn-ghost', type: 'button', onclick: () => setState({ page: 'settings' }) },
        '去设置页导入工作流'
      )
    );
  } catch (e) {
    card.appendChild(h('div', { class: 'err' }, e instanceof ApiError ? e.display : String(e)));
  }
  return card;
}

function renderSendImage(): HTMLElement {
  return h(
    'section',
    { class: 'card' },
    h('h3', { class: 'card-title' }, '把当前图层发到 ComfyUI'),
    h('p', { class: 'muted' }, '导出当前图层并上传到 ComfyUI 的输入目录，之后可以在节点图里用 LoadImage 直接引用。'),
    h(
      'button',
      {
        class: 'btn-primary',
        type: 'button',
        onclick: async () => {
          const bridge = await import('../ps/bridge.js');
          if (!bridge.isAvailable()) {
            toast('无法导出', bridge.reason(), 'error');
            return;
          }
          try {
            const snap = await bridge.captureActiveLayers();
            const asset = await api.uploadAsset(snap.bytes, 'from-photoshop.png');
            toast('已上传到资产库', `${asset.width}×${asset.height}，提交任务时会自动同步到 ComfyUI`);
          } catch (e) {
            toast('导出失败', e instanceof Error ? e.message : String(e), 'error');
          }
        }
      },
      '导出当前图层'
    )
  );
}

function openExternal(url: string): void {
  try {
    const shell = (globalThis as { require?: (m: string) => { shell?: { openExternal(u: string): void } } }).require?.('uxp')?.shell;
    if (shell) shell.openExternal(url);
    else window.open?.(url);
  } catch {
    toast('无法打开链接', url, 'warn');
  }
}

/** 供真机验证脚本读取当前判定结果。 */
export function webviewPath(): { path: Path; detail: string } {
  return { path: detected, detail: detectDetail };
}
