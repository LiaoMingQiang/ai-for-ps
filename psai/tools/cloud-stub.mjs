/**
 * 付费云端 Provider 的桩（OpenAI 兼容协议）。
 *
 * 存在的理由只有一个：**付费提交的崩溃安全没法在真平台上测**。
 * 「请求发出去了但没等到回复」这一刻，恰恰是会重复扣费的那一刻，
 * 而在真平台上复现它意味着真的花钱、而且没法稳定复现。
 *
 * 所以这里把上游的行为做成可切换的开关：
 *   ok      正常返回一张图（同步出图，和 Comfly / Gemini 一样）
 *   hang    收下请求就不回复了 —— 崩溃恢复要的"请求悬在半空"就是这个
 *   reset   收下请求后直接掐断连接 —— "不知道对面收没收"的典型形态
 *   status  返回指定的 HTTP 状态码，用来测明确拒绝（401 之类）
 *
 * submits 记录每一次真的打到 /images/* 的提交，测试据此断言
 * 「恢复流程绝不重新提交」—— 这是整个改动最贵的一条规则。
 */

import { createServer } from 'node:http';
import { makePng } from './comfy-stub.mjs';
import { listenSafe } from './listen-safe.mjs';

export async function startCloudStub(port = 0, behavior = {}) {
  const state = {
    mode: behavior.mode ?? 'ok',
    status: behavior.status ?? 500,
    /** 每次提交的记录：{ path, idempotencyKey, at } */
    submits: [],
    /** 每一次打到 /chat/completions 的记录（反推 / 优化提示词） */
    chats: [],
    /** 每一次打到 Midjourney 代理提交接口的记录 */
    mjSubmits: [],
    chatHang: false,
    /** chatHang 开着时挂住的 /chat/completions 连接 */
    heldChats: new Set(),
    /** hang 模式下挂住的连接，stop() 时统一掐掉 */
    held: new Set()
  };

  const png = makePng(64, 64, [200, 120, 40]);

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // 请求体读完再处理：不读的话客户端可能卡在写 body 上
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (path.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [{ id: 'stub-image-model' }, { id: 'gpt-4o-mini' }]
          })
        );
        return;
      }

      /*
       * 反推 / 优化提示词走 /chat/completions。
       *
       * chatHang 单独一个开关：提交前的这段准备工作也可能跑几十秒，
       * 用户在那个窗口里点取消，是一条独立的路径 ——
       * 老代码在这里会把任务判成已取消、却照样提交出去。
       */
      if (path.endsWith('/chat/completions')) {
        state.chats.push({ at: Date.now(), idempotencyKey: req.headers['idempotency-key'] ?? null });
        if (state.chatHang) {
          state.heldChats.add(res);
          res.on('close', () => state.heldChats.delete(res));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '桩：优化后的提示词' } }] }));
        return;
      }

      /*
       * Midjourney 代理。它**不在** /v1 底下（baseUrl 是 …/v1，
       * 而提交要打 …/mj/submit/imagine），而且是异步出图：只回一个任务号。
       * 这条路一样是真金白银的一次调用，幂等键不能漏 —— 桩要能验证它带了。
       */
      if (path.endsWith('/mj/submit/imagine')) {
        state.mjSubmits.push({
          at: Date.now(),
          idempotencyKey: req.headers['idempotency-key'] ?? null,
          mjSecret: req.headers['mj-api-secret'] ?? null
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 1, description: '提交成功', result: '1949273610948169729' }));
        return;
      }
      if (path.startsWith('/mj/task/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: '1949273610948169729',
            status: 'SUCCESS',
            progress: '100%',
            imageUrl: `http://127.0.0.1:${actualPort}/mj-result.png`
          })
        );
        return;
      }
      if (path.endsWith('/mj-result.png')) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
        res.end(png);
        return;
      }

      const isSubmit = path.includes('/images/');
      if (isSubmit) {
        state.submits.push({
          path,
          idempotencyKey: req.headers['idempotency-key'] ?? null,
          at: Date.now()
        });
      }

      if (isSubmit && state.mode === 'hang') {
        // 不回复、不关闭 —— 这就是"请求悬在半空"
        state.held.add(res);
        res.on('close', () => state.held.delete(res));
        return;
      }

      if (isSubmit && state.mode === 'reset') {
        // 收下了、然后掐断。客户端只知道"连接断了"，
        // 分不清对面处理了没有 —— 正是要测的那种模糊失败。
        res.socket?.destroy();
        return;
      }

      if (isSubmit && state.mode === 'status') {
        res.writeHead(state.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '桩：按测试要求返回的错误' } }));
        return;
      }

      if (isSubmit) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `桩没有实现 ${path}` } }));
    });
  });

  // 避开 WHATWG 禁用端口：撞上的话调用方用 fetch 根本连不进来（见 listen-safe.mjs）
  const actualPort = await listenSafe(server, port, '127.0.0.1');

  return {
    url: `http://127.0.0.1:${actualPort}/v1`,
    get submits() {
      return state.submits;
    },
    setMode(mode, status) {
      state.mode = mode;
      if (typeof status === 'number') state.status = status;
    },
    get chats() {
      return state.chats;
    },
    get mjSubmits() {
      return state.mjSubmits;
    },
    /** /chat/completions 收下请求但永不回复 —— 提交前的准备工作悬在半空 */
    setChatHang(on) {
      state.chatHang = on;
      if (!on) this.releaseChats();
    },
    /**
     * 让挂住的 /chat/completions **成功**返回。
     *
     * 掐断和成功返回是两种完全不同的现场，测的东西也不同：
     * 掐断验证的是"中止管不管用"，成功返回验证的是
     * "取消之后那段准备工作照常跑完了，接下来还会不会把任务提交出去"——
     * 后者才是老代码真正漏掉的那条路。
     */
    releaseChats() {
      for (const r of state.heldChats) {
        try {
          r.writeHead(200, { 'Content-Type': 'application/json' });
          r.end(JSON.stringify({ choices: [{ message: { content: '桩：优化后的提示词' } }] }));
        } catch {
          /* 连接可能已经没了 */
        }
      }
      state.heldChats.clear();
    },
    /** 放掉所有挂住的连接（掐断），让客户端的 fetch 立刻失败 */
    releaseHeld() {
      for (const res of state.held) res.socket?.destroy();
      state.held.clear();
    },
    async stop() {
      this.releaseChats();
      this.releaseHeld();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
