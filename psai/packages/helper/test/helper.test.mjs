/**
 * Helper 集成测试：真起进程、真发 HTTP、真写 SQLite。
 * ComfyUI 用桩，为的是能稳定复现排队/取消/失败/重启恢复这些分支。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHelper } from '../dist/index.js';
import { startComfyStub, makePng } from '../../../tools/comfy-stub.mjs';
import { assertCleanLog } from './_log-assertions.mjs';

let helper;
let stub;
let token;
let dataDir;

/*
 * 端口由系统分配，不写死。
 *
 * 写死有两个坑，第二个尤其阴：上一次跑崩留下的进程会一直占着；
 * 而 Windows 上端口被占**未必**报 EADDRINUSE —— 可能就那么挂着，
 * 整个套件一条输出都没有，报出来是一次超时，跟真正的原因毫无关系。
 * 每次 startHelper 之后都要重新读一遍：重启拿到的是新端口。
 */
let PORT = 0;

function url(path) {
  return `http://127.0.0.1:${PORT}${path}`;
}

async function api(method, path, body, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (!opts.noAuth) headers['Authorization'] = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url(path), { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function uploadPng(rgb = [10, 20, 30], size = 64) {
  const png = makePng(size, size, rgb);
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'input.png');
  const res = await fetch(url('/v1/assets'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd
  });
  const json = await res.json();
  assert.equal(json.ok, true, `上传失败: ${JSON.stringify(json)}`);
  return json.assets[0];
}

/** 一个最小但结构真实的 img2img 工作流（API 格式）。 */
function testWorkflow() {
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'stub_model.safetensors' } },
    2: { class_type: 'LoadImage', inputs: { image: 'example.png' } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: 'a photo', clip: ['1', 1] }, _meta: { title: 'Positive' } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: 'bad', clip: ['1', 1] }, _meta: { title: 'Negative' } },
    6: { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['1', 2] } },
    3: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        seed: 0,
        steps: 20,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        denoise: 1
      }
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['1', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'psai' } }
  };
}

async function waitForState(jobId, predicate, timeoutMs = 15000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const { json } = await api('GET', `/v1/jobs/${jobId}`);
    last = json.job;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`等待任务状态超时，最后状态=${last?.state} 错误=${JSON.stringify(last?.error)}`);
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-test-'));
  stub = await startComfyStub(0, { runMs: 120 });
  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  // 把 ComfyUI 指向桩
  await api('PATCH', '/v1/settings', { comfy: { baseUrl: stub.url } });
});

after(async () => {
  await helper?.stop();
  await stub?.stop();
  /*
   * 停机之后、删目录之前翻一遍日志。
   *
   * 非法状态转移和唯一约束冲突都不会让任何用例变红：前者只是被
   * transition() 拒绝 + 记一条 warn，后者会被事务吞掉走别的分支。
   * 它们会一直积着，直到某天某条路径真的因为被拒而卡死 ——
   * 而那时候现场早就没了。
   *
   * 位置很讲究：早于 helper.stop() 会让进程退不出去（报成超时），
   * 晚于 rmSync 则日志已经被删了。失败也要先清理再抛，
   * 否则每失败一次就漏一个临时目录。
   */
  let logProblem = null;
  try {
    if (dataDir) assertCleanLog(dataDir);
  } catch (e) {
    logProblem = e;
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔会被占用，忽略 */
  }
  if (logProblem) throw logProblem;
});

/* ==================== 健康与鉴权 ==================== */

test('健康检查是公开端点，返回版本与 schema 版本', async () => {
  const res = await fetch(url('/v1/health'));
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.online, true);
  assert.equal(json.schemaVersion, 1);
  assert.ok(json.version);
});

test('没有 token 的受保护端点返回 401 且带错误码', async () => {
  const { status, json } = await api('GET', '/v1/settings', undefined, { noAuth: true });
  assert.equal(status, 401);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'HELPER_UNAUTHORIZED');
});

test('两段式配对：challenge 换 token，且 challenge 用后即焚', async () => {
  const r1 = await fetch(url('/v1/pair/request'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: 'uxp' })
  });
  const { challenge } = await r1.json();
  assert.ok(challenge);

  const confirm = async () =>
    fetch(url('/v1/pair/confirm'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge })
    }).then((r) => r.json());

  const ok = await confirm();
  assert.ok(ok.token, '第一次 confirm 应该拿到 token');

  const again = await confirm();
  assert.equal(again.ok, false, 'challenge 必须一次性');
  assert.equal(again.error.code, 'HELPER_PAIR_FAILED');
});

test('伪造的 token 会被拒绝', async () => {
  const res = await fetch(url('/v1/settings'), { headers: { Authorization: 'Bearer not-a-real-token' } });
  assert.equal(res.status, 401);
});

/* ==================== 设置 ==================== */

test('设置可读可增量更新，不会互相覆盖', async () => {
  const before = (await api('GET', '/v1/settings')).json.settings;
  assert.equal(before.generation.maxConcurrency, 1);

  await api('PATCH', '/v1/settings', { generation: { maxConcurrency: 3 } });
  const mid = (await api('GET', '/v1/settings')).json.settings;
  assert.equal(mid.generation.maxConcurrency, 3);
  assert.equal(mid.generation.writebackMode, 'smartObject', '只改一个字段不应清掉同组其他字段');
  assert.equal(mid.comfy.baseUrl, stub.url, '改 generation 不应影响 comfy 分组');

  await api('PATCH', '/v1/settings', { generation: { maxConcurrency: 1 } });
});

