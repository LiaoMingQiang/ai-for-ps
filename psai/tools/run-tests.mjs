/**
 * 测试总入口。
 * 顺序：先构建 shared（测试直接跑编译产物，保证测的是真交付物），再逐套件执行。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  for (const name of readdirSync(dir)) {
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
];

if (suites.length === 0) {
  console.error('FAIL  没有找到任何测试套件');
  process.exit(1);
}

console.log(`=== 运行 ${suites.length} 个测试套件 ===`);
run(process.execPath, ['--test', ...suites]);
console.log('TESTS-OK');
