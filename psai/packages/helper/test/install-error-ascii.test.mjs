/**
 * 安装失败时给 NSIS 的那行字必须是纯 ASCII。
 *
 * 真机上有一台中文用户名的机器安装失败，弹出来的是：
 *
 *   ERROR EIO, Access is denied. '\\?\C:\Users\藍鎳槤鍾卜AppData\Roaming\...'
 *
 * 两处坏掉：用户名成了乱码，而且**用户名和 AppData 之间的反斜杠没了**。
 * 原因是 NSIS 用 nsExec::ExecToStack 捕获这段 stdout，按系统 ANSI 代码页
 * 解码，而我们写的是 UTF-8 —— 在中文 Windows 上就是 GBK 乱码；
 * 更糟的是 GBK 双字节字符的第二字节可能正好是 0x5C，被当成路径分隔符吃掉。
 *
 * 结果是一条既看不懂、路径又是错的报错，用户拿它无从下手。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toAsciiSafe } from '../dist/index.js';

const PRINTABLE = /^[\x20-\x7E]*$/;

test('中文被换成 ?，不产生任何非 ASCII 字节', () => {
  const out = toAsciiSafe('复制插件文件失败：目标目录已存在');
  assert.match(out, PRINTABLE, `输出必须全是可打印 ASCII，实际：${out}`);
});

test('反斜杠原样留住 —— 路径不能缺一段', () => {
  /*
   * 这条是关键。如果实现图省事把非 ASCII 连同周围字符一起丢掉，
   * 或者用正则误伤了反斜杠，报错里的路径就会像真机那样少一个分隔符，
   * 看的人根本对不上是哪个目录。
   */
  const p = 'C:\\Users\\王营木\\AppData\\Roaming\\Adobe\\UXP\\Plugins\\External\\com.aiforps.psai_0.9.7';
  const out = toAsciiSafe(p);
  assert.equal(
    (out.match(/\\/g) ?? []).length,
    (p.match(/\\/g) ?? []).length,
    `反斜杠数量必须一个不少，实际：${out}`
  );
  assert.ok(out.includes('\\AppData\\Roaming\\'), `AppData 前后的分隔符要在：${out}`);
  assert.ok(out.includes('com.aiforps.psai_0.9.7'), 'ASCII 的部分要原样保留');
});

test('ASCII 原文一个字符不动', () => {
  const s = "EIO, Access is denied. '\\\\?\\C:\\x' (code=EPERM) [ok] {y} 100%";
  assert.equal(toAsciiSafe(s), s);
});

test('过长的消息被截断 —— MessageBox 装不下整篇栈', () => {
  assert.ok(toAsciiSafe('x'.repeat(5000)).length <= 600);
});

test('换行与制表符也换掉，不破坏 NSIS 的显示', () => {
  const out = toAsciiSafe('第一行\n第二行\t带制表符');
  assert.match(out, PRINTABLE);
  assert.ok(!out.includes('\n'));
});