/* ==================== Provider ==================== */

test('Provider 列表覆盖注册表，未配置的带原因', async () => {
  const { json } = await api('GET', '/v1/providers');
  assert.equal(json.ok, true);
  const ids = json.providers.map((p) => p.id);
  for (const need of ['comfyui', 'runninghub', 'comfly', 'modelscope', 'volcengine', 'bailian', 'gemini', 'custom']) {
    assert.ok(ids.includes(need), `缺少 ${need}`);
  }
  const rh = json.providers.find((p) => p.id === 'runninghub');
  assert.equal(rh.configured, false);
  assert.ok(rh.reason, '未配置的 Provider 必须给出原因');
  assert.equal(rh.cancelSupport, 'none', '取消语义必须如实标注');
});

test('测试连接会打到真实地址并返回版本与延迟', async () => {
  const { json } = await api('POST', '/v1/providers/comfyui/test');
  assert.equal(json.ok, true);
  assert.equal(json.result.ok, true);
  assert.match(json.result.detail, /0\.30\.1-stub/);
  assert.ok(json.result.latencyMs >= 0);
});

test('API Key 写入后只回掩码，明文不出现在任何响应里', async () => {
  const secret = 'sk-testkey-abcdef123456';
  const w = await api('POST', '/v1/providers/comfly/credentials', { apiKey: secret });
  assert.equal(w.json.ok, true);

  const list = await api('GET', '/v1/providers');
  const body = JSON.stringify(list.json);
  assert.ok(!body.includes(secret), '响应里绝不能出现明文 API Key');

  const comfly = list.json.providers.find((p) => p.id === 'comfly');
  const field = comfly.credentialFields.find((f) => f.key === 'apiKey');
  assert.ok(field.masked, '应该返回掩码');
  assert.ok(field.masked.includes('••'), `掩码格式不对: ${field.masked}`);
  assert.ok(field.masked.endsWith('3456'), '掩码应保留尾部便于辨认');
  assert.equal(comfly.configured, true);
});

test('清除凭据后 Provider 回到未配置', async () => {
  await api('DELETE', '/v1/providers/comfly/credentials');
  const { json } = await api('GET', '/v1/providers');
  const comfly = json.providers.find((p) => p.id === 'comfly');
  assert.equal(comfly.configured, false);
  assert.match(comfly.reason, /API Key/);
});

test('未配置的 Provider 拉取模型会报明确错误，而不是返回空列表', async () => {
  const { status, json } = await api('GET', '/v1/providers/bailian/models');
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(status, 409);
});

test('RunningHub 明确报告不支持拉取模型', async () => {
  await api('POST', '/v1/providers/runninghub/credentials', { apiKey: 'rh-fake-key' });
  const { status, json } = await api('GET', '/v1/providers/runninghub/models');
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'PROVIDER_UNSUPPORTED');
  assert.equal(status, 501);
  await api('DELETE', '/v1/providers/runninghub/credentials');
});

test('ComfyUI 能力发现返回真实的采样器/模型列表', async () => {
  const { json } = await api('GET', '/v1/comfy/object-info');
  assert.equal(json.ok, true);
  assert.deepEqual(json.samplers, ['euler', 'dpmpp_2m', 'res_multistep']);
  assert.deepEqual(json.schedulers, ['normal', 'karras']);
  assert.ok(json.checkpoints.includes('stub_model.safetensors'));
  assert.ok(json.nodeCount > 5);
});

/* ==================== 资产 ==================== */

test('上传图片会解析出真实宽高', async () => {
  const a = await uploadPng([1, 2, 3], 96);
  assert.equal(a.width, 96);
  assert.equal(a.height, 96);
  assert.equal(a.mime, 'image/png');
  assert.ok(a.sha256.length === 64);
});

test('同一张图重复上传按 sha256 去重', async () => {
  const a = await uploadPng([9, 9, 9], 48);
  const b = await uploadPng([9, 9, 9], 48);
  assert.equal(a.id, b.id, '内容相同应复用同一个资产');
});

