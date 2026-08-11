# AI for PS — 项目交接文档

> 交接日期：2026-08-11 · 当前版本：**0.9.0**（开发里程碑，**未达 1.0.0 Release Gate**）
> 仓库：`C:\Users\A\Documents\Default Project\ai-for-ps`（git，14 个提交，工作区干净）

---

## 1. 项目是什么

Photoshop UXP 正式插件：**Photoshop 原生设计环境 + AI Workflow Operating Layer**。
用户在当前图层 / 选区 / Mask 上发起 AI 任务 → 本地 Helper 调度 Provider → 结果缓存 → 安全写回 Photoshop（智能对象/像素层/选区原位）。

不是"PS 里嵌一个 ComfyUI 网页"，不是无限画布。

## 2. 最终架构（已实现）

```
apps/
├── uxp-plugin/    Photoshop UXP 插件（Manifest v5 + entrypoints.setup，PS 25.2+）
│   ├── src/entry.js         真实插件入口（浏览器预览兼容）
│   ├── js/ps/bridge.js      真实 PhotoshopBridge（快照导出 PNG / 安全写回）
│   ├── js/core/             comfyui 客户端 / helper-client / jobs / workflows / providers
│   └── js/ui/               7 大页完整 UI（生成/AI编辑/工作流/任务/历史/资产库/设置）
└── helper/        Node.js/TypeScript 本地 Helper（Fastify + node:sqlite + ws）
    ├── src/db.ts            SQLite schema v2 + 版本化迁移（备份→迁移→失败回滚）
    ├── src/credentials.ts   API Key 安全存储（Windows DPAPI；macOS/Linux 文件加密 fallback）
    ├── src/job-engine.ts    Job Engine（18 态状态机 + 重启恢复 + 并发闸 + 安全取消）
    ├── src/providers/       ProviderAdapter SDK + 7 个 Provider
    ├── src/workflow/        导入/扫描/Studio/版本/依赖
    ├── src/agent/           Agent（受控工具 + Plan 批准 + 审计）
    └── dist-bundle/         AI-for-PS-Helper.exe（Node SEA 单文件 91.7MB）
```

数据流：`UXP 只带 providerId 提交任务 → Helper 决定 Provider 实现 → 结果资产持久化 → UXP 写回前重新校验源文档`

## 3. 已完成工作（按阶段，全部有真实测试）

| 阶段 | 内容 | 测试结果 |
|---|---|---|
| PHASE 0 | 仓库审计、备份 `backup/pre-repair-20260811-1333/`、git 基线、测试基线 | e2e-core 17/17 |
| PHASE 1 | 真实 UXP 入口：manifest v5 修正（PS 25.2+、权限最小化）、entrypoints.setup、统一 bootstrap 链、修复 panel ID 不一致 | lint OK / validate ALL PASS / smoke_ui PASS |
| PHASE 2 | 真实 PhotoshopBridge：duplicate→隐藏→mergeVisible→crop→saveAs.png（executeAsModal 内）；选区原位写回（按任务时 bounds）；写回前 validateWritebackTarget（文档存在/尺寸/图层）；修复 Selection.bounds 类型错误 | lint / validate / smoke PASS |
| PHASE 3 | Helper 后端：Fastify + node:sqlite + WS、配对 token、Bearer 认证、单实例锁、GPU 真实读取（RTX 4070 Ti SUPER 16GB 实测）、7 Provider 注册表 | helper-smoke 27/27 |
| PHASE 4 | SQLite 全 schema（20 表）+ 迁移系统；DPAPI 凭据（roundtrip 实测、无明文泄漏）；Project upsert；multipart Asset Store（sha256/去重/sharp→纯 JS 头解析/快照关联） | helper-smoke 37/37 |
| PHASE 5-7 | ProviderAdapter SDK + Manager；ComfyUI adapter（官方 API、官方 progress 结构、queued→WS delete / running→确认后 interrupt、recover 不重提交）；OpenAI Compatible（401→AUTH_FAILED、429→RATE_LIMIT、诚实不支持取消） | comfyui 22/22 · openai 9/9 |
| PHASE 8 | Workflow 导入/扫描/Studio/版本：API+UI 双格式、全字段识别（Prompt/Seed/Steps/CFG/Denoise/Width/Height/Image/Mask/LoRA/Sampler/Scheduler）、版本不覆盖（1.0.0→1.1.0 双版本+hash）、依赖 vs ComfyUI 实检、坏 JSON/无输出明确报错 | workflow 28/28 |
| PHASE 9 | JobEngine：18 态状态机 + job_events 全记录；恢复先查远端**不重新提交**（stub history 无重复执行实测）；取消 queued 不影响 running；写回成败分离（retryable_writeback_failure 结果保留）；并发闸（修复计数泄漏 bug） | job-engine 24/24 |
| PHASE 10-11 | Dependency Center（ComfyUI 版本/节点/模型/GPU 真实扫描）；Project Context（state/历史隔离）；生成血缘 lineage | helper-smoke 51/51 |
| PHASE 12 | 云 Provider：Gemini（generateContent）、RunningHub（task API 轮询）、火山方舟/百炼/ModelScope（OpenAI 兼容复用） | cloud 8/8 |
| PHASE 13 | Workers 注册（本地 worker 自动同步 GPU/队列/延迟）；成本中心（本地记 GPU 时长，云费用不虚构） | helper-smoke 61/61 |
| PHASE 14 | Agent：受控 Tool Registry（8 工具）、Plan 带 Provider/耗时/云上传/成本/PSD 修改方式、未批准→403、PS 工具委托 UXP 不伪造、全量审计（schema v2 迁移实测） | helper-smoke 61/61 |
| PHASE 15 | 打包：**AI-for-PS-Helper.exe（Node SEA 单文件，实测运行：health/pair/providers/GPU 全通）**、AI-for-PS.ccx（zip 校验 38 entries 无坏条目）、NSIS 安装器（Helper+自启动）、install-helper.bat、checksums.txt（5 文件 SHA-256 自洽）、CHANGELOG | ad-hoc 验证 ALL PASS |

