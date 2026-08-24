/**
 * UXP 插件的安装与卸载。
 *
 * 为什么这段代码在 Helper 里，而不是写在 NSIS 脚本里：
 * 装一个 UXP 插件不只是拷文件，还要把自己登记进 Photoshop 的插件注册表
 *   %APPDATA%\Adobe\UXP\PluginsInfo\v1\PS.json
 * 那是一份 JSON，里面**同时列着用户装的所有其他 UXP 插件**。
 * NSIS 没有 JSON 解析能力，用文本替换去改它，迟早会把别人的插件删掉或改坏 ——
 * 那是用户花钱买的插件，被我们的安装器搞没了是不可接受的。
 *
 * 所以：NSIS 只负责搬字节，改注册表这一步交给 Helper 自己（它本来就是 Node，
 * 打包成单文件 exe 后照样能跑，用户机器上不需要装任何运行时）。
 *
 * 安装位置来自真机实测（本机 Photoshop 里正常加载的插件就在这里）：
 *   %APPDATA%\Adobe\UXP\Plugins\External\<pluginId>_<version>\
 *   %APPDATA%\Adobe\UXP\PluginsInfo\v1\PS.json  →  { plugins: [ { pluginId, path, ... } ] }
 * 其中 path 用的是 `$localPlugins\External\...` 这种带变量的写法，不是绝对路径。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** PS.json 里一条插件记录。字段名沿用 Adobe 的写法，不要改。 */
export interface UxpPluginEntry {
  hostMinVersion: string;
  name: string;
  /** 形如 `$localPlugins\External\com.aiforps.psai_0.9.0` */
  path: string;
  pluginId: string;
  status: string;
  type: string;
  versionString: string;
}

export interface UxpRegistry {
  plugins: UxpPluginEntry[];
}

/** 插件包里的 manifest（只取我们要用的字段）。 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  host?: { app?: string; minVersion?: string } | Array<{ app?: string; minVersion?: string }>;
}

/**
 * UXP 根目录。
 *
 * PSAI_UXP_ROOT 是给测试用的：真机上装一次插件会动到用户 Photoshop 的注册表，
 * 测试里必须能指到临时目录，否则这段代码就只能靠人工验证 ——
 * 而"人工验证过一次"对安装器来说远远不够，它每次发版都要重新跑。
 */
export function uxpRoot(): string {
  const override = process.env['PSAI_UXP_ROOT'];
  if (override) return resolve(override);
  const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'Adobe', 'UXP');
}

export function externalDir(root = uxpRoot()): string {
  return join(root, 'Plugins', 'External');
}

/** 宿主应用对应的注册表文件。Photoshop 是 PS.json。 */
export function registryFile(root = uxpRoot(), host = 'PS'): string {
  return join(root, 'PluginsInfo', 'v1', `${host}.json`);
}

/**
 * 读注册表。
 *
 * 文件不存在（用户从没装过任何 UXP 插件）、或者内容坏了，都返回空表而不是抛。
 * 抛出去的话安装器就装不下去了，可"没有注册表"恰恰是全新机器的正常状态。
 * 内容坏了也一样：我们待会儿会先备份再重写，用户不会丢东西。
 */
export function readRegistry(file: string): UxpRegistry {
  if (!existsSync(file)) return { plugins: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const plugins = (parsed as UxpRegistry)?.plugins;
    return Array.isArray(plugins) ? { plugins: plugins.filter((p) => !!p && typeof p.pluginId === 'string') } : { plugins: [] };
  } catch {
    return { plugins: [] };
  }
}

/**
 * 写注册表。先备份、再原子替换。
 *
 * 备份文件名带时间戳 —— 和 Adobe 自己那套 `PS.json.bak-<ts>` 保持一致。
 * 原子替换（先写临时文件再 rename）是为了防"写到一半断电"：
 * 半个 JSON 会让 Photoshop 一个插件都加载不出来，用户完全不知道发生了什么。
 */
export function writeRegistry(file: string, reg: UxpRegistry): void {
  mkdirSync(join(file, '..'), { recursive: true });
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    try {
      cpSync(file, `${file}.bak-${stamp}`);
    } catch {
      /* 备份失败不该挡住安装，下面的原子替换本身也是安全的 */
    }
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  rmSync(file, { force: true });
  renameSync(tmp, file);
}

/** 从 manifest 里取 host.minVersion，manifest 可能把 host 写成对象或数组。 */
export function hostMinVersionOf(m: PluginManifest, fallback = '25.2.0'): string {
  const hosts = Array.isArray(m.host) ? m.host : m.host ? [m.host] : [];
  for (const h of hosts) {
    if (h?.minVersion) return h.minVersion;
  }
  return fallback;
}

export function readManifest(pluginDir: string): PluginManifest {
  const file = join(pluginDir, 'manifest.json');
  if (!existsSync(file)) throw new Error(`插件包里没有 manifest.json：${file}`);
  const m = JSON.parse(readFileSync(file, 'utf8')) as PluginManifest;
  if (!m.id || !m.version) throw new Error(`manifest.json 缺少 id 或 version：${file}`);
  return m;
}

/** 这个插件 id 在 External 下已经装过哪些版本的目录（含被禁用的）。 */
export function installedDirsOf(pluginId: string, root = uxpRoot()): string[] {
  const dir = externalDir(root);
  if (!existsSync(dir)) return [];
  // 目录名是 `<pluginId>_<version>`，可能还带 `.disabled` 后缀。
  // 必须用「id + 下划线」前缀匹配，不能只用 id ——
  // com.foo.bar 和 com.foo.barbaz 是两个不同的插件，前缀匹配会误删后者。
  return readdirSync(dir)
    .filter((name) => name === pluginId || name.startsWith(`${pluginId}_`) || name.startsWith(`${pluginId}.`))
    .map((name) => join(dir, name));
}