test('资产可以按 id 取回原始字节', async () => {
  const a = await uploadPng([5, 5, 5], 32);
  const res = await fetch(url(`/v1/assets/${a.id}`), { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, a.bytes);
  assert.equal(buf.slice(1, 4).toString('ascii'), 'PNG');
});

test('不存在的资产返回 404 + ASSET_NOT_FOUND', async () => {
  const res = await fetch(url('/v1/assets/as_nope'), { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 404);
});

/* ==================== 提示词库 ==================== */

test('内置提示词全部播种，且能按功能筛选', async () => {
  const all = (await api('GET', '/v1/prompts')).json.presets;
  assert.equal(all.length, 10);
  assert.ok(all.every((p) => p.builtin));

  const stylize = (await api('GET', '/v1/prompts?featureId=cloud.wash&kind=stylize')).json.presets;
  assert.equal(stylize.length, 6, '洗图/去噪应能选到 6 个稿型预设');
  const labels = stylize.map((p) => p.label).sort();
  assert.deepEqual(labels, ['白膜', '白膜 · 带材质', '纯色稿', '法线', '黑白深度', '黑白线稿'].sort());
});

test('编辑内置提示词会标记为已自定义，恢复默认可还原', async () => {
  const edited = (await api('PUT', '/v1/prompts/preset.lineart.bw', { prompt: '我改过的提示词内容占位' })).json.preset;
  assert.equal(edited.prompt, '我改过的提示词内容占位');
  assert.equal(edited.customized, true);

  const restored = (await api('PUT', '/v1/prompts/preset.lineart.bw', { restore: true })).json.preset;
  assert.match(restored.prompt, /line art/);
  assert.equal(restored.customized, false);
});

test('出厂预设不可删除', async () => {
  const { json } = await api('DELETE', '/v1/prompts/preset.normal');
  assert.equal(json.ok, false);
  assert.match(json.error.details ?? json.error.message, /不可删除/);
});

test('可以新建并删除自定义预设', async () => {
  const created = (
    await api('POST', '/v1/prompts', {
      label: '我的稿型',
      kind: 'stylize',
      scope: ['cloud.wash'],
      prompt: 'my custom style prompt for testing'
    })
  ).json.preset;
  assert.equal(created.builtin, false);

  const inList = (await api('GET', '/v1/prompts?featureId=cloud.wash&kind=stylize')).json.presets;
  assert.equal(inList.length, 7);

  assert.equal((await api('DELETE', `/v1/prompts/${created.id}`)).json.ok, true);
});

/* ==================== 工作流 ==================== */

test('扫描能识别输出节点、可绑定字段与语义', async () => {
  const { json } = await api('POST', '/v1/workflows/scan', { json: testWorkflow() });
  assert.equal(json.ok, true);
  const s = json.scan;
  assert.equal(s.format, 'api');
  assert.deepEqual(s.outputNodeIds, ['9']);
  assert.ok(s.requiredNodeTypes.includes('KSampler'));
  assert.deepEqual(s.requiredModels, [{ kind: 'checkpoint', name: 'stub_model.safetensors' }]);

  const semantics = new Set(s.fields.map((f) => f.semantic).filter(Boolean));
  for (const need of ['prompt', 'negativePrompt', 'seed', 'steps', 'cfg', 'denoise', 'sampler', 'scheduler', 'image', 'checkpoint']) {
    assert.ok(semantics.has(need), `没有识别出语义 ${need}`);
  }

  const neg = s.fields.find((f) => f.nodeId === '5' && f.input === 'text');
  assert.equal(neg.semantic, 'negativePrompt', '标题含 Negative 的文本框应识别为负向提示词');
  // 连线输入不应出现在可绑定字段里
  assert.ok(!s.fields.some((f) => f.nodeId === '3' && f.input === 'model'));
});

test('没有输出节点的工作流会被拒绝导入', async () => {
  const bad = { 1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } } };
  const { status, json } = await api('POST', '/v1/workflows/import', { json: bad, name: '无输出' });
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'WORKFLOW_NO_OUTPUT');
  assert.equal(status, 400);
});

test('坏 JSON 结构会被拒绝', async () => {
  const { json } = await api('POST', '/v1/workflows/import', { json: { a: 1, b: 2 }, name: '坏结构' });
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'WORKFLOW_INVALID_JSON');
});

let importedWorkflowId;

test('导入工作流并自动生成绑定建议', async () => {
  const { json } = await api('POST', '/v1/workflows/import', { json: testWorkflow(), name: '测试工作流' });
  assert.equal(json.ok, true, JSON.stringify(json));
  importedWorkflowId = json.workflow.id;
  assert.equal(json.workflow.version, '1.0.0');
  assert.equal(json.workflow.source, 'imported');

  const bound = new Set(json.workflow.bindings.map((b) => b.paramId));
  for (const need of ['prompt', 'negativePrompt', 'seed', 'steps', 'cfg', 'denoise', 'sampler', 'image']) {
    assert.ok(bound.has(need), `没有自动绑定 ${need}`);
  }
  const imageBinding = json.workflow.bindings.find((b) => b.paramId === 'image');
  assert.equal(imageBinding.nodeId, '2');
  assert.equal(imageBinding.required, true);
});

test('内容相同的重复导入不会产生新版本', async () => {
  const { json } = await api('POST', '/v1/workflows/import', { json: testWorkflow(), name: '测试工作流' });
  assert.equal(json.versionBumped, false);
  assert.equal(json.workflow.id, importedWorkflowId);
});

test('内容变化的同名导入会递增版本且保留旧版本', async () => {
  const changed = testWorkflow();
  changed['3'].inputs.steps = 25;
  const { json } = await api('POST', '/v1/workflows/import', { json: changed, name: '测试工作流' });
  assert.equal(json.versionBumped, true);
  assert.equal(json.workflow.version, '1.1.0');

  const list = (await api('GET', '/v1/workflows')).json.workflows.filter((w) => w.name === '测试工作流');
  assert.equal(list.length, 2, '旧版本必须保留');
});

