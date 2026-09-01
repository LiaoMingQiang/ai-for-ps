/**
 * 历史页：所有任务的持久化列表。
 * 结果永远留在资产库，所以「再次写回」在任何时候都可用 —— 这是 PRD H-04 的核心承诺。
 */

import { JOB_STATE_LABELS, isActive, isTerminal, breadcrumb, WRITEBACK_MODE_LABELS } from '@psai/shared';
import type { JobRecord, JobState, WritebackMode } from '@psai/shared';
import { h, clear, formatTime, formatDuration, toggleClass } from '../app/dom.js';
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
    // 一次 200 条意味着一屏要渲染两百个缩略图。改成 60 条 ——
    // 面板本来就是窄栏，再多也翻不完，而渲染成本是实打实的。
    const query: Record<string, string | number> = { limit: 60 };
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

  /**
   * 「写入当前文档」：把一条没有目标文档的任务的结果，放进现在打开的这一份。
   *
   * 必须**明确确认**写进哪里，而不是默默用当前文档：
   * 用户可能同时开着好几份，而"写进哪一份"是不可撤销的决定。
   * 确认时把文档名摆出来，他一眼就能看出是不是自己想要的那份。
   */
  function rebindButton(job: JobRecord, pickAsset: () => string, reload: () => void): HTMLElement {
    const wrap = h('span', { class: 'hist-rebind' });

    const start = h(
      'button',
      {
        class: 'btn-ghost',
        type: 'button',
        title: '这条任务提交时没有打开文档，结果只存进了资产库。可以把它放进现在打开的文档。',
        onclick: () => {
          const ctx = bridge.getContext();
          if (!ctx) {
            toast('没有打开的文档', '请先在 Photoshop 里打开或新建一份文档，再写入。', 'warn');
            return;
          }
          clear(wrap);
          wrap.appendChild(
            h(
              'span',
              { class: 'hist-confirm' },
              h('span', { class: 'muted' }, `写入「${ctx.documentName}」？`),
              h(
                'button',
                {
                  class: 'btn-ghost',
                  type: 'button',
                  onclick: async () => {
                    // 目标在**按下确认那一刻**再读一次：从看到提示到点确认之间，
                    // 用户完全可能切到别的文档去。
                    const now = bridge.getContext();
                    if (!now || now.documentId !== ctx.documentId) {
                      toast('当前文档变了', '刚才那份文档已经不是当前文档了，请重新确认。', 'warn');
                      clear(wrap);
                      wrap.appendChild(start);
                      return;
                    }
                    const ok = await performWriteback(job, 'smartObject', job.writeback?.layerName ?? 'AI 结果', {
                      assetId: pickAsset(),
                      rebindTarget: bridge.buildTarget(now, null)
                    });
                    if (ok) reload();
                    else {
                      clear(wrap);
                      wrap.appendChild(start);
                    }
                  }
                },
                '确认'
              ),
              h(
                'button',
                {
                  class: 'btn-ghost',
                  type: 'button',
                  onclick: () => {
                    clear(wrap);
                    wrap.appendChild(start);
                  }
                },
                '取消'
              )
            )
          );
        }
      },
      '写入当前文档'
    );

    wrap.appendChild(start);
    return wrap;
  }

  function row(job: JobRecord): HTMLElement {
    const crumbs = breadcrumb(job.featureId);

    /*
     * 这一行现在选中的是哪一张结果。
     *
     * 一次生成可能出好几张。以前历史页只画 results[0]，「再次写回」
     * 写的也永远是 results[0] —— 用户在生成页挑中了 #3，
     * 过一会儿回历史页想再写一次，进文档的却是 #1，而界面上
     * 一个字的提示都没有。他只会觉得写回坏了。
     */
    let chosen = 0;

    const thumb = h('div', { class: job.results.length > 1 ? 'hist-thumbs' : 'hist-thumb' });
    const thumbEls: HTMLElement[] = [];

    function markChosen(): void {
      thumbEls.forEach((el, i) => toggleClass(el, 'chosen', i === chosen));
    }

    if (job.results.length === 0) {
      thumb.appendChild(h('span', { class: 'hist-thumb-none' }, '—'));
    } else {
      job.results.forEach((r, i) => {
        const img = h('img', { alt: '' }) as HTMLImageElement;
        // 小方块用缩略图就够了，别去拉十几兆的原图
        void assetImgSrc(r.assetId, { thumb: true }).then((src) => (img.src = src));
        const cell = h(
          'button',
          {
            class: 'hist-thumb-cell',
            type: 'button',
            title: job.results.length > 1 ? `第 ${i + 1} 张 —— 点一下选它，再次写回就写这一张` : '',
            onclick: () => {
              chosen = i;
              markChosen();
            }
          },
          img
        );
        thumbEls.push(cell);
        thumb.appendChild(cell);
      });
      markChosen();
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

    /*
     * 写回入口分两种，因为它们做的事**真的不一样**：
     *
     *   · 任务本来就有目标文档 → 「再次写回」：写回它自己那份文档
     *   · 任务没有目标（提交时没打开文档，落成了「仅存资产库」）
     *     → 「写入当前文档」：把结果放进**现在**打开的这一份，
     *       并且要用户明确确认写进哪里
     *
     * 上一版这两种共用「再次写回」这一个标签，而对 assetOnly 那条路
     * 它其实什么都不写 —— 只是给 Helper 记了一笔账。
     * 按钮写着"写回"却不写回，这比没有按钮更糟：用户点完看不出任何变化，
     * 只会以为写回坏了，或者更糟 —— 以为图已经进文档了。
     */
    const wbMode: WritebackMode = job.writeback?.mode ?? 'smartObject';
    const pickAsset = (): string => job.results[chosen]?.assetId ?? job.results[0]!.assetId;

    if (job.results.length > 0 && job.target && wbMode !== 'assetOnly') {
      actions.appendChild(
        h(
          'button',
          {
            class: 'btn-ghost',
            type: 'button',
            title: '结果一直保留在资产库，随时可以再写回',
            onclick: async () => {
              // 写的是用户**现在选中**的那一张，不是永远的第一张
              const ok = await performWriteback(job, wbMode, job.writeback?.layerName ?? 'AI 结果', {
                assetId: pickAsset()
              });
              if (ok) void load();
            }
          },
          '再次写回'
        )
      );
    } else if (job.results.length > 0) {
      actions.appendChild(rebindButton(job, pickAsset, load));
    }

    /*
     * 「提交结果未知」不给一键重跑。
     *
     * 这个状态的意思是：请求已经发往付费平台，但没等到回复 —— 平台可能已经接单并计费。
     * 摆一个和别处一模一样的「用这套参数重跑」在这里，用户会像平时那样顺手点下去，
     * 而那一下就是第二次扣费。出路统一收进下面的处置面板，每条都要人先看清楚再点。
     */
    if (job.state !== 'submission_unknown') {
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
    }

    if (isActive(job.state)) {
      actions.appendChild(
        h(
          'button',
          {
            class: 'btn-ghost',
            type: 'button',
            onclick: async () => {
              const res = await api.cancelJob(job.id);
              if (res.pending) toast('正在取消', res.reason);
              else if (!res.cancelled) toast('取消未生效', res.reason, 'warn');
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
      ...(job.state === 'submission_unknown' ? [submissionUnknownPanel(job)] : []),
      detail
    );
  }

  /**
   * 「提交结果未知」的处置面板。
   *
   * 这个状态是唯一一个**本地无法自行决定**的状态：请求已经发往付费平台，
   * 但没等到回复。平台可能已经接单并计费，也可能没有。所以这里不做任何自动动作，
   * 只把三条出路摆出来，并且把重新提交锁在一个必须勾的确认后面 ——
   * 那个勾选框就是这个状态存在的意义：不让人不假思索地再点一次。
   */
  function submissionUnknownPanel(job: JobRecord): HTMLElement {
    const panel = h('div', { class: 'hist-resolve' });
    panel.appendChild(
      h(
        'p',
        { class: 'hist-resolve-warn' },
        `请求已经发往 ${job.providerId}，但没等到回复。平台可能已经接单并计费 —— 本地无法判断。` +
          '请先到平台账单/任务列表确认，再选择下面的处置方式。'
      )
    );

    /* ---- 1. 认领：在平台上找到了那条任务 ---- */
    const remoteInput = h('input', {
      class: 'input',
      type: 'text',
      placeholder: '平台上的任务号（在平台任务列表里能找到）'
    }) as HTMLInputElement;
    const adoptBtn = h(
      'button',
      {
        class: 'btn-ghost',
        type: 'button',
        onclick: async () => {
          const remoteId = remoteInput.value.trim();
          if (!remoteId) {
            toast('需要任务号', '认领已提交的任务必须填写平台上的任务号', 'warn');
            return;
          }
          try {
            await api.resolveSubmission(job.id, 'adopt', { remoteId });
            toast('已认领', '接着按正常流程等结果，不会重复计费');
            void load();
          } catch (e) {
            toast('认领失败', e instanceof ApiError ? e.display : String(e), 'error');
          }
        }
      },
      '认领并继续等待'
    );
    panel.appendChild(h('div', { class: 'hist-resolve-row' }, remoteInput, adoptBtn));

    /* ---- 2. 重新提交：必须先勾确认 ---- */
    const confirmBox = h('input', { type: 'checkbox', class: 'checkbox' }) as HTMLInputElement;
    const retryBtn = h(
      'button',
      {
        class: 'btn-ghost danger',
        type: 'button',
        disabled: true,
        onclick: async () => {
          try {
            await api.resolveSubmission(job.id, 'retry', { confirmedDuplicateBillingRisk: true });
            toast('已重新排队', '这是一次新的提交，会产生新的费用');
            void load();
          } catch (e) {
            toast('重新提交失败', e instanceof ApiError ? e.display : String(e), 'error');
          }
        }
      },
      '重新提交'
    ) as HTMLButtonElement;
    confirmBox.onchange = (): void => {
      if (confirmBox.checked) retryBtn.removeAttribute('disabled');
      else retryBtn.setAttribute('disabled', '');
    };
    panel.appendChild(
      h(
        'div',
        { class: 'hist-resolve-row' },
        h('label', { class: 'checkline' }, confirmBox, '我已确认平台侧的实际情况，接受可能重复扣费'),
        retryBtn
      )
    );

    /* ---- 3. 放弃 ---- */
    panel.appendChild(
      h(
        'div',
        { class: 'hist-resolve-row' },
        h(
          'button',
          {
            class: 'btn-ghost',
            type: 'button',
            onclick: async () => {
              try {
                await api.resolveSubmission(job.id, 'abandon');
                toast('已放弃这次提交', '任务标记为失败，不会再自动重来');
                void load();
              } catch (e) {
                toast('操作失败', e instanceof ApiError ? e.display : String(e), 'error');
              }
            }
          },
          '放弃这次提交'
        )
      )
    );

    return panel;
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
