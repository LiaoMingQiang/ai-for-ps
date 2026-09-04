# AI for PS

在 Photoshop 里直接调度 AI 生图的电商视觉工作台。设计师不离开 Photoshop，
就能把当前图层或选区送进本地 ComfyUI 或云端模型，拿回结果并安全写回画布。

**项目全部在 [`psai/`](psai/) 下**，那是一个 npm workspace 单仓：

| 位置 | 是什么 |
| --- | --- |
| [`psai/packages/plugin`](psai/packages/plugin) | Photoshop UXP 插件，只跟本机 Helper 说话，不直连任何 AI 服务 |
| [`psai/packages/helper`](psai/packages/helper) | 本机 Helper：Fastify + node:sqlite + ws，作业引擎 / 资产库 / 凭据 / Provider |
| [`psai/packages/shared`](psai/packages/shared) | 两端共用的协议与类型 |

从 [`psai/README.md`](psai/README.md) 开始读。安装说明见
[`psai/docs/INSTALL.md`](psai/docs/INSTALL.md)，完整需求见
[`psai/docs/PRD.md`](psai/docs/PRD.md)。

## 当前版本

**0.9.7**（标签 `v0.9.7`）。

自动化套件 660 条，连续两轮全绿，`npm run check` 通过。

**验过的**：两条云端链路都对着 RunningHub 真跑过，走的是实际发货的适配器代码 ——
AI 应用 165 秒出 1536×1536，ComfyUI 工作流 425 秒出 8192×8192。两次都核对了
出来的是输入图本身，而不是工作流作者预置的示例图（那正是参数没落位时会发生的、
带着「成功」回来的假结果）。

**没验过的**：真机 Photoshop 验收**一项都没做** ——
[`psai/docs/PHOTOSHOP_ACCEPTANCE.md`](psai/docs/PHOTOSHOP_ACCEPTANCE.md)
里每个勾选框都是空的。选区遮罩取值、图层捕获、写回这三组只能在装了
Photoshop 的机器上验，替身再忠实也不是 Photoshop。另外测试里有一个间歇性的
`bad port` 故障仍未定位，它只影响测试环境，不影响装出来的产品。

## 关于旧版本

仓库根目录原先还有一套 0.9.0 时期的实现（`helper/`、`uxp-plugin/`、
`installer/`、`test/`、`scripts/`）。它已经被现在的 `psai/` 完全取代，
不再随仓库分发；需要的话在 `v0.9.2` 之前的历史里能找到。
