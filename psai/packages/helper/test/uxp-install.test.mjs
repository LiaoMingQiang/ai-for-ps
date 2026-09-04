/**
 * UXP 插件的安装 / 升级 / 卸载。
 *
 * 这一组测试守的是安装器里**最危险**的一步：改
 *   %APPDATA%\Adobe\UXP\PluginsInfo\v1\PS.json
 * 那份 JSON 同时列着用户装的所有 UXP 插件 —— 别人花钱买的插件也在里面。
 * 我们只该动自己那一条。写坏了的后果不是"我们的插件装不上"，
 * 而是"用户的 Photoshop 里所有插件都不见了"，而且他完全不知道是谁干的。
 *
 * 所以每条用例都在临时目录里跑真实的文件操作，不 mock 文件系统：
 * 这段代码的价值全在"它到底往磁盘上写了什么"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installPlugin,
  uninstallPlugin,
  readRegistry,
  registryFile,
  externalDir,
  installedDirsOf,
  hostMinVersionOf
} from '../dist/uxp-install.js';

function newRoot() {
  return mkdtempSync(join(tmpdir(), 'psai-uxp-'));
}

/** 造一个最小但结构真实的插件包。 */
function makePlugin(dir, { id = 'com.aiforps.psai', version = '0.9.0', name = 'AI for PS' } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      manifestVersion: 5,
      id,
      name,
      version,
      main: 'index.html',
      host: { app: 'PS', minVersion: '25.2.0' }
    }),
    'utf8'
  );
  writeFileSync(join(dir, 'index.html'), '<html></html>', 'utf8');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'main.js'), `// ${version}`, 'utf8');
  return dir;
}

/** 模拟"用户已经装了别的 UXP 插件"。 */
function seedForeignPlugin(root, pluginId = 'com.someoneelse.tool') {
  const file = registryFile(root);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      plugins: [
        {
          hostMinVersion: '24.0.0',
          name: '别人的插件',
          path: `$localPlugins\\External\\${pluginId}_2.0.0`,
          pluginId,
          status: 'enabled',
          type: 'uxp',
          versionString: '2.0.0'
        }
      ]
    }),
    'utf8'
  );
  const dir = join(externalDir(root), `${pluginId}_2.0.0`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), '{}', 'utf8');
  return { pluginId, dir };
}

/* ---------------- 全新安装 ---------------- */

test('全新机器：没有注册表也能装上', () => {
  // 从没装过任何 UXP 插件的机器上，PS.json 根本不存在。
  // 这是全新机器的正常状态，不该被当成错误。
  const root = newRoot();
  const src = makePlugin(join(root, 'payload'));

  const r = installPlugin({ sourceDir: src, root });

  assert.equal(r.pluginId, 'com.aiforps.psai');
  assert.equal(r.version, '0.9.0');
  assert.ok(existsSync(join(r.installedPath, 'manifest.json')), '插件文件要真的落到 External 下');
  assert.ok(existsSync(join(r.installedPath, 'dist', 'main.js')), '子目录也要一起拷过去');

  const reg = readRegistry(registryFile(root));
  assert.equal(reg.plugins.length, 1);
  assert.equal(reg.plugins[0].pluginId, 'com.aiforps.psai');
  assert.equal(reg.plugins[0].status, 'enabled');
  assert.equal(reg.plugins[0].versionString, '0.9.0');
});

test('注册表里的 path 用 $localPlugins 变量写法，不是绝对路径', () => {
  // 真机上 Adobe 自己就是这么写的。换成绝对路径 Photoshop 认不出来，
  // 插件装了却不出现在菜单里 —— 这种错最难查，因为文件明明都在。
  const root = newRoot();
  const src = makePlugin(join(root, 'payload'));
  installPlugin({ sourceDir: src, root });

  const reg = readRegistry(registryFile(root));
  assert.equal(reg.plugins[0].path, '$localPlugins\\External\\com.aiforps.psai_0.9.0');
  assert.ok(!reg.plugins[0].path.includes(':'), 'path 里不该出现盘符');
});

