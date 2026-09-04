/**
 * 撞上另一个 Helper 实例时，日志和异常必须说清对方是哪一版。
 *
 * 真机上出过这么一次，而且卡了很久：用户装了新版安装包，面板的「关于」页
 * 却一直显示插件 0.9.3 / Helper 0.9.1。重装、重启 Photoshop 都没用，
 * 合理的结论看起来是"安装包没把后端一起更新"。
 *
 * 真相是：一个几天前用 `node dist/index.js` 手工起的旧 Helper 一直占着
 * 34117 端口和锁文件。新装的那个每次启动都撞锁、抛一句
 * 「已有 Helper 实例在运行」然后悄悄退掉 —— 这句话里没有任何信息能表明
 * 撞上的是**旧版本**，于是查错的方向从一开始就偏了。
 *
 * 现在撞锁时会去问对方的 /v1/health，把两个版本号一起写进消息。
 * 这一组用例钉死这件事。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startHelper } from '../dist/index.js';
import { PSAI_VERSION } from '@psai/shared';

const here = dirname(fileURLToPath(import.meta.url));
const workflowsDir = resolve(here, '../../../workflows');

let first;
let dataDir;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-conflict-'));
  // ephemeral: false —— 单实例锁只有在非临时模式下才生效，而锁正是这里要测的东西。
  // probeOnStart: false —— 别去敲用户本机真实的 ComfyUI。
  first = await startHelper({
    port: 0,
    dataDir,
    ephemeral: false,
    probeOnStart: false,
    workflowsDir
  });
  await first.recovered;
});

after(async () => {
  await first?.stop();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

test('第二个实例被挡下，消息里带着对方的版本号', async () => {
  let err;
  try {
    const second = await startHelper({
      // 指向第一个实例真正占着的端口，撞锁时才问得到它
      port: first.port,
      dataDir,
      ephemeral: false,
      probeOnStart: false,
      workflowsDir
    });
    await second.stop();
  } catch (e) {
    err = e;
  }
  assert.ok(err, '同一个数据目录下的第二个实例必须被挡下');
  const msg = String(err.message);

  // 关键：消息里要有版本号。旧实现只有一句「已有 Helper 实例在运行」，
  // 那句话让人完全看不出撞上的是哪一版 —— 这条对着旧实现跑会红。
  assert.match(msg, new RegExp(PSAI_VERSION.replace(/\./g, '\\.')), `消息里应当带版本号，实际是：${msg}`);
});

test('探测不到对方时，退回原来那句话，不至于因为探测失败而崩', async () => {
  /*
   * 端口上没人应答是完全可能的：对方进程刚死、锁文件是残留的，
   * 或者端口被别的程序占着。那时候版本问不出来，但"被挡下"这个结论不变。
   */
  let err;
  try {
    const second = await startHelper({
      // 故意给一个没人监听的端口：锁还是那把锁，但探测必然失败
      port: 1,
      dataDir,
      ephemeral: false,
      probeOnStart: false,
      workflowsDir
    });
    await second.stop();
  } catch (e) {
    err = e;
  }
  assert.ok(err, '探测失败也不能让它被误判成可以启动');
  assert.match(String(err.message), /已有 Helper 实例在运行/);
});

test('第一个实例自己活得好好的 —— 挡下别人不影响它', async () => {
  const res = await fetch(`http://127.0.0.1:${first.port}/v1/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, PSAI_VERSION);
});