test('绑定到不存在的节点会被拒绝', async () => {
  const { json } = await api('PUT', `/v1/workflows/${importedWorkflowId}/bindings`, {
    bindings: [{ paramId: 'prompt', nodeId: '999', input: 'text', required: true }]
  });
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'WORKFLOW_BINDING_INVALID');
});

test('绑定到连线输入会被拒绝', async () => {
  const { json } = await api('PUT', `/v1/workflows/${importedWorkflowId}/bindings`, {
    bindings: [{ paramId: 'prompt', nodeId: '3', input: 'model', required: true }]
  });
  assert.equal(json.ok, false);
  assert.match(json.error.details ?? '', /连线输入/);
});

test('依赖预检能对着真实 object_info 判定缺什么', async () => {
  // 自带一份工作流，避免依赖前面测试的执行顺序
  const wf = (await api('POST', '/v1/workflows/import', { json: testWorkflow(), name: '依赖预检用' })).json.workflow;
  const { json } = await api('GET', `/v1/workflows/${wf.id}/dependencies`);
  assert.equal(json.ok, true);
  assert.equal(json.report.ok, true, `不该缺依赖: ${JSON.stringify(json.report)}`);
  assert.equal(json.report.missingNodes.length, 0);
  assert.equal(json.report.checkedAgainst, stub.url);
});

test('缺节点的工作流会被依赖预检抓出来', async () => {
  const wf = testWorkflow();
  wf['77'] = { class_type: 'SomeMissingCustomNode', inputs: { foo: 1 } };
  const imported = (await api('POST', '/v1/workflows/import', { json: wf, name: '缺节点工作流' })).json.workflow;
  const { json } = await api('GET', `/v1/workflows/${imported.id}/dependencies`);
  assert.equal(json.report.ok, false);
  assert.deepEqual(json.report.missingNodes, ['SomeMissingCustomNode']);
});

test('内置工作流不可删除', async () => {
  const builtins = (await api('GET', '/v1/workflows')).json.workflows.filter((w) => w.source === 'builtin');
  if (builtins.length === 0) return; // P5 之前还没有内置工作流
  const { json } = await api('DELETE', `/v1/workflows/${builtins[0].id}`);
  assert.equal(json.ok, false);
});

/* ==================== 功能目录 ==================== */

test('功能接口返回完整目录与 18 个功能', async () => {
  const { json } = await api('GET', '/v1/features');
  assert.equal(json.ok, true);
  assert.equal(json.features.length, 18);
  assert.equal(json.catalog.length, 4, '一级导航是 4 项');

  const f = json.features.find((x) => x.id === 'comfy.wash.portrait');
  assert.deepEqual(f.breadcrumb, ['生成', 'comfyui', '洗图', '人像']);
  assert.ok(f.params.length >= 10);
  assert.ok('seed' in f.defaults);
  assert.equal(f.providerId, 'comfyui');
});

test('未绑定工作流的固定功能显示未就绪并给出原因', async () => {
  const { json } = await api('GET', '/v1/features');
  const f = json.features.find((x) => x.id === 'comfy.wash.portrait');
  if (!f.workflowId) {
    assert.equal(f.ready, false);
    assert.equal(f.reason, '未绑定工作流');
  }
});

test('闭源功能在没有任何闭源 Provider 时未就绪', async () => {
  const { json } = await api('GET', '/v1/features');
  const f = json.features.find((x) => x.id === 'cloud.t2i');
  assert.equal(f.ready, false);
  assert.ok(f.reason, '必须给出未就绪原因');
});

test('把功能绑定到导入的工作流后变为就绪', async () => {
  const put = await api('PUT', '/v1/features/comfy.wash.portrait/binding', {
    providerId: 'comfyui',
    workflowId: importedWorkflowId,
    enabled: true
  });
  assert.equal(put.json.ok, true);

  const { json } = await api('GET', '/v1/features');
  const f = json.features.find((x) => x.id === 'comfy.wash.portrait');
  assert.equal(f.workflowId, importedWorkflowId);
  assert.equal(f.ready, true);
  assert.equal(f.reason, null);
});

test('绑定到不存在的工作流会被拒绝', async () => {
  const { json } = await api('PUT', '/v1/features/comfy.wash.scene/binding', { workflowId: 'wf.does.not.exist' });
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'WORKFLOW_NOT_FOUND');
});

/* ==================== 任务：正常路径 ==================== */

function psTarget(overrides = {}) {
  return {
    documentId: 101,
    documentName: 'test.psd',
    documentPath: 'C:/tmp/test.psd',
    canvasWidth: 2000,
    canvasHeight: 1500,
    sourceLayerIds: [11],
    sourceLayerNames: ['图层 1'],
    selectionBounds: null,
    colorMode: 'RGB',
    bitDepth: 8,
    ...overrides
  };
}

async function createJob(overrides = {}) {
  const asset = await uploadPng([33, 66, 99], 128);
  const body = {
    featureId: 'comfy.wash.portrait',
    params: { prompt: '一只猫', seed: { mode: 'fixed', value: 12345 }, denoise: 0.3, steps: 12, ...overrides.params },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'layer' }],
    target: psTarget(overrides.target),
    writeback: { mode: 'smartObject', layerName: 'AI 结果' },
    ...overrides.body
  };
  const { json } = await api('POST', '/v1/jobs', body);
  assert.equal(json.ok, true, `创建任务失败: ${JSON.stringify(json)}`);
  return json.job;
}

