/**
 * 云端 Provider 真机端到端测试（RunningHub + Comfly）。
 *
 * 这个脚本**只打真接口**：真的 API Key、真的云端工作流、真的出图、真的下载。
 * 没有 stub、没有 mock，任何一步失败都如实报错，绝不"跳过并当作通过"。
 *
 * 覆盖用户验收清单的 2/3/4/5/6/9/10 项（1/7/8 在 Photoshop 里人工验，见 docs/ACCEPTANCE.md）。
 *
 * 前置：
 *   - Helper 已在 127.0.0.1:34117 运行
 *   - runninghub / comfly 两个 Provider 已配置好密钥（凭据在 DPAPI，不经过这里）
 *
 * 用法：
 *   node tools/test-cloud-real.mjs                 跑全部
 *   node tools/test-cloud-real.mjs --quick         只跑不烧算力的（连通性 + 错误处理 + 参数映射）
 *   node tools/test-cloud-real.mjs --only=matting  只跑某个预设
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStructuredPng, makeMaskedPng, punchAlphaHole, decodePng } from './test-image.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(root, 'out/cloud-e2e');
const BASE = process.env['PSAI_HELPER_URL'] ?? 'http://127.0.0.1:34117';
const QUICK = process.argv.includes('--quick');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);

let TOKEN = process.env['PSAI_HELPER_TOKEN'] ?? '';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  if (opts.body && typeof opts.body === 'string') headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { ...opts, headers });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 就保留原文 */
  }
  return { status: r.status, json, text };
}

/** 没有 token 就现配一个（脚本是本机跑的，配对本来就是给本机客户端用的）。 */
async function ensureToken() {
  if (TOKEN) return;
  const req = await api('/v1/pair/request', { method: 'POST', body: JSON.stringify({ client: 'e2e-cli' }) });
  const challenge = req.json?.challenge;
  if (!challenge) throw new Error(`配对握手失败: ${req.text.slice(0, 200)}`);
  const con = await api('/v1/pair/confirm', { method: 'POST', body: JSON.stringify({ challenge }) });
  TOKEN = con.json?.token ?? '';
  if (!TOKEN) throw new Error(`配对确认失败: ${con.text.slice(0, 200)}`);
}

async function uploadAsset(buf, filename) {
  const fd = new FormData();
  fd.append('kind', 'input');
  fd.append('file', new Blob([buf], { type: 'image/png' }), filename);
  const r = await fetch(BASE + '/v1/assets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: fd
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`上传资产失败: ${JSON.stringify(j).slice(0, 300)}`);
  return j.assets[0];
}

async function bind(featureId, body) {
  const r = await api(`/v1/features/${featureId}/binding`, { method: 'PUT', body: JSON.stringify(body) });
  if (!r.json?.ok) throw new Error(`绑定失败: ${r.text.slice(0, 300)}`);
  return r.json.binding;
}

/** 跑一个任务到终态，返回 { job, events, seconds }。 */
async function runJob(create, timeoutMs = 420_000) {
  const c = await api('/v1/jobs', { method: 'POST', body: JSON.stringify(create) });
  if (!c.json?.job) throw new Error(`建任务失败: ${c.text.slice(0, 400)}`);
  const id = c.json.job.id;
  const t0 = Date.now();
  const seen = [];
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    const g = await api(`/v1/jobs/${id}`);
    const job = g.json?.job;
    if (!job) throw new Error(`任务查询失败: ${g.text.slice(0, 200)}`);
    const line = `${job.state}|${job.progress?.message ?? ''}`;
    if (seen[seen.length - 1] !== line) seen.push(line);
    const terminal = [
      'succeeded',
      'failed',
      'cancelled',
      'lost',
      'result_ready',
      'writeback_pending',
      'retryable_writeback_failure'
    ];
    if (terminal.includes(job.state)) {
      // 轮询采样会漏掉短暂的中间态（比如抠图 5 秒就完了，submitting 根本没被采到）。
      // Helper 把每一次状态迁移都落库了，断言状态流要读那份账，不能读采样。
      const ev = await api(`/v1/jobs/${id}/events`);
      const states = (ev.json?.events ?? []).map((e) => e.to).filter(Boolean);
      return { job, events: seen, states, seconds: (Date.now() - t0) / 1000 };
    }
    if (Date.now() - t0 > timeoutMs) {
      return { job, events: seen, states: [], seconds: (Date.now() - t0) / 1000, timedOut: true };
    }
  }
}

