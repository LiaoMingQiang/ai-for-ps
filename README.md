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

**0.9.2**（标签 `v0.9.2`）。

自动化套件 604 条，连续两轮全绿，`npm run check` 通过。但**真机 Photoshop
验收一项都没做** —— [`psai/docs/PHOTOSHOP_ACCEPTANCE.md`](psai/docs/PHOTOSHOP_ACCEPTANCE.md)
里每个勾选框都是空的。选区遮罩取值、图层捕获、写回这三组只能在装了
Photoshop 的机器上验，替身再忠实也不是 Photoshop。0.9.2 的安装包也还没在
任何一台干净机器上装过。

## 关于旧版本

仓库根目录原先还有一套 0.9.0 时期的实现（`helper/`、`uxp-plugin/`、
`installer/`、`test/`、`scripts/`）。它已经被现在的 `psai/` 完全取代，
不再随仓库分发；需要的话在 `v0.9.2` 之前的历史里能找到。
