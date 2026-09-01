/**
 * 取消在**传输层**的行为。
 *
 * cancel-races 那一组测的是引擎的判断（判成什么状态、放不放名额）。
 * 这一组往下一层：请求到底发没发出去、正文还在不在读。
 * 两件事在上层看起来都是"取消了"，可代价完全不同 ——
 * 一个是一分钱没花，一个是钱花了、带宽也跑了。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { httpFetch, RequestAbortedError, safeEndpoint, sanitizeExternalText } from '../dist/providers/http.js';

let server;
let base;
/** 收到过几次真实请求 —— "有没有发出去"只能靠它回答 */
let hits = 0;
/** 正文分几段慢慢吐，用来在读正文的过程中取消 */
let slowBody = false;

before(async () => {
  server = createServer((req, res) => {
    hits++;
    if (slowBody) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write('first-chunk');
      // 故意不结束：正文停在半路，取消要能把它掐掉
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

test('信号已经 abort 时，一个字节都不发出去', async () => {
  /*
   * addEventListener('abort') 对一个**已经**触发过的信号什么都不做。
   * 少了入口那道检查，一次已经取消的提交照样会完整发到付费平台上：
   * 用户在提交的准备阶段点了取消，等真正发请求时信号早就 abort 了，
   * 而我们照发不误，钱照花。
   */
  const before_ = hits;
  const ac = new AbortController();
  ac.abort();

  const e = await httpFetch(`${base}/x`, { signal: ac.signal, timeoutMs: 2000 }).then(
    () => null,
    (err) => err
  );
  assert.ok(e, '应该直接失败');
  assert.ok(e instanceof RequestAbortedError, `应该是取消而不是别的错误：${e?.name} ${e?.message}`);
  assert.equal(hits, before_, '服务端不该收到任何请求');
});

test('取消能穿透到读正文那一段', async () => {
  /*
   * 响应头回来了不等于事情结束了 —— 一张结果图可能还有几十兆要读。
   * 以前响应头一到就把伞收了：用户点了取消，进度条停了，
   * 而后台还在老老实实地把那张图下完。
   */
  slowBody = true;
  try {
    const ac = new AbortController();
    const res = await httpFetch(`${base}/slow`, { signal: ac.signal, timeoutMs: 30_000 });
    assert.equal(res.status, 200, '响应头应该正常回来');

    const reading = res.text().then(
      () => null,
      (err) => err
    );
    setTimeout(() => ac.abort(), 80);

    const e = await reading;
    assert.ok(e, '读正文应该被打断');
    assert.ok(e instanceof RequestAbortedError, `读正文被取消时应报取消：${e?.name} ${e?.message}`);
  } finally {
    slowBody = false;
  }
});

test('正常读完之后，超时定时器不会把进程挂住', async () => {
  // 反面保证：把清理推迟到正文读完之后，别忘了真的清。
  // 忘了的话每个请求都留一个几十秒的定时器，Node 退不出去。
  const res = await httpFetch(`${base}/ok`, { timeoutMs: 25_000 });
  const json = await res.json();
  assert.deepEqual(json, { ok: true });
  // 这个用例能正常结束本身就是断言：有残留定时器的话 node --test 会挂到超时
});

/* ==================== 外部文本里的签名地址 ==================== */

const ACCESS_KEY = 'AkFAKE1234567890abcd';
const SIGNATURE = 'SgFAKEZm9vYmFyYmF6cXV4MTIz';
const SIGNED = `https://openapi.liblibai.cloud/api/generate/webui/status?AccessKey=${ACCESS_KEY}&Signature=${SIGNATURE}&Timestamp=1767225600000`;

test('上游把完整签名地址回显在错误正文里，也要被清掉', () => {
  /*
   * safeEndpoint 只管我们自己拼的那个地址。可网关和代理很爱把它收到的
   * 完整请求 URL 原样回显在错误里 —— 那段文本我们一个字都没参与拼装，
   * 却会照原样存进 error_json 再显示给用户，而 error_json 会出现在
   * 诊断包、截图、工单里。
   */
  const body = `{"error":{"message":"failed to proxy ${SIGNED}: upstream timeout"}}`;
  const clean = sanitizeExternalText(body);
  assert.ok(!clean.includes(ACCESS_KEY), `AccessKey 泄漏：${clean}`);
  assert.ok(!clean.includes(SIGNATURE), `Signature 泄漏：${clean}`);
  // 反面：主机和路径要留着，否则这条错误就没法查了
  assert.match(clean, /openapi\.liblibai\.cloud/);
  assert.match(clean, /upstream timeout/);
});

test('响应体里的凭据字段、各家令牌前缀都要打掉', () => {
  const cases = [
    ['{"accessKey":"AkFAKE1234567890abcd","note":"x"}', 'AkFAKE1234567890abcd'],
    ['{"secretKey":"SkFAKEzzzzzzzzzzzzzzzzzzzz"}', 'SkFAKEzzzzzzzzzzzzzzzzzzzz'],
    ['x-goog-api-key: AIzaSyFAKEABCDEFGHIJKLMNOPQRSTUVWX', 'AIzaSyFAKEABCDEFGHIJKLMNOPQRSTUVWX'],
    ['{"x-amz-security-token":"FwoGZXIvYXdzEFAKEtokenvalue123456"}', 'FwoGZXIvYXdzEFAKEtokenvalue123456'],
    ['credentials AKIAFAKE0000000000 rejected', 'AKIAFAKE0000000000'],
    ['sts token ASIAFAKE1111111111 expired', 'ASIAFAKE1111111111'],
    ['oss key LTAIFAKE2222222222 denied', 'LTAIFAKE2222222222'],
    ['Bearer sk-FAKEupstreamechoed000000000000', 'sk-FAKEupstreamechoed000000000000']
  ];
  const leaks = [];
  for (const [text, secret] of cases) {
    const out = sanitizeExternalText(text);
    if (out.includes(secret)) leaks.push(`${secret} → ${out}`);
  }
  assert.deepEqual(leaks, [], `以下没被清掉：\n${leaks.join('\n')}`);
});

test('URL 里的用户名密码也是凭据', () => {
  const out = safeEndpoint('https://someuser:FAKEp4ssw0rd@example.com/api?x=1');
  assert.ok(!out.includes('FAKEp4ssw0rd'), `密码泄漏：${out}`);
  assert.ok(!out.includes('someuser'), `用户名泄漏：${out}`);
  assert.match(out, /example\.com/, '主机要留着');
});

test('脱敏不改变错误码，也不吃掉排查线索', () => {
  // 反面保证。清得太狠的话，用户拿到一句"连不上"，
  // 连自己把地址填错了都看不出来。
  const clean = sanitizeExternalText(`connect ECONNREFUSED 127.0.0.1:8188 while calling ${SIGNED}`);
  assert.match(clean, /ECONNREFUSED/);
  assert.match(clean, /127\.0\.0\.1:8188/);
  assert.match(clean, /generate\/webui\/status/, '接口路径要留着');
});