test('完整走通：创建 → 生成 → 结果就绪 → 等待写回', async () => {
  const job = await createJob();
  assert.equal(job.featureId, 'comfy.wash.portrait');
  assert.equal(job.providerId, 'comfyui');
  assert.equal(job.workflowId, importedWorkflowId);

  const done = await waitForState(job.id, (j) => j.state === 'writeback_pending' || j.state === 'succeeded');
  assert.equal(done.state, 'writeback_pending', '有写回目标时应停在待写回');
  assert.equal(done.results.length, 1);
  assert.ok(done.results[0].width > 0);
  assert.ok(done.remoteId, '应记录远端任务号');
  assert.ok(done.gpuMs >= 0, '本地任务应记录 GPU 时长');
});

test('大图原样上传，不缩放不重编码', async () => {
  // 用户提的第 1 条：原图必须按原始尺寸提交，不许我们背着他降采样。
  //
  // 这里守的是一条**否定**规则 —— 没有任何代码缩图，所以正常情况下它一定通过。
  // 留着它是因为「加一个 maxEdge 顺手压一下」是个太自然的念头：
  // 设置里一度真有过一个 inputMaxEdge，画了输入框、存进了库，只是从没被读过。
  // 谁要是哪天把它接上，这条测试会立刻响。
  const big = await uploadPng([200, 120, 40], 2048);
  assert.equal(big.width, 2048, '上传后宽度必须还是原始宽度');
  assert.equal(big.height, 2048, '上传后高度必须还是原始宽度');

  // 字节也要一模一样：重编码会改变哈希，内容寻址和去重都靠它
  const raw = makePng(2048, 2048, [200, 120, 40]);
  const back = await fetch(url(`/v1/assets/${big.id}`), { headers: { Authorization: `Bearer ${token}` } });
  if (back.ok) {
    const got = Buffer.from(await back.arrayBuffer());
    assert.equal(got.length, raw.length, '字节数变了说明被重新编码过');
    assert.ok(got.equals(raw), '上传的图必须原样存下来');
  }
});

test('解析后的参数被完整记录，可用于复现', async () => {
  const job = await createJob();
  const done = await waitForState(job.id, (j) => j.results.length > 0);
  const rp = done.resolvedParams;
  assert.equal(rp.seed, 12345, '固定种子应原样落库');
  // 出图尺寸默认跟随原图：输入是 128×128，出的就该是 128×128。
  // 以前这里是 1024×1024 —— 无论原图多大都按分辨率滑杆的默认值重算，
  // 一张 4000px 的图洗完只剩 1024px，而用户从没要求缩小。
  assert.equal(rp.__width, 128, '应跟随原图宽度');
  assert.equal(rp.__height, 128, '应跟随原图高度');
  assert.equal(rp.__followSourceSize, true, '要标记这次是跟随原图，下游才知道该不该套 2K 兜底');
  assert.equal(rp.prompt, '一只猫');
  assert.ok(Array.isArray(rp.__promptBreakdown));
});

test('参数真的注入到了提交给 ComfyUI 的图里', async () => {
  const job = await createJob({ params: { prompt: '注入校验用的提示词', steps: 17, denoise: 0.42 } });
  const done = await waitForState(job.id, (j) => !!j.remoteId);
  const task = stub.tasks.get(done.remoteId);
  assert.ok(task, '桩里应有这条任务');
  assert.equal(task.prompt['4'].inputs.text, '注入校验用的提示词');
  assert.equal(task.prompt['3'].inputs.steps, 17);
  assert.equal(task.prompt['3'].inputs.seed, 12345);
  assert.ok(Math.abs(task.prompt['3'].inputs.denoise - 0.42) < 1e-9);
  assert.match(task.prompt['2'].inputs.image, /^up_/, '输入图应被替换成 ComfyUI 侧的文件名');
});

test('状态流转全程有审计记录', async () => {
  const job = await createJob();
  await waitForState(job.id, (j) => j.results.length > 0);
  const { json } = await api('GET', `/v1/jobs/${job.id}/events`);
  const states = json.events.map((e) => e.to);
  assert.equal(states[0], 'created');
  for (const need of ['queued_local', 'submitting', 'submitted', 'result_ready']) {
    assert.ok(states.includes(need), `事件流缺少 ${need}`);
  }
});

/* ==================== 任务：写回 ==================== */

/** 领一次写回执行权，拿到凭据。回报时必须带上它。 */
async function leaseWriteback(jobId, body = {}) {
  const { json } = await api('POST', `/v1/jobs/${jobId}/writeback`, body);
  assert.equal(json.ok, true, `领取写回执行权失败: ${JSON.stringify(json)}`);
  assert.ok(json.attemptId, '必须发一个凭据回来');
  return json.attemptId;
}

test('写回成功后任务才算完成', async () => {
  const job = await createJob();
  await waitForState(job.id, (j) => j.state === 'writeback_pending');
  const attemptId = await leaseWriteback(job.id);
  const { json } = await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: true,
    detail: '已置入智能对象',
    attemptId
  });
  assert.equal(json.job.state, 'succeeded');
});