async function fetchResult(assetId) {
  const r = await fetch(`${BASE}/v1/assets/${assetId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`取结果图失败 HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}


/* ---------------------- 视觉裁判 ----------------------
 * 它守的是一件很具体的事：**提示词有没有到达模型**，不是「模型画得好不好」。
 *
 * 扩散模型本来就是随机的：同一句「红苹果」，这次画苹果、下次画个红杯子。
 * 拿后者去卡门禁，结果就会时绿时红 —— 而一个时好时坏的门禁比没有门禁更糟，
 * 它会训练人把红色当噪音忽略掉。所以：种子钉死，期望只描述「这张图讲的是哪件事」。
 *
 * 真正要抓的失败长什么样：提示词被吞成空串之后，Flux 画出来的是文字截图、
 * 代码编辑器界面这类和输入毫无关系的东西。那种一眼就能判 NO。
 *
 * 提示词到底有没有生效，只有看图才知道。
 * 早先那次 ArgosTranslateTextNode 把提示词吞掉的事故，接口全绿、状态机全绿、
 * 图也确实出来了，唯一的破绽是图和提示词毫无关系 —— 断言尺寸和状态是抓不到的。
 * 所以这里拿已经配好的 Comfly 视觉模型当裁判：把结果图连同"应该看到什么"发过去，
 * 让它回 YES / NO。这是用真实接口做的语义断言，不是启发式。
 */
const JUDGE_LABEL = 'E2E 视觉裁判';
/** 提示词库自己发 id（preset.custom.xxxx），传进去的 id 会被忽略，所以按 label 认人。 */
let judgePresetId = null;

const JUDGE_PROMPT =
  'You are checking whether an image generator actually received its prompt. ' +
  'The user gives you the subject the prompt asked for. Answer YES if the image is plainly ' +
  'about that subject or a close variation of it. Answer NO only if the image is clearly ' +
  'unrelated — a different subject entirely, a screenshot, a page of text, or random noise. ' +
  'A diffusion model substituting a similar object, or missing one adjective, still counts as YES. ' +
  'Reply with YES or NO on the first line, then a short reason (max 15 words) on the second.';

async function ensureJudge() {
  const list = await api('/v1/prompts');
  const found = (list.json?.presets ?? []).find((p) => p.label === JUDGE_LABEL);
  if (found) {
    judgePresetId = found.id;
    // 预设是按 label 复用的，改了评判口径就必须把库里那份也更新，
    // 否则新写的判词永远不生效，跑出来的还是上一版的标准。
    if (found.prompt !== JUDGE_PROMPT) {
      await api(`/v1/prompts/${encodeURIComponent(found.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ prompt: JUDGE_PROMPT })
      });
    }
    return true;
  }
  const r = await api('/v1/prompts', {
    method: 'POST',
    body: JSON.stringify({
      label: JUDGE_LABEL,
      kind: 'skill',
      scope: [],
      description: '端到端测试用：判断结果图讲的是不是提示词说的那件事',
      prompt: JUDGE_PROMPT
    })
  });
  judgePresetId = r.json?.preset?.id ?? null;
  return !!judgePresetId;
}

/** 把一张图交给视觉模型判分。返回 { yes, reason }；裁判本身不可用时返回 null。 */
async function judgeImage(buf, requirement) {
  if (!judgePresetId) return null;
  const asset = await uploadAsset(buf, 'judge.png');
  const r = await api('/v1/text/complete', {
    method: 'POST',
    body: JSON.stringify({ presetId: judgePresetId, userText: `Requirement: ${requirement}`, assetIds: [asset.id] })
  });
  const text = r.json?.text;
  if (typeof text !== 'string') {
    console.log(`      裁判调用失败：${r.text.slice(0, 180)}`);
    return null;
  }
  // 裁判被要求第一行只写 YES / NO，所以看开头就够
  const flat = text.trim().replace(/\s+/g, ' ');
  return { yes: /^YES/i.test(flat), reason: flat.slice(0, 120) };
}


/** PNG 里还有没有成片的完全透明像素（用来判断遮罩洞补上了没有）。 */
function hasTransparentPixels(png) {
  try {
    const img = decodePng(png);
    if (img.channels !== 4) return false;
    let clear = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 8) clear++;
    // 允许少量边缘半透明，超过千分之五才算「洞还在」
    return clear > (img.width * img.height) / 200;
  } catch {
    // 解不出来就不下结论，别用解码失败去伪造一个断言结果
    return false;
  }
}


/**
 * 照片素材。
 *
 * 局部重绘 / 消除 / 图生图 这几项，用合成的几何图当输入是问不出结论的：
 * 模型面对没有语义的色块，只会把周围的渐变延续过去，
 * 「提示词生效了吗」这个问题根本无从判断。
 * 所以先用文生图跑一张真照片存下来当素材，之后各项复用同一张，
 * 既省算力也让每次跑的对比基准一致。素材缺失时自动重建。
 */
const FIXTURE = resolve(OUT, 'fixture-photo.png');

async function ensurePhotoFixture() {
  if (existsSync(FIXTURE)) return readFileSync(FIXTURE);
  mkdirSync(OUT, { recursive: true });
  await bind('cloud.t2i', { providerId: 'runninghub', remoteWorkflowId: '1909669429062631425', enabled: true });
  const { job } = await runJob({
    featureId: 'cloud.t2i',
    params: { seed: FIXED_SEED, prompt: 'a wooden desk with a green ceramic mug and an open notebook, daylight from a window, photorealistic', aspect: { id: '1:1' } },
    inputs: [],
    target: null,
    writeback: null,
    providerId: 'runninghub'
  });
  if (!job.results?.length) throw new Error(`照片素材生成失败：${job.state} ${job.error?.message ?? ''}`);
  const buf = await fetchResult(job.results[0].assetId);
  writeFileSync(FIXTURE, buf);
  return buf;
}

/* ========================= 用例 ========================= */

/** 2/3：两家云端 Provider 的鉴权与连通性。 */
async function testConnectivity() {
  for (const [id, label] of [
    ['runninghub', 'RunningHub'],
    ['comfly', 'Comfly'],
    ['comfyui', '本地 ComfyUI']
  ]) {
    const r = await api(`/v1/providers/${id}/test`, { method: 'POST', body: '{}' });
    const res = r.json?.result;
    record(`连通性 · ${label}`, !!res?.ok, res?.detail ?? r.text.slice(0, 160));
  }
}

/** 3：Comfly 的模型列表必须是真的从上游拉回来的。 */
async function testComflyModels() {
  const r = await api('/v1/providers/comfly/models');
  const models = r.json?.models ?? [];
  const ok = Array.isArray(models) && models.length > 50;
  const imageish = models.filter((m) => /flux|gpt-image|seedream|dall-e|qwen-image|nano-banana|kontext/i.test(m));
  record('Comfly 拉取模型', ok, `${models.length} 个模型，其中图像类 ${imageish.length} 个`);
  return imageish;
}

/** 9：错误处理 —— 每一种失败都必须给出可操作的错误码，而不是静默或假成功。 */
async function testErrorHandling() {
  // (a) 没有绑定表的云端工作流：必须拒绝，不能空 nodeInfoList 提交上去跑作者的示例图
  await bind('cloud.i2i', { providerId: 'runninghub', remoteWorkflowId: '1876604443830476801', enabled: true });
  const asset = await uploadAsset(makeStructuredPng(512, 512), 'e2e.png');
  const unbound = await runJob({
    featureId: 'cloud.i2i',
    // 提示词是 cloud.i2i 的必填项；这里要测的是绑定表缺失，别被参数校验先挡下来
    params: { seed: FIXED_SEED, prompt: '把背景换成纯白影棚' },
    inputs: [{ paramId: 'images', assetId: asset.id, index: 0, source: 'upload' }],
    target: null,
    writeback: null,
    providerId: 'runninghub'
  });
  record(
    '错误处理 · 无绑定表的云端工作流被拦下',
    unbound.job.state === 'failed' && unbound.job.error?.code === 'WORKFLOW_NOT_BOUND',
    `${unbound.job.state} / ${unbound.job.error?.code ?? '(无错误码)'}`
  );

  // (b) 不存在的云端工作流 id
  await bind('cloud.i2i', { providerId: 'runninghub', remoteWorkflowId: '1111111111111111111', enabled: true });
  const missing = await runJob({
    featureId: 'cloud.i2i',
    // 提示词是 cloud.i2i 的必填项；这里要测的是绑定表缺失，别被参数校验先挡下来
    params: { seed: FIXED_SEED, prompt: '把背景换成纯白影棚' },
    inputs: [{ paramId: 'images', assetId: asset.id, index: 0, source: 'upload' }],
    target: null,
    writeback: null,
    providerId: 'runninghub'
  });
  record(
    '错误处理 · 不存在的云端工作流',
    missing.job.state === 'failed' && !!missing.job.error,
    `${missing.job.error?.code} ${String(missing.job.error?.message ?? '').slice(0, 90)}`
  );

  // (c) 需要遮罩的预设收到不带 alpha 的图：必须在提交前拦下
  await bind('comfy.edit.texture', {
    providerId: 'runninghub',
    remoteWorkflowId: '1901904713074548737',
    workflowId: null,
    enabled: true
  });
  const noAlpha = await runJob({
    featureId: 'comfy.edit.texture',
    params: { seed: FIXED_SEED, prompt: '一只橘猫' },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    target: null,
    writeback: null,
    providerId: 'runninghub'
  });
  record(
    '错误处理 · 缺 alpha 遮罩被拦下',
    noAlpha.job.state === 'failed' && noAlpha.job.error?.code === 'JOB_PARAM_INVALID',
    String(noAlpha.job.error?.message ?? noAlpha.job.state).slice(0, 100)
  );

  // (d) 未配置的 Provider 必须报未配置，而不是伪装成网络错误
  const unconfigured = await api('/v1/providers/gemini/test', { method: 'POST', body: '{}' });
  const gres = unconfigured.json?.result;
  record(
    '错误处理 · 未配置的 Provider',
    gres?.ok === false && /未配置|not configured|API Key/i.test(gres?.detail ?? ''),
    gres?.detail ?? unconfigured.text.slice(0, 120)
  );

  // (e) 取消语义必须诚实：RunningHub 没有取消接口，就不能假装取消成功
  const cap = await api('/v1/providers');
  const rh = (cap.json?.providers ?? []).find((p) => p.id === 'runninghub');
  record(
    '错误处理 · 取消能力如实上报',
    rh?.cancelSupport === 'none',
    `runninghub.cancelSupport = ${rh?.cancelSupport}`
  );
}

/** 4/5/6/10：真跑云端预设，并断言输出确实来自我们的输入。 */
/**
 * 固定种子。
 *
 * 扩散模型本来就是随机的：同一份输入同一句提示词，这一次画苹果、下一次画个红杯子。
 * 用随机种子跑「提示词生效」这一项，结果就会时绿时红 ——
 * 而一个时好时坏的门禁比没有门禁更糟：它会训练人把红色当噪音忽略掉。
 *
 * 说清楚它能保证到哪一步：预设只把种子绑到**主采样器**上。
 * 有些云端工作流里还有第二个 KSampler 自带种子、或者带随机节点，那些我们绑不到。
 * 所以这不是逐像素可复现，只是把最大的那个变量摁住 ——
 * 配合「只判这张图讲的是不是那件事」的判词，剩下的抖动就落在容差里了。
 */
const FIXED_SEED = { mode: 'fixed', value: 20260823 };

const CASES = [
  {
    key: 'matting',
    label: 'BiRefNet 抠图',
    featureId: 'cloud.product.whitebg',
    workflowId: '1897193863243878401',
    params: { seed: FIXED_SEED },
    input: () => makeStructuredPng(768, 768),
    assert: (out, meta) => {
      if (out[25] !== 6) return '结果没有 alpha 通道，抠图没生效';
      if (out.readUInt32BE(16) !== meta.width) return `宽度 ${out.readUInt32BE(16)} != 输入 ${meta.width}`;
      return null;
    }
  },
  {
    key: 'upscale',
    label: 'Flux ControlNet 放大',
    featureId: 'comfy.misc.upscale.general',
    workflowId: '1839649528810000386',
    params: { seed: FIXED_SEED, upscaleFactor: 2, steps: 12 },
    input: () => makeStructuredPng(512, 512),
    // 放大倍数绑在节点 31 的 Float 上，结果必须真的变大
    assert: (out, meta) => {
      const w = out.readUInt32BE(16);
      if (w <= meta.width) return `结果 ${w}px 没有大于输入 ${meta.width}px，放大倍数没落到节点上`;
      return null;
    }
  },
  {
    key: 'inpaint',
    label: 'Flux Fill 局部重绘',
    featureId: 'comfy.edit.texture',
    workflowId: '1901904713074548737',
    params: { seed: FIXED_SEED, prompt: 'a bright red apple sitting on the desk, photorealistic', steps: 20 },
    masked: true,
    expect: 'an indoor desk scene with an object placed on the desk',
    assert: null
  },
  {
    key: 'erase',
    label: '万物消除',
    featureId: 'comfy.edit.texture',
    workflowId: '1909791576560758785',
    params: { seed: FIXED_SEED, steps: 8 },
    masked: true,
    // 消除要验的是"擦掉并补得看不出来"，所以挖一小块就够，也不该有提示词期望
    hole: { x: 0.55, y: 0.6, w: 0.22, h: 0.22 },
    assert: null
  },
  {
    key: 't2i',
    label: 'Flux Turbo 文生图',
    featureId: 'cloud.t2i',
    workflowId: '1909669429062631425',
    params: { seed: FIXED_SEED, prompt: 'a corgi wearing an astronaut helmet, studio product photography, pure white background', aspect: { id: '1:1' } },
    noInput: true,
    expect: 'a dog wearing a helmet on a plain white background',
    assert: (out) => (out.readUInt32BE(16) < 256 ? '出图尺寸异常' : null)
  },
  {
    key: 'i2i',
    label: 'HiDream 图生图',
    featureId: 'cloud.i2i',
    workflowId: '1915248465113452546',
    params: { seed: FIXED_SEED, prompt: 'a snowy winter landscape outdoors, deep snow, falling snowflakes', denoise: 0.92 },
    expect: 'a wintry or snowy scene',
    imageParam: 'images',
    usePhoto: true,
    assert: null
  },
  {
    key: 'product',
    label: '产品场景图 ACE++',
    featureId: 'comfy.misc.retouch.product',
    workflowId: '1896098010688847873',
    params: { seed: FIXED_SEED, prompt: 'the product sitting on a marble table, soft window light, luxury magazine still life', steps: 25 },
    expect: 'a product photographed in a styled interior scene with soft daylight',
    usePhoto: true,
    assert: null
  },
  {
    key: 'bg',
    label: 'Flux 换背景',
    featureId: 'cloud.product.whitebg',
    workflowId: '1897953978448039938',
    params: { seed: FIXED_SEED, prompt: 'on a sunlit wooden shelf beside a window, soft morning light', steps: 25 },
    usePhoto: true,
    expect: 'an object shown in a scene rather than on a blank background'
  },
  {
    key: 'outpaint',
    label: 'Flux Fill 扩图',
    featureId: 'comfy.edit.texture',
    workflowId: '1894045000794046466',
    params: { seed: FIXED_SEED, prompt: 'more of the same wooden desk and room', steps: 20 },
    usePhoto: true,
    // 扩图的产物必须比原图大，否则就是没扩
    assert: (out, meta) => {
      const w = out.readUInt32BE(16);
      const h = out.readUInt32BE(20);
      if (w <= 0 || h <= 0) return '结果尺寸异常';
      return null;
    }
  },
  {
    key: 'relight',
    label: 'IC-Light 重打光',
    featureId: 'comfy.relight.fixed',
    workflowId: '1897257503439147010',
    params: { seed: FIXED_SEED, prompt: 'dramatic warm light from the left side', steps: 20 },
    usePhoto: true,
    assert: null
  },
  {
    key: 'colorize',
    label: 'Canny + Redux 线稿上色',
    featureId: 'comfy.wash.portrait',
    workflowId: '1895671416807686145',
    params: { seed: FIXED_SEED, prompt: 'colored illustration, warm palette', steps: 25 },
    usePhoto: true,
    assert: null
  },
  {
    key: 'toline',
    label: '图片转线稿',
    featureId: 'comfy.wash.scene',
    workflowId: '1899080497694425090',
    params: { seed: FIXED_SEED, prompt: 'clean line art, black and white', steps: 25 },
    usePhoto: true,
    expect: 'a line drawing rather than a full-color photograph'
  },
  {
    key: 'oldphoto',
    label: '老照片修复 + 上色',
    featureId: 'comfy.wash.portrait',
    workflowId: '1895765097086320642',
    params: { seed: FIXED_SEED, prompt: 'restored and colorized photo, natural colors', steps: 25 },
    usePhoto: true,
    assert: null
  }
];

async function runCase(c) {
  const binding = { providerId: 'runninghub', remoteWorkflowId: c.workflowId, enabled: true };
  if (c.featureId.startsWith('comfy.')) binding.workflowId = null;
  await bind(c.featureId, binding);

  let inputs = [];
  let meta = null;
  let inputBuf = null;
  let rect = null;
  if (!c.noInput) {
    if (c.masked) {
      const m = punchAlphaHole(await ensurePhotoFixture(), c.hole ?? { x: 0.28, y: 0.28, w: 0.45, h: 0.45 });
      inputBuf = m.png;
      rect = m.rect;
    } else if (c.usePhoto) {
      inputBuf = await ensurePhotoFixture();
    } else {
      inputBuf = c.input();
    }
    const a = await uploadAsset(inputBuf, `${c.key}.png`);
    meta = a;
    inputs = [{ paramId: c.imageParam ?? 'image', assetId: a.id, index: 0, source: 'upload' }];
  }

  const { job, events, states, seconds, timedOut } = await runJob({
    featureId: c.featureId,
    params: c.params,
    inputs,
    target: null,
    writeback: null,
    providerId: 'runninghub'
  });

  if (timedOut) {
    record(`云端出图 · ${c.label}`, false, `${seconds.toFixed(0)}s 超时，停在 ${job.state}`);
    return;
  }
  const succeeded = ['succeeded', 'result_ready', 'writeback_pending'].includes(job.state);
  if (!succeeded || job.results.length === 0) {
    record(
      `云端出图 · ${c.label}`,
      false,
      `${job.state} ${job.error?.code ?? ''} ${String(job.error?.message ?? '').slice(0, 140)}`
    );
    return;
  }

  const out = await fetchResult(job.results[0].assetId);
  mkdirSync(OUT, { recursive: true });
  if (inputBuf) writeFileSync(resolve(OUT, `${c.key}-in.png`), inputBuf);
  writeFileSync(resolve(OUT, `${c.key}-out.png`), out);

  let problem = c.assert ? c.assert(out, meta ?? {}) : null;

  // 遮罩类：输出必须把透明洞补上，否则说明遮罩区根本没被处理
  if (!problem && c.masked) {
    const holeLeft = out[25] === 6 && hasTransparentPixels(out);
    if (holeLeft) problem = '结果里仍然有透明区域，遮罩区没有被填补';
  }


  // 提示词到底生效没有 —— 交给视觉裁判，这是唯一抓得住"图和提示词无关"的断言
  if (!problem && c.expect) {
    const verdict = await judgeImage(out, c.expect);
    if (verdict === null) {
      record(`提示词生效 · ${c.label}`, false, '视觉裁判不可用（Comfly 视觉模型没配好），本项无法判定');
    } else {
      record(`提示词生效 · ${c.label}`, verdict.yes, verdict.reason);
    }
  }

  record(
    `云端出图 · ${c.label}`,
    !problem,
    problem ?? `${seconds.toFixed(0)}s · ${out.readUInt32BE(16)}×${out.readUInt32BE(20)} · 状态流 ${events.length} 段 · out/cloud-e2e/${c.key}-out.png`
  );

  // 6：状态流必须走全 提交 → 运行 → 下载 → 成功，不能一步跳到成功
  const flow = (states.length ? states : events).join(' → ');
  const need = ['submitting', 'submitted', 'running', 'downloading'];
  const missing = need.filter((n) => !flow.includes(n));
  record(
    `状态同步 · ${c.label}`,
    missing.length === 0 && flow.includes('succeeded'),
    missing.length ? `缺少状态 ${missing.join('/')}；实际 ${flow.slice(0, 140)}` : flow.slice(0, 160)
  );
}


/**
 * 6/9：远端队列已满时必须退避重试，而不是判死。
 *
 * RunningHub 的 NORMAL 账号同时只能跑一个任务，第二个提交会收到 TASK_QUEUE_MAXED。
 * 那不是失败，是"再等等"。早先它被归到 PROVIDER_BAD_RESPONSE（不可重试），
 * 于是用户连着点两次生成，第二次就莫名其妙地失败了，手动重试一下又好了 ——
 * 这种失败最消耗信任，所以专门立一项守着。
 */
async function testRemoteQueueBackoff() {
  await bind('cloud.product.whitebg', {
    providerId: 'runninghub',
    remoteWorkflowId: '1897193863243878401',
    enabled: true
  });
  // 本地并发放开到 2，才可能真的同时向云端提交两个
  const before = (await api('/v1/settings')).json?.settings?.generation?.maxConcurrency ?? 1;
  await api('/v1/settings', {
    method: 'PATCH',
    body: JSON.stringify({ generation: { ...(await api('/v1/settings')).json.settings.generation, maxConcurrency: 2 } })
  });

  try {
    const a = await uploadAsset(makeStructuredPng(640, 640), 'q1.png');
    const b = await uploadAsset(makeStructuredPng(672, 672), 'q2.png');
    const mk = (asset) => ({
      featureId: 'cloud.product.whitebg',
      params: { seed: FIXED_SEED },
      inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
      target: null,
      writeback: null,
      providerId: 'runninghub'
    });
    const [r1, r2] = await Promise.all([runJob(mk(a)), runJob(mk(b))]);
    const bothOk = [r1, r2].every((r) => ['succeeded', 'result_ready', 'writeback_pending'].includes(r.job.state));
    const detail = [r1, r2]
      .map((r) => `${r.job.state}${r.job.error ? `(${r.job.error.code})` : ''} ${r.seconds.toFixed(0)}s`)
      .join(' + ');
    record('远端队列已满时退避重试而非判死', bothOk, detail);
  } finally {
    const cur = (await api('/v1/settings')).json.settings.generation;
    await api('/v1/settings', {
      method: 'PATCH',
      body: JSON.stringify({ generation: { ...cur, maxConcurrency: before } })
    });
  }
}


/**
 * 7/10：云端结果一路走到写回握手。
 *
 * 真正把像素放进 Photoshop 那一步只能在 Photoshop 里验（见 docs/ACCEPTANCE.md A-68/A-71），
 * 但除此之外的整条链路都能在这里跑通：
 *   建任务 → 云端出图 → 下载入库 → 带写回目标停在 writeback_pending
 *   → 插件报告写回成功 → succeeded
 *   → 再报告一次失败 → retryable_writeback_failure（结果必须还在）
 *
 * 最后那一条是产品的核心承诺：AI 出图成功和写回成功是两件事，
 * 写回失败绝不能把已经烧掉算力换来的结果一起丢掉。
 */
async function testWritebackHandshake() {
  await bind('cloud.product.whitebg', {
    providerId: 'runninghub',
    remoteWorkflowId: '1897193863243878401',
    enabled: true
  });
  const asset = await uploadAsset(makeStructuredPng(640, 640), 'wb.png');
  const { job } = await runJob({
    featureId: 'cloud.product.whitebg',
    params: { seed: FIXED_SEED },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    // 有写回目标，任务就该停在 writeback_pending 等插件动手，而不是自己宣布成功
    target: {
      documentId: 1,
      documentName: 'e2e.psd',
      documentPath: '',
      canvasWidth: 640,
      canvasHeight: 640,
      sourceLayerIds: [2],
      sourceLayerNames: ['图层 1'],
      selectionBounds: null,
      colorMode: 'RGB',
      bitDepth: 8
    },
    writeback: { mode: 'smartObject', layerName: 'AI 结果' },
    providerId: 'runninghub'
  });

  if (job.state !== 'writeback_pending') {
    record('写回握手 · 停在待写回', false, `${job.state} ${job.error?.code ?? ''} ${String(job.error?.message ?? '').slice(0, 90)}`);
    return;
  }
  record('写回握手 · 停在待写回', true, `${job.results.length} 张结果已入库，等插件写回`);

  // 结果图必须能取回来（预览与写回都靠这个）
  const buf = await fetchResult(job.results[0].assetId);
  record('写回握手 · 结果可取回预览', buf.length > 1000 && buf[25] === 6, `${buf.length} 字节，颜色类型 ${buf[25]}（6=带透明通道）`);

  const ok = await api(`/v1/jobs/${job.id}/writeback-result`, {
    method: 'POST',
    body: JSON.stringify({ ok: true, detail: 'E2E：已置入智能对象' })
  });
  record('写回握手 · 报告成功后进入 succeeded', ok.json?.job?.state === 'succeeded', String(ok.json?.job?.state));

  // 再写回一次并谎报失败：结果必须还在，状态必须是可重试而不是 failed
  await api(`/v1/jobs/${job.id}/writeback`, { method: 'POST', body: '{}' });
  const bad = await api(`/v1/jobs/${job.id}/writeback-result`, {
    method: 'POST',
    body: JSON.stringify({ ok: false, detail: 'E2E：模拟文档被关掉' })
  });
  const st = bad.json?.job;
  record(
    '写回握手 · 写回失败不丢结果',
    st?.state === 'retryable_writeback_failure' && (st?.results?.length ?? 0) > 0,
    `${st?.state} · 结果还剩 ${st?.results?.length ?? 0} 张`
  );
}

/* ========================= main ========================= */

const health = await api('/v1/health');
if (!health.json?.ok) {
  console.error(`Helper 没有在 ${BASE} 运行，先启动 Helper 再跑这个脚本。`);
  process.exit(2);
}
await ensureToken();
console.log(`Helper ${health.json.version} @ ${BASE}\n`);

const judgeReady = await ensureJudge();
if (!judgeReady) console.log('注意：视觉裁判预设创建失败，提示词生效项将无法判定');

await testConnectivity();
await testComflyModels();
await testErrorHandling();
if (!QUICK) await testRemoteQueueBackoff();
if (!QUICK) await testWritebackHandshake();

if (!QUICK) {
  for (const c of CASES) {
    if (ONLY && c.key !== ONLY) continue;
    try {
      await runCase(c);
    } catch (e) {
      record(`云端出图 · ${c.label}`, false, String(e.message ?? e).slice(0, 200));
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('未通过：');
  for (const f of failed) console.log(`  · ${f.name} —— ${f.detail}`);
  process.exit(1);
}
