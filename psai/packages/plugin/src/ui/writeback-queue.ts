/**
 * 写回的执行队列、落盘的意图/结论记录，以及重启后的对账。
 *
 * 三件事，都只能在插件这一侧解决。
 *
 * 一、Photoshop 一次只能被一个人改。
 *     写回走的是 executeAsModal —— 它是**全局独占**的。同时发起两次，
 *     第二次会直接抛「模态忙」，而那次失败跟写回本身毫无关系。
 *     每个任务一把锁不够：两条**不同**任务的写回照样会撞上。
 *     所以要一条全局队列，一次只放一个进去。
 *
 * 二、Photoshop 改完了，回报却发不出去。
 *     图**已经**进了用户的文档，而我们因为一个网络抖动把它记成
 *     「写回失败」。用户看到失败，去点「再次写回」——
 *     于是文档里出现第二个一模一样的图层。
 *     所以改文档和报结果必须分开：改完先落盘，然后只重试**回报**，
 *     绝不重新改文档。
 *
 * 三、中途被打断（面板重载、Photoshop 崩溃、断电）。
 *     这时候我们连"到底写没写进去"都不知道。什么都不记的话，
 *     只剩两个选择，而两个都是错的：当它没发生过 → 再写一次 →
 *     多一个图层；当它成功了 → 而其实没写 → 用户白等。
 *     所以动手**之前**先落一条意图，动完落一条结论；
 *     重启时按意图去文档里核对**那一次**的出处标记，而不是猜。
 *     核不出来就如实进入"不确定"，并且绝不自动再写一次。
 */

import { api, ApiError } from '../app/api.js';
import * as bridge from '../ps/bridge.js';
import {
  AckRecords,
  fileRecordStore,
  memoryRecordStore,
  type RecordStore,
  type WritebackIntent
} from './ack-store.js';

/* ---------------- 一、全局互斥 ---------------- */

let chain: Promise<unknown> = Promise.resolve();

/**
 * 排队执行一段需要独占 Photoshop 的操作。
 *
 * 前一个无论成败都不影响后一个 —— 用 catch 把链路的失败吃掉，
 * 只把结果透传给各自的调用方。
 */
export function withPhotoshopLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/* ---------------- 二、落盘记录 ---------------- */

let records: AckRecords | null = null;
function store(): AckRecords {
  if (!records) records = new AckRecords(fileRecordStore() ?? memoryRecordStore());
  return records;
}

/** 测试用：换掉落盘位置。 */
export function setAckStore(s: RecordStore): void {
  records = new AckRecords(s);
}

/**
 * 动 Photoshop **之前**必须先落这一条。
 *
 * 落不下去就不要动手 —— 没有痕迹的写回一旦被打断，
 * 就再也说不清到底写没写进去了，而那正是这套记录要避免的情况。
 */
export async function recordIntent(intent: WritebackIntent): Promise<void> {
  await store().putIntent(intent);
}

/* ---------------- 三、回报的补报队列 ---------------- */

export interface PendingAck {
  jobId: string;
  attemptId: string;
  ok: boolean;
  detail: string;
  code?: string;
  /** 已经重试过几次，只用于日志和排查 */
  tries: number;
}

const pendingAcks = new Map<string, PendingAck>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 排查与测试用：现在还有哪些结果没报上去。 */
export function pendingAckCount(): number {
  return pendingAcks.size;
}

/**
 * 停下重试计时器，但**保留**已经攒下的待报记录（内存里和盘上都留着）。
 *
 * 面板卸载时用这个，不是 clearPendingAcks。
 * 这些记录对应的是"文档已经改完、只差报一声"——正因为面板要关了，
 * 它们才更需要留到下次启动。卸载时顺手清空的话，
 * 等于每次关面板都主动制造一次"Helper 永远等不到结论"。
 */
export function stopAckFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

/** 彻底清空（含盘上那份）。给测试和"用户明确要求丢弃"用。 */
export function clearPendingAcks(): void {
  pendingAcks.clear();
  stopAckFlush();
  void store()
    .clear()
    .catch(() => undefined);
}

/**
 * 记下一个"Photoshop 那边已成定局"的结果，然后尽力报上去。
 *
 * 落盘排在发请求**前面**：反过来的话，"发出去的瞬间面板被关掉"
 * 会两头落空 —— 请求没到、盘上也没有。
 */
export async function reportOutcome(ack: Omit<PendingAck, 'tries'>): Promise<boolean> {
  pendingAcks.set(ack.attemptId, { ...ack, tries: 0 });
  await store()
    .putDone({
      attemptId: ack.attemptId,
      jobId: ack.jobId,
      ok: ack.ok,
      detail: ack.detail,
      ...(ack.code ? { code: ack.code } : {}),
      finishedAt: Date.now()
    })
    .catch(() => undefined);
  return flushAcks();
}

/**
 * 这几个 4xx 是"待会儿再来"，不是"这条请求本身有问题"。
 *
 * 一刀切地把所有 4xx 都丢掉，等于在服务端限流、或者一次请求超时的时候，
 * 直接扔掉一条**文档已经改完**的记录。Helper 那边永远等不到结论，
 * 租约过期后判成「等待插件回报超时」——用户看到"写回失败"，
 * 而他文档里那个图层好端端地待着，然后他会再写一次。
 */
