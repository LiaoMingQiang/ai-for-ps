/**
 * 从粘进来的网址里认出云端工作流 ID。
 *
 * 各平台把 ID 藏在完全不同的地方，而 LiblibAI 尤其隐蔽 —— 用户直接问
 * 「我在哪里找 LiblibAI 的工作流 id，我找不到」。它页面上根本没有展示
 * 工作流 ID 的地方，只有在线 ComfyUI 打开那份工作流时地址栏里的
 * comfyuuid 参数。找不到是正常的。
 *
 * 所以输入框直接吃整条网址：让用户去 URL 里抠一段十六进制，
 * 抠错了报的错还会指向别处。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractCloudWorkflowId } from '../dist/index.js';

test('LiblibAI：从在线 ComfyUI 的地址里取 comfyuuid', () => {
  // 用户截图里那条真实地址
  const url =
    'liblib.art/comfy?open=comfy=workflowData-19991929&comfyname=高质量洗图F1' +
    '&comfyOid=a9c9b57d22a42b8b758d947d0c0ea90&comfyuuid=6a40234cc28b49de806ed9bac9eeb555';
  assert.equal(extractCloudWorkflowId(url), '6a40234cc28b49de806ed9bac9eeb555');
});

test('LiblibAI：comfyOid 排在前面也不能被误取', () => {
  /*
   * 这条是关键。comfyOid 和 comfyuuid 长得一模一样（都是长十六进制），
   * 而 comfyOid 排在前面 —— 取错了会得到一个"看起来很像"的错 ID，
   * 提交时报的是工作流不存在，跟真正的原因（取错了字段）毫无关系。
   */
  const url = 'https://liblib.art/comfy?comfyOid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&comfyuuid=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.equal(extractCloudWorkflowId(url), 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('RunningHub 工作流地址', () => {
  assert.equal(
    extractCloudWorkflowId('https://www.runninghub.ai/zh-cn/workflow/2095750596867792898'),
    '2095750596867792898'
  );
});

test('RunningHub AI 应用地址', () => {
  assert.equal(
    extractCloudWorkflowId('https://www.runninghub.ai/zh-cn/ai-detail/1892509998193545217'),
    '1892509998193545217'
  );
});

test('带查询串和锚点的地址也认', () => {
  assert.equal(
    extractCloudWorkflowId('https://www.runninghub.ai/zh-cn/workflow/2095750596867792898?tab=api#top'),
    '2095750596867792898'
  );
});

test('本来就是纯 ID 的，原样返回', () => {
  assert.equal(extractCloudWorkflowId('1892509998193545217'), '1892509998193545217');
  assert.equal(extractCloudWorkflowId('  6a40234cc28b49de806ed9bac9eeb555  '), '6a40234cc28b49de806ed9bac9eeb555');
});

test('空输入返回空串，不抛异常', () => {
  assert.equal(extractCloudWorkflowId(''), '');
  assert.equal(extractCloudWorkflowId('   '), '');
});

test('认不出来的原样返回，交给服务端判', () => {
  // 在这里猜错，比让服务端说"这个 ID 不合法"更难查。
  assert.equal(extractCloudWorkflowId('随便写点什么'), '随便写点什么');
});

test('认不出来时绝不猜 —— 宁可原样留着让用户自己填', () => {
  /*
   * 真机上出过：用户粘的是 liblib.art 的另一个页面地址
   *   lib3?uuid=a9c9fb57d22a42bfb758d947d0c0ea90&modelInfo=6a40234cc28b49de806ed9bac9eeb333
   * 两个参数都是 32 位十六进制。原来有个"挑最长那串"的兜底，取了前面那个
   * （页面 uuid），而工作流 uuid 是后面那个 —— 界面还报了一句
   * 「已从网址里认出 ID」，理直气壮地给了个错答案。
   *
   * 猜错的代价不是报错，是拿着错 ID 去提交，平台回「工作流不存在」，
   * 跟真正的原因毫无关系。所以认不出就原样返回。
   */
  const url = 'https://www.liblib.art/lib3?uuid=a9c9fb57d22a42bfb758d947d0c0ea90&modelInfo=6a40234cc28b49de806ed9bac9eeb333';
  assert.equal(extractCloudWorkflowId(url), url, '认不出的地址必须原样返回，不许挑一个像的');
});

test('带 comfyuuid 的地址仍然认得出 —— 不猜不等于不认', () => {
  // 去掉兜底不能把真正认识的那条路也砍了。
  const url = 'https://www.liblib.art/comfy?open=x&comfyOid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&comfyuuid=6a40234cc28b49de806ed9bac9eeb333';
  assert.equal(extractCloudWorkflowId(url), '6a40234cc28b49de806ed9bac9eeb333');
});