/* ---------------- 不许碰别人的插件 ---------------- */

test('装我们的插件，绝不动用户已有的其他插件', () => {
  const root = newRoot();
  const foreign = seedForeignPlugin(root);
  const src = makePlugin(join(root, 'payload'));

  const r = installPlugin({ sourceDir: src, root });

  assert.equal(r.keptOtherEntries, 1, '别人的记录必须原样保留');
  const reg = readRegistry(registryFile(root));
  assert.equal(reg.plugins.length, 2);
  const other = reg.plugins.find((p) => p.pluginId === foreign.pluginId);
  assert.ok(other, '别人的插件记录不见了 —— 这会让用户的 Photoshop 少一个插件');
  assert.equal(other.versionString, '2.0.0', '别人的记录内容不该被改');
  assert.ok(existsSync(join(foreign.dir, 'manifest.json')), '别人的插件目录不该被删');
});

test('卸载我们的插件，同样不动别人的', () => {
  const root = newRoot();
  const foreign = seedForeignPlugin(root);
  installPlugin({ sourceDir: makePlugin(join(root, 'payload')), root });

  const r = uninstallPlugin({ pluginId: 'com.aiforps.psai', root });

  assert.equal(r.removedEntries, 1);
  assert.equal(r.keptOtherEntries, 1);
  const reg = readRegistry(registryFile(root));
  assert.deepEqual(reg.plugins.map((p) => p.pluginId), [foreign.pluginId]);
  assert.ok(existsSync(join(foreign.dir, 'manifest.json')), '别人的插件目录不该被删');
});

test('前缀相同的另一个插件不会被误删', () => {
  // com.aiforps.psai 和 com.aiforps.psaitools 是两个插件。
  // 只用 startsWith(id) 匹配的话，装前者会把后者一起清掉。
  const root = newRoot();
  const sibling = join(externalDir(root), 'com.aiforps.psaitools_1.0.0');
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, 'manifest.json'), '{}', 'utf8');

  installPlugin({ sourceDir: makePlugin(join(root, 'payload')), root });

  assert.ok(existsSync(sibling), 'com.aiforps.psaitools 被误删了');
  assert.deepEqual(installedDirsOf('com.aiforps.psai', root).map((d) => d.split(/[\\/]/).pop()), [
    'com.aiforps.psai_0.9.0'
  ]);
});

/* ---------------- 升级 ---------------- */

test('升级：旧版本目录被清干净，只留新版本', () => {
  // 旧目录留着的话，Photoshop 有时会加载到旧版本 ——
  // 用户升级完发现界面没变，而我们怎么查都查不出问题。
  const root = newRoot();
  installPlugin({ sourceDir: makePlugin(join(root, 'v1'), { version: '0.9.0' }), root });
  const r = installPlugin({ sourceDir: makePlugin(join(root, 'v2'), { version: '1.0.0' }), root });

  assert.equal(r.version, '1.0.0');
  assert.equal(r.removedDirs.length, 1, '应清理掉 0.9.0 的目录');

  const dirs = readdirSync(externalDir(root));
  assert.deepEqual(dirs, ['com.aiforps.psai_1.0.0'], `External 下应只剩新版本，实际 ${dirs.join(', ')}`);

  const reg = readRegistry(registryFile(root));
  assert.equal(reg.plugins.length, 1, '同一个 id 不能留两条记录');
  assert.equal(reg.plugins[0].versionString, '1.0.0');
});

test('升级后文件内容确实是新版本的', () => {
  // 只删记录不换文件的话，版本号变了而代码没变，
  // 这种"升级成功但行为没变"比装不上更难排查。
  const root = newRoot();
  installPlugin({ sourceDir: makePlugin(join(root, 'v1'), { version: '0.9.0' }), root });
  const r = installPlugin({ sourceDir: makePlugin(join(root, 'v2'), { version: '1.0.0' }), root });

  assert.equal(readFileSync(join(r.installedPath, 'dist', 'main.js'), 'utf8'), '// 1.0.0');
});

