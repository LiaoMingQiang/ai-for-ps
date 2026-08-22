/**
 * 把 Helper 打成单文件 exe（Node SEA），用户不需要装 Node。
 *
 * 步骤：esbuild 打成一个 CJS → 生成 SEA blob → 复制 node.exe → postject 注入。
 * 内置工作流不打进 exe（它们是数据不是代码），随包放在 exe 旁边的 workflows/ 里，
 * 启动时用 PSAI_WORKFLOWS_DIR 指过去。
 */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, writeFileSync, existsSync, statSync, cpSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const OUT = resolve(ROOT, 'release/helper');
const WORK = resolve(ROOT, '.tmp/sea');

console.log('=== 打包 Helper 单文件 exe ===');

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

/* 1. esbuild 打成一个 CJS 文件 */
const bundlePath = join(WORK, 'helper.cjs');
await build({
  entryPoints: [resolve(ROOT, 'packages/helper/dist/index.js')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // node: 内置模块与原生绑定不打包
  external: ['node:*'],
  banner: {
    js: '// AI for PS Helper —— 由 tools/bundle-helper.mjs 生成，请勿手工编辑'
  },
  logLevel: 'warning',
  minify: false
});
console.log(`  bundle: ${(statSync(bundlePath).size / 1048576).toFixed(1)} MB`);

/* 2. SEA 配置与 blob */
const seaConfig = join(WORK, 'sea-config.json');
const blobPath = join(WORK, 'helper.blob');
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: bundlePath.replaceAll('\\', '/'),
      output: blobPath.replaceAll('\\', '/'),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false
    },
    null,
    2
  ),
  'utf8'
);

execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
console.log(`  blob: ${(statSync(blobPath).size / 1048576).toFixed(1)} MB`);

/* 3. 复制 node.exe 并注入 */
const exeName = process.platform === 'win32' ? 'AI-for-PS-Helper.exe' : 'AI-for-PS-Helper';
const exePath = join(OUT, exeName);
copyFileSync(process.execPath, exePath);

// Windows 上要先去掉签名，否则注入后签名失效导致无法启动
if (process.platform === 'win32') {
  try {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `$sig = Get-AuthenticodeSignature '${exePath}'; if ($sig.Status -ne 'NotSigned') { Write-Output 'signed' } else { Write-Output 'unsigned' }`
    ]);
  } catch {
    /* 查不到签名状态不影响后续 */
  }
}

const postjectCli = resolve(ROOT, 'node_modules/postject/dist/cli.js');
execFileSync(
  process.execPath,
  [
    postjectCli,
    exePath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  ],
  { stdio: 'inherit' }
);
console.log(`  exe: ${exePath} (${(statSync(exePath).size / 1048576).toFixed(1)} MB)`);

/* 4. 内置工作流随包（数据不进 exe） */
const wfOut = join(OUT, 'workflows');
rmSync(wfOut, { recursive: true, force: true });
cpSync(resolve(ROOT, 'workflows'), wfOut, { recursive: true });
console.log(`  workflows: ${wfOut}`);

/* 5. 启动脚本：把 PSAI_WORKFLOWS_DIR 指到随包目录 */
writeFileSync(
  join(OUT, 'run-helper.bat'),
  [
    '@echo off',
    'rem 直接运行 Helper（调试用）。正式安装由 Setup.exe 注册为开机自启。',
    'set PSAI_WORKFLOWS_DIR=%~dp0workflows',
    'start "" "%~dp0AI-for-PS-Helper.exe"'
  ].join('\r\n'),
  'utf8'
);

console.log('BUNDLE-OK');

/* 6. 冒烟：起一次看能不能跑起来 */
if (existsSync(exePath)) {
  console.log('=== 冒烟：启动打包后的 exe ===');
  const { spawn } = await import('node:child_process');
  const child = spawn(exePath, [], {
    env: { ...process.env, PSAI_PORT: '34219', PSAI_WORKFLOWS_DIR: wfOut, PSAI_DATA_DIR: join(WORK, 'smoke-data') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => (out += String(d)));
  child.stderr.on('data', (d) => (out += String(d)));

  let ok = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch('http://127.0.0.1:34219/v1/health', { signal: AbortSignal.timeout(1500) });
      const j = await res.json();
      console.log(`  健康检查通过：version=${j.version} schema=${j.schemaVersion}`);
      ok = true;
      break;
    } catch {
      /* 还没起来 */
    }
  }
  child.kill();
  if (!ok) {
    console.error('  SMOKE-FAIL 打包后的 exe 起不来：');
    console.error(out.slice(0, 2000));
    process.exitCode = 1;
  } else {
    console.log('SMOKE-OK');
  }
}
