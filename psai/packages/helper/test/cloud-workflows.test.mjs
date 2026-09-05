/**
 * 云端工作流条目：登记、区分、以及"对它做不了什么"。
 *
 * 背景。用户在真机上问的是：云端的 webapp id 要怎么导入才算合理？要先验证吗？
 * 怎么区分新添加的是本地工作流还是云端的 API？
 *
 * 在这之前这三个问题都没有答案，因为**根本没有云端条目这回事**：
 * 云端工作流 ID 只能在两个地方手打（Provider 卡片上的默认 ID、
 * 某个功能绑定里的「自定义工作流 ID…」），打完不留痕，换个功能要再打一遍
 * 19 位数字，也没有任何地方能看到"我一共加过哪些"。
 *
 * 现在它们和本机图共用一张表，靠 kind 区分。这一组用例钉死三件事：
 *   一、登记进去的能被原样读回来，并且**明确标着**是云端的；
 *   二、老库里已有的本机图不会因为这个改动变成 undefined；
 *   三、对云端条目做没有意义的操作（参数绑定、依赖检查）会被明确挡下，
 *       而不是对着一份空图跑出"全部就绪"这种看起来通过、实际什么都没查的结论。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startHelper } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));

let helper;
let dataDir;
let PORT = 0;
let token;

async function call(method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (!Number.isInteger(PORT) || PORT <= 0) {
    throw new Error(`测试用的 Helper 端口无效：PORT=${PORT}。多半是某次启动 Helper 没成功，或者在赋值前就发了请求。`);
  }
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: payload });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-cloudwf-'));
  helper = await startHelper({
    port: 0,
    dataDir,
    ephemeral: true,
    workflowsDir: resolve(here, '../../../workflows')
  });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;
});

after(async () => {
  await helper?.stop();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

test('登记一条 RunningHub 云端工作流，读回来带着平台和 ID', async () => {
  const res = await call('POST', '/v1/workflows/cloud', {
    name: '老照片修复',
    providerId: 'runninghub',
    remoteId: '1234567890123456789'
  });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.workflow.kind, 'cloud');
  assert.equal(res.body.workflow.providerId, 'runninghub');
  assert.equal(res.body.workflow.remoteId, '1234567890123456789');

  const list = await call('GET', '/v1/workflows');
  const mine = list.body.workflows.find((w) => w.name === '老照片修复');
  assert.ok(mine, '登记完应当出现在列表里 —— 这正是用户要的那份"清单"');
  assert.equal(mine.kind, 'cloud');
  assert.equal(mine.remoteId, '1234567890123456789');
});

test('内置工作流仍然是 comfy —— 加列不能把老记录变成 undefined', async () => {
  const list = await call('GET', '/v1/workflows');
  const builtins = list.body.workflows.filter((w) => w.source === 'builtin');
  assert.ok(builtins.length >= 12, `内置工作流应当还在，实际 ${builtins.length} 份`);
  for (const w of builtins) {
    assert.equal(w.kind, 'comfy', `${w.name} 的 kind 应当是 comfy`);
    assert.equal(w.providerId, null);
    assert.equal(w.remoteId, null);
  }
});

test('同名同 ID 重复登记不产生第二条', async () => {
  const first = await call('POST', '/v1/workflows/cloud', {
    name: '重复登记测试',
    providerId: 'runninghub',
    remoteId: '9999999999999999999'
  });
  const again = await call('POST', '/v1/workflows/cloud', {
    name: '重复登记测试',
    providerId: 'runninghub',
    remoteId: '9999999999999999999'
  });
  assert.equal(again.body.versionBumped, false);
  assert.equal(again.body.workflow.id, first.body.workflow.id);

  const list = await call('GET', '/v1/workflows');
  const hits = list.body.workflows.filter((w) => w.name === '重复登记测试');
  assert.equal(hits.length, 1, '同一个 ID 登记两次应当还是一条');
});

test('同名但换了 ID：算新版本，旧的保留', async () => {
  await call('POST', '/v1/workflows/cloud', {
    name: '换了ID',
    providerId: 'runninghub',
    remoteId: '1111111111111111111'
  });
  const bumped = await call('POST', '/v1/workflows/cloud', {
    name: '换了ID',
    providerId: 'runninghub',
    remoteId: '2222222222222222222'
  });
  assert.equal(bumped.body.versionBumped, true);
  assert.equal(bumped.body.workflow.version, '1.1.0');

  const list = await call('GET', '/v1/workflows');
  const hits = list.body.workflows.filter((w) => w.name === '换了ID');
  assert.equal(hits.length, 2, '旧版本要留着 —— 用户可能已经用它出过一批图');
});

test('缺 ID / 缺名称 / 未知平台，都要被明确挡下', async () => {
  const noId = await call('POST', '/v1/workflows/cloud', { name: 'x', providerId: 'runninghub', remoteId: '' });
  assert.notEqual(noId.body.ok, true);
  assert.match(JSON.stringify(noId.body), /云端工作流 ID/);

  const noName = await call('POST', '/v1/workflows/cloud', { name: '  ', providerId: 'runninghub', remoteId: '1' });
  assert.match(JSON.stringify(noName.body), /名称/);

  const bogus = await call('POST', '/v1/workflows/cloud', { name: 'x', providerId: '不存在的平台', remoteId: '1' });
  assert.match(JSON.stringify(bogus.body), /未知的 Provider/);
});

test('本机 ComfyUI 不能登记云端工作流 ID', async () => {
  // ComfyUI 跑在本机，"云端工作流 ID"对它没有意义。
  // 允许登记的话，绑上去之后提交必然失败，而失败原因会指向别处。
  const res = await call('POST', '/v1/workflows/cloud', {
    name: 'x',
    providerId: 'comfyui',
    remoteId: '123'
  });
  assert.match(JSON.stringify(res.body), /不是以工作流为单位/);
});

test('对云端条目做参数绑定：明确拒绝，不许对着空图跑校验', async () => {
  const made = await call('POST', '/v1/workflows/cloud', {
    name: '绑定应当被拒',
    providerId: 'runninghub',
    remoteId: '3333333333333333333'
  });
  const id = made.body.workflow.id;
  const res = await call('PUT', `/v1/workflows/${encodeURIComponent(id)}/bindings`, {
    bindings: [{ paramId: 'prompt', nodeId: '6', field: 'text', transform: 'none', required: true }]
  });
  assert.notEqual(res.body.ok, true, '云端条目上不该能存参数绑定');
  assert.match(JSON.stringify(res.body), /平台侧/);
});

test('对云端条目做依赖检查：明确拒绝，不许报"全部就绪"', async () => {
  const made = await call('POST', '/v1/workflows/cloud', {
    name: '依赖检查应当被拒',
    providerId: 'runninghub',
    remoteId: '4444444444444444444'
  });
  const id = made.body.workflow.id;
  const res = await call('GET', `/v1/workflows/${encodeURIComponent(id)}/dependencies`);
  // 这一条是关键：对着空图跑依赖检查会得到 missingNodes: [] / missingModels: []，
  // 也就是"依赖齐全"。那是一个看起来通过、实际什么都没查的结论，比报错更糟。
  assert.notEqual(res.body.ok, true, '云端条目的依赖检查必须被拒绝，不能返回"齐全"');
  assert.match(JSON.stringify(res.body), /平台/);
});

test('删除云端条目照常可用', async () => {
  const made = await call('POST', '/v1/workflows/cloud', {
    name: '待删除',
    providerId: 'runninghub',
    remoteId: '5555555555555555555'
  });
  const del = await call('DELETE', `/v1/workflows/${encodeURIComponent(made.body.workflow.id)}`);
  assert.equal(del.body.ok, true);
  const list = await call('GET', '/v1/workflows');
  assert.equal(list.body.workflows.filter((w) => w.name === '待删除').length, 0);
});

/* ---------------- 「自定义工作流」选到云端条目时的作业解析 ---------------- */

