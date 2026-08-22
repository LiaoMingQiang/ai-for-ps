/**
 * 应用装配：面板挂载、生命周期、状态条、路由、Helper 事件订阅。
 */

import { PSAI_VERSION } from '@psai/shared';
import type { HelperEvent } from '@psai/shared';
import { h, clear } from './dom.js';
import {
  api,
  health,
  ensurePaired,
  connectEvents,
  disconnectEvents,
  onHelperEvent,
  ApiError,
  resolveBase,
  probeResults
} from './api.js';
import { getState, setState, subscribe, upsertJob, toast, dismissToast, resetStore } from './store.js';
import * as bridge from '../ps/bridge.js';
import { renderTopNav } from '../ui/nav.js';
import { renderGeneratePage } from '../ui/page-generate.js';
import { renderHistoryPage } from '../ui/page-history.js';
import { renderSettingsPage } from '../ui/page-settings.js';
import { renderComfyWebPage } from '../ui/page-comfyweb.js';

let booted = false;
let healthTimer: ReturnType<typeof setTimeout> | null = null;
const mounts = new Set<{ root: HTMLElement; kind: 'main' | 'comfyWeb'; dispose: () => void }>();

/* ---------------- 健康轮询节奏 ---------------- */

const HEALTH_OK_MS = 5000;
const HEALTH_FAIL_MIN_MS = 2000;
const HEALTH_FAIL_MAX_MS = 30_000;
let healthBackoff = HEALTH_FAIL_MIN_MS;

/**
 * 连不上时退避，别死命重试。
 *
 * 起因：一个卡在重试循环里的客户端几分钟就把 Helper 的日志刷到 2.9MB，
 * 还把 Helper 拖慢到面板点不动。连不上时越急越糟 —— 对端要么没起来，
 * 要么被策略挡着，高频重试改变不了任何一种，只会消耗两边。
 */
function scheduleHealth(): void {
  if (healthTimer) clearTimeout(healthTimer);
  if (!booted) return;
  const online = getState().health.online;
  const delay = online ? HEALTH_OK_MS : healthBackoff;
  healthTimer = setTimeout(() => {
    void refreshHealth().finally(scheduleHealth);
  }, delay);
}

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
  scheduleHealth();

  onHelperEvent(handleHelperEvent);
  setState({ booted: true });
}

export function teardownPlugin(): void {
  booted = false;
  if (healthTimer) clearTimeout(healthTimer);
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
    // 离线时先重新探一遍候选地址；已经连上就不用每次都探
    if (!getState().health.online) {
      const probe = await resolveBase();
      if (!probe.ok) {
        healthBackoff = Math.min(healthBackoff * 2, HEALTH_FAIL_MAX_MS);
        setState({
          health: {
            online: false,
            version: null,
            paired: false,
            activeJobs: 0,
            comfyui: null,
            reason: probe.probes.map((p) => `${p.url} → ${p.detail}`).join('；')
          }
        });
        return;
      }
    }

    const hp = await health();
    const wasOffline = !getState().health.online;

    healthBackoff = HEALTH_FAIL_MIN_MS; // 连上了，退避重新计数
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
    // 一定要带上原始报错。之前这里把 HELPER_OFFLINE 换成了一句
    // "请先启动 AI for PS Helper"，结果 Helper 明明在跑、真正的原因是
    // 网络白名单或 CORS 时，界面反而在误导人往错的方向查。
    const reason = e instanceof ApiError ? e.display : String(e);
    healthBackoff = Math.min(healthBackoff * 2, HEALTH_FAIL_MAX_MS);
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
  // 页面只在"上线/离线翻转"时重绘。
  // 之前把 health 整个订阅进来，心跳里 activeJobs 一变就整页重建，
  // 正在输入的提示词和正在拖的立方体会被冲掉。
  let lastOnline: boolean | null = null;
  const unsubPage = subscribe(['page', 'featureId', 'features'], () => void paintPage());
  const unsubOnline = subscribe(['health'], () => {
    const online = getState().health.online;
    if (online === lastOnline) return;
    lastOnline = online;
    void paintPage();
  });
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
      unsubOnline();
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

  // 每个候选地址的原始报错都摆出来。排查这类问题全靠这几行原文：
  // "Helper 没起" / "UXP 网络白名单没放行" / "CORS 被拦" 在界面上长得一样，
  // 但只有原始报错能区分它们。
  const probes = probeResults();
  const diag = h('div', { class: 'offline-diag' });
  if (probes.length) {
    diag.appendChild(h('div', { class: 'offline-diag-title' }, '连接诊断'));
    for (const p of probes) {
      diag.appendChild(
        h(
          'div',
          { class: `offline-diag-row ${p.ok ? 'ok' : 'err'}` },
          h('code', {}, p.url),
          h('span', {}, p.ok ? '通' : p.detail)
        )
      );
    }
  }

  const copyBtn = h(
    'button',
    {
      class: 'btn-ghost',
      type: 'button',
      onclick: () => {
        const text = [
          `插件版本 ${PSAI_VERSION}`,
          `Photoshop 环境 ${bridge.isAvailable() ? '可用' : bridge.reason()}`,
          `fetch ${typeof fetch === 'function' ? '可用' : '不可用'}`,
          ...probes.map((p) => `${p.url} → ${p.ok ? 'OK' : p.detail}`)
        ].join('\n');
        try {
          const clip = (navigator as unknown as { clipboard?: { writeText(t: string): Promise<void> } }).clipboard;
          void clip?.writeText(text);
          toast('诊断信息已复制');
        } catch {
          toast('复制失败', text, 'warn');
        }
      }
    },
    '复制诊断信息'
  );

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
    diag,
    h(
      'div',
      { class: 'row gap' },
      h(
        'button',
        {
          class: 'btn-primary',
          type: 'button',
          onclick: () => {
            // 用户主动点了就立刻重试一次，不受退避约束
            healthBackoff = HEALTH_FAIL_MIN_MS;
            void refreshHealth().finally(scheduleHealth);
          }
        },
        '重新检测'
      ),
      copyBtn
    ),
    h('div', { class: 'muted small' }, `插件版本 ${PSAI_VERSION} · fetch ${typeof fetch === 'function' ? '可用' : '不可用'}`)
  );
}
