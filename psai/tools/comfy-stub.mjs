/**
 * ComfyUI 桩：实现测试所需的官方接口子集。
 * 用它跑「排队 / 进度 / 完成 / 取消 / 失败 / 重启恢复」这些真实 ComfyUI 上不好复现的分支。
 * 正常路径仍然要对真实 ComfyUI 跑（npm run test:comfy:real）。
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/** 生成一张真实可解析的 PNG（纯色方块）。资产库会解析它的 IHDR，所以必须是合法 PNG。 */
export function makePng(width = 64, height = 64, rgb = [80, 140, 240]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // 每行的 filter type
    for (let x = 0; x < width; x++) {
      raw[o++] = rgb[0];
      raw[o++] = rgb[1];
      raw[o++] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const OBJECT_INFO = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['stub_model.safetensors', 'other.safetensors']] } },
    input_order: { required: ['ckpt_name'] }
  },
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { default: 0, control_after_generate: true }],
        steps: ['INT', { default: 20 }],
        cfg: ['FLOAT', { default: 8 }],
        sampler_name: [['euler', 'dpmpp_2m', 'res_multistep']],
        scheduler: [['normal', 'karras']],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT', { default: 1 }]
      },
      input_order: {
        required: [
          'model',
          'seed',
          'steps',
          'cfg',
          'sampler_name',
          'scheduler',
          'positive',
          'negative',
          'latent_image',
          'denoise'
        ]
      }
    }
  },
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } } },
  LoadImage: { input: { required: { image: [['example.png']] } } },
  VAEEncode: { input: { required: { pixels: ['IMAGE'], vae: ['VAE'] } } },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } } },
  UpscaleModelLoader: { input: { required: { model_name: [['4x-UltraSharp.pth']] } } },
  ImageUpscaleWithModel: { input: { required: { upscale_model: ['UPSCALE_MODEL'], image: ['IMAGE'] } } },
  EmptyLatentImage: {
    input: {
      required: {
        width: ['INT', { default: 512 }],
        height: ['INT', { default: 512 }],
        batch_size: ['INT', { default: 1 }]
      }
    }
  }
};

/**
 * @param {number} port
 * @param {{ runMs?: number, failNext?: boolean, queueHold?: boolean }} behavior
 */