test('自定义工作流点名一条云端条目：作业记下它，不套本机图的校验', async () => {
  /*
   * 「自定义工作流」的工作流是每次提交现选的。选到云端条目时走的是
   * 云端平台，不该套本机图那套校验 —— 节点在平台那边，本机没有图。
   *
   * 这条对着旧实现跑会红：旧的解析分支条件里带着
   * `providerId !== 'runninghub'`，云端条目正好落在被排除的那一侧，
   * 于是 workflowId 留在 null —— 用户在下拉里选了，等于没选。
   */
  const made = await call('POST', '/v1/workflows/cloud', {
    name: '自定义工作流用的云端图',
    providerId: 'runninghub',
    remoteId: '1010101010101010101'
  });
  const wfId = made.body.workflow.id;

  const job = await call('POST', '/v1/jobs', {
    featureId: 'comfy.custom',
    params: {},
    inputs: [],
    target: null,
    writeback: { mode: 'assetOnly' },
    workflowId: wfId,
    providerId: 'runninghub'
  });
  assert.equal(job.body.ok, true, `作业没建起来：${JSON.stringify(job.body)}`);
  assert.equal(job.body.job.workflowId, wfId, '选中的那条云端工作流必须被记进作业里');
});

test('自定义工作流什么都没选：照旧报"尚未绑定工作流"', async () => {
  // 回归：加了云端分支之后，本机那条路的行为必须一个字没变。
  const job = await call('POST', '/v1/jobs', {
    featureId: 'comfy.custom',
    params: {},
    inputs: [],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  assert.notEqual(job.body.ok, true);
  assert.match(JSON.stringify(job.body), /尚未绑定工作流|WORKFLOW_NOT_BOUND/);
});

test('点名一个库里没有的工作流：照旧报得清清楚楚', async () => {
  const job = await call('POST', '/v1/jobs', {
    featureId: 'comfy.custom',
    params: {},
    inputs: [],
    target: null,
    writeback: { mode: 'assetOnly' },
    workflowId: 'wf.user.根本不存在.1_0_0'
  });
  assert.notEqual(job.body.ok, true);
  assert.match(JSON.stringify(job.body), /不在工作流库中|WORKFLOW_NOT_BOUND/);
});

/* ---------------- AI 应用 vs ComfyUI 工作流 ---------------- */

const APP_CURL = `curl --location --request POST 'https://www.runninghub.ai/openapi/v2/run/ai-app/1892509998193545217' \
--header "Authorization: Bearer \${RUNNINGHUB_API_KEY}" \
--data-raw '{
  "nodeInfoList": [
    { "nodeId": "525", "fieldName": "image", "fieldValue": "x.png", "description": "Upload product retouching" },
    { "nodeId": "727", "fieldName": "int", "fieldValue": "25", "description": "Similarity value" }
  ],
  "instanceType": "default"
}'`;

test('AI 应用不带节点参数表：登记就被拒，并说清去哪儿拿', async () => {
  /*
   * 这一条是花钱买来的教训的守门人。
   *
   * 少了 nodeInfoList，提交时那个数组是空的，而 RunningHub **照跑不误** ——
   * 用作者预置的示例图出一张图，带着 SUCCESS 回来。用户付了钱，
   * 拿到一张跟自己输入毫无关系的图，界面上还看不出哪里不对。
   * 所以必须拦在登记这一步，而不是等提交。
   */
  const res = await call('POST', '/v1/workflows/cloud', {
    name: '没带节点表的应用',
    providerId: 'runninghub',
    remoteId: '1892509998193545217',
    remoteKind: 'aiApp'
  });
  assert.notEqual(res.body.ok, true);
  assert.match(JSON.stringify(res.body), /请求示例|节点/);
});

test('AI 应用带上 curl：解析出节点表并存下来', async () => {
  const res = await call('POST', '/v1/workflows/cloud', {
    name: 'AI产品精修3.0',
    providerId: 'runninghub',
    remoteId: '1892509998193545217',
    remoteKind: 'aiApp',
    nodeInfoRaw: APP_CURL
  });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.workflow.remoteKind, 'aiApp');
  assert.equal(res.body.workflow.nodeInfo.length, 2);
  assert.equal(res.body.workflow.nodeInfo[0].fieldName, 'image');
  assert.equal(res.body.workflow.nodeInfo[1].defaultValue, '25', '示例值要留着当默认值');
});

test('ComfyUI 工作流不需要节点表', async () => {
  // 工作流能从平台拉回 ComfyUI 图，节点是扫出来的，不用用户粘。
  const res = await call('POST', '/v1/workflows/cloud', {
    name: '云端工作流一份',
    providerId: 'runninghub',
    remoteId: '2095750036550721537',
    remoteKind: 'workflow'
  });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.workflow.remoteKind, 'workflow');
  assert.equal(res.body.workflow.nodeInfo, null);
});