## 4. 测试体系（当前全绿，真实执行输出）

```bash
# Helper 侧（cd helper）
npm run build          # tsc typecheck PASS
npm test               # helper-smoke 61/61 · comfyui 22/22 · openai 9/9
                       # workflow 28/28 · job-engine 24/24 · cloud 8/8
# 插件侧（cd uxp-plugin）
npm run lint           # 27 文件 LINT-OK
npm run validate       # manifest/入口 ID 一致性 ALL PASS
# 仓库级
node test/e2e-core.mjs 18188   # 17/17（ComfyUI 桩）
python3 test/smoke_ui.py       # 浏览器版 CDP 冒烟 ALL PASS
```

依赖的外部服务：`test/comfy_stub.py`（18188 旧桩 / 18189 新桩含 queue/interrupt/WS）、真实 ComfyUI @8188 在线、nvidia-smi 可用。

## 5. 未完成工作（诚实清单）

| 项 | 状态 | 说明 |
|---|---|---|
| **PHASE 16 真实 Photoshop E2E** | ❌ 未做 | 场景 1-15 需 Photoshop 实机 + 用户配合（UXP Developer Tool 加载、人工确认写回）。**当前最大缺口** |
| .ccx 签名 | ❌ 未做 | 正式分发需 Adobe 签名（未签名仅限开发模式加载） |
| 云 Provider 真实账户验证 | ❌ 未做 | Gemini/火山/百炼/RunningHub/ModelScope 协议已 mock 测试，未用真实 API Key 验证 |
| NSIS 编译 AI-for-PS-Setup.exe | ⚠️ 待做 | `AI-for-PS-Setup.nsi` 已写好，需 makensis 编译（本机未装 NSIS） |
| 更新/回滚机制（规则四十一） | ⚠️ 部分 | DB 迁移备份/回滚已实现；Helper/插件自动更新下载未实现 |
| GPU 智能并发（pauseWhenVramAbove/autoResume） | ⚠️ 部分 | 基础并发闸已实现；VRAM 阈值暂停未实现 |
| Workflow Package（.workflow 目录格式） | ⚠️ 部分 | 字段/绑定/依赖已入库；manifest.json 包格式未做 |
| 团队/SDK 页（UI 已有） | ⚠️ UI 保留 | 后端真实化未做 |
| 浏览器专用 API 清理（规则三十五） | ⚠️ 部分 | 文件选择等仍需改 UXP localFileSystem |
| 设置持久化分层（UXP local vs Helper） | ⚠️ 部分 | 架构已定，UXP 侧迁移未完成 |
| UXP 侧 jobs.js 全面切 Helper 驱动 | ⚠️ 部分 | Helper 侧完整；UXP 直连 ComfyUI 路径仍是浏览器预览模式 |

