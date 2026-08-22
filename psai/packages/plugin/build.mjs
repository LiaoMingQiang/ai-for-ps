/**
 * 插件构建：TypeScript -> 单个 IIFE bundle。
 * UXP 没有 npm 运行时，也没有 ESM 加载器，所以必须打成一个自执行脚本。
 */
import { build, context } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/** UXP 用 require() 提供宿主模块，不能被 esbuild 打包进来。 */
const uxpExternals = ['photoshop', 'uxp', 'os', 'fs'];

const options = {
  entryPoints: [resolve(here, 'src/entry.ts')],
  outfile: resolve(here, 'dist/main.js'),
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  target: ['es2021'],
  external: uxpExternals,
  sourcemap: 'inline',
  legalComments: 'none',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' }
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching...');
} else {
  await build(options);
  console.log('BUILD-OK  dist/main.js');
}
