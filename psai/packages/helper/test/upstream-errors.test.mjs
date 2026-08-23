/**
 * 上游错误信息的回归测试。
 *
 * 用户报「闭源模型没有任何结果」时，面板上显示的是：
 *
 *     PROVIDER_BAD_RESPONSE
 *     Comfly HTTP 503：
 *
 * 冒号后面什么都没有。看着像我们把错误吞了，其实是网关回了
 * {"error":{"message":" "}} —— message 就是一个空格。
 * 我们原样透传，于是用户对着一片空白无从下手。
 *
 * 同一批还暴露出两个问题：
 *   - gemini-3-pro-image-2k 明明说的是「不支持此 API 路径」（换个模型就行），
 *     却被报成 PROVIDER_BAD_RESPONSE，把排查方向带向「是不是我们解析错了」
 *   - 5xx 一律映射成 PROVIDER_BAD_RESPONSE —— 平台自己出错和
 *     「我们看不懂它的响应」是两回事，混在一起查不出来
 *
 * 下面的报文全部来自真机抓到的原始响应。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { explainHttpError } from '../dist/providers/openai.js';
import { codeForStatus } from '../dist/providers/http.js';

/** 真机原样抓下来的报文。 */
const BODY_BLANK_MESSAGE = '{"error":{"message":" ","type":"new_api_error","param":"","code":"unknown_error"}}';
const BODY_WRONG_PATH = JSON.stringify({
  error: {
    message:
      '所有分组对于模型 gemini-3-pro-image-2k 不支持此 API 路径 [/v1/images/generations]，请更换请求路径或联系管理员 (request id: EMaster2026)',
    type: 'new_api_error'
  }
});

test('message 只有空格时不摆原始 JSON，直说平台没给原因', () => {
  const e = explainHttpError(503, BODY_BLANK_MESSAGE, 'Comfly', codeForStatus(503));
  assert.ok(!/HTTP 503：\s*$/.test(e.details), `冒号后面不能是空的：${JSON.stringify(e.details)}`);
  assert.ok(!e.details.includes('new_api_error'), '不该把原始 JSON 摆给用户');
  assert.ok(e.details.includes('没有说明原因'), `应如实说明平台没给原因，实际：${e.details}`);
  assert.ok(e.details.includes('换一个模型'), '要给出下一步能做什么');
});

test('平台 5xx 报 PROVIDER_UPSTREAM_ERROR，不是「响应解析不了」', () => {
  // 响应完全能解析，只是内容是「我这边出错了」。
  // 报成 PROVIDER_BAD_RESPONSE 会让人往「我们解析有问题」的方向查。
  const e = explainHttpError(503, BODY_BLANK_MESSAGE, 'Comfly', codeForStatus(503));
  assert.equal(e.code, 'PROVIDER_UPSTREAM_ERROR');
  assert.equal(codeForStatus(500), 'PROVIDER_UPSTREAM_ERROR');
  assert.equal(codeForStatus(502), 'PROVIDER_UPSTREAM_ERROR');
});

test('「不支持此 API 路径」归到模型不可用 —— 换个模型就能继续', () => {
  const e = explainHttpError(503, BODY_WRONG_PATH, 'Comfly', codeForStatus(503));
  assert.equal(e.code, 'PROVIDER_MODEL_UNAVAILABLE', '这是模型的问题，不是平台挂了');
  assert.ok(e.details.includes('gemini-3-pro-image-2k'), '要说清是哪个模型');
  assert.ok(e.details.includes('参数设置'), '要指路到能改模型的地方');
});

test('原有的「无可用渠道 / 模型不存在」判定没被改坏', () => {
  const cases = [
    '当前分组 default 下对于模型 flux-pro 无可用渠道',
    'The model `dall-e-4` does not exist',
    '模型不存在或未开通',
    'model_not_found'
  ];
  for (const message of cases) {
    const e = explainHttpError(404, JSON.stringify({ error: { message } }), 'Comfly', codeForStatus(404));
    assert.equal(e.code, 'PROVIDER_MODEL_UNAVAILABLE', `应判为模型不可用：${message}`);
  }
});

test('上游给了正经 message 就原样用，别自作聪明改写', () => {
  const message = '余额不足，请充值后重试';
  const e = explainHttpError(402, JSON.stringify({ error: { message } }), 'Comfly', codeForStatus(402));
  assert.ok(e.details.includes(message), '用户需要看到平台的原话');
});

test('响应压根不是 JSON 时截断原文，仍留线索', () => {
  const e = explainHttpError(502, '<html><body>502 Bad Gateway</body></html>', 'Comfly', codeForStatus(502));
  assert.ok(e.details.includes('502 Bad Gateway'), `应保留原文线索，实际：${e.details}`);
});

test('响应完全为空时也说人话，不留空白', () => {
  const e = explainHttpError(503, '', 'Comfly', codeForStatus(503));
  assert.ok(e.details.trim().endsWith('平台没有返回任何内容'), `实际：${e.details}`);
  assert.ok(!/：\s*$/.test(e.details));
});

test('超长原文会被截断，不会把整页 HTML 灌进面板', () => {
  const e = explainHttpError(500, 'x'.repeat(5000), 'Comfly', codeForStatus(500));
  assert.ok(e.details.length < 400, `细节长度 ${e.details.length}，应截断`);
});
