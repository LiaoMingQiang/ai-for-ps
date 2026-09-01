/**
 * 写回意图与结论的落盘记录。
 *
 * 为什么必须落盘，而且必须在**动 Photoshop 之前**就落：
 *
 * 写回这一步不可撤销 —— 图一旦进了用户的文档，就没有"重来一次"这回事。
 * 而它中间可能被打断：面板重载、Photoshop 崩溃、整台机器断电。
 * 打断之后如果我们什么都不知道，只有两种选择，而两种都是错的：
 *
 *   · 当它没发生过 → 再写一次 → 用户文档里多一个一模一样的图层
 *   · 当它成功了   → 而其实没写进去 → 用户以为拿到了结果，其实没有
 *
 * 所以要留下痕迹：动手**之前**记一条「打算写」，动完记一条「写完了，
 * 结果是什么」。重启时按这两条痕迹去核对文档，而不是猜。
 *
 * ── 为什么是一条记录一个文件 ──
 *
 * 早先是一整个 JSON 数组反复覆写。那有两个问题：
 *   1. 覆写不是原子的。写到一半断电，整个队列一起变成一段坏 JSON ——
 *      不是丢一条，是全丢。
 *   2. 两次写回并发时，后写的那次会把前一次的内容整个盖掉。
 *
 * 现在每个 attempt 一个文件，各写各的，互不覆盖。
 * 「有没有结论」由**另一个文件在不在**表示 —— 创建文件比原地覆写
 * 更接近原子操作，而且断电时最坏的结果只是那一个文件坏掉，
 * 而那种情况本来就要走"不确定"那条路。
 */

const DIR_HINT = 'psai-wb';
const INTENT_SUFFIX = '.intent.json';
const DONE_SUFFIX = '.done.json';

/** 动手之前记下来的东西：这次打算做什么。 */
export interface WritebackIntent {
  attemptId: string;
  jobId: string;
  assetId: string;
  mode: string;
  layerName: string;
  /** 目标文档的耐久身份，重启后核对用 */
  documentId: number | null;
  documentName: string | null;
  documentPath: string | null;
  /** 写进图层名里的那段标记，重启后靠它在文档里找证据 */
  provenanceTag: string;
  startedAt: number;
}

/** 动完之后记下来的东西：结果是什么。 */
export interface WritebackDone {
  attemptId: string;
  jobId: string;
  ok: boolean;
  detail: string;
  code?: string;
  finishedAt: number;
}

export interface StoredRecord {
  intent: WritebackIntent;
  /** 没有就是"动手了但没等到结论"—— 重启时要去文档里核对 */
  done: WritebackDone | null;
  /** 文件坏了（写到一半断电）。这种一律按"不确定"处理 */
  corrupt: boolean;
}

/**
 * 底层存储。抽出来是为了能在测试里换掉 —— 而"面板重载后还在不在"
 * 这件事只有换得掉才测得出来。
 */
export interface RecordStore {
  /** 写一个文件（同名就覆盖）。 */
  write(name: string, text: string): Promise<void>;
  /** 读一个文件；不存在返回 null。 */
  read(name: string): Promise<string | null>;
  /** 删一个文件；不存在不算错。 */
  remove(name: string): Promise<void>;
  /** 列出所有文件名。 */
  list(): Promise<string[]>;
}

interface UxpEntry {
  name: string;
  read(opts?: unknown): Promise<string>;
  write(data: string, opts?: unknown): Promise<void>;
  delete(): Promise<void>;
}

interface UxpFolder {
  createFile(name: string, opts?: unknown): Promise<UxpEntry>;
  getEntry(name: string): Promise<UxpEntry>;
  getEntries(): Promise<UxpEntry[]>;
  createFolder(name: string): Promise<UxpFolder>;
}

function uxpFs(): { getDataFolder(): Promise<UxpFolder> } | null {
  try {
    const uxp = (globalThis as { require?: (m: string) => unknown }).require?.('uxp') as
      | { storage?: { localFileSystem?: { getDataFolder(): Promise<UxpFolder> } } }
      | undefined;
    return uxp?.storage?.localFileSystem ?? null;
  } catch {
    return null;
  }
}

