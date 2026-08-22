/**
 * 历史页：所有任务的持久化列表。
 * 结果永远留在资产库，所以「再次写回」在任何时候都可用 —— 这是 PRD H-04 的核心承诺。
 */

import { JOB_STATE_LABELS, isActive, isTerminal, breadcrumb, WRITEBACK_MODE_LABELS } from '@psai/shared';
import type { JobRecord, JobState, WritebackMode } from '@psai/shared';
import { h, clear, formatTime, formatDuration } from '../app/dom.js';
import { api, ApiError, assetImgSrc } from '../app/api.js';
import { getState, setState, toast } from '../app/store.js';
import { performWriteback } from './page-generate.js';
import * as bridge from '../ps/bridge.js';

interface Filters {
  state: JobState | '';
  featureId: string;
  currentDocOnly: boolean;
}

const filters: Filters = { state: '', featureId: '', currentDocOnly: false };

export async function renderHistoryPage(host: HTMLElement): Promise<void> {
  clear(host);
  host.appendChild(h('header', { class: 'page-head' }, h('h2', { class: 'page-title' }, '历史')));

  const listHost = h('div', { class: 'history-list' });
  const bar = h('div', { class: 'filters' });

  /* ---- 筛选 ---- */
  const stateSelect = h('select', {
    class: 'input select',
    onchange: (e: Event) => {
      filters.state = (e.target as HTMLSelectElement).value as JobState | '';
      void load();
    }
  }) as HTMLSelectElement;
  stateSelect.appendChild(h('option', { value: '' }, '全部状态'));
  for (const [s, label] of Object.entries(JOB_STATE_LABELS)) {
    const opt = h('option', { value: s }, label) as HTMLOptionElement;
    if (s === filters.state) opt.setAttribute('selected', '');
    stateSelect.appendChild(opt);
  }

  const featureSelect = h('select', {
    class: 'input select',
    onchange: (e: Event) => {
      filters.featureId = (e.target as HTMLSelectElement).value;
      void load();
    }
  }) as HTMLSelectElement;
  featureSelect.appendChild(h('option', { value: '' }, '全部功能'));
  for (const f of getState().features) {
    const opt = h('option', { value: f.id }, f.breadcrumb.slice(1).join(' / ')) as HTMLOptionElement;
    if (f.id === filters.featureId) opt.setAttribute('selected', '');
    featureSelect.appendChild(opt);
  }

  const docToggle = h(
    'button',
    {
      class: `chip ${filters.currentDocOnly ? 'on' : ''}`,
      type: 'button',
      onclick: () => {
        filters.currentDocOnly = !filters.currentDocOnly;
        void load();
        void renderHistoryPage(host);
      }
    },
    '只看当前文档'
  );

  bar.appendChild(stateSelect);
  bar.appendChild(featureSelect);
  bar.appendChild(docToggle);
  host.appendChild(bar);
  host.appendChild(listHost);

  async function load(): Promise<void> {
    clear(listHost);
    listHost.appendChild(h('div', { class: 'muted pad' }, '正在载入…'));
    const query: Record<string, string | number> = { limit: 200 };
    if (filters.state) query['state'] = filters.state;
    if (filters.featureId) query['featureId'] = filters.featureId;
    if (filters.currentDocOnly) {
      const ctx = bridge.getContext();
      if (ctx) query['documentId'] = ctx.documentId;
      else {
        clear(listHost);
        listHost.appendChild(h('div', { class: 'muted pad' }, '当前没有打开的 Photoshop 文档'));
        return;
      }
    }
    try {
      const jobs = await api.jobs(query);
      setState({ jobs });
      paint(jobs);
    } catch (e) {
      clear(listHost);
      listHost.appendChild(h('div', { class: 'err pad' }, e instanceof ApiError ? e.display : String(e)));
    }
  }

  function paint(jobs: JobRecord[]): void {
    clear(listHost);
    if (jobs.length === 0) {
      listHost.appendChild(h('div', { class: 'muted pad' }, '还没有任务'));
      return;
    }
    for (const job of jobs) listHost.appendChild(row(job));
  }

  function row(job: JobRecord): HTMLElement {
    const crumbs = breadcrumb(job.featureId);
    const thumb = h('div', { class: 'hist-thumb' });
    if (job.results[0]) {
      const img = h('img', { alt: '' }) as HTMLImageElement;
      void assetImgSrc(job.results[0].assetId).then((src) => (img.src = src));
      thumb.appendChild(img);
    } else {
      thumb.appendChild(h('span', { class: 'hist-thumb-none' }, '—'));
    }

    const meta = h(
      'div',
      { class: 'hist-meta' },
      h('div', { class: 'hist-title' }, crumbs.slice(1).join(' / ')),
      h(
        'div',
        { class: 'hist-sub muted' },
        `${formatTime(job.createdAt)} · ${job.providerId}` +
          (job.finishedAt && job.startedAt ? ` · ${formatDuration(job.finishedAt - job.startedAt)}` : '') +
          (job.target ? ` · ${job.target.documentName}` : '')
      ),
      job.error ? h('div', { class: 'hist-err' }, `${job.error.code}：${job.error.message}`) : null
    );

    const chip = h('span', { class: `state-chip state-${job.state}` }, JOB_STATE_LABELS[job.state]);

    const actions = h('div', { class: 'hist-actions' });

    if (job.results.length > 0 && job.target) {
      actions.appendChild(
        h(
          'button',
          {
            class: 'btn-ghost',
            type: 'button',
            title: '结果一直保留在资产库，随时可以再写回',
            onclick: async () => {
              const ok = await performWriteback(job, job.writeback?.mode ?? 'smartObject', job.writeback?.layerName ?? 'AI 结果');
              if (ok) void load();
            }
          },
          '再次写回'
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
            try {
              const next = await api.rerunJob(job.id);
              setState({ page: 'generate', featureId: next.featureId, activeJobId: next.id });
              toast('已用这套参数重跑', `新任务 ${next.id.slice(0, 12)}`);
            } catch (e) {
              toast('重跑失败', e instanceof ApiError ? e.display : String(e), 'error');
            }
          }
        },
        '用这套参数重跑'
      )
    );

    if (isActive(job.state)) {
      actions.appendChild(
        h(
          'button',
          {
            class: 'btn-ghost',
            type: 'button',
            onclick: async () => {
              const res = await api.cancelJob(job.id);
              if (!res.ok) toast('取消未生效', res.reason, 'warn');
              void load();
            }
          },
          '取消'
        )
      );
    }

    if (job.state === 'failed' || job.state === 'lost') {
      actions.appendChild(
        h(
          'button',
          {
            class: 'btn-ghost',
            type: 'button',
            onclick: async () => {
              await api.retryJob(job.id);
              void load();
            }
          },
          '重试'
        )
      );
    }

    if (isTerminal(job.state)) {
      actions.appendChild(
        h(
          'button',
          {
            class: 'btn-ghost danger',
            type: 'button',
            onclick: async () => {
              await api.deleteJob(job.id);
              void load();
            }
          },
          '删除'
        )
      );
    }

    const detail = h('div', { class: 'hist-detail hidden' });
    const expand = h(
      'button',
      {
        class: 'btn-ghost',
        type: 'button',
        onclick: async () => {
          const hidden = detail.classList.toggle('hidden');
          if (!hidden && detail.children.length === 0) await fillDetail(detail, job);
        }
      },
      '详情'
    );
    actions.appendChild(expand);

    return h(
      'article',
      { class: 'hist-row' },
      h('div', { class: 'hist-main' }, thumb, meta, chip),
      actions,
      detail
    );
  }

  async function fillDetail(host2: HTMLElement, job: JobRecord): Promise<void> {
    clear(host2);
    const kv = (k: string, v: string): HTMLElement => h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));

    host2.appendChild(kv('任务 ID', job.id));
    if (job.workflowId) host2.appendChild(kv('工作流', `${job.workflowId} v${job.workflowVersion ?? '-'}`));
    if (job.remoteId) host2.appendChild(kv('远端任务号', job.remoteId));
    if (job.parentJobId) host2.appendChild(kv('由哪条重跑而来', job.parentJobId));
    if (job.writeback) host2.appendChild(kv('写回方式', WRITEBACK_MODE_LABELS[job.writeback.mode as WritebackMode]));
    if (job.target) {
      host2.appendChild(kv('目标文档', `${job.target.documentName}（${job.target.canvasWidth}×${job.target.canvasHeight}）`));
      if (job.target.selectionBounds) {
        const b = job.target.selectionBounds;
        host2.appendChild(kv('选区', `${b.left},${b.top} → ${b.right},${b.bottom}`));
      }
    }

    const breakdown = (job.resolvedParams as { __promptBreakdown?: Array<{ label: string; text: string }> })
      .__promptBreakdown;
    if (breakdown?.length) {
      const box = h('div', { class: 'prompt-breakdown' });
      for (const b of breakdown) {
        box.appendChild(h('div', { class: 'pb-row' }, h('span', { class: 'pb-label' }, b.label), h('span', { class: 'pb-text' }, b.text)));
      }
      host2.appendChild(h('details', {}, h('summary', {}, '最终提示词构成'), box));
    }

    host2.appendChild(
      h('details', {}, h('summary', {}, '解析后的参数'), h('pre', { class: 'code' }, JSON.stringify(job.resolvedParams, null, 2)))
    );

    try {
      const events = await api.jobEvents(job.id);
      const list = h('ol', { class: 'events' });
      for (const ev of events) {
        list.appendChild(
          h(
            'li',
            {},
            h('span', { class: 'ev-time' }, formatTime(ev.at)),
            h('span', { class: 'ev-state' }, JOB_STATE_LABELS[ev.to]),
            h('span', { class: 'ev-note muted' }, ev.note)
          )
        );
      }
      host2.appendChild(h('details', {}, h('summary', {}, `状态流转（${events.length}）`), list));
    } catch {
      /* 事件读不到不影响其他信息 */
    }
  }

  await load();
}
