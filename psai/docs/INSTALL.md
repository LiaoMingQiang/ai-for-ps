# 安装与卸载

## 给使用者

1. 下载 `AI-for-PS-Setup-<版本>.exe`
2. 双击运行
3. 按向导点「下一步」装完
4. 打开 Photoshop
5. 菜单「增效工具 → AI for PS」

不需要 UXP Developer Tool，不需要 Creative Cloud 桌面端，不需要手工拷文件，
也不需要管理员权限。

**Photoshop 正开着的话，请先退出再装** —— 安装要替换插件文件，Photoshop 开着时
文件被占用，换不了。安装器检测到会提示你。装完之后打开 Photoshop 就能看到面板。

**SmartScreen 提示「未知发布者」**：安装包还没有做代码签名，Windows 会拦一下。
点「更多信息 → 仍要运行」即可。这个提示要消除得买代码签名证书，见下面的「已知限制」。

## 装了些什么

| 位置 | 内容 | 卸载时 |
| --- | --- | --- |
| `%LOCALAPPDATA%\Programs\AIforPS` | Helper 程序、内置工作流、插件包副本 | 删除 |
| `%APPDATA%\Adobe\UXP\Plugins\External\com.aiforps.psai_<版本>` | Photoshop 插件本体 | 删除 |
| `%APPDATA%\Adobe\UXP\PluginsInfo\v1\PS.json` | 插件注册记录（**只增删自己那一条**） | 只删自己那条 |
| `%LOCALAPPDATA%\AIforPS` | 任务历史、生成结果、日志、API Key（DPAPI 加密） | **保留** |
| 注册表 `HKCU\...\Run\AIforPSHelper` | 开机自启 | 删除 |
| 注册表 `HKCU\...\Uninstall\AIforPS` | 控制面板卸载入口 | 删除 |
| 开始菜单「AI for PS」 | 三个快捷方式 | 删除 |

Helper 是一个单文件 exe，Node 运行时打包在里面 —— 目标机器不需要装 Node。

## 卸载

控制面板 →「程序和功能」→「AI for PS」→ 卸载。
也可以运行开始菜单里的「卸载 AI for PS」。

**任务历史与生成结果不会被删除**，留在 `%LOCALAPPDATA%\AIforPS`。
卸载一个插件顺手删掉几个月的生成结果是不可挽回的 ——
想删的人自己能删，删错的人找不回来。要彻底清除请手动删除该目录。

## 升级

直接运行新版本的安装器。它会先把旧版本干净卸掉再装新的：
旧的插件目录、旧的 Helper、早期版本留下的文件都会清掉，
用户数据原样保留。不需要先手动卸载。

## 出问题时

两份日志，出问题时把它们发过来：

- `%LOCALAPPDATA%\Programs\AIforPS\install.log` —— 安装过程每一步（UTF-16LE）
- `%LOCALAPPDATA%\AIforPS\logs\plugin-install.log` —— 插件登记的详细过程（UTF-8）

Helper 自己的运行日志在 `%LOCALAPPDATA%\AIforPS\logs\helper-<日期>.log`。

常见情况：

- **装完 Photoshop 里看不到面板** —— Photoshop 需要重启一次。UXP 只在启动时读插件注册表。
- **面板显示「Helper 没有连上」** —— Helper 没在跑。开始菜单里点「启动 Helper」，
  或者重启一次机器（安装器已经配了开机自启）。
- **安装器报「插件登记失败」** —— 多半是 Photoshop 还开着占用文件。
  完全退出 Photoshop（检查任务管理器里没有 Photoshop.exe）再装一次。

## 静默安装 / 批量部署

```
AI-for-PS-Setup-<版本>.exe /S
```

静默模式跳过 Photoshop 运行检查，直接安装 —— 批量部署时请自行确保 Photoshop 已退出。

静默卸载**必须带 `_?=`**：

```
"%LOCALAPPDATA%\Programs\AIforPS\Uninstall.exe" /S _?=%LOCALAPPDATA%\Programs\AIforPS
```

不带 `_?=` 的话，NSIS 会把卸载器拷到临时目录再重新执行，那份进程里的 `$INSTDIR`
指向临时目录 —— 结果是"卸载成功"（退出码 0）但真正的安装目录一个文件都没动。
注册表里的 `QuietUninstallString` 已经带上了 `_?=`，直接用它即可。

## 从源码打包

```
cd psai
npm install
node tools/make-release.mjs
```

产物在 `psai/release/`：

- `AI-for-PS-Setup-<版本>.exe` —— 交付给用户的安装包
- `helper/AI-for-PS-Helper.exe` —— Helper 单文件 exe
- `plugin/` —— 插件目录（安装器打进包里的就是它）
- `AI-for-PS.ccx` —— 备用的 Creative Cloud 安装包，正常流程用不到
- `checksums.txt` —— 所有产物的 SHA-256

打包需要本机装有 [NSIS 3](https://nsis.sourceforge.io/)（`makensis.exe`）。
没装的话其余产物照常产出，只有 Setup.exe 这一步会明确报失败，不会假装成功。

## 已知限制

- **没有代码签名**。安装包和 Helper 都未签名，SmartScreen 会提示未知发布者。
  另外 Helper 是用 Node SEA 打的，注入过程会让 node.exe 原本的签名失效 ——
  真要签，得在打包之后对成品 exe 重新签一次。
- **没有在全新的干净 Windows 虚拟机上验证过**。已验证的是：全新安装、
  升级覆盖、静默安装、静默卸载、卸载残留检查，以及"机器上已有别的 UXP 插件"
  这个场景（我们的安装/卸载全程没有动它）。"从没装过任何 Photoshop 插件的机器"
  只有单元测试覆盖（临时目录模拟无注册表的情况），没有真机跑过。
- **只支持 Windows**。API Key 用 DPAPI 加密，安装器是 NSIS。
