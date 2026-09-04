/**
 * 每一个摆在设置页上的凭据字段，都必须真的有人读。
 *
 * 真机上出的问题：RunningHub 卡片上有两个几乎同名的输入框 ——
 * 「工作流 ID」和「默认工作流 ID」，上下紧挨着，只差「默认」两个字。
 * 上面那个是**死的**：凭据存储会把它存下来，但整个 Helper 里没有
 * 任何一处读它。用户填了上面那个，以为配好了，提交却说没有工作流 ID，
 * 而设置页上明明白白写着他填过。
 *
 * 这种 bug 靠人眼审是查不出来的 —— 字段声明在 shared/providers.ts，
 * 读取在 helper/providers/manager.ts，两个文件隔得很远，
 * 而且"没人读"不会有任何编译错误或运行时报错。所以用结构性检查钉死：
 * 声明了就必须有对应的 credentials.get。
 *
 * 这条对着旧实现跑会红，红在 runninghub 的 workflowId 上。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDERS } from '@psai/shared';

const here = dirname(fileURLToPath(import.meta.url));
const managerSrc = readFileSync(join(here, '../src/providers/manager.ts'), 'utf8');

/** manager 里所有 `credentials.get(x, 'key')` 读到的 key。 */
function consumedKeys() {
  const keys = new Set();
  for (const m of managerSrc.matchAll(/credentials\.get\(\s*[^,]+,\s*'([^']+)'/g)) keys.add(m[1]);
  return keys;
}

test('声明出来的凭据字段，每一个都有人读', () => {
  const consumed = consumedKeys();
  assert.ok(consumed.size > 0, '一个 credentials.get 都没匹配到，说明这个检查本身失效了');

  const dead = [];
  for (const p of PROVIDERS) {
    for (const c of p.credentials ?? []) {
      if (!consumed.has(c.key)) dead.push(`${p.id}.${c.key}（界面上标着「${c.label}」）`);
    }
  }
  assert.deepEqual(
    dead,
    [],
    `这些字段会显示在设置页上、能被填写和保存，但 Helper 从来不读它们 —— ` +
      `用户填了等于没填，而且没有任何提示：\n  ${dead.join('\n  ')}`
  );
});

test('RunningHub 只保留真正生效的那个工作流 ID 入口', () => {
  const rh = PROVIDERS.find((p) => p.id === 'runninghub');
  assert.ok(rh);
  const keys = (rh.credentials ?? []).map((c) => c.key);
  assert.deepEqual(keys, ['apiKey'], '凭据里不该再有 workflowId —— 生效的是 Provider 设置上的 defaultWorkflowId');
});
