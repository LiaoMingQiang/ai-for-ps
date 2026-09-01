/**
 * 读一个"必须是正整数"的环境变量。
 *
 * 单独一个文件是为了能被测到：run-tests.mjs 一被 import 就会去构建
 * 各个包，没法在用例里直接引它。
 *
 * 必须严格，而且必须**抛错**，不能兜底成默认值。
 * 原来写的是 `Math.max(1, Number(env))` —— `PSAI_TEST_REPEAT=not-a-number`
 * 会算出 NaN，`for (i = 1; i <= NaN; i++)` 一轮都不跑，
 * 然后照样打印 TESTS-OK、退出码 0。
 * 一次拼错的环境变量换来一个"全绿"的门禁，而它什么都没验过 ——
 * 这比没有门禁更糟，因为它会让人相信它。
 */

/**
 * @param {string} name     变量名，只用于报错文案
 * @param {string|undefined} raw
 * @param {number} fallback 没设置时用它
 * @returns {number}
 */
export function positiveInt(name, raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).trim();
  /*
   * 只认纯十进制正整数。
   *
   * Number() 太宽松，下面这些它全都收：
   *   ''      → 0        （空串被当成 0）
   *   '  '    → 0
   *   '0x10'  → 16       （十六进制）
   *   '1e3'   → 1000     （科学计数法）
   *   '1.9'   → 1.9      （小数，之后当轮数用会很怪）
   *   'Infinity' → ∞     （死循环）
   * 这些写法没有一个是人真心想输入的，收下它们只会让错误更难发现。
   */
  if (!/^[0-9]+$/.test(s)) {
    throw new Error(`${name} 必须是正整数，收到的是 ${JSON.stringify(raw)}`);
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`${name} 必须是 1 以上的正整数，收到的是 ${JSON.stringify(raw)}`);
  }
  return n;
}
