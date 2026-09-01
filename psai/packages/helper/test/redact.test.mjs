/**
 * 日志脱敏的回归测试。
 *
 * 诊断包是直接打包日志目录的，所以脱敏必须在**写入那一刻**完成 ——
 * 导出时再处理是来不及的，文件已经在磁盘上躺了很久了。
 *
 * 下面每一条 must 都对应一种真实会出现在日志里的密钥形态。
 * 加规则之前先在这里加用例，别反过来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { redact } from '../dist/log.js';
import { startDeadServer } from './_dead-server.mjs';
import { safeEndpoint, mapNetworkError, ensureOk, jsonOf, httpFetch } from '../dist/providers/http.js';

/*
 * LiblibAI 的签名地址样本。
 *
 * 它的鉴权整个在查询串上：AccessKey 是身份，Signature 是拿 SecretKey 算出来的。
 * 所以任何一条带着完整 URL 的日志/异常/接口响应，都等于把密钥发出去了 ——
 * 而带完整 URL 的最常见来源恰恰是超时和连不上，这两种最常发生。
 */
const LIBLIB_ACCESS_KEY = 'AkFAKE1234567890abcd';
const LIBLIB_SIGNATURE = 'SgFAKEZm9vYmFyYmF6cXV4MTIz';
const LIBLIB_NONCE = 'NcFAKE1234';
const LIBLIB_SIGNED_URL =
  'https://openapi.liblibai.cloud/api/generate/webui/status' +
  `?AccessKey=${LIBLIB_ACCESS_KEY}&Signature=${LIBLIB_SIGNATURE}` +
  `&Timestamp=1767225600000&SignatureNonce=${LIBLIB_NONCE}`;

/** 这些必须被打码。value 是密钥本身，断言它不出现在结果里。 */
const MUST_REDACT = [
  {
    name: 'OpenAI / Comfly 风格的 sk- 前缀',
    line: 'comfly 已配置 key=sk-FAKEfixture0000000000000000000000000000',
    secret: 'sk-FAKEfixture0000000000000000000000000000'
  },
  {
    name: 'Gemini 的 AIza 前缀',
    line: 'gemini key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    secret: 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
  },
  {
    name: '魔搭的 ms- 前缀',
    line: 'modelscope token ms-0123456789abcdef0123',
    secret: 'ms-0123456789abcdef0123'
  },
  {
    name: 'JSON 请求体里的 apiKey 字段',
    line: 'POST /task/openapi/create {"apiKey":"deadbeefcafef00d0123456789abcdef","workflowId":"1"}',
    secret: 'deadbeefcafef00d0123456789abcdef'
  },
  {
    name: 'Authorization: Bearer 头',
    line: 'Authorization: Bearer aVeryLongOpaqueTokenValue1234567890',
    secret: 'aVeryLongOpaqueTokenValue1234567890'
  },
  {
    // 配对 token 就是这么进 WebSocket URL 的：ws://…/v1/events?token=…
    // 谁把请求行写进日志，一个长期有效的 token 就明文躺在那儿了
    name: 'URL 查询串里的 token（WebSocket 配对用的就是这个形态）',
    line: 'GET /v1/events?token=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA HTTP/1.1',
    secret: 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA'
  },
  {
    name: 'URL 查询串里的 apiKey',
    line: 'https://www.runninghub.cn/x?apiKey=deadbeefcafef00d0123456789abcdef&z=1',
    secret: 'deadbeefcafef00d0123456789abcdef'
  },
  {
    // RunningHub 的 key 是 32 位十六进制、不带任何前缀，
    // 前缀规则一条都匹配不到，必须靠"裸十六进制"这条兜住
    name: '裸的 32 位十六进制（RunningHub API Key 的形态）',
    line: 'runninghub 鉴权通过 deadbeefcafef00d0123456789abcdef',
    secret: 'deadbeefcafef00d0123456789abcdef'
  },
  {
    // LiblibAI 的鉴权整个在 URL 上。一条超时日志就能同时泄掉身份和签名，
    // 而超时是最常见的一种日志。
    name: 'LiblibAI 签名 URL 里的 AccessKey',
    line: `PROVIDER_TIMEOUT ${LIBLIB_SIGNED_URL} 超过 30000ms 未响应`,
    secret: LIBLIB_ACCESS_KEY
  },
  {
    name: 'LiblibAI 签名 URL 里的 Signature',
    line: `PROVIDER_TIMEOUT ${LIBLIB_SIGNED_URL} 超过 30000ms 未响应`,
    secret: LIBLIB_SIGNATURE
  },
  {
    // SignatureNonce 本身不是密钥，但它和 Signature 前缀重名 ——
    // 正则顺序写反的话，`signature=` 那条会先咬掉 `SignatureNonce=` 的前半截，
    // 留下 `Nonce=xxx` 在日志里，而真正的 Signature 反而没被打掉。
    // 这条样本守的是那个顺序。
    name: 'LiblibAI 的 SignatureNonce',
    line: `GET ${LIBLIB_SIGNED_URL}`,
    secret: LIBLIB_NONCE
  },
  {
    name: '大小写变体：accesskey / signature 全小写',
    line: 'GET /api/generate/webui/status?accesskey=AkFAKE1234567890abcd&signature=SgFAKEzzzzzzzzzzzzzzzzzzzzzz',
    secret: 'SgFAKEzzzzzzzzzzzzzzzzzzzzzz'
  },
  {
    name: 'JSON 体里的 accessKey / secretKey',
    line: '{"accessKey":"AkFAKE1234567890abcd","secretKey":"SkFAKEzzzzzzzzzzzzzzzzzzzzzzzz"}',
    secret: 'SkFAKEzzzzzzzzzzzzzzzzzzzzzzzz'
  },
  {
    // Midjourney 代理接口用的头，和 Bearer 不是一回事
    name: 'mj-api-secret 请求头',
    line: 'mj-api-secret: sk-FAKEmjproxy00000000000000000000',
    secret: 'sk-FAKEmjproxy00000000000000000000'
  },
  {
    name: 'x-api-key 请求头',
    line: 'x-api-key: XkFAKEabcdefghijklmnopqrstuvwx',
    secret: 'XkFAKEabcdefghijklmnopqrstuvwx'
  },
  {
    // 结果图是 OSS 直链，签名参数的键名跟 Liblib 自己的接口又不一样
    name: 'OSS 直链的签名参数',
    line: 'GET https://liblibai-online.liblib.cloud/x.png?OSSAccessKeyId=LTAIFAKE0000000000&Expires=1900000000&Signature=OsFAKEzzzzzzzzzzzzzzz%3D',
    secret: 'LTAIFAKE0000000000'
  }
];