/** 真正落盘的实现。拿不到 UXP 文件系统时返回 null，调用方退回内存版。 */
export function fileRecordStore(): RecordStore | null {
  const lfs = uxpFs();
  if (!lfs) return null;

  async function folder(): Promise<UxpFolder> {
    const data = await lfs!.getDataFolder();
    /*
     * 单独开一个子目录。数据目录里还有临时结果 PNG 之类的东西，
     * 混在一起的话 list() 每次都要在一堆无关文件里筛，
     * 而且容易被别处的清理逻辑误删。
     */
    try {
      return await data.createFolder(DIR_HINT);
    } catch {
      // 已经存在时 createFolder 会抛，退回按名字取
      const e = (await data.getEntry(DIR_HINT)) as unknown as UxpFolder;
      return e;
    }
  }

  return {
    async write(name, text) {
      const f = await folder();
      const file = await f.createFile(name, { overwrite: true });
      await file.write(text);
    },
    async read(name) {
      try {
        const f = await folder();
        const e = await f.getEntry(name);
        return await e.read();
      } catch {
        return null;
      }
    },
    async remove(name) {
      try {
        const f = await folder();
        const e = await f.getEntry(name);
        await e.delete();
      } catch {
        /* 不存在就算了 */
      }
    },
    async list() {
      try {
        const f = await folder();
        const entries = await f.getEntries();
        return entries.map((e) => e.name);
      } catch {
        return [];
      }
    }
  };
}

/** 内存版：拿不到文件系统时的退路，也用于测试。 */
export function memoryRecordStore(backing = new Map<string, string>()): RecordStore {
  return {
    write: async (name, text) => {
      backing.set(name, text);
    },
    read: async (name) => backing.get(name) ?? null,
    remove: async (name) => {
      backing.delete(name);
    },
    list: async () => [...backing.keys()]
  };
}

/* ---------------- 记录的读写 ---------------- */

/**
 * 所有写盘操作排成一条链。
 *
 * 两次写回可以同时在跑（一次在等 Photoshop，一次在等网络）。
 * 不串起来的话，两个 write 交错落到同一个后端上，
 * 而 UXP 的文件接口没有承诺过并发安全。
 * 记录本来就少、也小，串行的代价可以忽略。
 */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export class AckRecords {
  constructor(private store: RecordStore) {}

  setStore(s: RecordStore): void {
    this.store = s;
  }

  /** 动手之前先落一条意图。**必须**在碰 Photoshop 之前 await 它。 */
  async putIntent(intent: WritebackIntent): Promise<void> {
    await serialize(() => this.store.write(`${intent.attemptId}${INTENT_SUFFIX}`, JSON.stringify(intent)));
  }

  /**
   * 落结论。
   *
   * 单独一个文件，而不是改写意图那一份 —— 「有没有结论」由
   * 这个文件在不在表示，创建文件比原地覆写更接近原子操作。
   */
  async putDone(done: WritebackDone): Promise<void> {
    await serialize(() => this.store.write(`${done.attemptId}${DONE_SUFFIX}`, JSON.stringify(done)));
  }

  /** 报上去了，两份都可以删了。 */
  async forget(attemptId: string): Promise<void> {
    await serialize(async () => {
      await this.store.remove(`${attemptId}${DONE_SUFFIX}`);
      await this.store.remove(`${attemptId}${INTENT_SUFFIX}`);
    });
  }

  /** 全清。给测试和"用户明确要求丢弃"用。 */
  async clear(): Promise<void> {
    await serialize(async () => {
      for (const n of await this.store.list()) {
        if (n.endsWith(INTENT_SUFFIX) || n.endsWith(DONE_SUFFIX)) await this.store.remove(n);
      }
    });
  }

  /** 读出所有还没报掉的记录。 */
  async all(): Promise<StoredRecord[]> {
    return serialize(async () => {
      const names = await this.store.list();
      const out: StoredRecord[] = [];
      for (const n of names) {
        if (!n.endsWith(INTENT_SUFFIX)) continue;
        const attemptId = n.slice(0, -INTENT_SUFFIX.length);
        const rawIntent = await this.store.read(n);
        const intent = parse<WritebackIntent>(rawIntent);
        if (!intent || typeof intent.attemptId !== 'string' || typeof intent.jobId !== 'string') {
          /*
           * 意图这一份就坏了 —— 连是哪条任务都不知道，没法核对，也没法上报。
           * 只能丢掉并留个日志。这比留着一份永远处理不了的记录好：
           * 后者会在每次启动时被重新捡起来，永远失败。
           */
          out.push({
            intent: { ...emptyIntent(), attemptId },
            done: null,
            corrupt: true
          });
          continue;
        }
        const rawDone = await this.store.read(`${attemptId}${DONE_SUFFIX}`);
        const done = rawDone === null ? null : parse<WritebackDone>(rawDone);
        out.push({
          intent,
          done: done && typeof done.ok === 'boolean' ? done : null,
          // 结论文件在但解不开 = 写到一半断电，按"不确定"处理
          corrupt: rawDone !== null && (!done || typeof done.ok !== 'boolean')
        });
      }
      return out;
    });
  }
}

function parse<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function emptyIntent(): WritebackIntent {
  return {
    attemptId: '',
    jobId: '',
    assetId: '',
    mode: '',
    layerName: '',
    documentId: null,
    documentName: null,
    documentPath: null,
    provenanceTag: '',
    startedAt: 0
  };
}
