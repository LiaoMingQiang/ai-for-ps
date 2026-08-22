/**
 * 应用装配：面板挂载、生命周期、状态条、路由、Helper 事件订阅。
 */

import { PSAI_VERSION } from '@psai/shared';
import type { HelperEvent } from '@psai/shared';
import { h, clear } from './dom.js';
import { api, health, ensurePaired, connectEvents, disconnectEvents, onHelperEvent, ApiError } from './api.js';
import { getState, setState, subscribe, upsertJob, toast, dismissToast, resetStore } from './store.js';
import * as bridge from '../ps/bridge.js';
import { renderTopNav } from '../ui/nav.js';
import { renderGeneratePage } from '../ui/page-generate.js';
import { renderHistoryPage } from '../ui/page-history.js';
import { renderSettingsPage } from '../ui/page-settings.js';
import { renderComfyWebPage } from '../ui/page-comfyweb.js';

let booted = false;
let healthTimer: ReturnType<typeof setInterval> | null = null;
const mounts = new Set<{ root: HTMLElement; kind: 'main' | 'comfyWeb'; dispose: () => void }>();

/* ---------------- 生命周期 ---------------- */

export async function bootPlugin(): Promise<void> {
  if (booted) return;
  booted = true;

  const ps = bridge.initBridge();
  setState({ inPhotoshop: ps.ok, psReason: ps.reason });

  if (ps.ok) {
    bridge.watchContext(() => {
      const ctx = bridge.getContext();
      setState({
        doc: ctx
          ? {
              documentId: ctx.documentId,
              documentName: ctx.documentName,
              documentPath: ctx.documentPath,
              width: ctx.width,
              height: ctx.height,
              colorMode: ctx.colorMode,
              bitDepth: ctx.bitDepth,
              activeLayerName: ctx.activeLayers[0]?.name ?? null,
              activeLayerIds: ctx.activeLayers.map((l) => l.id),
              hasSelection: ctx.hasSelection,
              selectionBounds: ctx.selectionBounds
            }
          : null
      });
    });
  }

  await refreshHealth();
  healthTimer = setInterval(() => void refreshHealth(), 5000);

  onHelperEvent(handleHelperEvent);
  setState({ booted: true });
}

export function teardownPlugin(): void {
  booted = false;
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  disconnectEvents();
  for (const m of mounts) m.dispose();
  mounts.clear();
  resetStore();
}

function handleHelperEvent(ev: HelperEvent): void {
  switch (ev.type) {
    case 'job:update':
      upsertJob(ev.job);
      break;
    case 'gpu':
      setState({ gpu: ev.gpu });
      break;
    case 'provider:status':
      // 状态条上的 ComfyUI 圆点跟着变
      void refreshHealth();
      break;
    default:
      break;
  }
}

/** 连 Helper、配对、拉基础数据。失败时把原因如实写进状态条。 */
async function refreshHealth(): Promise<void> {
  try {
    const hp = await health();
    const wasOffline = !getState().health.online;

    setState({
      health: {
        online: true,
        version: hp.version,
        paired: hp.paired,
        activeJobs: hp.activeJobs,
        comfyui: hp.comfyui,
        reason: null
      }
    });

    if (wasOffline) {
      await ensurePaired();
      await connectEvents();
      await loadBaseData();
    }
  } catch (e) {
    const reason =
      e instanceof ApiError
        ? e.shape.code === 'HELPER_OFFLINE'
          ? '本地 Helper 未运行 —— 请先启动 AI for PS Helper'
          : e.display
        : String(e);
    setState({
      health: { online: false, version: null, paired: false, activeJobs: 0, comfyui: null, reason }
    });
  }
}

