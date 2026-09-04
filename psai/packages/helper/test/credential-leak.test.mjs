/**
 * 密钥不外泄 —— 端到端。
 *
 * redact.test.mjs 测的是脱敏函数本身。这一组测的是**整条路**：
 * 真起 Helper、配一个真格式的 LiblibAI 密钥、让请求真的失败，
 * 然后翻遍所有会被人看到、被人转发的地方，确认那两个值哪儿都没有。
 *
 * 为什么必须端到端测：LiblibAI 的鉴权整个在 URL 的查询串上
 * （AccessKey 是身份，Signature 是拿 SecretKey 算出来的）。
 * 一次超时就会生成一条带完整 URL 的错误，而这条错误会同时出现在
 *   - 日志文件里（诊断包直接打包这个目录）
 *   - /v1/jobs/:id 的响应里（面板会把它显示出来，用户会截图发群里）
 *   - 任务的事件流里
 * 这三条路只有第一条经过 redact()。所以真正的防线必须在**生成消息那一刻**，
 * 而不是写日志那一刻 —— 这一组就是钉住这件事。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { startHelper } from '../dist/index.js';
import { makePng } from '../../../tools/comfy-stub.mjs';
import { startDeadServer } from './_dead-server.mjs';
import { assertCleanLog } from './_log-assertions.mjs';

/*
 * 端口由系统分配，不写死。
 *
 * 写死有两个坑，第二个尤其阴：上一次跑崩留下的进程会一直占着；
 * 而 Windows 上端口被占**未必**报 EADDRINUSE —— 可能就那么挂着，
 * 整个套件一条输出都没有，报出来是一次超时，跟真正的原因毫无关系。
 * 每次 startHelper 之后都要重新读一遍：重启拿到的是新端口。
 */
let PORT = 0;

/*
 * 假密钥，但**格式和真的一样**。
 *
 * 用 'x' / 'test' 这种一眼假的值测脱敏是自欺欺人：真密钥是有长度、有字符集的，
 * 而好几条脱敏规则正是按长度和字符集写的。所以这里的样本必须够长、够像。
 * 约定：所有样本都带 FAKE 字样，方便肉眼和下面那条断言判定它不是真的。
 */
const ACCESS_KEY = 'AkFAKEqQiNwvya8a8OHv';
const SECRET_KEY = 'SkFAKEahLszRjWGYSCjxF31Vui8heO7l';

let helper;
let dataDir;
let token;
/** 这一轮用的那个"确定连不上"的地址。断言里要用它，不能写死端口。 */
let DEAD = '';
let deadSrv = null;

function url(path) {
  if (!Number.isInteger(PORT) || PORT <= 0) {
    throw new Error(`测试用的 Helper 端口无效：PORT=${PORT}。多半是某次启动 Helper 没成功，或者在赋值前就发了请求。`);
  }
  return `http://127.0.0.1:${PORT}${path}`;
}

async function api(method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
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
  return { status: res.status, text, json };
}

