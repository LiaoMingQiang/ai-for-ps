# AI-for-PS · 电商 AI 工作台

Photoshop UXP 插件: 图层/选区/Mask → AI 任务 → 结果缓存 → Photoshop 安全写回。

**当前版本: 0.9.0 (开发里程碑) — 1.0.0 Release Gate 尚未全部通过 (需 Photoshop 实机 E2E)**

## 架构

```
Photoshop UXP Plugin (apps/uxp-plugin)
  ↓ pairing token (SecureStorage/local settings)
Local Helper (apps/helper — 单文件 exe)
  ├── SQLite (schema v2, 迁移自动备份) / DPAPI 凭据 / Asset Store (sha256+去重)
  ├── Job Engine (18 态状态机, 重启恢复先查远端不重提交)
  ├── Provider Adapters: ComfyUI | OpenAI Compatible | Gemini | 火山方舟 | 阿里百炼 | RunningHub | ModelScope
  ├── Workflow 导入/扫描/Studio/版本 / 依赖中心 / GPU Monitor / Workers / 成本中心
  └── Agent (受控工具 + Plan 批准 + 审计)
```

## 目录

```
ai-for-ps/
├── uxp-plugin/       Photoshop UXP 插件 (Manifest v5 + entrypoints.setup, PS 25.2+)
│   ├── src/entry.js  真实插件入口 (browser 预览兼容)
│   ├── js/ps/        PhotoshopBridge (快照导出/安全写回) + 文档上下文
│   ├── js/core/      comfyui 客户端 / helper-client / jobs / workflows / providers ...
│   └── js/ui/        7 大页 UI (生成/AI编辑/工作流/任务/历史/资产库/设置) — 完整保留
├── helper/           Node.js/TypeScript Helper (Fastify + node:sqlite + ws)
│   ├── src/          config/db/pairing/credentials(gpu)/job-engine/providers/workflow/agent
│   ├── dist-bundle/  AI-for-PS-Helper.exe (Node SEA 单文件) + helper.cjs
│   └── test/         6 个集成测试套件
├── installer/        旧版浏览器预览安装 (保留); 正式安装见 release/
├── release/          交付物: AI-for-PS.ccx / helper/AI-for-PS-Helper.exe / AI-for-PS-Setup.nsi / install-helper.bat / checksums.txt / CHANGELOG.md
├── test/             comfy_stub.py (含 queue/interrupt/WS) / e2e-core.mjs / smoke_ui.py
└── scripts/          make-release.py / verify-ccx.py
```

## 测试 (全部真实执行)

```bash
cd helper && npm run build && npm test
# helper-smoke 61/61 · comfyui.integration 22/22 · openai.integration 9/9
# workflow.integration 28/28 · job-engine.integration 24/24 · cloud.integration 8/8
cd uxp-plugin && npm run lint && npm run validate
cd .. && node test/e2e-core.mjs 18188   # 17/17
python3 test/smoke_ui.py                # 浏览器版冒烟
```

## 运行

```bash
# Helper (开发): cd helper && npm run build && npm start   → http://127.0.0.1:33057
# Helper (发布): release/install-helper.bat (注册自启动 + 启动单文件 exe)
# 插件: Photoshop 中 UXP Developer Tool 加载 uxp-plugin/ 或 release/AI-for-PS.ccx
```

## 安全

- Helper 默认仅监听 127.0.0.1 (局域网模式需显式开启)
- API Key 仅存 Helper (Windows DPAPI); UXP 只保存配对 token
- 写回前校验源文档存在/尺寸/图层; 选区任务按任务时记录的 bounds 原位写回
- AI 成功与写回成功严格区分: 写回失败 → retryable_writeback_failure (结果保留可重试)
- 无 Mock Success; 未配置 Provider 显示 Disabled + 原因

## 已知限制

- 真实 Photoshop E2E (场景 1-15) 未执行 — 需 PS 实机
- .ccx 未签名 (正式分发需 Adobe 签名)
- 云 Provider 适配器协议已测 (mock), 未用真实账户验证