async function loadBaseData(): Promise<void> {
  try {
    const [{ features }, settings, providers, workflows, jobs] = await Promise.all([
      api.features(),
      api.settings(),
      api.providers(),
      api.workflows(),
      api.jobs({ limit: 100 })
    ]);
    setState({ features, settings, providers, workflows, jobs });
    if (settings.ui.lastFeatureId && features.some((f) => f.id === settings.ui.lastFeatureId)) {
      setState({ featureId: settings.ui.lastFeatureId });
    }
    void api.gpu().then((gpu) => setState({ gpu })).catch(() => undefined);
  } catch (e) {
    toast('载入失败', e instanceof ApiError ? e.display : String(e), 'error');
  }
}

/* ---------------- 状态条 ---------------- */

function dot(kind: 'on' | 'off' | 'warn' | 'idle'): HTMLElement {
  return h('span', { class: `dot ${kind}` });
}

function renderStatusBar(onGoSettings: () => void): HTMLElement {
  const s = getState();
  const bar = h('div', { class: 'statusbar' });

  const helper = h(
    'button',
    { class: 'status-item', type: 'button', title: s.health.reason ?? '', onclick: onGoSettings },
    dot(s.health.online ? 'on' : 'off'),
    h('span', {}, s.health.online ? `Helper ${s.health.version ?? ''}` : 'Helper 离线')
  );
  bar.appendChild(helper);

  const c = s.health.comfyui;
  const comfyKind = !c?.configured ? 'idle' : c.online ? 'on' : 'off';
  bar.appendChild(
    h(
      'button',
      { class: 'status-item', type: 'button', title: c?.reason ?? c?.baseUrl ?? '', onclick: onGoSettings },
      dot(comfyKind),
      h('span', {}, c?.configured ? `ComfyUI ${c.online ? '在线' : '离线'}` : 'ComfyUI 未配置')
    )
  );

  const g = s.gpu;
  if (g) {
    bar.appendChild(
      h(
        'button',
        { class: 'status-item', type: 'button', title: g.reason ?? '', onclick: onGoSettings },
        dot(g.available ? 'on' : 'idle'),
        h(
          'span',
          {},
          g.available && g.vramTotalMb
            ? `GPU ${((g.vramUsedMb ?? 0) / 1024).toFixed(1)}/${(g.vramTotalMb / 1024).toFixed(0)}G`
            : 'GPU 不可用'
        )
      )
    );
  }

  const active = s.jobs.filter((j) => !['succeeded', 'failed', 'cancelled', 'lost'].includes(j.state)).length;
  bar.appendChild(
    h(
      'button',
      { class: 'status-item', type: 'button', onclick: () => setState({ page: 'history' }) },
      h('span', { class: 'badge' }, String(active)),
      h('span', {}, '进行中')
    )
  );

  /* Photoshop 文档上下文 */
  const doc = s.doc;
  bar.appendChild(
    h(
      'div',
      { class: 'status-doc', title: doc?.documentPath ?? '' },
      doc
        ? h(
            'span',
            {},
            `${doc.documentName} · ${doc.width}×${doc.height} · ${doc.activeLayerName ?? '无活动图层'}${doc.hasSelection ? ' · 有选区' : ''}`
          )
        : h('span', { class: 'muted' }, s.inPhotoshop ? '没有打开的文档' : (s.psReason ?? '不在 Photoshop 中'))
    )
  );

  return bar;
}

function renderToasts(): HTMLElement {
  const wrap = h('div', { class: 'toasts' });
  for (const t of getState().toasts) {
    wrap.appendChild(
      h(
        'div',
        { class: `toast ${t.kind}`, onclick: () => dismissToast(t.id) },
        h('strong', {}, t.title),
        t.detail ? h('span', {}, t.detail) : null
      )
    );
  }
  return wrap;
}

/* ---------------- 面板挂载 ---------------- */

