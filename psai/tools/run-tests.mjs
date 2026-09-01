/**
 * 测试总入口。
 * 顺序：先构建 shared（测试直接跑编译产物，保证测的是真交付物），再逐套件执行。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { positiveInt } from './env-int.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** npm 在 Windows 上是 .cmd，必须走 shell；node 自身路径可能含空格，绝不能走 shell。 */
function run(cmd, args, { cwd = root, useShell = false } = {}) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: useShell });
}

function runNpm(args) {
  run(npm, args, { useShell: process.platform === 'win32' });
}

function collect(dir, out = []) {
  if (!existsSync(dir)) return out;
  // 排序：readdirSync 的顺序依赖文件系统，同一份代码在两台机器上
  // 可能按不同顺序跑。顺序一变，"只在某个前后关系下才出现"的问题
  // 就会时有时无 —— 那种 flaky 最难查。
  for (const name of readdirSync(dir).sort()) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (name.endsWith('.test.mjs')) out.push(p);
  }
  return out;
}

console.log('=== 构建 shared ===');
runNpm(['run', 'build', '-w', '@psai/shared']);

if (existsSync(resolve(root, 'packages/helper/src/index.ts'))) {
  console.log('=== 构建 helper ===');
  runNpm(['run', 'build', '-w', '@psai/helper']);
}

const suites = [
  ...collect(resolve(root, 'packages/shared/test')),
  ...collect(resolve(root, 'packages/helper/test')),
  ...collect(resolve(root, 'packages/plugin/test')),
  ...collect(resolve(root, 'tools/test'))
].sort();

if (suites.length === 0) {
  console.error('FAIL  没有找到任何测试套件');
  process.exit(1);
}

/*
 * 限制并发。
 *
 * node --test 默认按 CPU 核数并行（这台机器 20 核），而我们有十来个套件
 * 每个都要起一个真 Helper + 一个 ComfyUI 桩。同时跑起来会把本机压到
 * ComfyUI 探测（15 秒超时）都过不去 —— 表现是一批 helper.test 用例
 * 卡在 15000ms 整数附近失败，单独跑却全绿。
 *
 * 这种"偶尔红一次"的套件比没有套件更糟：它会训练人去无视失败。
 * 4 路并发仍然比串行快得多，又给每个 Helper 留足了余量。
 */
/*
 * 并发上限。
 *
 * 这是一道**减压措施**，不是根因修复。根因是每个临时 Helper 启动时
 * 都会去探宿主机的 127.0.0.1:8188（新数据目录的默认 ComfyUI 地址）——
 * 那已经在 config.probeOnStart 里关掉了。
 * 但十几个套件各自起 Helper + 桩仍然是实打实的负载，
 * 留着这个上限让结果稳定，代价只是慢一点。
 */
let CONCURRENCY;
let REPEAT;
try {
  CONCURRENCY = positiveInt('PSAI_TEST_CONCURRENCY', process.env['PSAI_TEST_CONCURRENCY'], 4);
  /** 跑几遍。查 flaky 用：PSAI_TEST_REPEAT=5 npm test */
  REPEAT = positiveInt('PSAI_TEST_REPEAT', process.env['PSAI_TEST_REPEAT'], 1);
} catch (e) {
  // 环境变量拼错了就**退出**，不能兜底成默认值继续跑 ——
  // 见 tools/env-int.mjs：兜底会换来一个什么都没验过的"全绿"。
  console.error(`TESTS-FAIL  ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

/*
 * 一个套件都没发现，多半是发现逻辑坏了或者目录结构变了。
 * 这种情况下"全部通过"是没有意义的，必须红。
 */
if (suites.length === 0) {
  console.error('TESTS-FAIL  一个测试套件都没找到');
  process.exit(2);
}

for (let i = 1; i <= REPEAT; i++) {
  const label = REPEAT > 1 ? `（第 ${i}/${REPEAT} 轮）` : '';
  console.log(`=== 运行 ${suites.length} 个测试套件（并发 ${CONCURRENCY}）${label} ===`);
  run(process.execPath, ['--test', `--test-concurrency=${CONCURRENCY}`, ...suites]);
}
console.log('TESTS-OK');
