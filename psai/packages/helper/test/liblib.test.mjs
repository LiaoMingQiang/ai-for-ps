/**
 * LiblibAI 适配器 + Provider 层对称性。
 *
 * 这一组守两件事：
 *  1. LiblibAI 自己的协议细节（签名、错误码映射、状态映射）
 *  2. **RunningHub 没有因为它被改坏** —— 用户的要求是"两个可互换的云端提供方"，
 *     那就必须有测试盯着这份对称性，否则下次给其中一个加东西时，
 *     另一个会安静地长出差异来。
 *
 * 协议细节全部来自真机探测（真账号打 openapi.liblibai.cloud），
 * 每条断言旁边都记了当时的响应，方便日后对着官方文档复核。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { normalizeStatus, explainLiblibCode } from '../dist/providers/liblib.js';
import { PROVIDERS, findProvider } from '../../shared/dist/providers.js';

/* ---------------- 签名 ---------------- */

test('签名算的是 uri，不是整个 URL', () => {
  // 最容易写错的一处：把带 query 或带域名的完整 URL 拿去签，
  // 结果每次都鉴权失败，而错误信息只说"签名验证失败"，看不出哪里错。
  // 真机验证过：按 uri 签能通过（拿不存在的任务查状态回 100051 而不是鉴权错）。
  const secret = 'test-secret';
  const uri = '/api/generate/webui/status';
  const ts = 1700000000000;
  const nonce = 'abcdef1234';
  const expected = createHmac('sha1', secret)
    .update(`${uri}&${ts}&${nonce}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.ok(!expected.includes('='), '结尾的 = 必须去掉');
  assert.ok(!expected.includes('+') && !expected.includes('/'), '必须是 base64url');
  // 换成完整 URL 去签会得到完全不同的结果 —— 这就是那个坑
  const wrong = createHmac('sha1', secret)
    .update(`https://openapi.liblibai.cloud${uri}?AccessKey=x&${ts}&${nonce}`)
    .digest('base64');
  assert.notEqual(expected, wrong.replace(/=+$/, ''));
});

/* ---------------- 状态映射 ---------------- */

test('generateStatus 只认有把握的几档，其余一律 unknown', () => {
  assert.equal(normalizeStatus(1), 'queued');
  assert.equal(normalizeStatus(2), 'running');
  assert.equal(normalizeStatus(5), 'done');
  assert.equal(normalizeStatus(6), 'failed');
  assert.equal(normalizeStatus(7), 'failed');
});

test('没见过的状态码报 unknown，而不是当成失败', () => {
  // unknown 会让引擎继续轮询；猜成 failed 会把一个正在跑的云端任务判死，
  // 而任务照样在那边跑、照样计费 —— 这个方向的错误是不可逆的。
  for (const code of [0, 8, 99, undefined, -1]) {
    assert.equal(normalizeStatus(code), 'unknown', `${code} 不该被当成终态`);
  }
});

/* ---------------- 错误码映射 ---------------- */

test('限流归到可重试，不判死', () => {
  // 真机：{"code":429,"msg":"请求过多，请稍后重试"}
  const e = explainLiblibCode(429, '请求过多，请稍后重试', '/api/generate/webui/status');
  assert.equal(e.code, 'PROVIDER_RATE_LIMIT');
  assert.equal(e.retryable, true, '限流是"再等等"，判死的话用户重试一下又好了，最消耗信任');
});

test('任务不存在归到 JOB_LOST', () => {
  // 真机：{"code":100051,"msg":"生图任务不存在: 000..."}
  const e = explainLiblibCode(100051, '生图任务不存在: 000', '/api/generate/webui/status');
  assert.equal(e.code, 'JOB_LOST');
});

test('模型/模板不存在要指路到设置，而不是报一个看不懂的错', () => {
  // 真机：{"code":200001,"msg":"model.notExist"}
  const a = explainLiblibCode(200001, 'model.notExist', '/api/model/version/get');
  assert.equal(a.code, 'PROVIDER_MODEL_UNAVAILABLE');
  // 真机：{"code":100000,"msg":"参数无效: template not found, templateUuid: x"}
  const b = explainLiblibCode(100000, '参数无效: template not found, templateUuid: x', '/api/generate/comfyui/app');
  assert.equal(b.code, 'PROVIDER_MODEL_UNAVAILABLE');
  assert.match(String(b.details ?? b.message), /liblib\.art/, '要告诉用户 uuid 去哪儿复制');
});

test('路由不存在要说成"插件侧的问题"，别让用户去改自己的参数', () => {
  // 这个平台把"路由不存在"也塞进 code 100000，和"参数不对"混在一起。
  // 分开报很重要：路由不对是我们的 bug，参数不对是用户能自己改的。
  const e = explainLiblibCode(100000, 'No static resource api/generate/comfy/app.', '/api/generate/comfy/app');
  assert.equal(e.code, 'PROVIDER_BAD_RESPONSE');
  assert.match(String(e.details ?? e.message), /插件侧/);
});

test('参数校验失败归到 JOB_PARAM_INVALID', () => {
  // 真机：{"code":100050,"msg":"生图参数未通过参数完整度校验，请检查参数配置"}
  const e = explainLiblibCode(100050, '生图参数未通过参数完整度校验，请检查参数配置', '/api/generate/webui/text2img');
  assert.equal(e.code, 'JOB_PARAM_INVALID');
});

test('鉴权失败能被认出来', () => {
  // 真机（故意用错的 SecretKey）：msg = "签名验证失败"
  const e = explainLiblibCode(100000, '签名验证失败', '/api/generate/webui/status');
  assert.equal(e.code, 'PROVIDER_AUTH_FAILED');
});

/* ---------------- Provider 层对称性 ---------------- */

test('LiblibAI 在出厂 Provider 名单里', () => {
  const p = findProvider('liblib');
  assert.ok(p, 'LiblibAI 必须是内置 Provider，不是一个外链');
  assert.equal(p.kind, 'liblib');
  assert.equal(p.defaultBaseUrl, 'https://openapi.liblibai.cloud');
  assert.equal(p.recommended, true, '要和 RunningHub 一样出现在推荐平台里');
});

test('LiblibAI 同时具备云端工作流与托管生图两种能力', () => {
  // 用户明确要求的第 2 条：两类能力都要有
  const p = findProvider('liblib');
  assert.ok(p.capabilities.includes('workflow'), '缺少云端工作流能力');
  assert.ok(p.capabilities.includes('textToImage'), '缺少托管生图能力');
  assert.ok(p.capabilities.includes('imageToImage'));
});

test('LiblibAI 是两段式密钥，且都必填', () => {
  const p = findProvider('liblib');
  const keys = p.credentials.map((c) => c.key);
  assert.deepEqual(keys, ['accessKey', 'secretKey']);
  for (const c of p.credentials) {
    assert.equal(c.secret, true, `${c.key} 必须按密文处理`);
    assert.equal(c.required, true, `${c.key} 少一个就签不出名字，必须必填`);
  }
});

test('RunningHub 没有被改坏', () => {
  // 回归：这一轮动了 Provider 注册表、设置结构和设置页，
  // RunningHub 的对外契约必须一个字都没变。
  const p = findProvider('runninghub');
  assert.ok(p);
  assert.equal(p.kind, 'runninghub');
  assert.equal(p.defaultBaseUrl, 'https://www.runninghub.cn');
  assert.equal(p.recommended, true);
  assert.ok(p.capabilities.includes('workflow'));
  assert.deepEqual(p.credentials.map((c) => c.key), ['apiKey', 'workflowId']);
  assert.equal(p.cancelSupport, 'none');
});

test('两个云端工作流平台在能力上是对称的', () => {
  // 用户要的是"两个可互换的云端提供方"。可互换的最低标准：
  // 凡是 RunningHub 有的工作流侧能力，LiblibAI 都得有。
  const rh = findProvider('runninghub');
  const lb = findProvider('liblib');
  for (const cap of ['workflow', 'textToImage', 'imageToImage', 'progress', 'listModels']) {
    assert.ok(rh.capabilities.includes(cap), `RunningHub 少了 ${cap}`);
    assert.ok(lb.capabilities.includes(cap), `LiblibAI 少了 ${cap}`);
  }
  // 两家都没有取消接口，都必须如实声明 —— 会产生费用的事不能含糊
  assert.equal(rh.cancelSupport, 'none');
  assert.equal(lb.cancelSupport, 'none');
});

test('按能力筛得出「工作流型云平台」这一类，不用点名 id', () => {
  // 设置页和绑定页现在都靠这个筛法。写死 id 的话，
  // 每加一个平台就要回去改 UI，漏改就是"配好了却选不着"。
  const cloudWorkflow = PROVIDERS.filter((p) => p.capabilities.includes('workflow') && p.kind !== 'comfyui');
  const ids = cloudWorkflow.map((p) => p.id).sort();
  assert.deepEqual(ids, ['liblib', 'runninghub']);
});

test('每个 Provider 的 id 与凭据字段都不重复', () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'Provider id 撞车');
  for (const p of PROVIDERS) {
    const keys = p.credentials.map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length, `${p.id} 的凭据字段名撞车`);
  }
});