test('不带凭据的写回回报一律拒绝', async () => {
  // 凭据是"这次回报对应哪一次写回"的唯一依据。放行无凭据的回报，
  // 等于任何一个卡了很久才回过神的面板都能把后来那次成功的写回覆盖成失败 ——
  // 用户看到"写回失败"，而图其实好好地躺在文档里。
  const job = await createJob();
  await waitForState(job.id, (j) => j.state === 'writeback_pending');
  const { status, json } = await api('POST', `/v1/jobs/${job.id}/writeback-result`, { ok: true, detail: 'x' });
  assert.equal(json.ok, false);
  assert.equal(status, 400);
  assert.match(`${json.error.message}${json.error.details ?? ''}`, /attemptId/);
  assert.equal(
    (await api('GET', `/v1/jobs/${job.id}`)).json.job.state,
    'writeback_pending',
    '被拒的回报不该动到任务状态'
  );
});

test('写回失败不算 AI 失败：结果保留，状态可重试', async () => {
  const job = await createJob();
  await waitForState(job.id, (j) => j.state === 'writeback_pending');
  const failAttempt = await leaseWriteback(job.id);
  const { json } = await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: false,
    detail: '源文档已关闭',
    code: 'PHOTOSHOP_DOCUMENT_NOT_FOUND',
    attemptId: failAttempt
  });
  assert.equal(json.job.state, 'retryable_writeback_failure');
  assert.equal(json.job.results.length, 1, '结果必须保留');
  assert.equal(json.job.error.code, 'PHOTOSHOP_DOCUMENT_NOT_FOUND');

  // 文档重开后可以再次写回
  const retryAttempt = await leaseWriteback(job.id);
  assert.equal((await api('GET', `/v1/jobs/${job.id}`)).json.job.state, 'writeback_pending');
  const ok = await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: true,
    detail: '重试成功',
    attemptId: retryAttempt
  });
  assert.equal(ok.json.job.state, 'succeeded');
  assert.equal(ok.json.job.error, null, '成功之后那条陈旧的失败错误必须清掉，否则「已完成」旁边挂着一行红字');
});

test('已完成的任务仍可再次写回（结果永久可用）', async () => {
  const job = await createJob();
  await waitForState(job.id, (j) => j.state === 'writeback_pending');
  await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: true,
    detail: 'ok',
    attemptId: await leaseWriteback(job.id)
  });

  const again = await api('POST', `/v1/jobs/${job.id}/writeback`, { mode: 'pixelLayer', layerName: '再写一次' });
  assert.equal(again.json.job.state, 'writeback_pending');
  assert.equal(again.json.job.writeback.mode, 'pixelLayer');
  assert.equal(again.json.job.writeback.layerName, '再写一次');
});

test('仅存资产库的任务不进入写回流程', async () => {
  const asset = await uploadPng([7, 7, 7], 64);
  const { json } = await api('POST', '/v1/jobs', {
    featureId: 'comfy.wash.portrait',
    params: { prompt: 'x', seed: { mode: 'fixed', value: 1 } },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'upload' }],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  const done = await waitForState(json.job.id, (j) => j.state === 'succeeded');
  assert.equal(done.results.length, 1);
});

/* ==================== 任务：取消 / 失败 ==================== */

test('取消排队中的任务不影响其他任务', async () => {
  // 并发放到 2，两条任务才会同时挂在远端队列里，才能测"只取消其中一条"
  await api('PATCH', '/v1/settings', { generation: { maxConcurrency: 2 } });
  stub.setHold(true);
  try {
    const a = await createJob();
    const b = await createJob();
    await waitForState(a.id, (j) => !!j.remoteId);
    await waitForState(b.id, (j) => !!j.remoteId);

    const cancelled = await api('POST', `/v1/jobs/${a.id}/cancel`);
    assert.equal(cancelled.json.ok, true, JSON.stringify(cancelled.json));
    assert.equal(cancelled.json.cancelled, true, '排队中的任务一定取消得掉');
    assert.equal(cancelled.json.job.state, 'cancelled');

    stub.setHold(false);
    const bDone = await waitForState(b.id, (j) => j.results.length > 0);
    assert.equal(bDone.results.length, 1, '另一条任务应正常完成');

    const aFinal = (await api('GET', `/v1/jobs/${a.id}`)).json.job;
    assert.equal(aFinal.state, 'cancelled');
    assert.equal(aFinal.results.length, 0);
  } finally {
    // 桩一直 hold 住会让后面所有任务都卡死，无论成败都要放开
    stub.setHold(false);
    await api('PATCH', '/v1/settings', { generation: { maxConcurrency: 1 } });
  }
});

test('ComfyUI 执行失败会如实上报原始报错', async () => {
  stub.failNext();
  const job = await createJob();
  const failed = await waitForState(job.id, (j) => j.state === 'failed', 20000);
  assert.equal(failed.state, 'failed');
  assert.ok(failed.error, '必须带错误信息');
  assert.match(JSON.stringify(failed.error), /故意失败/, '应透出 ComfyUI 的原始报错');
  assert.equal(failed.results.length, 0);
});

