# REAL_PHOTOSHOP_ACCEPTANCE — PHASE 26 真实 Photoshop 验收清单

> 状态: **PENDING** — 需要真实 Photoshop 2026 (25.x) 人工执行
> 版本: 0.9.0 · 日期: 2026-08-12
> **本清单不接受 Stub 测试替代。每项必须由人在真实 Photoshop 中执行并记录。**

## 前置条件

- [ ] Photoshop 2026 安装并可用（≥ 25.2）
- [ ] Helper 已安装运行（`release/install-helper.bat` 或 `helper/dist-bundle/AI-for-PS-Helper.exe`），health OK
- [ ] ComfyUI 运行于 127.0.0.1:8188（或 Helper 中配置的执行端地址），`/system_stats` 可达
- [ ] UXP Developer Tool 加载 `uxp-plugin/` 或 `release/AI-for-PS.ccx`（开发模式）
- [ ] 插件面板 `aiForPsPanel` 正常显示，状态条显示 Helper 在线

## 执行指引

每项操作前记录：日期 / 操作人 / Photoshop 版本 / Helper 版本 / ComfyUI 版本。
通过 = 勾选 `[x] PASS` 并附证据（截图/图层调板/网络日志片段）。
失败 = 勾选 `[ ] FAIL` 并记录：现象、复现步骤、Helper 日志（`%LOCALAPPDATA%\AI-for-PS\data\` 下）、诊断 ID（UI 错误提示中的 diagnosticId）。

---

## TEST 01 — 当前图层 → Helper → ComfyUI → 结果 → 新智能对象

- [ ] 打开测试 PSD，选中一个普通图层（如产品主体）
- [ ] 生成页选择「当前图层」输入，提交任务
- [ ] 网络日志出现 `POST /v1/jobs`（**不得**出现直接 `POST 8188/prompt`）
- [ ] 任务经 Helper 状态机到 `result_ready`，结果资产出现在 Helper
- [ ] 写回策略「新智能对象」→ 结果作为 Smart Object 图层出现在**源 PSD** 中，命名正确
- [ ] PASS / FAIL

## TEST 02 — 当前选区 → AI → 原 Selection Bounds 原位写回

- [ ] 在 PSD 中建立选区（记录 left/top/right/bottom），选中图层，提交「当前选区」任务
- [ ] 生成完成后写回，结果图层 **bounds == 任务创建时记录的选区 bounds**（±1px）
- [ ] 生成期间**不要改变选区**（验证不依赖当前选区：可在提交后清除选区，写回仍按原 bounds）
- [ ] PASS / FAIL

## TEST 03 — 任务运行期间切换 PSD → 不得写错文档

- [ ] PSD-A 提交任务（运行中），切换到 PSD-B
- [ ] 任务完成后写回 → 结果必须进入 **PSD-A**（validateWritebackTarget 按 sourceDocumentId 校验）
- [ ] PSD-B 不得出现任何 AI 图层
- [ ] PASS / FAIL

## TEST 04 — 运行期间关闭源 PSD → 结果保留 + retryable_writeback_failure

- [ ] PSD-A 提交任务，运行期间关闭 PSD-A
- [ ] AI 完成后：写回失败，状态 = `retryable_writeback_failure`（**结果不丢失**，仍在 Helper Asset Store）
- [ ] UI 显示可「重新写回」，不弹假成功
- [ ] PASS / FAIL

## TEST 05 — 重新打开 PSD → 重新写回成功

- [ ] 承接 TEST 04：重新打开 PSD-A
- [ ] 在任务页对 `retryable_writeback_failure` 任务点「重新写回」
- [ ] 结果成功写入 PSD-A（智能对象），任务状态 → `completed`
- [ ] PASS / FAIL

## TEST 06 — Photoshop 崩溃/重启 → Job 恢复不重复提交

- [ ] 提交任务（运行中），强制结束 Photoshop 进程
- [ ] 重新打开 Photoshop + 插件
- [ ] 插件启动恢复任务：经 Helper 查询远端状态（**不得重新 submit**）
- [ ] 远端已完成 → 下载结果 → 可写回；结果不重复生成
- [ ] PASS / FAIL

## TEST 07 — Helper 重启 → remoteJobId 恢复

- [ ] 提交任务（运行中），重启 Helper 进程
- [ ] Helper 启动恢复：有 remoteJobId 的任务先查远端（/history/{id}）
- [ ] running → 恢复监控；completed → 下载结果；不得无条件重新提交
- [ ] PASS / FAIL

## TEST 08 — 缺 Custom Node → 提交前 Dependency Center 阻止

- [ ] 导入一个依赖缺失节点的 Workflow（如自定义节点不在 ComfyUI 中）
- [ ] 依赖中心显示 `✕ missing` 对应节点
- [ ] 提交任务被阻止或明确报 `COMFY_NODE_MISSING`（不得进入执行）
- [ ] PASS / FAIL

## TEST 09 — ComfyUI OOM → COMFY_OOM + 修复建议

- [ ] （可构造：提交超大分辨率或占用显存的任务）触发 ComfyUI 显存不足
- [ ] 任务状态 `provider_failure`，错误码含 OOM/显存信息，UI 显示修复建议
- [ ] PASS / FAIL

## TEST 10 — Provider API Key 错误 → PROVIDER_AUTH_FAILED

- [ ] 在 Helper 中为 OpenAI Compatible/Gemini 配置错误 Key
- [ ] 测试连接 / 提交任务 → UI 显示 `PROVIDER_AUTH_FAILED`（不得只显示「请求失败」）
- [ ] PASS / FAIL

## TEST 11 — 真实 Workflow Import 全字段识别

- [ ] 导入真实 ComfyUI Workflow JSON（API 格式）
- [ ] 必须识别: Prompt / Model(Checkpoint) / Sampler / Scheduler / Seed / Steps / CFG / Denoise / Width / Height / Image / Mask / LoRA
- [ ] 输出节点检测（SaveImage）正确
- [ ] PASS / FAIL

## TEST 12 — Studio Binding 修改 Denoise → 提交的 JSON 真变化

- [ ] 导入含 KSampler denoise=0.25 的 Workflow
- [ ] Studio 中把 Denoise 绑定值改为 0.42 并保存
- [ ] 提交任务 → ComfyUI 收到的 workflow JSON 中对应节点 `inputs.denoise === 0.42`
- [ ] PASS / FAIL

## TEST 13 — 取消 Queued Job → 不 interrupt 其他任务

- [ ] 两个任务排队（ComfyUI 慢时），取消排队中的任务
- [ ] 运行中的任务不受影响（stub/真实 ComfyUI 队列中 running 任务继续）
- [ ] PASS / FAIL

## TEST 14 — 取消 Running Job → 只中断当前 prompt

- [ ] 任务运行中取消 → Helper 确认 `prompt_id` 匹配后才 `/interrupt`
- [ ] 其他任务不受影响
- [ ] PASS / FAIL

## TEST 15 — 两个 PSD 同时打开 → Project/History 不串文档

- [ ] PSD-A 与 PSD-B 同时打开，分别提交任务
- [ ] 历史页按项目隔离（A 的历史不出现在 B 的项目上下文）
- [ ] Project Context 随活动文档切换（lastWorkflow/lastProvider 各自独立）
- [ ] PASS / FAIL

---

## 汇总

| Test | 结果 | 备注 |
|---|---|---|
| 01 | ☐ | |
| 02 | ☐ | |
| 03 | ☐ | |
| 04 | ☐ | |
| 05 | ☐ | |
| 06 | ☐ | |
| 07 | ☐ | |
| 08 | ☐ | |
| 09 | ☐ | |
| 10 | ☐ | |
| 11 | ☐ | |
| 12 | ☐ | |
| 13 | ☐ | |
| 14 | ☐ | |
| 15 | ☐ | |

**Release Gate 结论**（全部 PASS 后才允许 1.0.0）:
- [ ] 15/15 PASS → 可进入 1.0.0 评审
- [ ] 存在 FAIL → 记录 Bug，修复后**增加回归测试**，重跑本清单