test('不写类型时按工作流处理 —— 加列之前登记的那些不能变成 undefined', async () => {
  const res = await call('POST', '/v1/workflows/cloud', {
    name: '没写类型的老条目',
    providerId: 'runninghub',
    remoteId: '7777777777777777777'
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.workflow.remoteKind, 'workflow');
});

test('粘贴的内容里没有 nodeInfoList：报错要指向该去哪儿复制', async () => {
  const res = await call('POST', '/v1/workflows/cloud', {
    name: '贴错了',
    providerId: 'runninghub',
    remoteId: '1892509998193545218',
    remoteKind: 'aiApp',
    nodeInfoRaw: '我随便贴了点别的东西'
  });
  assert.notEqual(res.body.ok, true);
  assert.match(JSON.stringify(res.body), /API 页面|请求示例/);
});

/* ---------------- 平台错误码要翻成能照着做的话 ---------------- */

test('RunningHub 的两个实测错误码被翻译，且保留平台原文', async () => {
  /*
   * 这两个码正是把上一轮排查带偏的东西：
   *   WORKFLOW_NOT_SAVED_OR_NOT_RUNNING —— 看着像"我们没绑定"，
   *     其实是"你还没在平台上跑过这份工作流"
   *   WORKFLOW_NOT_EXISTS —— 看着像"ID 打错了"，
   *     其实多半是把 AI 应用的 ID 当成工作流 ID 填了
   *
   * 原样端一句英文常量出去，用户既不知道什么意思也不知道该做什么。
   * 这条对着旧实现跑会红：旧的只会拼成 `RunningHub: <英文常量>`。
   */
  const { RunningHubAdapter } = await import('../dist/providers/runninghub.js');
  const { Logger } = await import('../dist/log.js');
  const log = new Logger(dataDir, 'error');

  // 用一个立刻回 RunningHub 错误信封的假服务器，避免打真平台
  const { createServer } = await import('node:http');
  const cases = [
    ['WORKFLOW_NOT_SAVED_OR_NOT_RUNNING', /保存并成功运行过一次|点一次「运行」/],
    ['WORKFLOW_NOT_EXISTS', /AI 应用|类型/]
  ];

  for (const [platformMsg, expect] of cases) {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 810, msg: platformMsg, data: null }));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const adapter = new RunningHubAdapter(
      { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-FAKEnotarealkey0000000000', defaultWorkflowId: '', timeoutMs: 5000 },
      log
    );
    /*
     * 用 test() —— 它走 post()，会拿到 RunningHub 的错误信封。
     * 不能用 listModels()：那个在联网之前就抛「该 Provider 不支持此操作」，
     * 根本到不了翻译那一步（第一版就是这么写错的）。
     */
    let text = '';
    try {
      const r = await adapter.testConnection();
      text = String(r?.detail ?? '');
    } catch (e) {
      text = String(e?.message ?? e);
    }
    await new Promise((r) => srv.close(r));

    assert.match(text, expect, `「${platformMsg}」应当被翻译成能照着做的话，实际：${text}`);
    assert.match(text, new RegExp(platformMsg), '平台原文要保留，方便对着平台文档查');
  }
});

