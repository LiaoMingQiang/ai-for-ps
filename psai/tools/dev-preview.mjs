/**
 * 开发预览：起 Helper（开 CORS）+ 一个静态服务器托管插件目录，
 * 好在浏览器里看面板长什么样。UXP 专有能力（写回、取图层）在这里不可用，
 * 面板会如实显示"不在 Photoshop 中运行"，这正是它该有的行为。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(here, '../packages/plugin');
const PORT = Number(process.argv[2] ?? 5599);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.map': 'application/json'
};

const { startHelper } = await import(pathToFileURL(resolve(here, '../packages/helper/dist/index.js')).href);
const helper = await startHelper({ devCors: true });
console.log(`Helper: ${helper.url}（已开启开发 CORS）`);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  let path = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = join(PLUGIN_DIR, decodeURIComponent(path));
  if (!file.startsWith(PLUGIN_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`面板预览: http://127.0.0.1:${PORT}/index.html`);
});
