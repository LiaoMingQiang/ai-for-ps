/**
 * 给用户看的错误消息里，URL 的查询串必须一个字不留。
 *
 * 背景：submission_unknown 那句话原来只带错误码的通用文案，真正有诊断价值的
 * details 被丢掉了。补上 details 之后，credential-leak 用例立刻变红 ——
 * 因为 LiblibAI 的整套鉴权就在 URL 查询串上，details 里带着完整的签名地址。
 *
 * safeEndpoint 会把**值**打码但保留参数名（`?AccessKey=REDACTED&Signature=…`），
 * 日志里这样便于定位。但这段文字会进 error_json，而 error_json 会出现在
 * 诊断包、截图、工单里 —— 那里连参数名都不该有：
 *   光看到 `?AccessKey=&Signature=` 就泄露了"这个账号用签名鉴权"；
 *   而且哪天 redact 漏一处，值就跟着出去了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { endpointOnly } from '../dist/providers/http.js';

test('查询串整段去掉，主机和路径留着', () => {
  const out = endpointOnly('a http://h/p?AccessKey=x&Signature=y z');
  assert.equal(out, 'a http://h/p z');
  assert.doesNotMatch(out, /AccessKey|Signature/i);
});

test('URL 前面粘着全角括号时也要处理', () => {
  /*
   * 真机上那句话就是这样的：「…没等到回复（http://…?AccessKey=…」。
   * 第一版按"整个词以 http 开头"判断，这条就漏了 —— 词是「（http://…」。
   */
  const out = endpointOnly(
    '但没等到回复（http://127.0.0.1:7422/api/generate/webui/text2img?AccessKey=a&Signature=b&SignatureNonce=c 超时）。'
  );
  assert.doesNotMatch(out, /AccessKey|Signature|SignatureNonce/i, `查询串没去干净：${out}`);
  assert.match(out, /webui\/text2img/, '路径要留着 —— 否则连打的是哪个接口都看不出来');
  assert.match(out, /没等到回复/, '正文不能被吃掉');
});

test('没有网址的文本原样保留', () => {
  // 平台的业务错误常常就是一句中文，不能被误伤。
  assert.equal(endpointOnly('LiblibAI：内部服务错误'), 'LiblibAI：内部服务错误');
});

test('正文里的问号不许被当成查询串吃掉', () => {
  const s = '没有网址的普通问句？这个问号不该被吃掉';
  assert.equal(endpointOnly(s), s);
});

test('多个网址各自处理', () => {
  const out = endpointOnly('先 https://a.com/x?k=1 再 http://b.com/y?j=2 完');
  assert.doesNotMatch(out, /[?]/, `不该还剩问号：${out}`);
  assert.match(out, /a\.com\/x/);
  assert.match(out, /b\.com\/y/);
});

test('超长文本会被截断，但截断不影响脱敏', () => {
  const long = 'x'.repeat(500) + ' http://h/p?AccessKey=secret';
  const out = endpointOnly(long, 300);
  assert.ok(out.length <= 300);
  assert.doesNotMatch(out, /AccessKey/i);
});