test('失败的任务可以重试', async () => {
  stub.failNext();
  const job = await createJob();
  await waitForState(job.id, (j) => j.state === 'failed', 20000);

  const retried = await api('POST', `/v1/jobs/${job.id}/retry`);
  assert.equal(retried.json.ok, true);
  const done = await waitForState(job.id, (j) => j.results.length > 0, 20000);
  assert.equal(done.results.length, 1);
  assert.equal(done.error, null, '重试成功后应清掉错误');
});

test('重试后的耗时不会是负数', async () => {
  // 真机上见过「耗时 -299170ms」。
  // 原因：transition() 写的是 finished_at = COALESCE(finished_at, ?)，只认第一次；
  // 重试把 started_at 刷成新时间，finished_at 却还停在上一次失败的时刻，
  // 面板拿 finished - started 一减就是负的。
  stub.failNext();
  const job = await createJob();
  const failed = await waitForState(job.id, (j) => j.state === 'failed', 20000);
  assert.ok(failed.finishedAt, '第一次失败应记下结束时间');

  await new Promise((r) => setTimeout(r, 30));
  await api('POST', `/v1/jobs/${job.id}/retry`);

  const done = await waitForState(job.id, (j) => j.results.length > 0, 20000);
  assert.ok(done.startedAt, '重试后应有开始时间');
  assert.ok(done.finishedAt, '重试完成后应有结束时间');
  const elapsed = done.finishedAt - done.startedAt;
  assert.ok(elapsed >= 0, `耗时不能为负，实际 ${elapsed}ms（started=${done.startedAt} finished=${done.finishedAt}）`);
  assert.ok(
    done.finishedAt > failed.finishedAt,
    '结束时间应刷新到这一次，而不是留着上一次失败的时刻'
  );
});

test('已完成的任务不能再取消', async () => {
  const job = await createJob();
  await waitForState(job.id, (j) => j.state === 'writeback_pending');
  await api('POST', `/v1/jobs/${job.id}/writeback-result`, {
    ok: true,
    detail: 'ok',
    attemptId: await leaseWriteback(job.id)
  });
  const { json } = await api('POST', `/v1/jobs/${job.id}/cancel`);
  // ok 只表示请求处理成功了；"取消不了"是一个正常答案，看 cancelled。
  // 以前这里把业务结论塞进 ok，客户端那套统一错误处理会把它当成一次失败的调用报出去。
  assert.equal(json.ok, true, '请求本身是成功的');
  assert.equal(json.cancelled, false, '终态任务取消不掉');
  assert.equal(json.pending, false);
  assert.match(json.reason, /终态/);
});

/* ==================== 任务：校验 ==================== */

test('缺少必需输入图会被拦截', async () => {
  const { status, json } = await api('POST', '/v1/jobs', {
    featureId: 'comfy.wash.portrait',
    params: {},
    inputs: [],
    target: psTarget(),
    writeback: { mode: 'smartObject' }
  });
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'JOB_INPUT_MISSING');
  assert.equal(status, 400);
});

test('引用不存在的资产会被拦截', async () => {
  const { json } = await api('POST', '/v1/jobs', {
    featureId: 'comfy.wash.portrait',
    params: {},
    inputs: [{ paramId: 'image', assetId: 'as_ghost', index: 0, source: 'layer' }],
    target: psTarget(),
    writeback: { mode: 'smartObject' }
  });
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'ASSET_NOT_FOUND');
});

test('图生图超过 10 张会被拒绝', async () => {
  const assets = [];
  for (let i = 0; i < 11; i++) assets.push(await uploadPng([i, i * 2, i * 3], 32));
  const { json } = await api('POST', '/v1/jobs', {
    featureId: 'cloud.i2i',
    params: { prompt: 'x' },
    inputs: assets.map((a, i) => ({ paramId: 'images', assetId: a.id, index: i, source: 'upload' })),
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'JOB_PARAM_INVALID');
  assert.match(
    json.error.details ?? json.error.message,
    /最多 10 张/,
    '张数超限要报具体原因，不能被"未配置 Provider"盖掉'
  );
});

test('未绑定工作流的功能提交时明确报错', async () => {
  const asset = await uploadPng([2, 4, 6], 32);
  const { status, json } = await api('POST', '/v1/jobs', {
    featureId: 'comfy.edit.texture',
    params: { prompt: 'x' },
    inputs: [{ paramId: 'image', assetId: asset.id, index: 0, source: 'layer' }],
    target: psTarget(),
    writeback: { mode: 'smartObject' }
  });
  const wfs = (await api('GET', '/v1/workflows')).json.workflows;
  const hasBuiltin = wfs.some((w) => w.id === 'wf.edit.texture');
  if (!hasBuiltin) {
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'WORKFLOW_NOT_BOUND', '工作流库里没有这份工作流时应报"未绑定"');
    assert.equal(status, 409);
    assert.match(json.error.details ?? '', /重新绑定/);
  }
});

