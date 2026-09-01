/**
 * 断线重连之后，把面板里的任务列表和 Helper 对齐。
 *
 * 为什么需要这件事：WebSocket 断开期间的 job:update 是**不补发**的。
 * 网络抖一下、Helper 重启一次、机器睡一觉醒来 —— 这期间任务照跑，
 * 而面板里那份快照停在断线那一刻。用户看到的是一堆永远停在
 * 「生成中」的任务，而它们其实早就完成了。
 *
 * 为什么不能简单地"拉一份新的盖上去"：
 *
 *   1. 那次 REST 请求是要花时间的（几十到几百毫秒）。这期间
 *      WebSocket 可能已经连上并推来了**更新的**状态。
 *      直接覆盖的话，一个几百毫秒前的快照会把刚收到的新状态盖掉 ——
 *      任务在界面上"倒退"回旧状态，然后停在那儿不动，
 *      因为下一条推送要等到下一次状态变化。
 *
 *   2. 列表是分页的。拉回 100 条不等于"总共只有 100 条"，
 *      拿它去判断"本地那条不在里面 = 被删了"会误删翻页范围之外的任务。
 *
 * 所以合并是**单调**的：逐条比 updatedAt，谁新用谁；
 * 删除只在快照确实覆盖到的范围内判定。
 */

import type { JobRecord } from '@psai/shared';

export interface MergeOptions {
  /**
   * 这一页是不是"全部"（返回条数 < limit 就说明后面没有了）。
   *
   * 只有全量的时候，"本地有、快照没有"才能推断成删除。
   * 分页的时候只能在快照覆盖到的时间范围内判断。
   */
  complete: boolean;
  /**
   * 发起这次快照请求的时刻。
   *
   * 比这个时刻更晚更新过的本地任务，一律不动 —— 它们的状态来自
   * 快照**之后**才到的推送，比快照新。
   */
  requestedAt: number;
}

/**
 * 把一份 REST 快照合并进本地列表。
 *
 * 规则只有三条：
 *   · 快照里有、本地没有        → 加进来（断线期间新建的）
 *   · 两边都有                  → 谁的 updatedAt 大用谁（绝不让旧的盖新的）
 *   · 本地有、快照没有          → 只在快照覆盖得到、且本地那条不比快照新时，才当作已删除
 */
export function mergeJobSnapshot(local: JobRecord[], snapshot: JobRecord[], opts: MergeOptions): JobRecord[] {
  const byId = new Map<string, JobRecord>();
  for (const j of local) byId.set(j.id, j);

  const snapIds = new Set<string>();
  let oldestInSnapshot = Number.POSITIVE_INFINITY;

  for (const remote of snapshot) {
    snapIds.add(remote.id);
    oldestInSnapshot = Math.min(oldestInSnapshot, remote.createdAt);

    const mine = byId.get(remote.id);
    if (!mine) {
      byId.set(remote.id, remote);
      continue;
    }
    /*
     * 相等时用快照。
     *
     * 同一毫秒里既推过又拉过的情况下，两份内容本来就该一样；
     * 而如果不一样，服务端那份才是权威的。
     */
    if (remote.updatedAt >= mine.updatedAt) byId.set(remote.id, remote);
  }

  for (const [id, mine] of [...byId]) {
    if (snapIds.has(id)) continue;

    /*
     * 本地有、快照没有。可能是被删了，也可能只是：
     *   · 它在翻页范围之外（快照没覆盖到那么老）
     *   · 它是在快照请求发出**之后**才建的（快照拍的时候还不存在）
     * 这两种都不能当成删除 —— 删错了用户会看到自己的任务凭空消失。
     */
    if (!opts.complete && mine.createdAt < oldestInSnapshot) continue;
    if (mine.updatedAt > opts.requestedAt) continue;
    byId.delete(id);
  }

  // 和 Helper 的列表口径一致：新的在前
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}
