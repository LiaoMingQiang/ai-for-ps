# AI for PS

在 Photoshop 里直接调度 AI 生图的电商视觉工作台。设计师不离开 Photoshop，
就能把当前图层或选区送进本地 ComfyUI 或云端模型，拿回结果并安全写回画布。

- 完整需求：[docs/PRD.md](docs/PRD.md)
- 内置工作流与参数映射：[docs/WORKFLOWS.md](docs/WORKFLOWS.md)
- 真机验收清单：[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)

## 它是什么

```
Photoshop UXP 插件（packages/plugin）
   │  只跟本机 Helper 说话，不直连任何 AI 服务
   ▼
本机 Helper（packages/helper）—— Fastify + node:sqlite + ws
   ├── 作业引擎：18 态状态机 · 并发闸 · 重启恢复 · 取消
   ├── 资产库：sha256 去重，结果永久保留
   ├── 凭据：Windows DPAPI，明文不落盘也不出响应
   └── Provider：ComfyUI · RunningHub · OpenAI 兼容族 · Gemini
```

导航是从需求方的功能图谱直接解码出来的 5 级结构：

```
ComfyUI Web │ 生成 │ 历史 │ 设置
              └─ comfyui │ 闭源模型
                   ├─ 洗图（人像 / 场景）
                   ├─ 光影溶图（固定视角 / 自适应视角）
                   ├─ 图像编辑（质感加强）
                   ├─ 其他功能（放大 · 精修 · 视角转换 → 通用/无损、产品/人物/场景、360°旋转）
                   └─ 自定义工作流
```

## 三条设计纪律

**1. 面板上不能有转不动的旋钮。**
每个滑杆都必须映射到工作流里某个真实的节点输入。参考图谱把「真实感/光影/强度」
画成一排共享参数，但同一个滑杆在不同功能里未必都接得上 —— 摆一个调了不起作用的
控件比不摆更糟。测试 `builtin-workflows.test.mjs` 强制这一点。

**2. AI 出图成功 与 写回 Photoshop 成功 是两件事。**
写回失败绝不标记成 `failed`，而是 `retryable_writeback_failure`：结果永久留在资产库，
文档重开后随时可以再写回。否则用户会以为要重新烧一次显卡。

**3. 不允许假成功。**
未配置的 Provider 显示禁用 + 原因；不支持取消的平台如实说会继续计费；
没出图就绝不显示结果。lint 里有一条规则专门拦这个。

## 开发

```bash
cd psai && npm install
```

```bash
npm run check
```

```bash
npm test
```

| 命令 | 做什么 |
|---|---|
| `npm run check` | 三包 typecheck + lint + UXP manifest 校验 |
| `npm test` | 133 项：契约、Helper 集成、重启恢复、内置工作流静态校验 |
| `npm run test:comfy:real` | 对真实 ComfyUI 的适配器端到端（28 项） |
| `npm run test:workflows:real` | 11 份内置工作流逐个真实出图 |
| `npm run workflows:author` | 重新生成内置工作流 |
| `npm run release` | 打交付物到 `release/` |

浏览器里预览面板样式（UXP 专有能力不可用，面板会如实说明）：

```bash
npm run dev:preview
```

## 安装

1. 运行 `release/AI-for-PS-Setup.exe` —— 装 Helper、注册开机自启、立刻启动一次
2. 用 UXP Developer Tool 加载 `packages/plugin`（或安装 `release/AI-for-PS.ccx`）
3. 打开 Photoshop → 增效工具 → AI 面板 —— 自动配对，不需要额外操作

## 目录

```
psai/
├── docs/            PRD · 内置工作流说明 · 真机验收清单
├── packages/
│   ├── shared/      功能目录、参数 schema、作业契约、错误码（唯一事实源）
│   ├── helper/      本机服务
│   └── plugin/      UXP 插件
├── workflows/       11 份内置 ComfyUI 工作流（graph + 绑定 + 元数据）
└── tools/           构建、打包、测试、文档生成
```

`packages/shared/src/catalog.ts` 是整个产品的骨架：导航、参数表单、绑定矩阵、
PRD 的功能表、以及"功能有没有遗漏"的测试，全都读它。新增一个功能 = 加一条目录项
加一份工作流，UI 零改动。

## 已知限制

- 闭源模型与 RunningHub 只做了协议实现与桩测试，**未用真实账号验证**
- `.ccx` 未经 Adobe 签名，需用 UXP Developer Tool 以开发模式加载
- 开发机没装 ESRGAN 类放大模型，放大走 `ImageScaleBy` 重采样；装了模型可换成 `ImageUpscaleWithModel`
- 内置工作流基于 SD1.5 系（IC-Light 只支持 SD1.5）
- 仅支持 Windows（DPAPI 与 NSIS 安装器）
- UXP `<webview>` 内嵌本机 ComfyUI 的放行策略尚未在真机验证，代码已备降级路径