/* ---------------- 逐项填写的节点表（粘贴被截断时唯一稳的那条路） ---------------- */

test('直接传节点表数组也能登记 —— 不必经过剪贴板', async () => {
  /*
   * 真机上 UXP 的文本框粘贴会被截断：整段 curl 粘进去只剩开头几行，
   * 解析必然失败，报出来的是「没能找到 nodeInfoList」，看起来像我们不认
   * 他的格式。那是宿主的行为，改不了 —— 所以界面改成逐项填写，
   * 这条路径必须在服务端也走得通。
   */
  const res = await call('POST', '/v1/workflows/cloud', {
    name: '手填节点表的应用',
    providerId: 'runninghub',
    remoteId: '1892509998193545299',
    remoteKind: 'aiApp',
    nodeInfo: [
      { nodeId: '525', fieldName: 'image', defaultValue: '' },
      { nodeId: '727', fieldName: 'int', defaultValue: '25' }
    ]
  });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.workflow.nodeInfo.length, 2);
  assert.equal(res.body.workflow.nodeInfo[0].fieldName, 'image');
  assert.equal(res.body.workflow.nodeInfo[1].defaultValue, '25');
});

test('节点表里空行被丢掉，全空则明确报错', async () => {
  // 界面上默认摆着一行空的，用户只填了一行时另一行不该让整次登记失败。
  const ok = await call('POST', '/v1/workflows/cloud', {
    name: '带空行的应用',
    providerId: 'runninghub',
    remoteId: '1892509998193545288',
    remoteKind: 'aiApp',
    nodeInfo: [
      { nodeId: '525', fieldName: 'image' },
      { nodeId: '', fieldName: '' },
      { nodeId: '  ', fieldName: 'x' }
    ]
  });
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  assert.equal(ok.body.workflow.nodeInfo.length, 1);

  const bad = await call('POST', '/v1/workflows/cloud', {
    name: '全空的应用',
    providerId: 'runninghub',
    remoteId: '1892509998193545277',
    remoteKind: 'aiApp',
    nodeInfo: [{ nodeId: '', fieldName: '' }]
  });
  assert.notEqual(bad.body.ok, true);
  assert.match(JSON.stringify(bad.body), /节点号|字段名|请求示例/);
});