export async function startComfyStub(port, behavior = {}) {
  /** promptId -> { state, submittedAt, images, failed } */
  const tasks = new Map();
  /** promptHang 开着时挂住的连接，stop() 时统一掐掉 */
  const held = new Set();
  let promptHang = false;
  let promptHangSeen = 0;
  const uploads = new Map();
  let queueHold = behavior.queueHold ?? false;
  let failNext = behavior.failNext ?? false;
  const runMs = behavior.runMs ?? 150;
  let resultCount = behavior.resultCount ?? 1;

  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set();
  const broadcast = (msg) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(s);
      } catch {
        /* noop */
      }
    }
  };

  const json = (res, code, obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length });
    res.end(body);
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  const advance = (id, force = false) => {
    const t = tasks.get(id);
    // force：跳过 queueHold 和 pending 检查，直接开跑。
    // 用来复现"我们以为它在排队，其实 ComfyUI 已经开跑了"——
    // 那条任务必须真的跑完，否则它会一直占着并发名额，
    // 后面每个用例都超时，而报出来的原因跟真正的问题毫无关系。
    if (!t) return;
    if (!force && (t.state !== 'pending' || queueHold)) return;
    if (t.state === 'running') return;
    t.state = 'running';
    broadcast({ type: 'executing', data: { node: '3', prompt_id: id } });
    let step = 0;
    const total = 4;
    const tick = setInterval(() => {
      step++;
      broadcast({ type: 'progress', data: { value: step, max: total, prompt_id: id, node: '3' } });
      if (step >= total) {
        clearInterval(tick);
        if (t.failed) {
          t.state = 'error';
          broadcast({
            type: 'execution_error',
            data: {
              prompt_id: id,
              node_id: '3',
              node_type: 'KSampler',
              exception_type: 'RuntimeError',
              exception_message: '桩：故意失败'
            }
          });
          return;
        }
        t.state = 'done';
        // 出图张数可配：多图工作流是真实存在的（批量出图、多视角），
        // 而"半份结果"这种问题只有多图才谈得上。
        t.images = Array.from({ length: resultCount }, (_, i) => ({
          filename: `${id}-${i}.png`,
          subfolder: '',
          type: 'output'
        }));
        broadcast({ type: 'executing', data: { node: null, prompt_id: id } });
      }
    }, Math.max(10, runMs / total));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = url.pathname;

    if (path === '/system_stats') {
      return json(res, 200, { system: { os: 'stub', comfyui_version: '0.30.1-stub', ram_total: 1 } });
    }
    if (path === '/object_info') return json(res, 200, OBJECT_INFO);
    if (path.startsWith('/object_info/')) {
      const cls = decodeURIComponent(path.slice('/object_info/'.length));
      return json(res, 200, OBJECT_INFO[cls] ? { [cls]: OBJECT_INFO[cls] } : {});
    }

    if (path === '/upload/image' && req.method === 'POST') {
      const body = await readBody(req);
      const name = `up_${createHash('sha256').update(body).digest('hex').slice(0, 10)}.png`;
      uploads.set(name, body);
      return json(res, 200, { name, subfolder: '', type: 'input' });
    }

    if (path === '/prompt' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      if (promptHang) {
        // 收下请求就不回复了。用来复现"提交还在飞的时候用户点了取消"——
        // 那一刻本地既不知道对面收没收，也还没有 prompt_id。
        promptHangSeen++;
        held.add(res);
        res.on('close', () => held.delete(res));
        return;
      }
      if (!body.prompt || Object.keys(body.prompt).length === 0) {
        return json(res, 400, { error: { type: 'invalid_prompt', message: '桩：空的 prompt' } });
      }
      const id = randomUUID();
      tasks.set(id, { state: 'pending', submittedAt: Date.now(), images: [], failed: failNext, prompt: body.prompt });
      failNext = false;
      setTimeout(() => advance(id), 20);
      return json(res, 200, { prompt_id: id, number: tasks.size, node_errors: {} });
    }

    if (path.startsWith('/history/')) {
      const id = decodeURIComponent(path.slice('/history/'.length));
      const t = tasks.get(id);
      if (!t || (t.state !== 'done' && t.state !== 'error')) return json(res, 200, {});
      return json(res, 200, {
        [id]: {
          status: {
            completed: t.state === 'done',
            status_str: t.state === 'done' ? 'success' : 'error',
            messages: t.state === 'error' ? [['execution_error', { exception_message: '桩：故意失败' }]] : []
          },
          outputs: t.state === 'done' ? { 9: { images: t.images } } : {}
        }
      });
    }

    if (path === '/view') {
      /*
       * 每个文件名给一张**不同**的图。
       *
       * 以前一律返回同一张纯色图，于是所有任务的结果字节完全一样，
       * 而资产库是按 sha256 去重的 —— 两条不同任务的结果会共用同一个 assetId。
       * 那会让"这张资产属不属于这条任务"之类的用例悄悄失去意义：
       * 它们看起来通过了，其实是因为两边本来就是同一个 id。
       * 真实的 ComfyUI 当然不会这样。
       */
      const name = url.searchParams.get('filename') ?? 'x';
      let hash = 0;
      for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
      const png = makePng(64, 64, [hash & 0xff, (hash >> 8) & 0xff, (hash >> 16) & 0xff]);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    }

    if (path === '/queue') {
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        /*
         * 如实照抄真实语义：ComfyUI 对 delete 一律回 200，
         * **哪怕那个 id 根本不在队列里，或者它已经开始执行了**。
         * 只看状态码的话，一次什么也没删掉的调用会被汇报成"已取消"。
         */
        for (const id of body.delete ?? []) {
          const t = tasks.get(id);
          if (t && t.state === 'pending') tasks.delete(id);
        }
        return json(res, 200, {});
      }
      const running = [];
      const pending = [];
      for (const [id, t] of tasks) {
        if (t.state === 'running') running.push([0, id, {}, {}, []]);
        if (t.state === 'pending') pending.push([0, id, {}, {}, []]);
      }
      return json(res, 200, { queue_running: running, queue_pending: pending });
    }

    if (path === '/interrupt' && req.method === 'POST') {
      for (const [id, t] of tasks) if (t.state === 'running') tasks.delete(id);
      return json(res, 200, {});
    }

    // 桩自身的控制面
    if (path === '/__stub/hold') {
      queueHold = url.searchParams.get('on') === '1';
      if (!queueHold) for (const id of tasks.keys()) advance(id);
      return json(res, 200, { queueHold });
    }
    if (path === '/__stub/fail-next') {
      failNext = true;
      return json(res, 200, { failNext });
    }
    if (path === '/__stub/tasks') {
      return json(res, 200, {
        tasks: [...tasks.entries()].map(([id, t]) => ({ id, state: t.state }))
      });
    }

    return json(res, 404, { error: 'not found' });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } } } }));
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  // 端口以**实际绑上的**为准：传 0 时由系统分配一个空闲端口。
  // 直接回传入参的话，传 0 的调用方会拿到 http://127.0.0.1:0 —— 一个连不上的地址，
  // 而报错要等到第一次请求才出现，看起来像别的毛病。
  const boundPort = server.address()?.port ?? port;

  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    tasks,
    setHold: (on) => {
      queueHold = on;
      if (!on) for (const id of tasks.keys()) advance(id);
    },
    /** /prompt 收下请求但永不回复 —— 提交悬在半空 */
    setPromptHang: (on) => {
      promptHang = on;
      if (!on) {
        for (const r of held) r.socket?.destroy();
        held.clear();
      }
    },
    /**
     * 把某条任务强行推到 running —— 复现"我们以为它在排队，其实已经开跑了"。
     * 走的是正常的执行流程，所以它会照常跑完：不这么做的话它会永远卡在
     * running 上占着并发名额，后面每个用例都超时。
     */
    forceRunning: (id) => advance(id, true),
    /** 每个任务出几张图。多图工作流是真实存在的，"半份结果"也只有多图才谈得上。 */
    setResultCount: (n) => {
      resultCount = n;
    },
    /** 挂住模式下已经收到过几次提交（用来断言"没有重发"） */
    get promptHangSeen() {
      return promptHangSeen;
    },
    failNext: () => {
      failNext = true;
    },
    async stop() {
      for (const r of held) r.socket?.destroy();
      held.clear();
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {
          /* noop */
        }
      }
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

// 直接运行：node tools/comfy-stub.mjs 18190
if (process.argv[1] && process.argv[1].endsWith('comfy-stub.mjs')) {
  const port = Number(process.argv[2] ?? 18190);
  startComfyStub(port).then((s) => console.log(`comfy stub listening on ${s.url}`));
}
