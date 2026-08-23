/**
 * 三条出图协议各自的解析环节。
 *
 * 这些函数看着琐碎，但每一个都对应一次真机上踩到的坑：
 *  - 图明明回来了，却被存成错误的格式（nano-banana-pro 回的是 JPEG，我们标成 PNG）
 *  - 图明明在回复正文里，却被判成「模型没有返回图像」（Gemini 回的是 markdown 链接）
 * 两种都会让用户看到「没有任何结果」，而真实原因跟"没结果"毫无关系。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sniffImageMime, extractImageRefs, flattenChatContent } from '../dist/providers/openai.js';

/* ---------------- 图片格式识别 ---------------- */

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const GIF = Buffer.from('474946383961', 'hex');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);

test('data URI 自己声明的类型优先', () => {
  // 真机：nano-banana-pro 的 b64_json 回的是一整条 data URI，内容是 JPEG。
  // 我们以前无条件标 image/png，一张 JPEG 被存成 .png ——
  // 缩略图、写回 Photoshop 的图层、导出文件名全都跟真实格式对不上。
  assert.equal(sniffImageMime('data:image/jpeg;base64,/9j/4AAQ', JPEG), 'image/jpeg');
  assert.equal(sniffImageMime('data:image/png;base64,iVBORw0K', PNG), 'image/png');
  assert.equal(sniffImageMime('data:image/webp;base64,UklGRg', WEBP), 'image/webp');
  assert.equal(sniffImageMime('  DATA:IMAGE/JPEG;BASE64,/9j/  ', JPEG), 'image/jpeg', '大小写与空格都要宽容');
});

test('没有 data URI 就看 magic bytes', () => {
  assert.equal(sniffImageMime('', JPEG), 'image/jpeg');
  assert.equal(sniffImageMime('', PNG), 'image/png');
  assert.equal(sniffImageMime('', GIF), 'image/gif');
  assert.equal(sniffImageMime('', WEBP), 'image/webp');
});

test('两个都认不出来才退回 png，且不会崩', () => {
  assert.equal(sniffImageMime('', Buffer.alloc(0)), 'image/png');
  assert.equal(sniffImageMime('', Buffer.from([1, 2, 3])), 'image/png');
  assert.equal(sniffImageMime('not-a-data-uri', Buffer.from('hello')), 'image/png');
});

test('声明与实际字节冲突时以声明为准', () => {
  // 上游说是什么就按什么存。它比我们更清楚自己编码出来的是什么，
  // 而且真出错的话，错误会停在"格式对不上"这种看得见的地方，
  // 好过我们悄悄改成另一种格式让问题往后飘。
  assert.equal(sniffImageMime('data:image/webp;base64,xxx', JPEG), 'image/webp');
});

/* ---------------- chat 回复里捞图 ---------------- */

test('markdown 图片链接能被捞出来', () => {
  // 真机原文：Gemini 图像族的回复正文就长这样
  const said = '![image](https://files.closeai.fans/filesystem/output/20260823/62bb0a35-433e-4770-81f9-8b816ae55333.jpg)';
  assert.deepEqual(extractImageRefs(said), [
    'https://files.closeai.fans/filesystem/output/20260823/62bb0a35-433e-4770-81f9-8b816ae55333.jpg'
  ]);
});

test('多张图按出现顺序返回并去重', () => {
  const said = '![a](https://x.test/1.png) 还有 ![b](https://x.test/2.jpg) 再来一张 ![c](https://x.test/1.png)';
  assert.deepEqual(extractImageRefs(said), ['https://x.test/1.png', 'https://x.test/2.jpg']);
});

test('data URI 与裸链接也认', () => {
  // 只认 markdown 的话，换个模型/换个网关回裸链接就会被判成「没出图」，
  // 排查方向直接被带到"模型不行"上去，其实只是我们没认出来。
  assert.deepEqual(extractImageRefs('data:image/png;base64,iVBORw0KGgo='), ['data:image/png;base64,iVBORw0KGgo=']);
  assert.deepEqual(extractImageRefs('图在这里 https://x.test/out.webp 拿走'), ['https://x.test/out.webp']);
  assert.deepEqual(extractImageRefs('https://x.test/out.jpeg?sig=abc123'), ['https://x.test/out.jpeg?sig=abc123']);
});

test('正文里的普通网址不会被当成图', () => {
  // 否则模型随口引用一个来源，我们就会去下载一个 HTML 页面当图存
  assert.deepEqual(extractImageRefs('参考 https://example.com/docs 这一页'), []);
  assert.deepEqual(extractImageRefs('我不能生成这张图，因为它涉及真实人物。'), []);
});

test('没有图时返回空数组，交给上层去说人话', () => {
  assert.deepEqual(extractImageRefs(''), []);
  assert.deepEqual(extractImageRefs('抱歉，我无法完成这个请求。'), []);
});

/* ---------------- content 形状 ---------------- */

test('content 是字符串或数组都能压平', () => {
  assert.equal(flattenChatContent('hello'), 'hello');
  assert.equal(
    flattenChatContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
    'a\nb'
  );
  assert.equal(
    flattenChatContent([{ type: 'image_url', image_url: { url: 'https://x.test/1.png' } }]),
    'https://x.test/1.png'
  );
  assert.equal(flattenChatContent(['plain', { type: 'text', text: 'part' }]), 'plain\npart');
});

test('content 缺失或形状怪异时返回空串而不是抛', () => {
  // 上游的响应形状不由我们做主，解析崩掉会把一个"模型没出图"变成一次 500
  assert.equal(flattenChatContent(undefined), '');
  assert.equal(flattenChatContent(null), '');
  assert.equal(flattenChatContent(42), '');
  assert.equal(flattenChatContent([{}, { type: 'text' }]), '');
});

test('压平之后能直接接上捞图这一步', () => {
  const content = [{ type: 'text', text: '给你：![image](https://x.test/a.png)' }];
  assert.deepEqual(extractImageRefs(flattenChatContent(content)), ['https://x.test/a.png']);
});
