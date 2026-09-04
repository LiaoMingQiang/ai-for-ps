/**
 * 系统分配到 WHATWG「禁用端口」时，Helper 要换一个。
 *
 * 这是那个前后犯了五次、一直没定位的 flake 的真正原因。
 *
 * 症状：整批用例一起变红，报 `TypeError: fetch failed`，
 * cause 里是一句 `bad port`；重跑一次又全绿。看起来像并发问题、
 * 像端口被占、像 Helper 没起来 —— 查了几轮都不是。
 *
 * 真相：undici（Node 的 fetch）和浏览器一样，**拒绝连接**一批约定俗成的
 * 危险端口（6667 是 IRC、2049 是 NFS、5060 是 SIP……），报的就是 `bad port`。
 * 而测试全部用 port: 0 让系统分配，这台机器的动态端口范围又被调得很低 ——
 * 日志里出现过 `Helper 已就绪 http://127.0.0.1:6667`，6667 正在那张表上。
 *
 * Helper 自己跑得好好的，只是谁都连不上它。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBadPort } from '../dist/index.js';

test('认得出真机上撞到过的那个端口', () => {
  // 6667 就是日志里那个。它是 IRC 端口，在 WHATWG 的禁用表上。
  assert.equal(isBadPort(6667), true);
});

test('IRC 那一段整段都在表里', () => {
  for (const p of [6665, 6666, 6667, 6668, 6669, 6697]) {
    assert.equal(isBadPort(p), true, `${p} 应当被认作禁用端口`);
  }
});

test('几个常被误判为普通端口的也在表里', () => {
  // 这些看着像随机高位端口，实际都在禁用表上 —— 正是最容易漏的那批。
  for (const p of [2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6679, 10080]) {
    assert.equal(isBadPort(p), true, `${p} 应当被认作禁用端口`);
  }
});

test('常见的服务端口在表里', () => {
  for (const p of [21, 22, 23, 25, 53, 110, 143, 389, 465, 993, 995]) {
    assert.equal(isBadPort(p), true, `${p} 应当被认作禁用端口`);
  }
});

test('正常端口不许被误判', () => {
  /*
   * 误判的代价是白白重试、甚至把用户显式指定的端口判成坏的。
   * 34117 是本产品的默认端口，绝不能在表里。
   */
  for (const p of [34117, 8188, 3000, 8080, 49152, 55555, 65535, 6668 + 1]) {
    if (p === 6669) continue;
    assert.equal(isBadPort(p), false, `${p} 是正常端口，不该被判成禁用`);
  }
});

test("本产品的默认端口是安全的", async () => {
  const { HELPER_DEFAULT_PORT } = await import('@psai/shared');
  assert.equal(isBadPort(HELPER_DEFAULT_PORT), false, '默认端口若在禁用表上，所有人都连不上');
});
