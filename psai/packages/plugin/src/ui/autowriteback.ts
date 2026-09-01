/**
 * 自动写回。
 *
 * 「自动写回」这个开关以前是个摆设：设置页能打开、Helper 也会把它读出来，
 * 但读出来只用于挑一句提示文案（「等待插件写回」还是「等待用户确认写回」）——
 * 没有任何代码真的去写。用户打开它，然后对着一堆停在「等待写回」的任务
 * 等一个永远不会到来的动作。
 *
 * 写回必须发生在插件里：只有 UXP 这一侧碰得到 Photoshop。所以"自动"这件事
 * 只能由这里驱动 —— Helper 负责把任务推到 writeback_pending 并发放执行权凭据，
 * 这个模块负责看见它、并把活干了。
 *
 * 三个地方会触发扫描，缺一不可：
 *   1. 收到 job:update（正常路径，任务刚出图）
 *   2. WebSocket 重连之后（断线期间完成的任务，那几条 job:update 已经错过了）
 *   3. 面板启动时（Photoshop 关掉再打开，或者插件被重新加载）
 * 少了后两条，"断线/重启期间完成的任务"就会永远停在待写回 ——
 * 而那恰恰是自动写回最该顶用的场景：用户去泡了杯咖啡。
 */

import { isTerminal } from '@psai/shared';
import type { JobRecord } from '@psai/shared';
import { getState, setState, toast } from '../app/store.js';
import { api } from '../app/api.js';
import { flushAcks } from './writeback-queue.js';
import * as bridge from '../ps/bridge.js';
import { performWritebackDetailed } from './page-generate.js';

/**
 * 本进程里已经在驱动的任务。
 *
 * Helper 那边的租约才是权威的互斥（跨进程也管用），这一层只是省掉无谓的往返：
 * 一次生成会连着推来好几条 job:update，没有它的话每一条都会去打一次
 * /writeback，然后收到一串 WRITEBACK_IN_PROGRESS。
 */
const inFlight = new Set<string>();

/**
 * 已经放弃自动写回的任务。
 *
 * 分两种，处理方式完全不同：
 *   'failed'   写回真的失败了（文档关了、尺寸变了…）。重试一百次也一样，
 *              而每次都会弹一个红色提示。永久放弃，等用户手动点。
 *   'busy'     只是撞上了别人正在写（WRITEBACK_IN_PROGRESS）。
 *              这**不是**失败 —— 那次写回可能几秒后就完了，也可能是一条
 *              卡死的租约、两分钟后自动让位。永久放弃的话，
 *              一次偶然的撞车会让这条任务再也不会被自动写回，
 *              而用户完全看不出为什么。所以记一个到期时间，过了就再试。
 */
type GiveUp = { kind: 'failed' } | { kind: 'busy'; retryAfter: number };

const givenUp = new Map<string, GiveUp>();

/**
 * 租约过期的时间。Helper 那边是 120 秒，这里留一点余量再试，
 * 免得刚好卡在边界上又撞一次。
 */
const BUSY_RETRY_MS = 130_000;

/** 这一条现在还处于"放弃"状态吗。busy 到期了就自动解除。 */
function isGivenUp(jobId: string): boolean {
  const g = givenUp.get(jobId);
  if (!g) return false;
  if (g.kind === 'failed') return true;
  if (Date.now() >= g.retryAfter) {
    givenUp.delete(jobId);
    return false;
  }
  return true;
}

function shouldAuto(job: JobRecord): boolean {
  if (job.state !== 'writeback_pending') return false;
  // auto 是任务创建时冻结的，不是当前设置 —— 用户中途改开关不影响已在途的任务
  if (job.writeback?.auto !== true) return false;
  if (!job.target || job.results.length === 0) return false;
  if (job.writeback.mode === 'assetOnly') return false;

  /*
   * 上一次写回结果**不确定**的，绝不自动再写。
   *
   * 「不确定」的意思是：上次写回被中断，而重启后核不出来到底写没写进去
   * （源文档没打开、或者身份对不上）。文档里可能已经有一个结果图层了 ——
   * 自动再写一次就是第二个，而用户看不出这两个有什么区别，
   * 也不知道该删哪个。
   *
   * 这一档必须由人来判断：先打开文档看一眼，再决定重写还是就这样。
   * 手动点「再次写回」不受影响 —— 那是用户看过之后做的决定。
   */
  if (job.error?.code === 'WRITEBACK_UNKNOWN') return false;
  return true;
}

/**
 * 看一眼这条任务要不要自动写回，要就去写。
 *
 * 任何一步不满足都安静返回：自动写回是背景行为，用户没有在等它的回应，
 * 对着每一条不满足条件的任务弹提示只会变成噪音。
 * 真正失败时 performWriteback 会照常报出来 —— 那个必须说，
 * 因为用户会以为图已经进文档了。
 */