export interface InstallResult {
  pluginId: string;
  version: string;
  installedPath: string;
  /** 被清理掉的旧版本目录 */
  removedDirs: string[];
  /** 注册表里被替换掉的旧记录数 */
  replacedEntries: number;
  /** 注册表里保留下来的、属于别的插件的记录数 */
  keptOtherEntries: number;
}

/**
 * 安装（或升级）一个 UXP 插件。
 *
 * 升级语义是「干净升级」：同一个 pluginId 的旧版本目录整个删掉，注册表里
 * 同 id 的旧记录全部替换成新的一条。留着旧目录的话，Photoshop 有时会加载到
 * 旧版本，用户升级完发现界面没变，而我们怎么查都查不出问题。
 *
 * 别的插件的记录**一条都不动** —— 那是这个函数存在的首要理由。
 */
export function installPlugin(opts: {
  /** 插件包所在目录（里面有 manifest.json） */
  sourceDir: string;
  root?: string;
  host?: string;
  log?: (line: string) => void;
}): InstallResult {
  const root = opts.root ?? uxpRoot();
  const host = opts.host ?? 'PS';
  const log = opts.log ?? ((): void => undefined);

  const src = resolve(opts.sourceDir);
  const manifest = readManifest(src);
  const pluginId = manifest.id;
  const version = manifest.version;
  const dirName = `${pluginId}_${version}`;
  const target = join(externalDir(root), dirName);

  log(`插件 ${manifest.name ?? pluginId} ${version}`);
  log(`  来源 ${src}`);
  log(`  目标 ${target}`);

  // 1. 清掉这个 id 的所有旧目录（含新目标本身，保证是干净覆盖）
  const removedDirs: string[] = [];
  for (const dir of installedDirsOf(pluginId, root)) {
    try {
      rmSync(dir, { recursive: true, force: true });
      removedDirs.push(dir);
      log(`  已清理旧版本 ${dir}`);
    } catch (e) {
      // 删不掉通常是 Photoshop 正开着占用文件。不能当没事发生 ——
      // 旧目录留着就可能被加载，用户会以为升级没生效。
      throw new Error(`清理旧版本失败（Photoshop 可能正开着，请关闭后重试）：${dir} —— ${String(e)}`);
    }
  }

  // 2. 拷贝新版本
  mkdirSync(target, { recursive: true });
  cpSync(src, target, { recursive: true });
  log(`  已复制插件文件`);

  // 3. 合并注册表：同 id 的旧记录替换掉，别人的原样保留
  const file = registryFile(root, host);
  const reg = readRegistry(file);
  const mine = reg.plugins.filter((p) => p.pluginId === pluginId);
  const others = reg.plugins.filter((p) => p.pluginId !== pluginId);
  const entry: UxpPluginEntry = {
    hostMinVersion: hostMinVersionOf(manifest),
    name: manifest.name ?? pluginId,
    // 注意是 `$localPlugins\External\...` 这种带变量的相对写法，
    // 不是绝对路径 —— 真机上 Adobe 就是这么写的，换成绝对路径 PS 认不出来。
    path: `$localPlugins\\External\\${dirName}`,
    pluginId,
    status: 'enabled',
    type: 'uxp',
    versionString: version
  };
  writeRegistry(file, { plugins: [...others, entry] });
  log(`  已登记到 ${file}（保留了 ${others.length} 个其他插件的记录）`);

  return {
    pluginId,
    version,
    installedPath: target,
    removedDirs,
    replacedEntries: mine.length,
    keptOtherEntries: others.length
  };
}

export interface UninstallResult {
  pluginId: string;
  removedDirs: string[];
  removedEntries: number;
  keptOtherEntries: number;
}

/**
 * 卸载插件：目录删掉、注册表里同 id 的记录删掉，别人的照旧。
 * 找不到也算成功 —— 卸载一个本来就不在的东西，结果和卸载成功没有区别。
 */
export function uninstallPlugin(opts: {
  pluginId: string;
  root?: string;
  host?: string;
  log?: (line: string) => void;
}): UninstallResult {
  const root = opts.root ?? uxpRoot();
  const host = opts.host ?? 'PS';
  const log = opts.log ?? ((): void => undefined);

  const removedDirs: string[] = [];
  for (const dir of installedDirsOf(opts.pluginId, root)) {
    try {
      rmSync(dir, { recursive: true, force: true });
      removedDirs.push(dir);
      log(`  已删除 ${dir}`);
    } catch (e) {
      // 卸载时删不掉就如实说，但不要中断：注册表那一步还是要做完，
      // 否则 PS 会去加载一个已经残缺的目录，报一堆看不懂的错。
      log(`  删除失败（可能 Photoshop 正开着）：${dir} —— ${String(e)}`);
    }
  }

  const file = registryFile(root, host);
  const reg = readRegistry(file);
  const others = reg.plugins.filter((p) => p.pluginId !== opts.pluginId);
  const removedEntries = reg.plugins.length - others.length;
  if (removedEntries > 0) {
    writeRegistry(file, { plugins: others });
    log(`  已从 ${file} 移除 ${removedEntries} 条记录（保留 ${others.length} 条）`);
  }

  return { pluginId: opts.pluginId, removedDirs, removedEntries, keptOtherEntries: others.length };
}
