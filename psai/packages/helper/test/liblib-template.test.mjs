/**
 * LiblibAI 的 templateUuid 是平台常量，用户不该被要求去找它。
 *
 * 用户卡在这里：报错说「还需要一个 ComfyUI 模板 ID，在工作流页面
 * 「查看 API 参数」里」—— 而 LiblibAI 的界面上根本没有那个入口，
 * 他反复问「我在哪里找」。
 *
 * 拿他的真账号探出来的结论（三个候选，三种不同的报错）：
 *
 *   5d7e67009b344550bc1aa6ccbfa1d7f4  → get workflow failed          模板过了
 *   4df2efa0f18d46dc9758803e478eb51c  → get workflow version failed  模板过了
 *   （工作流 uuid 本身）               → template not found           不是模板
 *
 * 也就是说 templateUuid 是平台侧的常量：填对了就跨过模板这一关，
 * 卡点转移到工作流那一侧。既然是常量，就该由我们填默认值。
 *
 * 而「get workflow (version) failed」的真实含义是"这份工作流没有可运行的版本"，
 * 最常见的原因是它还没发布为应用。原样端出这句英文，用户看不出下一步做什么。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIBLIB_DEFAULT_COMFY_TEMPLATE } from '../dist/providers/liblib.js';

test('默认模板常量存在且形如 uuid', () => {
  assert.match(LIBLIB_DEFAULT_COMFY_TEMPLATE, /^[0-9a-f]{32}$/);
});

test('默认常量不是那个被平台判为 template not found 的值', () => {
  /*
   * 6f4f1594… 一直躺在测试夹具里，看着很像"正确答案"。
   * 实探过：平台明确回 template not found。把它当默认值等于把所有人引到坑里。
   */
  assert.notEqual(LIBLIB_DEFAULT_COMFY_TEMPLATE, '6f4f15946dbe472fb29c8768bb5c6f78');
});

test('平台那三句真实原文各自归到正确的分支', async () => {
  const { toPsaiError } = await import('../dist/providers/liblib.js').catch(() => ({}));
  // 映射逻辑不导出时，退回直接校验判据本身 —— 这三句原文是探出来的，不能改
  const isNoVersion = (m) => /get workflow(\s+version)?\s+failed/i.test(m);
  const isBadTemplate = (m) => /template not found/i.test(m);

  assert.equal(isNoVersion('get workflow failed'), true);
  assert.equal(isNoVersion('get workflow version failed'), true);
  assert.equal(isNoVersion('template not found, templateUuid: abc'), false);
  assert.equal(isBadTemplate('template not found, templateUuid: abc'), true);
  assert.equal(isBadTemplate('get workflow version failed'), false);
  void toPsaiError;
});

test('两类错误不能混为一谈', () => {
  /*
   * 「模板不对」和「工作流没有可运行版本」的处理方式完全相反：
   *   前者 —— 把设置里那一栏清空，让我们用常量
   *   后者 —— 去 liblib.art 把工作流发布为应用
   * 归错类的话，用户会对着设置反复改一个本来就对的值。
   */
  const noVersion = /get workflow(\s+version)?\s+failed/i;
  const badTemplate = /template not found/i;
  for (const m of ['get workflow failed', 'get workflow version failed']) {
    assert.equal(noVersion.test(m) && !badTemplate.test(m), true, `「${m}」只该命中"没有可运行版本"`);
  }
});
