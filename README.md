# AI-for-PS · 电商 AI 工作台

Photoshop UXP 插件原型:产品图 → AI 生成 → 比较 → 写回 Photoshop 闭环。
当前浏览器版已从演示数据全面切换为**真实链路**:真实连接 ComfyUI、真实上传/生成/进度/下载,不再有任何假数据与模拟进度;ComfyUI 不可达时任务真实失败并保留原因。

## 输出文件与位置

| 用途 | 路径 |
|---|---|
| 源码(实际开发层) | `uxp-plugin\` |
| 打包副本(安装内容) | `installer\app\`(`build.cmd` 从 `uxp-plugin` 同步,改码后必须重建) |
| 一键安装目的地 | `%LOCALAPPDATA%\AI-for-PS\`(`app\` + `server.ps1` + `run.bat` + `uninstall.bat`) |
| NSIS 安装包 | `installer.nsi` 编译产出 `AI-for-PS-Setup.exe`(需 makensis) |
| 快捷方式 | 桌面「AI-for-PS 工作台」+ 开始菜单 `Programs\AI-for-PS` |
| 卸载注册项 | `HKCU\...\Uninstall\AI-for-PS` |
| 本地服务端口 | 默认 `http://127.0.0.1:8754`,被占用自动 +1;实际端口写 `%TEMP%\a4p-port.txt` |
| 生成结果 (PNG) | ComfyUI 服务端 `output\aiforps_*.png`(SaveImage 节点);浏览器按需经 `/view` 拉取,本地不落盘 |
| 输入图片 | ComfyUI 服务端 `input\`(真实 POST 上传) |
| 任务/结果元数据 | 浏览器 `localStorage`:`aiforps.jobs.v1`(仅文件名等元数据,不含图片) |
| 导出 | 结果卡「写回/导出」→ 系统保存对话框另存 PNG |

## 目录结构

```
ai-for-ps/
├── uxp-plugin/              实际开发层 (浏览器预览 = 真实链路)
│   ├── index.html           预览入口 (经本地 server.ps1 访问)
│   ├── manifest.json        UXP 清单 (真实封装时启用)
│   ├── helper/index.js      宿主桥接层 (UXP/CEP 兼容)
│   └── js/
│       ├── i18n.js          A4P.t 文案表
│       ├── utils.js         工具 (无 newResultThumb 等伪造物)
│       ├── state.js         全局状态 store (事件总线 + history,无假种子数据)
│       ├── core/
│       │   ├── settings.js  持久化设置 (demoMode 默认 false;comfyuiUrl 默认 http://127.0.0.1:8188)
│       │   ├── comfyui.js   真实 ComfyUI 客户端 (见下)
│       │   ├── providers.js Provider 能力矩阵 (comfyui 模型列表实时检测)
│       │   ├── jobs.js      真实任务管线 (见下)
│       │   ├── helper-client.js / workflows.js / assets.js / agent.js
│       ├── ps/              context.js / bridge.js (UXP 写回协议,真实封装时启用)
│       └── ui/              router / pages (generate / edit / tasks / history / assets / settings / workflows)
├── installer/                一键安装与本地服务
│   ├── app/                 打包副本
│   ├── build.cmd            uxp-plugin → app 同步
│   ├── install.bat / run.bat / uninstall.bat / server.ps1
│   ├── installer.nsi        NSIS 安装器脚本 (可选真 setup.exe)
│   └── README.md
└── test/                     真实管线测试
    ├── comfy_stub.py        纯 aiohttp ComfyUI 桩 (system_stats/object_info/prompt/upload/history/view,生成真实 PNG,带 CORS,WS 关闭→轮询回退)
    └── e2e-core.mjs         e2e:直接加载生产 comfyui.js 驱动管线,17 项断言
```

## 真实链路

**Core ComfyUI 客户端 (`js/core/comfyui.js`)**
- `ping()` → `GET /system_stats`(版本/VRAM,缓存 `lastState`)
- `listCheckpoints()` → `GET /object_info` 读 `CheckpointLoaderSimple.required.ckpt_name`
- `uploadImage(blob,name)` → `POST /upload/image`(multipart)
- `buildWorkflow(p)` → 真实 ComfyUI API JSON(t2i:EmptyLatentImage; i2i:LoadImage→VAEEncode; 均含 KSampler/VAEDecode/SaveImage)
- `submitWorkflow(wf)` → `POST /prompt`;400+node_errors 解析为 `COMFY_NODE_ERROR`
- `connectProgress(promptId)` → WS 优先,失败/无 WS 自动回退 `GET /history/{id}` 轮询;error/cancelled/timeout 均真实上报
- `downloadImage(img)` → `GET /view`,校验 PNG 魔数,返回 bytes/blob/dataURL

**任务管线 (`js/core/jobs.js`)**
`VALIDATING → SNAPSHOTTING/UPLOADING → QUEUED → RUNNING → DOWNLOADING → VERIFYING → READY_FOR_WRITEBACK → (writeback) → SUCCEEDED`,以及真实 `FAILED / CANCELLED / WRITEBACK_FAILED`;含重启恢复(`RECOVERING`,结果从 ComfyUI 重新拉缩略图)。

**页面行为**
- 生成页:Checkpoint/模型下拉实时检测;图像输入真实文件上传(文生图/图生图);执行端状态、VRAM 来自 `/system_stats`;比较区展示真实任务结果,空态不再伪造
- 设置页:ComfyUI 地址可配置 + 真实「测试连接」
- 素材库:真实文件上传(会话内);任务中心/历史:真实任务数据与空态

## 测试与验证

```
python test\comfy_stub.py --port 18188     # 启动桩 (无依赖,仅 aiohttp;输出真实 PNG)
node test\e2e-core.mjs 18188               # 驱动生产 comfyui.js 跑真实管线
```

- e2e 17/17 断言通过:ping / checkpoint 列表 / 上传 / t2i+i2i 工作流提交 / 轮询回退进度 / 真实 PNG 下载(魔数校验) / 坏节点 `COMFY_NODE_ERROR`
- 浏览器渲染验证(Edge headless + 桩 @8188):启动无 JS 错误;模型下拉出现真实 checkpoint;状态芯片/VRAM 数据来自 `/system_stats`
- e2e 曾捕获并修复两个生产缺陷:`setEndpoint` 在 `A4P.comfyui` 未创建时赋值(模块加载即崩);node_errors 解析被嵌套 catch 吞掉

## 运行

```
installer\run.bat            # 或 powershell -File installer\server.ps1
# 打开 http://127.0.0.1:8754/ (被占自动 +1,见 %TEMP%\a4p-port.txt)
# 浏览器版直接连 http://127.0.0.1:8188 的真实 ComfyUI (需 --enable-cors-headers)
```

## 已知遗留事项

- `%LOCALAPPDATA%\AI-for-PS\` 存在旧安装副本,正在占用 8754 并有旧 helper 进程在跑(PID 见任务管理器);新包发布前建议清理
- 真实 UXP 封装尚未做:浏览器版为真实链路预览;`ps/bridge.js` 的 `executeAsModal` 与写回仍为 stub,需在 Photoshop 2026 中封装验证
- `installer\install.bat` 文案仍含 "mock preview" 字样,待更新
- 深度编辑页(局部重绘/扩图/高清)与项目工作流整线运行需 UXP 快照/蒙版,浏览器版明确提示不可用

## 设计约定

- 全局命名空间 `A4P`;ES5 + IIFE(UXP 约束)
- 状态变更走 `A4P.store.emit / on`
- 图像输入采用冻结快照(snapshotId);写回前校验 `sourceDocumentId`(禁止跨文档自动写回)
- 默认输出策略:新智能对象(非破坏),`saveOnly` 兜底