const RETRYABLE_STATUS = new Set([
  408, // Request Timeout
  425, // Too Early
  429 // Too Many Requests
]);

export async function flushAcks(): Promise<boolean> {
  let allOk = true;
  for (const [id, ack] of [...pendingAcks]) {
    try {
      await api.reportWriteback(ack.jobId, ack.ok, ack.detail, ack.code, ack.attemptId);
      pendingAcks.delete(id);
      await store().forget(id).catch(() => undefined);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status >= 400 && status < 500 && !RETRYABLE_STATUS.has(status)) {
        // 凭据不认了 / 参数不对：再报一百次也是一样的结果，别占着队列
        pendingAcks.delete(id);
        await store().forget(id).catch(() => undefined);
        continue;
      }
      ack.tries++;
      allOk = false;
    }
  }
  if (!allOk) scheduleFlush();
  return allOk;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushAcks();
  }, 3000);
}

/* ---------------- 四、重启后的对账 ---------------- */

export interface ReconcileSummary {
  /** 已经有结论、只差报上去的 */
  resumed: number;
  /** 去文档里核对过、确认写进去了的 */
  confirmed: number;
  /** 去文档里核对过、确认没写进去的 */
  refuted: number;
  /** 核不出来的 —— 绝不自动再写 */
  unknown: number;
}

/**
 * 面板启动时把上一次没走完的写回接上。
 *
 * 三种记录，处理方式完全不同：
 *
 *   有结论      → 只差报一声，直接进补报队列
 *   没结论      → 去文档里找**那一次**的出处标记：
 *                 找到 = 写进去了，报成功
 *                 明确没有 = 没写进去，报失败（可以放心重试）
 *                 核不出来 = 不确定，报 WRITEBACK_UNKNOWN
 *   记录本身坏了 → 同样按不确定处理
 *
 * 不确定这一档绝不自动再写一次。文档里可能已经有一个了，
 * 再写就是第二个；而用户看不出这两个有什么区别。
 */
export async function resumePendingAcks(): Promise<ReconcileSummary> {
  const sum: ReconcileSummary = { resumed: 0, confirmed: 0, refuted: 0, unknown: 0 };
  let all;
  try {
    all = await store().all();
  } catch {
    return sum;
  }

  for (const rec of all) {
    const { intent, done, corrupt } = rec;

    // 意图都读不出来：没法核对也没法上报，只能丢掉
    if (!intent.attemptId || !intent.jobId) {
      await store().forget(intent.attemptId).catch(() => undefined);
      continue;
    }

    if (done && !corrupt) {
      pendingAcks.set(done.attemptId, {
        jobId: done.jobId,
        attemptId: done.attemptId,
        ok: done.ok,
        detail: done.detail,
        ...(done.code ? { code: done.code } : {}),
        tries: 0
      });
      sum.resumed++;
      continue;
    }

    /*
     * 没有结论（或者结论文件坏了）：上一次是在"已经动手、还没记下结果"
     * 之间断的。去文档里找证据，别猜。
     */
    const probe = corrupt
      ? 'cannot-tell'
      : bridge.probeProvenance(
          intent.documentId === null
            ? null
            : {
                documentId: intent.documentId,
                documentName: intent.documentName ?? '',
                documentPath: intent.documentPath ?? ''
              },
          { jobId: intent.jobId, assetId: intent.assetId, attemptId: intent.attemptId }
        );

    if (probe === 'found') {
      pendingAcks.set(intent.attemptId, {
        jobId: intent.jobId,
        attemptId: intent.attemptId,
        ok: true,
        detail: '写回已完成（重启后在文档里核对到结果图层）',
        tries: 0
      });
      sum.confirmed++;
    } else if (probe === 'absent') {
      pendingAcks.set(intent.attemptId, {
        jobId: intent.jobId,
        attemptId: intent.attemptId,
        ok: false,
        detail: '上一次写回被中断，文档里没有留下结果 —— 可以放心重试',
        code: 'WRITEBACK_FAILED',
        tries: 0
      });
      sum.refuted++;
    } else {
      /*
       * 不确定。如实上报，让这条任务停在一个**需要人看一眼**的状态，
       * 而不是继续假装它失败了（用户会去重试，可能多一个图层）
       * 或者假装成功了（用户以为拿到了，其实没有）。
       */
      pendingAcks.set(intent.attemptId, {
        jobId: intent.jobId,
        attemptId: intent.attemptId,
        ok: false,
        detail:
          `上一次写回被中断，而${intent.documentName ? `「${intent.documentName}」` : '源文档'}` +
          '现在打不开，无法确认结果是否已经写进去。请先打开该文档检查，再决定是否重写。',
        code: 'WRITEBACK_UNKNOWN',
        tries: 0
      });
      sum.unknown++;
    }
  }

  if (pendingAcks.size > 0) void flushAcks();
  return sum;
}
