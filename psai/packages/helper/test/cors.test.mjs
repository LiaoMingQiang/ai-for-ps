/**
 * CORS 规则测试。
 *
 * 这里守的是一条安全边界：/v1/pair/request 与 /v1/pair/confirm 是公开端点，
 * 谁能跨域调它们，谁就能给自己配一个 token，进而用掉用户的显卡和已保存的 API Key。
 * 所以「UXP 插件来源要放行」和「网页来源绝不放行」必须同时成立。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHelper } from '../dist/index.js';

/*
 * 端口由系统分配，不写死。
 *
 * 写死有两个坑，第二个尤其阴：上一次跑崩留下的进程会一直占着；
 * 而 Windows 上端口被占**未必**报 EADDRINUSE —— 可能就那么挂着，
 * 整个套件一条输出都没有，报出来是一次超时，跟真正的原因毫无关系。
 * 每次 startHelper 之后都要重新读一遍：重启拿到的是新端口。
 */
let PORT = 0;
let helper;
let dataDir;

const url = (p) => `http://127.0.0.1:${PORT}${p}`;

async function withOrigin(path, origin, method = 'GET') {
  const headers = {};
  if (origin !== null) headers['Origin'] = origin;
  const res = await fetch(url(path), { method, headers });
  return {
    status: res.status,
    allowOrigin: res.headers.get('access-control-allow-origin'),
    allowHeaders: res.headers.get('access-control-allow-headers')
  };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-cors-'));
  helper = await startHelper({ dataDir, port: 0, ephemeral: true });
  PORT = helper.port; // 不从 url 里抠：端口等于 80 时 URL 会规范化掉，Number('') === 0 → undici 报 bad port
  if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`Helper 端口不可用：${PORT}（url=${helper.url}）`);
});

after(async () => {
  await helper?.stop();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

test('没有 Origin 头的请求照常工作（非浏览器客户端）', async () => {
  const r = await withOrigin('/v1/health', null);
  assert.equal(r.status, 200);
  assert.equal(r.allowOrigin, null, '没有 Origin 就不该回 CORS 头');
});

test('UXP 插件来源（非 http 方案）被放行', async () => {
  for (const origin of ['null', 'uxp://com.aiforps.psai', 'plugin://com.aiforps.psai', 'file://']) {
    const r = await withOrigin('/v1/health', origin);
    assert.equal(r.status, 200, `${origin} 应该能拿到响应`);
    assert.equal(r.allowOrigin, origin, `${origin} 应被放行`);
    assert.match(r.allowHeaders ?? '', /Authorization/, '必须允许 Authorization 头，否则带不了 token');
  }
});

test('网页来源默认不给 CORS 头 —— 网页不能给自己配对', async () => {
  for (const origin of ['https://evil.example.com', 'http://evil.example.com', 'http://127.0.0.1:5599']) {
    const r = await withOrigin('/v1/health', origin);
    assert.equal(r.allowOrigin, null, `${origin} 绝不能被放行`);
  }
});

test('配对端点同样不给网页来源开口子', async () => {
  const r = await withOrigin('/v1/pair/request', 'https://evil.example.com', 'POST');
  assert.equal(r.allowOrigin, null, '配对端点被网页跨域调用就等于把机器交出去了');
});

test('预检请求直接 204，不会因为缺 Authorization 被判 401', async () => {
  const res = await fetch(url('/v1/settings'), {
    method: 'OPTIONS',
    headers: { Origin: 'uxp://com.aiforps.psai', 'Access-Control-Request-Method': 'GET' }
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'uxp://com.aiforps.psai');
});

test('放行来源不影响鉴权：没 token 照样 401', async () => {
  const res = await fetch(url('/v1/settings'), { headers: { Origin: 'uxp://com.aiforps.psai' } });
  assert.equal(res.status, 401, 'CORS 放行不等于免鉴权');
});
