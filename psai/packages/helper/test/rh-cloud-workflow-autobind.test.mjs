/**
 * 用户登记的云端 ComfyUI 工作流：绑定是**拉回图之后自动扫出来的**。
 *
 * 这是「工作流填个 ID 就能用」成立的原因，也是它和 AI 应用的分界线：
 *
 *   工作流   平台给得出 ComfyUI 图 → 本机扫一遍就知道哪个节点收图 → 全自动
 *   AI 应用  ID 拉不回图（实测 380 WORKFLOW_NOT_EXISTS）→ 只能让用户粘节点表
 *
 * 在这之前，登记的云端工作流提交时必然被闸门拦下（「没有参数绑定表」），
 * 因为绑定只有两个来源：内置预设、或者本机导入的同名工作流。
 * 用户登记的那条两样都不是 —— 于是登记了也跑不了。
 *
 * 真机验证过：工作流 2095750596867792898，自动扫出 8 条绑定
 * （image / sampler / seed / scheduler / denoise / steps / upscaleModel / prompt），
 * 1024×1024 的输入跑出 8192×8192，出来的是输入图本身而不是作者的示例图。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunningHubAdapter } from '../dist/providers/runninghub.js';
import { Logger } from '../dist/log.js';

/** 一份最小但真实的图：取图 → 采样 → 存图 */
const GRAPH = {
  '914': { class_type: 'LoadImage', inputs: { image: '作者的示例图.jpg' }, _meta: { title: 'Load Image' } },
  '1092': {
    class_type: 'CLIPTextEncode',
    inputs: { text: '作者写的提示词', clip: ['1062', 0] },
    _meta: { title: 'CLIP Text Encode (Prompt)' }
  },
  '1062': { class_type: 'CLIPLoader', inputs: { clip_name: 'x.safetensors' }, _meta: { title: 'Load CLIP' } },
  '1096': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['914', 0] }, _meta: {} }
};

let srv;
let port;
let dataDir;
/** 记下最后一次 /task/openapi/create 的请求体，断言用 */
let lastCreate = null;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-rhauto-'));
  srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (o) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (req.url.includes('getJsonApiFormat')) return json({ code: 0, data: { prompt: JSON.stringify(GRAPH) } });
      if (req.url.includes('/upload')) return json({ code: 0, data: { fileName: '我上传的图.png' } });
      if (req.url.includes('/create')) {
        lastCreate = JSON.parse(body);
        return json({ code: 0, data: { taskId: '2095775803810054145' } });
      }
      json({ code: 0, data: {} });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
});

after(async () => {
  await new Promise((r) => srv.close(r));
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

function adapterAt() {
  return new RunningHubAdapter(
    { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-FAKEnotarealkey00000000', defaultWorkflowId: '', timeoutMs: 10_000 },
    new Logger(dataDir, 'error')
  );
}

const cloudEntry = {
  id: 'wf.cloud.t',
  name: '登记的云端工作流',
  kind: 'cloud',
  providerId: 'runninghub',
  remoteId: '2095750596867792898',
  remoteKind: 'workflow',
  nodeInfo: null,
  bindings: []
};

function ctxWith(extra = {}) {
  return {
    jobId: 'j1',
    featureId: 'comfy.custom',
    params: {},
    inputs: [{ paramId: 'image', index: 0, buffer: Buffer.from([1, 2, 3]), filename: 'in.png', mime: 'image/png' }],
    remoteWorkflowId: '2095750596867792898',
    remoteWorkflow: cloudEntry,
    ...extra
  };
}

test('登记的云端工作流没有绑定表：拉图自动推导，提交得出去', async () => {
  lastCreate = null;
  const res = await adapterAt().submit(ctxWith());
  assert.equal(res.remoteId, '2095775803810054145');
  assert.ok(lastCreate, '应当真的调用了 /task/openapi/create');
});

test('输入图落到了 LoadImage 那个节点上', async () => {
  /*
   * 这一条是整组里最要紧的。
   *
   * 图没落位的话，RunningHub **照跑不误** —— 用图里原本那张
   * 「作者的示例图.jpg」出一张图，带着成功回来。用户付了钱，
   * 拿到一张跟自己输入毫无关系的图，界面上还看不出哪里不对。
   */
  lastCreate = null;
  await adapterAt().submit(ctxWith());
  const hit = lastCreate.nodeInfoList.find((n) => n.nodeId === '914' && n.fieldName === 'image');
  assert.ok(hit, `输入图必须写进 #914.image，实际发出去的是 ${JSON.stringify(lastCreate.nodeInfoList)}`);
  assert.equal(hit.fieldValue, '我上传的图.png', '落位的必须是我们上传后拿到的文件名');
  assert.notEqual(hit.fieldValue, '作者的示例图.jpg');
});

test('AI 应用不走这条路 —— 它拉不回图，不能靠扫描兜底', async () => {
  /*
   * 如果这里也去拉图，AI 应用会拿到 380 WORKFLOW_NOT_EXISTS，
   * 报错就变成"工作流不存在"，而真正该说的是"你没提供节点表"。
   */
  const appEntry = { ...cloudEntry, remoteKind: 'aiApp', nodeInfo: [] };
  let err;
  try {
    await adapterAt().submit(ctxWith({ remoteWorkflow: appEntry }));
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'AI 应用没有节点表时必须被拦下');
  // PsaiError 的第二个参数进的是 details，message 是错误码的通用文案
  assert.match(`${err.message} ${err.details ?? ''}`, /节点参数表|请求示例/);
});

test('内置预设仍然优先，不会被自动扫描顶掉', async () => {
  /*
   * 预设的节点号是对着云端真图核对过的，比扫出来的可靠。这条防的是
   * "为了让登记的工作流能跑，顺手把预设那条路也改成扫描"。
   *
   * 怎么观测：这个假服务器对任何 ID 都回同一份最小图，而预设的绑定
   * 指向的是真图里的节点号 —— 用预设绑定就必然撞上"节点不存在"。
   * 换句话说，**这个错误正是预设生效的证据**；一旦它变成提交成功，
   * 就说明预设被扫描结果顶掉了。
   */
  let err;
  try {
    await adapterAt().submit(
      ctxWith({
        remoteWorkflowId: '1909669429062631425',
        remoteWorkflow: { ...cloudEntry, remoteId: '1909669429062631425' }
      })
    );
  } catch (e) {
    err = e;
  }
  assert.ok(err, '用了预设绑定就该撞上节点不存在；能提交成功反而说明预设被扫描顶掉了');
  assert.match(`${err.message} ${err.details ?? ''}`, /不存在的节点/);
});