test('重复装同一个版本是幂等的', () => {
  // 用户重跑一遍安装器是很常见的操作，不该产生第二条记录或残留目录
  const root = newRoot();
  const src = makePlugin(join(root, 'payload'));
  installPlugin({ sourceDir: src, root });
  installPlugin({ sourceDir: src, root });

  assert.deepEqual(readdirSync(externalDir(root)), ['com.aiforps.psai_0.9.0']);
  assert.equal(readRegistry(registryFile(root)).plugins.length, 1);
});

test('旧版本被 UXP 标成 .disabled 的目录也要清掉', () => {
  // 真机上见过：升级后旧目录被改名成 `<id>_<ver>.disabled` 留在那里。
  // 不清理的话 External 会越堆越多，而且 PS 偶尔还会去读它。
  const root = newRoot();
  const stale = join(externalDir(root), 'com.aiforps.psai_0.8.0.disabled');
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'manifest.json'), '{}', 'utf8');

  installPlugin({ sourceDir: makePlugin(join(root, 'payload')), root });

  assert.ok(!existsSync(stale), '.disabled 的旧目录应该被清掉');
});

/* ---------------- 坏数据与边界 ---------------- */

test('注册表内容损坏时不崩，且先备份再重写', () => {
  // 装到一半断电、或者别的工具写坏了，都可能留下半个 JSON。
  // 这时候抛异常等于让用户永远装不上；直接覆盖又可能弄丢东西 —— 所以先备份。
  const root = newRoot();
  const file = registryFile(root);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '{ "plugins": [ {"pluginId": "x"', 'utf8');

  installPlugin({ sourceDir: makePlugin(join(root, 'payload')), root });

  const reg = readRegistry(file);
  assert.equal(reg.plugins.length, 1);
  assert.equal(reg.plugins[0].pluginId, 'com.aiforps.psai');
  const backups = readdirSync(join(file, '..')).filter((f) => f.includes('.bak-'));
  assert.ok(backups.length >= 1, '覆盖坏文件前必须留一份备份');
});

test('卸载一个没装过的插件算成功', () => {
  // 卸载一个本来就不在的东西，结果和卸载成功没有区别。
  // 报错的话，安装器的卸载流程会因为"清理一个不存在的残留"而整体失败。
  const root = newRoot();
  const r = uninstallPlugin({ pluginId: 'com.nobody.here', root });
  assert.equal(r.removedEntries, 0);
  assert.deepEqual(r.removedDirs, []);
});

test('manifest 缺 id 或 version 时明确报错', () => {
  // 这属于打包出了问题，必须当场炸掉。
  // 悄悄装一个 id 为 undefined 的插件，后果是注册表里多一条永远清不掉的垃圾记录。
  const root = newRoot();
  const dir = join(root, 'bad');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'x' }), 'utf8');
  assert.throws(() => installPlugin({ sourceDir: dir, root }), /缺少 id 或 version/);
});

test('插件包里没有 manifest.json 时明确报错', () => {
  const root = newRoot();
  const dir = join(root, 'empty');
  mkdirSync(dir, { recursive: true });
  assert.throws(() => installPlugin({ sourceDir: dir, root }), /没有 manifest\.json/);
});

test('host 写成数组时也能取到 minVersion', () => {
  // UXP 的 manifest 允许 host 是对象或数组，两种都得认
  assert.equal(hostMinVersionOf({ id: 'a', name: 'a', version: '1', host: { app: 'PS', minVersion: '26.0.0' } }), '26.0.0');
  assert.equal(hostMinVersionOf({ id: 'a', name: 'a', version: '1', host: [{ app: 'PS', minVersion: '24.1.0' }] }), '24.1.0');
  assert.equal(hostMinVersionOf({ id: 'a', name: 'a', version: '1' }), '25.2.0', '没写就用兜底值');
});