export async function mountMainPanel(root: HTMLElement): Promise<void> {
  await bootPlugin();

  const statusHost = h('div', { class: 'status-host' });
  const navHost = h('div', { class: 'nav-host' });
  const pageHost = h('main', { class: 'page-host' });
  const toastHost = h('div', { class: 'toast-host' });

  clear(root);
  root.className = 'psai-root';
  root.appendChild(statusHost);
  root.appendChild(navHost);
  root.appendChild(pageHost);
  root.appendChild(toastHost);

  const goSettings = (): void => setState({ page: 'settings' });

  const paintChrome = (): void => {
    clear(statusHost);
    statusHost.appendChild(renderStatusBar(goSettings));
    clear(navHost);
    navHost.appendChild(renderTopNav(getState().page, (p) => setState({ page: p })));
  };

  let painting = false;
  const paintPage = async (): Promise<void> => {
    if (painting) return;
    painting = true;
    try {
      const page = getState().page;
      clear(pageHost);
      if (!getState().health.online) {
        pageHost.appendChild(offlineNotice());
        return;
      }
      switch (page) {
        case 'generate':
          await renderGeneratePage(pageHost);
          break;
        case 'history':
          await renderHistoryPage(pageHost);
          break;
        case 'settings':
          await renderSettingsPage(pageHost);
          break;
        case 'comfyWeb':
          await renderComfyWebPage(pageHost);
          break;
      }
    } catch (e) {
      clear(pageHost);
      pageHost.appendChild(
        h('div', { class: 'notice warn' }, '页面渲染出错：', String(e instanceof Error ? e.message : e))
      );
    } finally {
      painting = false;
    }
  };

  const paintToasts = (): void => {
    clear(toastHost);
    toastHost.appendChild(renderToasts());
  };

  const unsubChrome = subscribe(['health', 'gpu', 'doc', 'page', 'jobs'], paintChrome);
  const unsubPage = subscribe(['page', 'featureId', 'features', 'health'], () => void paintPage());
  const unsubJobs = subscribe(['jobs', 'activeJobId'], () => {
    // 生成页正在跟踪的任务变了才重绘，避免历史页刷新时整页闪
    if (getState().page === 'generate') void paintPage();
  });
  const unsubToast = subscribe(['toasts'], paintToasts);

  mounts.add({
    root,
    kind: 'main',
    dispose: () => {
      unsubChrome();
      unsubPage();
      unsubJobs();
      unsubToast();
    }
  });

  paintChrome();
  paintToasts();
  await paintPage();

  // 记住上次停留的功能
  subscribe(['featureId'], () => {
    const s = getState();
    if (!s.settings) return;
    void api
      .patchSettings({ ui: { ...s.settings.ui, lastFeatureId: s.featureId } })
      .catch(() => undefined);
  });
}

export async function mountComfyWebPanel(root: HTMLElement): Promise<void> {
  await bootPlugin();
  clear(root);
  root.className = 'psai-root psai-comfyweb';
  const pageHost = h('main', { class: 'page-host' });
  root.appendChild(pageHost);

  const paint = async (): Promise<void> => {
    if (!getState().health.online) {
      clear(pageHost);
      pageHost.appendChild(offlineNotice());
      return;
    }
    await renderComfyWebPage(pageHost);
  };

  const unsub = subscribe(['health'], () => void paint());
  mounts.add({ root, kind: 'comfyWeb', dispose: unsub });
  await paint();
}

export async function openSettings(): Promise<void> {
  await bootPlugin();
  setState({ page: 'settings' });
}

function offlineNotice(): HTMLElement {
  const s = getState();
  return h(
    'div',
    { class: 'offline' },
    h('div', { class: 'offline-title' }, 'Helper 没有连上'),
    h('div', { class: 'offline-reason' }, s.health.reason ?? '未知原因'),
    h(
      'div',
      { class: 'muted' },
      '这个插件不直连任何 AI 服务，所有任务都由本机的 AI for PS Helper 调度。请确认它已经在运行。'
    ),
    h(
      'button',
      { class: 'btn-primary', type: 'button', onclick: () => void refreshHealth() },
      '重新检测'
    ),
    h('div', { class: 'muted small' }, `插件版本 ${PSAI_VERSION}`)
  );
}
