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

**0.9.18**（标签 `v0.9.18`）。

自动化套件 705 条，连续三轮全绿，`npm run check` 通过。

### 验过的

两条云端链路都对着 RunningHub 真跑过，走的是**实际发货的适配器代码**：

| 类型 | 耗时 | 结果 |
| --- | --- | --- |
| AI 应用 | 165 秒 | 1024×1024 → 1536×1536 |
| ComfyUI 工作流 | 425 秒 | 1024×1024 → 8192×8192 |

两次都核对了**出来的是输入图本身**，而不是工作流作者预置的示例图 ——
后者正是参数没落位时会发生的、带着「成功」回来的假结果，也是这套代码里
好几道闸门专门在防的东西。

### 没验过 / 没解决的

- **真机 Photoshop 验收一项都没做**。
  [`psai/docs/PHOTOSHOP_ACCEPTANCE.md`](psai/docs/PHOTOSHOP_ACCEPTANCE.md)
  里每个勾选框都是空的。选区遮罩取值、图层捕获、写回这三组只能在装了
  Photoshop 的机器上验 —— 替身再忠实也不是 Photoshop。
- **LiblibAI 云端工作流跑不通**。平台自己回
  `{"code":200000,"msg":"内部服务错误"}`，卡点在平台侧，本机改不动。
  RunningHub 那两条不受影响。
- **UXP 认不认 `maxlength` 未经真机确认**。输入框的 256 字符上限是真的
  （面板上的字数计数器停在 256 就是证据），解开的做法只在替身上验过，
  而那个替身的 256 行为是照着现象写的、不是从真机测出来的。
- **一处原因不明**：`endpointOnly()` 用正则替换时不生效 —— 同一个式子在
  函数外手工跑能用，放进函数里就不行，源码 / 编译产物 / 清理重建全核对过。
  换成不用正则的写法才对。行为有 6 条用例钉住，但**没查出为什么**。

## 关于旧版本

仓库根目录原先还有一套 0.9.0 时期的实现（`helper/`、`uxp-plugin/`、
`installer/`、`test/`、`scripts/`）。它已经被现在的 `psai/` 完全取代，
不再随仓库分发；需要的话在 `v0.9.2` 之前的历史里能找到。