/** 这些必须**不**被改动，否则日志就没法看了。 */
const MUST_KEEP = [
  '内置工作流播种完成 {"seeded":11,"missing":[]}',
  'ComfyUI 探测 {"online":true,"baseUrl":"http://127.0.0.1:8188"}',
  'job_mt56z5u9_36dd2daf 状态 running 用时 35s',
  '远端队列已满，退避后重试提交 attempt=1 waitMs=5000',
  'RunningHub 已提交 taskId=1949273610948169729 覆盖字段数=6'
];

test('每一种真实密钥形态都会被打码', () => {
  const leaks = [];
  for (const c of MUST_REDACT) {
    const out = redact(c.line);
    if (out.includes(c.secret)) leaks.push(`${c.name}：密钥原文仍在 → ${out}`);
  }
  assert.deepEqual(leaks, [], `以下密钥没被脱敏：\n${leaks.join('\n')}`);
});

test('打码后仍保留定位信息，方便排查', () => {
  // 知道"是哪一处泄的"和"泄的是什么"是两件事，前者要留，后者要去
  assert.match(redact('Authorization: Bearer aVeryLongOpaqueTokenValue1234567890'), /Bearer /);
  assert.match(redact('GET /v1/events?token=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA'), /\?token=/);
  assert.match(redact('{"apiKey":"deadbeefcafef00d0123456789abcdef"}'), /"apiKey":"/);
});

test('正常日志不会被误伤', () => {
  const damaged = MUST_KEEP.filter((line) => redact(line) !== line);
  assert.deepEqual(damaged, [], `以下正常日志被误打码了：\n${damaged.join('\n')}`);
});

test('打码结果不会泄漏中间部分', () => {
  const secret = 'sk-FAKEabcdefghijklmnopqrstuvwxyz0123456789';
  const out = redact(`key=${secret}`);
  // 首尾各留 4 位是有意为之（能对上是哪个 key），中间必须没了
  assert.ok(!out.includes('ijklmnopqrstuvwxyz'), `中间部分泄漏了：${out}`);
  assert.ok(out.includes('••••••'), `没有打码标记：${out}`);
});

test('这份测试文件里的样本必须一眼看得出是假的', () => {
  // 脱敏测试最讽刺的失败方式，就是把真密钥写进测试当样本，然后连同测试一起提交上去。
  // 约定：本文件里所有 sk- 开头的样本都必须写成 sk-FAKE…，
  // 这样「是不是真密钥」用肉眼和这条断言都能立刻判定，不用去猜某串字符像不像真的。
  const self = readFileSync(new URL(import.meta.url), 'utf8');
  const bad = [...self.matchAll(/\bsk-[A-Za-z0-9_-]{12,}/g)]
    .map((m) => m[0])
    .filter((v) => !v.startsWith('sk-FAKE'));
  assert.deepEqual(bad, [], `样本没按 sk-FAKE… 约定写，无法确认是不是真密钥：${bad.join(', ')}`);
});

/* ==================== 错误消息里的地址 ==================== */

/*
 * 脱敏日志只是最后一道网。真正该守的是**源头**：
 * 别把带签名的地址塞进异常消息。异常消息不只进日志，
 * 它还会原样返回给插件、显示在面板上、出现在用户随手截的那张图里 ——
 * 那几条路径都不经过 redact()。
 */

test('safeEndpoint 隐去签名参数，但保留主机和路径', () => {
  const out = safeEndpoint(LIBLIB_SIGNED_URL);
  assert.ok(!out.includes(LIBLIB_ACCESS_KEY), `AccessKey 泄漏：${out}`);
  assert.ok(!out.includes(LIBLIB_SIGNATURE), `Signature 泄漏：${out}`);
  assert.ok(!out.includes(LIBLIB_NONCE), `SignatureNonce 泄漏：${out}`);
  // 排查时要知道是打哪个接口出的问题，这部分必须留着
  assert.match(out, /openapi\.liblibai\.cloud/);
  assert.match(out, /\/api\/generate\/webui\/status/);
  assert.match(out, /Timestamp=1767225600000/, '非敏感参数该留就留');
});

test('safeEndpoint 对无害地址一字不改', () => {
  for (const u of [
    'http://127.0.0.1:8188/prompt',
    'http://127.0.0.1:8188/view?filename=psai_0001.png&type=output&subfolder=',
    'https://ai.comfly.org/v1/images/generations'
  ]) {
    assert.equal(safeEndpoint(u), new URL(u).toString(), `被误伤了：${u}`);
  }
});

test('safeEndpoint 遇到解析不了的字符串，宁可整段丢掉问号后面', () => {
  // 被截断的串、相对路径 —— 解析不出来就不知道哪段是签名，只能保守处理
  const out = safeEndpoint('not a url at all?AccessKey=AkFAKE1234567890abcd&Signature=zzz');
  assert.ok(!out.includes('AkFAKE1234567890abcd'), `泄漏了：${out}`);
});

/** 异常的完整可见文本：message 和 details 都会返回给面板，两段都得干净。 */
function whole(e) {
  return `${e.message} ${e.details ?? ''}`;
}

test('网络错误不会把签名地址带进异常消息', () => {
  // 超时是最常见的一种错误，也是最容易把完整 URL 写进日志的那一种
  const timeout = mapNetworkError(
    Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    LIBLIB_SIGNED_URL,
    30000
  );
  assert.ok(!whole(timeout).includes(LIBLIB_ACCESS_KEY), `AccessKey 泄漏：${whole(timeout)}`);
  assert.ok(!whole(timeout).includes(LIBLIB_SIGNATURE), `Signature 泄漏：${whole(timeout)}`);
  assert.equal(timeout.code, 'PROVIDER_TIMEOUT', '脱敏不能改变错误码');

  const unreachable = mapNetworkError(new Error('fetch failed'), LIBLIB_SIGNED_URL, 30000);
  assert.ok(!whole(unreachable).includes(LIBLIB_SIGNATURE), `Signature 泄漏：${whole(unreachable)}`);
  assert.equal(unreachable.code, 'PROVIDER_UNREACHABLE');
});

test('非 2xx 与非 JSON 的错误同样不带签名地址', async () => {
  const res401 = new Response('unauthorized', { status: 401 });
  const e = await ensureOk(res401, LIBLIB_SIGNED_URL).then(
    () => null,
    (err) => err
  );
  assert.ok(e, '401 应该抛错');
  assert.ok(!whole(e).includes(LIBLIB_SIGNATURE), `Signature 泄漏：${whole(e)}`);
  assert.equal(e.code, 'PROVIDER_AUTH_FAILED');

  const resHtml = new Response('<html>502</html>', { status: 200 });
  const e2 = await jsonOf(resHtml, LIBLIB_SIGNED_URL).then(
    () => null,
    (err) => err
  );
  assert.ok(e2, '非 JSON 应该抛错');
  assert.ok(!whole(e2).includes(LIBLIB_ACCESS_KEY), `AccessKey 泄漏：${whole(e2)}`);
});

test('真发一次请求：连不上时的错误里也没有签名', async () => {
  // 上面几条测的是纯函数。这条走真实的 httpFetch，
  // 保证连接错误那条路径也接上了。
  // 地址来自一个"连上就掐断"的服务器 —— 见 _dead-server.mjs：
  // 拿一个空闲端口再放掉是个竞态，放掉之后别人随时可能绑上去。
  const deadSrv = await startDeadServer();
  const bad = `${deadSrv.url}/api/generate/webui/status?AccessKey=${LIBLIB_ACCESS_KEY}&Signature=${LIBLIB_SIGNATURE}`;
  const e = await httpFetch(bad, { timeoutMs: 800 })
    .then(
      () => null,
      (err) => err
    )
    .finally(() => deadSrv.stop());
  assert.ok(e, '应该连不上');
  // message 是错误码的固定文案，具体到哪个地址在 details 里 —— 两段都得检查，
  // 因为面板显示的是 `message（details）`，两段都会给到用户。
  assert.ok(!whole(e).includes(LIBLIB_ACCESS_KEY), `AccessKey 泄漏：${whole(e)}`);
  assert.ok(!whole(e).includes(LIBLIB_SIGNATURE), `Signature 泄漏：${whole(e)}`);
  assert.match(whole(e), new RegExp(deadSrv.url.replace(/[.]/g, '\.')), '排查还得知道是打哪儿去了');
});