export async function maybeAutoWriteback(job: JobRecord): Promise<void> {
  if (!shouldAuto(job)) return;
  if (inFlight.has(job.id)) return;
  if (isGivenUp(job.id)) return;

  // Photoshop 那边不可用时不要反复试。等它可用了，下一次扫描自然会捡起来。
  if (!bridge.isAvailable()) return;

  inFlight.add(job.id);
  try {
    const res = await performWritebackDetailed(job, job.writeback!.mode, job.writeback!.layerName || 'AI 结果', {
      auto: true
    });
    if (!res.ok) {
      /*
       * 区分"真失败"和"只是撞上了别人正在写"。
       *
       * 真失败（文档关了、尺寸变了、目标图层没了）重试一百次也一样，
       * 而每次都会弹一个红色提示 —— 永久放弃，等用户手动点。
       *
       * 撞车不是失败：那次写回可能几秒后就完了，也可能是一条卡死的租约、
       * 两分钟后自动让位。当成永久失败的话，一次偶然的撞车会让这条任务
       * 再也不会被自动写回，而用户完全看不出为什么。
       */
      givenUp.set(
        job.id,
        res.busy ? { kind: 'busy', retryAfter: Date.now() + BUSY_RETRY_MS } : { kind: 'failed' }
      );
    }
  } catch {
    givenUp.set(job.id, { kind: 'failed' });
  } finally {
    inFlight.delete(job.id);
  }
}

/**
 * 把当前已知的任务全过一遍。
 *
 * 重连和启动后调用。断线期间完成的任务，它们的 job:update 我们没收到 ——
 * 只靠事件驱动的话，那些任务会永远停在待写回。
 */
export async function reconcileAutoWriteback(opts: { refresh?: boolean } = {}): Promise<void> {
  if (!bridge.isAvailable()) return;

  /*
   * 先把没报上去的结果补报掉。
   *
   * 断线期间可能有"Photoshop 已经改完、回报没发出去"的结果卡在队列里。
   * 不先补这一批的话，下面的扫描会看到它们还停在 writeback_pending，
   * 于是**再写一遍** —— 用户文档里多一个图层。补报要排在扫描前面。
   */
  await flushAcks();

  /*
   * 重新拉一份任务列表。
   *
   * 断线期间的 job:update 我们没收到，内存里那份是断线**之前**的快照 ——
   * 拿它去判断"谁还等着写回"，会漏掉断线期间才完成的那些，
   * 而那恰恰是这个函数存在的全部理由。
   */
  if (opts.refresh !== false) {
    try {
      const jobs = await api.jobs({ limit: 100 });
      setState({ jobs });
    } catch {
      // 拉不回来就用内存里那份凑合，总比什么都不做强
    }
  }

  const jobs = getState().jobs.filter(shouldAuto);
  if (jobs.length === 0) return;

  // 一条一条来，不并发：写回要独占 Photoshop（executeAsModal），
  // 同时发几条只会让它们互相排队并抛"模态忙"。
  let done = 0;
  for (const job of jobs) {
    const before = getState().jobs.find((j) => j.id === job.id) ?? job;
    if (!shouldAuto(before)) continue; // 这期间可能已经被别处写回了
    await maybeAutoWriteback(before);
    const after = getState().jobs.find((j) => j.id === job.id);
    if (after && after.state === 'succeeded') done++;
  }

  // 这一条要说：用户离开了一会儿，回来该知道文档被动过。
  if (done > 0) toast('已自动写回', `${done} 个任务的结果已写入 Photoshop`);
}

/** 任务被删掉或重跑时清掉记忆，否则「放弃过」会一直粘着。 */
export function forgetAutoWriteback(jobId: string): void {
  givenUp.delete(jobId);
  inFlight.delete(jobId);
}

/**
 * 排查与测试用：哪些任务被**永久**放弃了（真失败）。
 *
 * 只算 failed 那一类。撞车（busy）是临时按下不表，到点还会再试 ——
 * 把它也算进"放弃"里的话，两种完全不同的处境就分不出来了，
 * 而它们对用户的意义天差地别：一个要他手动点一下，一个什么都不用做。
 */
export function autoWritebackGivenUp(): string[] {
  return [...givenUp.entries()].filter(([, g]) => g.kind === 'failed').map(([id]) => id);
}

/** 排查与测试用：这条任务因为撞车被按下不表，到什么时候为止。 */
export function autoWritebackHeldUntil(jobId: string): number | null {
  const g = givenUp.get(jobId);
  return g && g.kind === 'busy' && Date.now() < g.retryAfter ? g.retryAfter : null;
}

/** 终态且已成功的任务不必再留记录，免得这两张表无限长。 */
export function pruneAutoWriteback(jobs: JobRecord[]): void {
  for (const id of [...givenUp.keys()]) {
    const j = jobs.find((x) => x.id === id);
    if (!j || (isTerminal(j.state) && j.state === 'succeeded')) givenUp.delete(id);
  }
}