function logText() {
  const dir = join(dataDir, 'logs');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.log') || f.endsWith('.old'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

/** 库里所有可能装下错误文本的列，原样拿出来。 */
function dbText() {
  const db = new DatabaseSync(join(dataDir, 'psai.sqlite'), { readOnly: true });
  try {
    const chunks = [];
    for (const r of db.prepare('SELECT error_json, progress_json FROM jobs').all()) {
      chunks.push(String(r.error_json ?? ''), String(r.progress_json ?? ''));
    }
    for (const r of db.prepare('SELECT note FROM job_events').all()) chunks.push(String(r.note ?? ''));
    for (const r of db.prepare('SELECT detail FROM submission_attempts').all()) chunks.push(String(r.detail ?? ''));
    return chunks.join('\n');
  } finally {
    db.close();
  }
}

/**
 * 找出还带着真实值的签名参数。
 *
 * 不能简单地断言"文本里没有 Signature="——脱敏之后留下的正是
 * `Signature=REDACTED` 这种形态，那恰恰是**做对了**的样子。
 * 要找的是"键名后面跟着一个不是占位符的值"。
 */
function leakedSignedParams(text) {
  const out = [];
  for (const m of text.matchAll(/[?&](AccessKey|Signature|SignatureNonce|SecretKey)=([^&"'\s\\]{1,})/gi)) {
    // 用 startsWith 而不是全等：URL 后面常跟着标点（`…&SignatureNonce=REDACTED: fetch failed`），
    // 那个冒号会被吃进值里，全等比较会把一次成功的脱敏误判成泄漏。
    if (!m[2].startsWith('REDACTED')) out.push(m[0]);
  }
  return out;
}

async function waitFor(jobId, predicate, timeoutMs = 30000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const { json } = await api('GET', `/v1/jobs/${jobId}`);
    last = json.job;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`超时：最后状态=${last?.state} 错误=${JSON.stringify(last?.error)}`);
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-leak-'));
  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
  token = helper.issueToken();
  await helper.recovered;

  /*
   * 指到一个**确定没人监听**的端口：请求必然连不上，
   * 而"连不上"生成的错误恰恰是最容易把完整签名 URL 带出来的那一种。
   *
   * 端口不写死，也不"拿一个再放掉"——见 _dead-server.mjs：
   * 放掉的端口随时可能被别人绑上，那条用例就会连到一个别人的服务上假通过。
   * 这里真的占着端口，只是对每个连接立刻掐断。
   */
  deadSrv = await startDeadServer();
  DEAD = deadSrv.url;
  await api('PATCH', '/v1/providers/liblib', { baseUrl: DEAD, enabled: true });
  await api('POST', '/v1/providers/liblib/credentials', {
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
    comfyTemplateUuid: '6f4f15946dbe472fb29c8768bb5c6f78'
  });
});

after(async () => {
  await helper?.stop();
  await deadSrv?.stop();
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
    /* Windows 上偶尔被占用，忽略 */
  }
  if (logProblem) throw logProblem;
});

test('样本必须一眼看得出是假的', () => {
  // 脱敏测试最讽刺的失败方式，就是把真密钥写进测试当样本，然后连同测试一起提交。
  assert.ok(ACCESS_KEY.includes('FAKE'));
  assert.ok(SECRET_KEY.includes('FAKE'));
});

test('测试连接失败时，密钥不出现在响应里，也不出现在日志里', async () => {
  const res = await api('POST', '/v1/providers/liblib/test');
  const body = res.text;

  assert.ok(!body.includes(ACCESS_KEY), `AccessKey 出现在接口响应里：${body.slice(0, 400)}`);
  assert.ok(!body.includes(SECRET_KEY), `SecretKey 出现在接口响应里：${body.slice(0, 400)}`);
  // 签名是拿 SecretKey 算的，等于密钥的一部分能力；同样不能出去
  assert.deepEqual(leakedSignedParams(body), [], `签名参数带着真值出现在接口响应里：${body.slice(0, 400)}`);

  const logs = logText();
  assert.ok(!logs.includes(ACCESS_KEY), 'AccessKey 出现在日志里');
  assert.ok(!logs.includes(SECRET_KEY), 'SecretKey 出现在日志里');
  assert.deepEqual(leakedSignedParams(logs), [], '签名参数带着真值出现在日志里');

  // 反面：地址本身要留着，否则用户拿到一句"连不上"，
  // 连自己把地址填错了都看不出来。
  assert.ok(body.includes(DEAD), `出错时至少得看得出是打哪儿去了（应含 ${DEAD}）`);
});

test('拉取模型失败时同样不泄漏', async () => {
  const res = await api('GET', '/v1/providers');
  assert.ok(!res.text.includes(ACCESS_KEY), 'AccessKey 出现在 Provider 列表里');
  assert.ok(!res.text.includes(SECRET_KEY), 'SecretKey 出现在 Provider 列表里');

  // 掩码是可以有的 —— 用户需要认出"我配的是哪一个 key"，
  // 但认出 ≠ 拿到。掩码里绝不能含有完整值。
  const liblib = res.json.providers.find((p) => p.id === 'liblib');
  assert.ok(liblib, '前提：liblib 应该在列表里');
  for (const f of liblib.credentialFields) {
    if (!f.masked) continue;
    assert.ok(!f.masked.includes(ACCESS_KEY), `掩码里含有完整 AccessKey：${f.masked}`);
    assert.ok(!f.masked.includes(SECRET_KEY), `掩码里含有完整 SecretKey：${f.masked}`);
  }
});

test('任务失败后：错误、事件流、库里的每一列都不含密钥', async () => {
  await api('PUT', '/v1/features/cloud.t2i/binding', {
    providerId: 'liblib',
    model: '5d7e67009b344550bc1aa6ccbfa1d7f4',
    enabled: true
  });

  const fd = new FormData();
  fd.append('file', new Blob([makePng(64, 64, [7, 7, 7])], { type: 'image/png' }), 'in.png');
  await fetch(url('/v1/assets'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });

  const created = await api('POST', '/v1/jobs', {
    featureId: 'cloud.t2i',
    params: { prompt: '一只猫', seed: { mode: 'fixed', value: 1 } },
    inputs: [],
    target: null,
    writeback: { mode: 'assetOnly' }
  });
  assert.equal(created.json.ok, true, JSON.stringify(created.json));
  const jobId = created.json.job.id;

  // 连不上是"不知道对面收没收"的一种，付费平台会落到 submission_unknown
  const j = await waitFor(jobId, (x) => ['failed', 'lost', 'submission_unknown', 'cancelled'].includes(x.state));
  assert.ok(j.error, '前提：这次应该确实失败了，否则这条用例什么都没测到');
  // 前提之二：失败必须是**发出请求之后**才发生的。
  // 要是败在"没配密钥"那种早退分支上，签名根本没生成过，
  // 这条用例就等于什么都没测 —— 而且会一直绿着。
  assert.ok(
    /PROVIDER_UNREACHABLE|PROVIDER_TIMEOUT|JOB_LOST|SUBMISSION_UNKNOWN/.test(j.error.code),
    `应该是发出请求之后才失败的，实际错误码 ${j.error.code}：${j.error.details ?? j.error.message}`
  );

  const seen = [
    JSON.stringify(j),
    (await api('GET', `/v1/jobs/${jobId}/events`)).text,
    (await api('GET', '/v1/jobs')).text,
    dbText(),
    logText()
  ];

  for (const [i, blob] of seen.entries()) {
    assert.ok(!blob.includes(ACCESS_KEY), `AccessKey 泄漏在第 ${i} 处：${blob.slice(0, 500)}`);
    assert.ok(!blob.includes(SECRET_KEY), `SecretKey 泄漏在第 ${i} 处：${blob.slice(0, 500)}`);
    assert.deepEqual(leakedSignedParams(blob), [], `签名参数泄漏在第 ${i} 处：${blob.slice(0, 500)}`);
  }

  // 反面：脱敏不能把排查线索一起吃掉。
  // 出错时至少还得看得出是打哪个平台、哪个接口去的。
  const full = seen.join('\n');
  assert.match(full, /liblib/i, '连"是哪个平台"都看不出来的话，这个错误就没法查了');
});
