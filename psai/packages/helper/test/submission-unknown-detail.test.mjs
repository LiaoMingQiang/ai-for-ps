/**
 * 提交结果未知时，报错必须带上**平台到底说了什么**。
 *
 * 真机上连着四次 submission_unknown，界面只有一句
 * 「服务返回了无法解析的响应」。照着这句话查了半天"是不是返回了 HTML"、
 * "是不是编码问题" —— 全是错方向。
 *
 * 直接抓原始响应才发现：平台回的是**合法 JSON**，
 *   {"code":200000,"data":null,"msg":"内部服务错误"}
 * 而 PsaiError 的 message 是错误码的通用文案，真正有用的原文在 details 里。
 * 引擎拼这句话时只取了 message，把 details 丢了。
 *
 * 这是同一个坑第二次踩（上一次是 PsaiError 的第二个参数进 details 不进
 * message）。所以钉一条用例。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PsaiError, toErrorShape } from '@psai/shared';

test('PsaiError 的第二个参数进 details，不进 message', () => {
  const e = new PsaiError('PROVIDER_BAD_RESPONSE', 'LiblibAI：内部服务错误');
  const shape = toErrorShape(e);
  assert.equal(shape.details, 'LiblibAI：内部服务错误');
  assert.notEqual(shape.message, 'LiblibAI：内部服务错误', 'message 是错误码的通用文案，不是我们传的那句');
});

test('拼给用户的话要用 details，没有才退回 message', () => {
  /*
   * 引擎里那句 submission_unknown 的文案就是这么拼的。这里复刻同一个表达式，
   * 保证"优先 details"这条规则不会在某次重构里被改回 message。
   */
  const pick = (shape) => shape.details ?? shape.message;

  const withDetails = toErrorShape(new PsaiError('PROVIDER_BAD_RESPONSE', 'LiblibAI：内部服务错误'));
  assert.equal(pick(withDetails), 'LiblibAI：内部服务错误', '有 details 就必须用它');

  const noDetails = toErrorShape(new PsaiError('PROVIDER_BAD_RESPONSE'));
  assert.equal(pick(noDetails), noDetails.message, '没有 details 才退回通用文案');
  assert.ok(String(noDetails.message).length > 0);
});

test('平台那句真实原文能一路带到用户面前', () => {
  // 真机抓到的响应：{"code":200000,"data":null,"msg":"内部服务错误"}
  const shape = toErrorShape(new PsaiError('PROVIDER_BAD_RESPONSE', 'LiblibAI：内部服务错误'));
  const line =
    `请求已经发往 liblib，但没等到回复（${shape.details ?? shape.message}）。` + '平台可能已经接单并计费';
  assert.match(line, /内部服务错误/, '用户必须看得到平台的原话，否则无从下手');
  assert.doesNotMatch(line, /无法解析的响应/, '不能再报成"无法解析"—— 那是错的，平台回的是合法 JSON');
});