## 6. 1.0.0 Release Gate 核对（规则五十一）

已满足：Helper 自动启动（install-helper.bat+自启动注册）✓、自动配对（/v1/pair）✓、当前图层/选区读取（bridge 实现）✓、ComfyUI 真实生成（adapter+E2E 桩验证）✓、OpenAI Compatible 真实生成（mock 验证）✓、Workflow JSON 真实导入 ✓、参数真实绑定 ✓、Job SQLite 持久化 ✓、重启恢复 ✓、结果持久缓存 ✓、智能对象写回实现 ✓、选区原位写回实现 ✓、切文档不写错（validateWritebackTarget）✓、PSD 关闭结果不丢失（retryable_writeback_failure）✓、API Key 安全存储 ✓、依赖中心真实数据 ✓、无 Mock Success ✓、npm test/typecheck/lint/build PASS ✓

**未满足（禁止标 1.0.0）**：✗ Photoshop 中正式加载验证 · ✗ 重启后插件仍存在验证 · ✗ Windows+Photoshop 实机 E2E（场景 1-15）· ✗ Retry Writeback 实机验证 · ✗ 项目历史实机验证

## 7. 关键路径索引

```
备份:              backup/pre-repair-20260811-1333/
插件源码:          uxp-plugin/  (入口 src/entry.js, 桥 js/ps/bridge.js, 主链 js/main.js)
Helper 源码:       helper/src/  (入口 index.ts, 服务 server.ts, 引擎 job-engine.ts)
Helper 测试:       helper/test/  (6 套集成测试, 自托管进程)
打包产物:          helper/dist-bundle/ (exe + helper.cjs + scripts/dpapi.ps1)
交付物:            release/  (ccx/exe/nsi/bat/checksums/CHANGELOG/README)
ComfyUI 测试桩:    test/comfy_stub.py (18188 旧 / 18189 新)
打包脚本:          scripts/make-release.py, scripts/verify-ccx.py
UI 冒烟:           test/smoke_ui.py (Chrome CDP)
```

## 8. 已知限制与风险

1. **UXP 写回未实机验证**：bridge 代码按 Adobe 官方文档实现（API 已逐一核对），但 placeEvent/transform 的实际行为需 PS 实机确认——这是 1.0.0 前的硬门槛
2. 浏览器预览（dev-preview）仍直连 ComfyUI；正式路径必须走 Helper（UXP 侧 jobs.js 切换待完成）
3. DPAPI 依赖 PowerShell + .NET ProtectedData（Windows 标配）；Linux/macOS fallback 强度低于 Keychain
4. 同步型云 Provider（OpenAI/Gemini 等）Helper 重启后任务状态不可恢复——已诚实上报 JOB_LOST，需用户重新提交
5. RunningHub 无官方取消 API——取消返回明确不支持
6. .ccx 未签名，安装需开发模式
7. installer/ 目录仍是旧版浏览器工作台安装器（已保留不破坏；正式安装走 release/）

## 9. 下一步行动清单（按优先级）

1. **PHASE 16**：用户配合在 Photoshop 2026 中加载 uxp-plugin/（UXP Developer Tool）→ 跑场景 1-15 E2E → 修复实机发现的问题
2. UXP 侧 jobs.js 切换 Helper 驱动（移除直连 ComfyUI 作为正式路径）
3. 清理浏览器专用 API（文件选择改 UXP localFileSystem）
4. 云 Provider 真实账户验证（需要用户 API Key，存 Helper DPAPI）
5. NSIS 编译 Setup.exe（装 makensis 或换打包工具）
6. 全部 Release Gate 满足后 → 版本 1.0.0 + 最终验收报告（规则五十三 17 项）

## 10. 版本决策

当前 **0.9.0**（规则四十二：P0 能力未全通前不标 1.0.0）。所有 UI 功能入口完整保留（7 大导航页零删除）；未配置 Provider 显示 Disabled+原因，无任何 Mock Success。