/* ---------------- 「AI 应用」只属于 RunningHub ---------------- */

test('在别的平台下选「AI 应用」被拦下，并说清该选什么', async () => {
  /*
   * AI 应用是 RunningHub 独有的（它有一套 v2 接口 /openapi/v2/run/ai-app/{id}）。
   * LiblibAI 没有这个概念 —— 让它存进去的话，那份节点表不会有任何人读，
   * 提交时按工作流那条路走，报出来的错跟真正的原因毫无关系。
   *
   * 界面上这个类型选择器现在只对 RunningHub 出现；这条守的是服务端那一侧，
   * 免得界面改坏了就直接漏过去。
   */
  const res = await call('POST', '/v1/workflows/cloud', {
    name: 'Liblib 不该有 AI 应用',
    providerId: 'liblib',
    remoteId: 'some-uuid',
    remoteKind: 'aiApp',
    nodeInfo: [{ nodeId: '1', fieldName: 'image' }]
  });
  assert.notEqual(res.body.ok, true);
  assert.match(JSON.stringify(res.body), /RunningHub 特有|云端工作流/);
});

test('LiblibAI 登记云端工作流照常可用', async () => {
  // 拦掉 aiApp 不能把 LiblibAI 正常那条路也堵上。
  const res = await call('POST', '/v1/workflows/cloud', {
    name: 'Liblib 的一份工作流',
    providerId: 'liblib',
    remoteId: 'e10adc3949ba59abbe56e057f20f883e',
    remoteKind: 'workflow'
  });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.workflow.providerId, 'liblib');
  assert.equal(res.body.workflow.remoteKind, 'workflow');
});