test('没有配置闭源 Provider 时闭源功能提交被拦截', async () => {
  const { status, json } = await api('POST', '/v1/jobs', {
    featureId: 'cloud.t2i',
    params: { prompt: 'a cat' },
    inputs: [],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(status, 409);
});

/* ==================== 任务：列表与血缘 ==================== */

test('任务列表可按功能与文档筛选', async () => {
  const byFeature = (await api('GET', '/v1/jobs?featureId=comfy.wash.portrait&limit=100')).json.jobs;
  assert.ok(byFeature.length > 0);
  assert.ok(byFeature.every((j) => j.featureId === 'comfy.wash.portrait'));

  const byDoc = (await api('GET', '/v1/jobs?documentId=101&limit=100')).json.jobs;
  assert.ok(byDoc.length > 0);
  assert.ok(byDoc.every((j) => j.target?.documentId === 101));

  const other = (await api('GET', '/v1/jobs?documentId=999')).json.jobs;
  assert.equal(other.length, 0);
});

test('重跑会产生新任务并记录血缘', async () => {
  const job = await createJob();
  await waitForState(job.id, (j) => j.results.length > 0);
  const { json } = await api('POST', `/v1/jobs/${job.id}/rerun`);
  assert.equal(json.ok, true);
  assert.notEqual(json.job.id, job.id);
  assert.equal(json.job.parentJobId, job.id);
  await waitForState(json.job.id, (j) => j.results.length > 0);
});

test('删除任务会释放输入与结果的引用', async () => {
  const job = await createJob();
  await waitForState(job.id, (j) => j.results.length > 0);
  assert.equal((await api('DELETE', `/v1/jobs/${job.id}`)).json.ok, true);
  const res = await api('GET', `/v1/jobs/${job.id}`);
  assert.equal(res.status, 404);
});

/* ==================== 并发 ==================== */

test('并发上限为 1 时任务串行执行', async () => {
  await api('PATCH', '/v1/settings', { generation: { maxConcurrency: 1 } });
  stub.setHold(true);
  const jobs = [];
  try {
    for (let i = 0; i < 3; i++) jobs.push(await createJob());

    await new Promise((r) => setTimeout(r, 400));
    const states = [];
    for (const j of jobs) states.push((await api('GET', `/v1/jobs/${j.id}`)).json.job);
    const submitted = states.filter((s) => s.remoteId).length;
    assert.equal(submitted, 1, `并发 1 时同时只应有 1 条提交出去，实际 ${submitted}`);
  } finally {
    stub.setHold(false);
  }
  for (const j of jobs) await waitForState(j.id, (x) => x.results.length > 0, 30000);
});

test('并发额度在任务结束后正确释放（不会卡死队列）', async () => {
  // 前一条测试跑完 3 条任务，如果计数泄漏，这条新任务会永远排队
  const job = await createJob();
  const done = await waitForState(job.id, (j) => j.results.length > 0, 20000);
  assert.equal(done.results.length, 1);
});

/* ==================== 系统 ==================== */

test('系统信息返回数据目录与资产占用', async () => {
  const { json } = await api('GET', '/v1/system');
  assert.equal(json.ok, true);
  assert.equal(json.dataDir, dataDir);
  assert.ok(json.assetBytes > 0);
  assert.equal(json.lanMode, false);
});

test('GPU 信息要么真实要么带原因，绝不编造', async () => {
  const { json } = await api('GET', '/v1/gpu');
  assert.equal(json.ok, true);
  if (json.gpu.available) {
    assert.ok(json.gpu.name);
    assert.ok(json.gpu.vramTotalMb > 0);
  } else {
    assert.ok(json.gpu.reason, '读不到 GPU 必须给出原因');
    assert.equal(json.gpu.name, null);
  }
});

/* ==================== 启动必须给出可用地址，或者当场失败 ==================== */

test('反复停机重启：每一次给出的地址都必须是可用的', async () => {
  /*
   * 这条守的是一个查了很久的坑。
   *
   * 老代码在 `server.address()` 拿不到对象时退回 `cfg.port` ——
   * 而测试里 cfg.port 就是 0。于是 url 成了 `http://127.0.0.1:0`：
   * Helper 看起来"启动成功"，直到某个调用方拿这个地址发请求，
   * undici 抛一句 `bad port`。
   *
   * 那条报错出现在三层之外的某个用例里，跟真正的原因毫无关系 ——
   * 表现是一批互不相干的用例集体变红，而且只在并发跑的时候偶尔出现，
   * 单独跑那个文件永远是绿的。
   *
   * 现在拿不到端口就当场抛。这里反复重启几次，每次都把地址真的用一下。
   */
  const dir = mkdtempSync(join(tmpdir(), 'psai-boot-'));
  const started = [];
  try {
    for (let i = 0; i < 3; i++) {
      const h = await startHelper({ dataDir: dir, port: 0, ephemeral: true });
      started.push(h);
      await h.recovered;

      const parsed = new URL(h.url);
      const port = Number(parsed.port);
      assert.ok(
        Number.isInteger(port) && port > 0 && port <= 65535,
        `第 ${i + 1} 次启动给出的地址不可用：${h.url}`
      );

      // 光看字符串不够 —— 真发一次请求，确认这个地址是能用的
      const res = await fetch(`${h.url}/v1/health`, {
        headers: { Authorization: `Bearer ${h.issueToken()}` }
      });
      assert.equal(res.status, 200, `第 ${i + 1} 次启动的地址请求不通：${h.url}`);

      await h.stop();
      started.pop();
    }
  } finally {
    for (const h of started) await h.stop().catch(() => undefined);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});
