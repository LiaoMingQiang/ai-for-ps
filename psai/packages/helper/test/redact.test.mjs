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
