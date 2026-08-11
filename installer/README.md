# AI-for-PS 一键安装包

把 `uxp-plugin/` 浏览器演示封装为免依赖的 Windows 安装包：
安装后生成「AI-for-PS 工作台」桌面/开始菜单快捷方式，
通过内置本地服务（仅 127.0.0.1）启动，可正常使用 localStorage 等浏览器特性。

## 文件说明

| 文件 | 作用 |
|---|---|
| `install.bat` | 一键安装（复制应用 + 快捷方式 + 卸载入口注册） |
| `uninstall.bat` | 完整卸载（停服务/旧 Helper 进程 → 删文件/快捷方式/注册表） |
| `run.bat` | 启动器：后台起服务 + 打开浏览器 |
| `server.ps1` | 零依赖静态服务器（.NET HttpListener，支持中文 MIME） |
| `build.cmd` | 把 `../uxp-plugin` 打包为自包含的 `app\` |
| `installer.nsi` | 【可选】安装 NSIS 3 后编译，可生成真正的 `setup.exe` |

## 使用

1. 运行 `build.cmd` 生成自包含 `app\`（或保持仓库结构，installer 会自动找 `../uxp-plugin`）
2. 双击 `install.bat`，按提示完成安装
3. 桌面双击「AI-for-PS 工作台」或从开始菜单启动
4. 卸载：开始菜单「卸载 AI-for-PS」，或控制面板 → 应用和功能

## 参数

- `install.bat [目录]` 自定义安装目录（默认 `%LOCALAPPDATA%\AI-for-PS`）
- `install.bat xxx -noshortcuts` 跳过快捷方式（静默安装/测试）
- `uninstall.bat [目录]` 指定卸载目录
- 服务端口 8754，被占用时自动递增

> 说明：本安装包运行的是浏览器模拟版（mock）前端；真实 UXP/Helper 集成逻辑
> 见仓库根 README，封装真实插件时替换 `app/` 内容即可，安装器无需改动。