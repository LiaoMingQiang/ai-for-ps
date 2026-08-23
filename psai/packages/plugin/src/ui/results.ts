/**
 * 进度与结果区：进度条 → 结果缩略图 → 前后对比 → 写回选择器。
 */

import { JOB_STATE_LABELS, WRITEBACK_MODE_LABELS, isTerminal, AI_SUCCEEDED_STATES } from '@psai/shared';
import type { JobRecord, WritebackMode } from '@psai/shared';
import { h, clear, formatDuration, toggleClass } from '../app/dom.js';
import { api, assetImgSrc } from '../app/api.js';

export interface ResultsOptions {
  job: JobRecord | null;
  /** 输入图预览，用于前后对比 */
  inputPreview: string | null;
  availableModes: WritebackMode[];
  onWriteback(mode: WritebackMode, layerName: string): void;
  onCancel(): void;
  onDiscard(): void;
  onRetry(): void;
}

const ACTIVE_HINT: Record<string, string> = {
  inputs_uploading: '正在上传输入图',
  queued_local: '本地排队中',
  submitting: '正在提交',
  submitted: '已提交，等待远端调度',
  remote_queued: '远端排队中',
  running: '生成中',
  downloading: '正在下载结果'
};

export function renderResults(opts: ResultsOptions): HTMLElement {
  const card = h('section', { class: 'card results' });
  const job = opts.job;

  if (!job) {
    card.appendChild(h('h3', { class: 'card-title' }, '结果'));
    card.appendChild(h('div', { class: 'muted results-empty' }, '还没有提交过任务'));
    return card;
  }

  const title = h(
    'h3',
    { class: 'card-title' },
    '结果',
    h('span', { class: `state-chip state-${job.state}` }, JOB_STATE_LABELS[job.state])
  );
  card.appendChild(title);

  /* ---- 进度 ---- */
  if (!isTerminal(job.state) || job.state === 'writeback_pending') {
    const pct = job.progress.value === null ? null : Math.round(job.progress.value * 100);
    const bar = h('div', { class: `progress ${pct === null ? 'indeterminate' : ''}` });
    const fill = h('div', { class: 'progress-fill' });
    if (pct !== null) fill.style.width = `${pct}%`;
    bar.appendChild(fill);

    const parts: string[] = [];
    parts.push(job.progress.message || ACTIVE_HINT[job.state] || JOB_STATE_LABELS[job.state]);
    if (job.progress.step !== null && job.progress.total) parts.push(`步 ${job.progress.step}/${job.progress.total}`);
    if (job.progress.node) parts.push(`节点 ${job.progress.node}`);
    if (pct !== null) parts.push(`${pct}%`);

    card.appendChild(bar);
    card.appendChild(h('div', { class: 'progress-text muted' }, parts.join(' · ')));

    if (!isTerminal(job.state)) {
      card.appendChild(
        h(
          'div',
          { class: 'row gap' },
          h('button', { class: 'btn-ghost', type: 'button', onclick: opts.onCancel }, '取消任务')
        )
      );
    }
  }

  /* ---- 错误 ---- */
  if (job.error) {
    const box = h('div', { class: `errbox ${AI_SUCCEEDED_STATES.has(job.state) ? 'warn' : 'error'}` });
    box.appendChild(h('div', { class: 'errbox-code' }, job.error.code));
    box.appendChild(h('div', { class: 'errbox-msg' }, job.error.message));
    if (job.error.details) box.appendChild(h('pre', { class: 'errbox-detail' }, job.error.details));

    const actions = h('div', { class: 'row gap' });
    if (job.state === 'failed' || job.state === 'lost') {
      actions.appendChild(h('button', { class: 'btn-ghost', type: 'button', onclick: opts.onRetry }, '重试'));
    }
    if (job.error.code === 'JOB_CANCEL_UNSUPPORTED') {
      actions.appendChild(
        h('button', { class: 'btn-ghost', type: 'button', onclick: opts.onDiscard }, '仍然丢弃结果')
      );
    }
    if (actions.children.length) box.appendChild(actions);
    card.appendChild(box);
  }

  /* ---- 结果图 ---- */
  if (job.results.length > 0) {
    const strip = h('div', { class: 'result-strip' });
    let activeIdx = 0;
    const stage = h('div', { class: 'result-stage' });

    const showAt = (i: number): void => {
      activeIdx = i;
      clear(stage);
      const r = job.results[i]!;
      const img = h('img', { class: 'result-img', alt: `结果 ${i + 1}` }) as HTMLImageElement;
      void assetImgSrc(r.assetId).then((src) => (img.src = src));
      stage.appendChild(img);
      stage.appendChild(h('div', { class: 'result-meta muted' }, `${r.width}×${r.height}`));

      // 前后对比
      if (opts.inputPreview) {
        const compare = h('div', { class: 'compare' });
        const before = h('img', { class: 'compare-before', src: opts.inputPreview, alt: '原图' });
        const afterWrap = h('div', { class: 'compare-after-wrap' });
        const after = h('img', { class: 'compare-after', alt: '结果' }) as HTMLImageElement;
        void assetImgSrc(r.assetId).then((src) => (after.src = src));
        afterWrap.appendChild(after);
        const handle = h('div', { class: 'compare-handle' });
        compare.appendChild(before);
        compare.appendChild(afterWrap);
        compare.appendChild(handle);

        const setSplit = (ratio: number): void => {
          const clamped = Math.min(1, Math.max(0, ratio));
          afterWrap.style.width = `${clamped * 100}%`;
          handle.style.left = `${clamped * 100}%`;
        };
        setSplit(0.5);

        let dragging = false;
        const move = (e: PointerEvent): void => {
          if (!dragging) return;
          const rect = compare.getBoundingClientRect();
          setSplit((e.clientX - rect.left) / rect.width);
        };
        compare.addEventListener('pointerdown', ((e: PointerEvent) => {
          dragging = true;
          move(e);
        }) as EventListener);
        compare.addEventListener('pointermove', move as EventListener);
        compare.addEventListener('pointerup', (() => (dragging = false)) as EventListener);
        compare.addEventListener('pointerleave', (() => (dragging = false)) as EventListener);

        const details = h('details', { class: 'compare-wrap' }, h('summary', {}, '前后对比'), compare);
        stage.appendChild(details);
      }

      for (const [n, b] of Array.from(strip.children).entries()) toggleClass(b, 'active', n === i);
    };

    if (job.results.length > 1) {
      job.results.forEach((r, i) => {
        const t = h('button', { class: 'result-tab', type: 'button', onclick: () => showAt(i) }, `#${i + 1}`);
        strip.appendChild(t);
      });
      card.appendChild(strip);
    }
    card.appendChild(stage);
    showAt(activeIdx);
  }

  /* ---- 写回 ---- */
  const canWriteback =
    job.target !== null &&
    job.results.length > 0 &&
    ['result_ready', 'writeback_pending', 'retryable_writeback_failure', 'succeeded'].includes(job.state);

  if (canWriteback) {
    const modes = opts.availableModes.filter((m) => {
      if (m === 'inPlaceSelection') return !!job.target?.selectionBounds;
      return true;
    });
    const select = h('select', { class: 'input select' }) as HTMLSelectElement;
    for (const m of modes) {
      const opt = h('option', { value: m }, WRITEBACK_MODE_LABELS[m]) as HTMLOptionElement;
      if (m === job.writeback?.mode) opt.setAttribute('selected', '');
      select.appendChild(opt);
    }

    const nameInput = h('input', { class: 'input', type: 'text' }) as HTMLInputElement;
    nameInput.value = job.writeback?.layerName ?? 'AI 结果';

    const btn = h(
      'button',
      {
        class: 'btn-primary',
        type: 'button',
        onclick: () => opts.onWriteback(select.value as WritebackMode, nameInput.value.trim() || 'AI 结果')
      },
      job.state === 'succeeded' ? '再次写回 Photoshop' : '写回 Photoshop'
    );

    card.appendChild(
      h(
        'div',
        { class: 'writeback' },
        h('div', { class: 'writeback-row' }, h('label', { class: 'wb-label' }, '写回方式'), select),
        h('div', { class: 'writeback-row' }, h('label', { class: 'wb-label' }, '图层名'), nameInput),
        btn
      )
    );
  }

  /* ---- 耗时 ---- */
  if (job.finishedAt && job.startedAt) {
    const bits = [`耗时 ${formatDuration(job.finishedAt - job.startedAt)}`];
    if (job.gpuMs) bits.push(`GPU ${formatDuration(job.gpuMs)}`);
    bits.push(`Provider ${job.providerId}`);
    card.appendChild(h('div', { class: 'muted result-footer' }, bits.join(' · ')));
  }

  return card;
}

export { api };
