# AI for PS · 产品需求文档（PRD）

| 项 | 内容 |
|---|---|
| 产品名 | AI for PS |
| 版本 | 1.0.0 |
| 文档状态 | 基线（与 `packages/shared/src/catalog.ts` 保持强一致，由 `catalog.prd.test` 校验） |
| 形态 | Adobe Photoshop UXP 插件 + 本机 Helper 服务 |
| 目标宿主 | Photoshop 25.2.0 及以上（开发验证机：Photoshop 2026） |
| 平台 | Windows 10/11 x64（macOS 为后续版本目标） |
| 文档负责人 | — |
| 最近更新 | 2026-08-22 |

---

## 1. 产品定位

### 1.1 一句话定位

**在 Photoshop 里直接调度 AI 生图能力的电商视觉工作台**：设计师不离开 Photoshop，就能把当前图层 / 选区送进本地 ComfyUI 或云端模型，拿回结果并安全写回画布。

### 1.2 要解决的问题

电商与产品视觉设计师今天的实际工作流是割裂的：

1. 在 Photoshop 里做主视觉 → 导出 PNG → 切到 ComfyUI 网页 → 拖节点、连线、调参 → 出图 → 下载 → 拖回 Photoshop → 对位 → 继续修。
2. ComfyUI 的节点图对非技术用户门槛过高；同一件事（洗图、放大、精修）每次都要重新搭一遍图或翻找旧工作流。
3. 闭源模型（豆包 / 通义万相 / Gemini 等）各有各的控制台，跟本地 ComfyUI 是两套完全独立的操作路径。
4. 结果回到 Photoshop 后，位置、尺寸、图层结构都要手动收拾；一旦文档被改动，之前生成的结果就容易对不上。

### 1.3 产品主张

- **功能化，而非节点化**：把常用的 ComfyUI 工作流封装成「洗图 / 光影溶图 / 放大 / 精修 / 视角转换」这样的固定功能，用户只调 3~5 个滑杆，不碰节点图。
- **一个面板两条路**：本地 ComfyUI（可控、免费、吃显卡）与闭源模型 API（省事、稳定、按量付费）在同一个界面里并列，参数体验一致。
- **专业用户不被限制**：保留完整的 ComfyUI Web 图形编辑器入口和自定义工作流导入，高级用户可以随时下沉到节点层。
- **写回是一等公民**：结果不是"下载一张图"，而是按智能对象 / 像素图层 / 选区原位写回到正确的文档、正确的位置，且写回前会做完整的安全校验。

### 1.4 目标用户

| 用户 | 画像 | 核心诉求 |
|---|---|---|
| 电商主图设计师（主要） | 熟练 Photoshop，不懂 ComfyUI 节点 | 洗图、换背景、精修、白底图，批量且要快 |
| 产品/工业设计师 | 有 3D 与渲染概念 | 多视角推理、材质结构反推、白膜/线稿/法线稿 |
| AI 绘图进阶用户 | 会写工作流 | 把自己的工作流带进 Photoshop，参数暴露到面板上 |
| 摄影后期 | 关心画质 | 无损放大、质感加强、光影融合 |

### 1.5 非目标（本版本明确不做）

- 不做无限画布 / 不做 Photoshop 之外的独立创作环境。
- 不做模型训练、LoRA 训练、数据集管理。
- 不做多人协作、账号体系、云端素材同步。
- 不做视频生成。
- 不代替 ComfyUI 的节点编辑：编辑节点图仍然在 ComfyUI Web 里完成。

### 1.6 成功判据（v1.0）

1. 用户在 Photoshop 中安装后，**不需要读任何文档**就能完成一次「选中图层 → 洗图 → 写回」。
2. ComfyUI 分支 11 个固定功能全部开箱即用（内置工作流已随插件发布，且在真实 ComfyUI 上验证过出图）。
3. 关闭再打开 Photoshop 后插件仍在，历史任务仍在，结果仍可写回。
4. 任何失败都能在界面上看到**具体原因**，没有一处是静默失败或假成功。

---

## 2. 术语与参考

### 2.1 术语

| 术语 | 含义 |
|---|---|
| **Helper** | 随插件安装、跟随系统启动的本机后台服务。负责作业调度、Provider 调用、SQLite 持久化、密钥保管。插件本身不直连任何 AI 服务。 |
| **Provider** | 一个可以出图的后端。分四类：ComfyUI、RunningHub、OpenAI 兼容（火山方舟/阿里百炼/魔搭/Comfly/自定义）、Gemini。 |
| **功能（Feature）** | 面板上一个可执行的叶子节点，例如「洗图 / 人像」。每个功能有固定的参数表与一份工作流绑定。 |
| **固定功能** | 出厂内置、绑定内置工作流的功能（11 个 ComfyUI 分支功能）。 |
| **工作流（Workflow）** | 一份 ComfyUI 图。内置工作流随插件发布；用户也可导入自己的。 |
| **绑定（Binding）** | 把功能的参数 id 映射到工作流某个节点的某个输入。 |
| **快照（Snapshot）** | 从 Photoshop 导出的输入图（PNG），连同文档 id、图层 id、选区边界等上下文一起冻结。 |
| **写回（Writeback）** | 把结果放回 Photoshop 的动作。三种方式：智能对象、像素图层、选区原位。 |
| **反推（Reverse Prompt）** | 用视觉模型读输入图，产出可复用的文本提示词。 |
| **稿型** | 黑白线稿 / 纯色稿 / 白膜 / 黑白深度 / 法线 —— 产品设计常用的中间稿形态。 |

### 2.2 参考与来源

本 PRD 的功能骨架来自需求方提供的功能图谱（`ider/v2/无标题图谱.png`，15514×13086）与 4 张参考界面截图。图谱用颜色编码导航层级：

| 颜色 | 含义 |
|---|---|
| 深蓝 | 一级导航 |
| 黄 | 二级导航 |
| 绿 | 三级导航 |
| 浅蓝 | 四级导航 |
| 粉 | 五级导航 / 共享参数 |

其他明确引用：

- **参考项目**：`https://github.com/NimaNzrii/comfyui-photoshop` —— 在 Photoshop 插件菜单里提供 `Ai Panel / Settings / ComfyUI Web` 三个入口，把 ComfyUI 网页编辑器内嵌进 Photoshop 面板。本产品沿用「主面板 + 独立 ComfyUI Web 面板」的入口结构。
- **UI 风格参考**：Allen design / Aloha.ai 截图 —— 深色背景、卡片分组、分组标题左侧竖色条、二段式 Tab（主 Tab + 子 Tab）、底部通栏主行动按钮。
- **推荐平台**：Comfly `ai.comfly.org/token`、魔搭 `modelscope.cn`、火山引擎 `volcengine.com`、阿里百炼 `bailian.console.aliyun.com`。

### 2.3 与图谱的差异说明（需要备案的判断）

| 图谱内容 | 处理方式 | 理由 |
|---|---|---|
| 稿型预设列表中「白膜」出现两次 | 拆成「白膜」与「白膜 · 带材质」两个预设 | 同名两项无法在 UI 中区分；按产品设计常见语境拆分，并在预设说明里写清差异 |
| 「采样器」只给了 `euler` / `res_2m` 两个 | 采样器改为下拉，出厂推荐 9 项，并在连接 ComfyUI 后由 `/object_info` 实时覆盖为真实列表 | `res_2m` 在 ComfyUI 中的对应实现是 `res_multistep`；硬编码两项会让高级用户无法使用其余采样器 |
| 图谱未给出负向提示词 | 每个 ComfyUI 分支功能补充负向提示词（折叠在高级参数里） | 无负向提示词时 SD/SDXL 类模型质量明显下降 |
| 图谱未给出写回方式 | 补充写回选择器（智能对象/像素层/选区原位/仅存资产） | 这是插件相对网页版的核心价值，不能缺 |

---

## 3. 信息架构

### 3.1 面板入口

插件在 Photoshop 的「增效工具」菜单下注册三个入口：

| 入口 | 类型 | 说明 |
|---|---|---|
| AI 面板 | panel | 主面板，内含四级导航（ComfyUI / 生成 / 历史 / 设置） |
| ComfyUI Web | panel | 独立可停靠的 ComfyUI 网页编辑器面板 |
| 打开设置 | command | 打开主面板并直接跳到设置页 |

主面板默认停靠尺寸 460 × 720，最小 360 × 480，浮动时 1180 × 800。所有布局在 360px 宽度下必须仍然可用（单列堆叠）。

### 3.2 导航树（完整）

```
L1 ── ComfyUI Web            内嵌 ComfyUI 图形编辑器
   ├─ 生成
   │   ├─ L2 comfyui
   │   │   ├─ L3 洗图
   │   │   │   ├─ L4 人像                       comfy.wash.portrait
   │   │   │   └─ L4 场景                       comfy.wash.scene
   │   │   ├─ L3 光影溶图
   │   │   │   ├─ L4 固定视角                   comfy.relight.fixed
   │   │   │   └─ L4 自适应视角                 comfy.relight.adaptive
   │   │   ├─ L3 图像编辑
   │   │   │   └─ L4 质感加强                   comfy.edit.texture
   │   │   ├─ L3 其他功能
   │   │   │   ├─ L4 放大
   │   │   │   │   ├─ L5 通用放大               comfy.misc.upscale.general
   │   │   │   │   └─ L5 无损放大               comfy.misc.upscale.lossless
   │   │   │   ├─ L4 精修
   │   │   │   │   ├─ L5 产品                   comfy.misc.retouch.product
   │   │   │   │   ├─ L5 人物                   comfy.misc.retouch.person
   │   │   │   │   └─ L5 场景                   comfy.misc.retouch.scene
   │   │   │   └─ L4 视角转换
   │   │   │       └─ L5 360° 旋转              comfy.misc.viewpoint.orbit
   │   │   └─ L3 自定义工作流（动态列表）        comfy.custom
   │   └─ L2 闭源模型
   │       ├─ L3 洗图 / 去噪                     cloud.wash
   │       ├─ L3 文生图                          cloud.t2i
   │       ├─ L3 图生图                          cloud.i2i
   │       └─ L3 高质量产品渲染
   │           ├─ L4 产品多视角                  cloud.product.multiview
   │           └─ L4 精修白底图                  cloud.product.whitebg
   ├─ 历史
   └─ 设置
```

功能 ID 是稳定标识符，跨版本不变；历史记录、工作流绑定、深链都用它。

### 3.3 导航交互规则

1. **层级折叠**：L1 为顶部横向 Tab；L2 为其下的一排 Tab；L3/L4/L5 为左侧或顶部的分段控件，具体按面板宽度自适应（宽度 < 420px 时 L3 以下改为下拉选择器）。
2. **记忆**：切换 L1 回来时恢复上次停留的功能；重启 Photoshop 后恢复 `ui.lastFeatureId`。
3. **禁用而非隐藏**：未配置 Provider、未绑定工作流的功能仍然出现在导航里，但显示为禁用态并带原因徽标（例：`未绑定工作流`）。点击可跳到设置页对应项。
4. **面包屑**：功能页顶部显示 `生成 / comfyui / 洗图 / 人像`。

---

## 4. 功能需求

### 4.1 生成页通用规则

每个功能页的结构固定为四块，自上而下：

```
① 图像输入      —— 拖拽、粘贴或点击上传图片；或从 Photoshop 取图层/选区/合并可见
② 参数设置      —— 按 FeatureSpec.params 渲染；高级参数默认折叠
③ 结果          —— 进度条 → 结果缩略图 → 前后对比 → 写回方式
④ 开始处理      —— 底部通栏主按钮，显示预估耗时与所用 Provider
```

**通用规则：**

| 编号 | 规则 |
|---|---|
| G-01 | 「开始处理」在以下任一情况禁用，并在按钮下方显示具体原因：Helper 离线 / 未配对 / Provider 未配置 / 功能未绑定工作流 / 必填参数缺失 / 必需输入图缺失 / 并发已满。 |
| G-02 | 提交瞬间冻结 Photoshop 上下文（文档 id、尺寸、图层 id 与名称、选区边界），后续写回一律以冻结值为准，不读"当前"状态。 |
| G-03 | 输入图默认按 `generation.inputMaxEdge`（默认 2048）缩放最长边后再上传，缩放比例记入任务，写回时反算。设为 0 表示不缩放。 |
| G-04 | 提交后功能页可以自由切换，任务在后台继续；顶部状态条显示活动任务数。 |
| G-05 | 同一功能连续提交允许排队；并发上限由 `generation.maxConcurrency` 控制（默认 1，本地 ComfyUI 建议 1）。 |
| G-06 | 参数值全程受 `ParamSpec` 约束：超出范围的输入被钳制并提示，不会静默发送非法值。 |
| G-07 | 每次提交都会把最终生效的参数（含解析后的种子与宽高）存进任务记录，历史页可一键"用这套参数重跑"。 |
| G-08 | 结果出图后若 `generation.autoWriteback` 为真则自动写回，否则停在「等待写回」由用户点确认。 |

### 4.2 ComfyUI 分支 · 固定功能

以下 11 个功能共享同一条执行链路：

```
输入图 → 上传到 Helper 资产库 → 上传到 ComfyUI (/upload/image)
      → 取功能绑定的工作流 → 按绑定表注入参数 → POST /prompt
      → WS 监听进度 → /history 取结果 → 下载入资产库 → 写回 Photoshop
```

#### 4.2.1 洗图 / 人像 `comfy.wash.portrait`

- **入口**：生成 → comfyui → 洗图 → 人像
- **说明**：在保持人物身份与构图的前提下，重绘皮肤、发丝与衣物质感。
- **输入**：必需 1 张。来源：当前图层 / 当前选区 / 合并可见 / 粘贴 / 上传。默认取当前图层。
- **内置工作流**：`wf.wash.portrait`
- **依赖节点**：`CheckpointLoaderSimple`、`KSampler`、`VAEEncode`、`VAEDecode`、`LoadImage`、`SaveImage`

| 参数 | 控件 | 范围 | 默认 | 说明 |
|---|---|---|---|---|
| 提示词 `prompt` | 多行文本 + ✨优化 | — | 空 | 补充希望强化的方向，可留空 |
| 负向提示词 `negativePrompt` | 多行文本（高级） | — | `lowres, blurry, watermark, text, deformed` | |
| 随机种子 `seed` | 自动随机 / 随机 / 固定 | 0–4294967295 | 自动随机 | 固定时两次提交结果一致 |
| 真实感 `realism` | 滑杆 | 0–1，步 0.01 | 0.60 | 提高皮肤/材质真实细节权重 |
| 光影 `lighting` | 滑杆 | 0–1 | 0.35 | 0 保留原图光照，1 完全重打光 |
| 强度 `strength` | 滑杆 | 0–1 | 0.55 | |
| 重绘幅度 `denoise` | 滑杆 | 0–1 | 0.28 | 0.2~0.35 保结构 |
| 采样器 `sampler` | 下拉（高级） | 实时来自 `/object_info` | `euler` | |
| 调度器 `scheduler` | 下拉（高级） | 实时 | `normal` | |
| 步数 `steps` | 滑杆（高级） | 1–100 | 20 | |
| CFG `cfg` | 滑杆（高级） | 1–20 | 7.0 | |
| 分辨率 `resolution` | 滑杆 | 512–2048，步 64 | 1024 | 长边基准 |

- **写回**：智能对象（默认）/ 像素图层 / 选区原位 / 仅存资产
- **验收标准**：
  1. 输入当前图层 → 出图分辨率与输入一致（或按分辨率参数缩放）
  2. 重绘幅度 0.2 时人物五官与轮廓保持可辨识
  3. 随机种子固定时两次提交结果一致

#### 4.2.2 洗图 / 场景 `comfy.wash.scene`

- **入口**：生成 → comfyui → 洗图 → 场景
- **说明**：重绘环境、背景与氛围，保留主体位置与透视。
- **输入**：必需 1 张，来源同上。
- **内置工作流**：`wf.wash.scene`
- **参数**：与「人像」相同，仅默认值不同 —— 真实感 0.50 / 光影 0.50 / 强度 0.60 / 重绘幅度 0.35。
- **验收标准**：① 主体位置与透视不变 ② 提示词为空时工作流仍能出图 ③ 强度滑杆对结果有可见影响

#### 4.2.3 光影溶图 / 固定视角 `comfy.relight.fixed`

- **入口**：生成 → comfyui → 光影溶图 → 固定视角
- **说明**：把主体按背景的光照重新打光并融合，机位保持不变。
- **输入**：**两张**
  - `image` 主体图（必需，建议已抠图或带透明通道）
  - `background` 背景 / 参考光图（必需，默认来源 = 上传）
- **内置工作流**：`wf.relight.fixed`（基于 IC-Light）
- **依赖节点**：`LoadImage`、`KSampler`、`VAEDecode`、`SaveImage`

| 参数 | 控件 | 默认 | 说明 |
|---|---|---|---|
| 提示词 | 多行 + ✨ | 空 | 补充光照描述，例 `warm rim light from left` |
| 负向提示词 | 多行（高级） | 见通用 | |
| 随机种子 | 三态 | 自动随机 | |
| 光影 `lighting` | 滑杆 0–1 | 0.70 | 重打光强度 |
| 融合强度 `strength` | 滑杆 0–1 | 0.60 | |
| 重绘幅度 | 滑杆 0–1 | 0.35 | |
| 采样器/调度器/步数/CFG | 高级 | euler / normal / 20 / 7.0 | |
| 分辨率 | 滑杆 | 1024 | |

- **写回**：智能对象 / 像素图层 / 选区原位 / 仅存资产
- **验收标准**：① 主体轮廓与机位不变 ② 光照方向跟随背景图 ③ 光影滑杆 0 时接近原图光照

#### 4.2.4 光影溶图 / 自适应视角 `comfy.relight.adaptive`

- **入口**：生成 → comfyui → 光影溶图 → 自适应视角
- **说明**：允许小幅调整主体机位以贴合背景透视，再统一打光融合。
- **输入**：主体图 + 背景图（同上）
- **内置工作流**：`wf.relight.adaptive`
- **额外参数**：**摄像机 3D 视窗调整 `camera`**（见 §5.4），默认 0°/0°，机位翻译出的英文片段自动拼进提示词。
- **其余参数**：光影 0.70 / 融合强度 0.65 / 重绘幅度 0.45，其余同「固定视角」。
- **验收标准**：① 立方体角度变化会改变输出机位 ② 稳定度为 C 时 UI 给出风险提示 ③ 融合后主体与背景无明显边缘

#### 4.2.5 图像编辑 / 质感加强 `comfy.edit.texture`

- **入口**：生成 → comfyui → 图像编辑 → 质感加强
- **说明**：增强表面微结构、材质纹理与细节层次，不改变形体。
- **输入**：必需 1 张
- **内置工作流**：`wf.edit.texture`

| 参数 | 控件 | 默认 |
|---|---|---|
| 提示词 | 多行 + ✨，占位「指定要强化的材质，例如 brushed aluminium, matte leather...」 | 空 |
| 负向提示词 | 高级 | 见通用 |
| 随机种子 | 三态 | 自动随机 |
| 质感强度 `texture` | 滑杆 0–1 | 0.55 |
| 重绘幅度 | 滑杆 0–1 | 0.22 |
| 采样器/调度器/步数/CFG/分辨率 | — | euler / normal / 20 / 7.0 / 1024 |

- **验收标准**：① 形体与轮廓不变 ② 质感强度滑杆对细节量有可见影响 ③ 不引入新的物体

#### 4.2.6 其他功能 / 放大 / 通用放大 `comfy.misc.upscale.general`

- **入口**：生成 → comfyui → 其他功能 → 放大 → 通用放大
- **说明**：放大同时用扩散模型补充细节。
- **输入**：必需 1 张
- **内置工作流**：`wf.upscale.general`
- **依赖节点**：`LoadImage`、`UpscaleModelLoader`、`ImageUpscaleWithModel`、`KSampler`、`SaveImage`

| 参数 | 控件 | 默认 |
|---|---|---|
| 放大倍数 `upscaleFactor` | 分段：1.5× / 2× / 3× / 4× | 2× |
| 提示词 | 多行 + ✨ | 空 |
| 负向提示词 | 高级 | 见通用 |
| 随机种子 | 三态 | 自动随机 |
| 重绘幅度 | 滑杆 | 0.25 |
| 采样器/调度器 | 高级 | euler / normal |
| 步数 / CFG | 高级 | 15 / 6.0 |

- **写回**：智能对象 / 像素图层 / 仅存资产（**不提供选区原位**，因为尺寸已变）
- **验收标准**：① 输出尺寸 = 输入 × 放大倍数（±8px 对齐误差）② 细节量高于纯插值放大 ③ 重绘幅度 0 时不产生新内容

#### 4.2.7 其他功能 / 放大 / 无损放大 `comfy.misc.upscale.lossless`

- **入口**：生成 → comfyui → 其他功能 → 放大 → 无损放大
- **说明**：纯放大模型推理，不做扩散重绘，绝不改变画面内容。
- **输入**：必需 1 张
- **内置工作流**：`wf.upscale.lossless`

| 参数 | 控件 | 默认 |
|---|---|---|
| 放大倍数 | 分段 1.5×/2×/3×/4× | 2× |
| 放大模型 `upscaleModel` | 下拉，实时来自 ComfyUI 已装的 upscale 模型 | （使用工作流默认） |

- **写回**：智能对象 / 像素图层 / 仅存资产
- **验收标准**：① 输出内容与输入逐物体一致（无新增/丢失元素）② 输出尺寸 = 输入 × 放大倍数 ③ 不含随机性：同输入两次结果一致

#### 4.2.8–4.2.10 其他功能 / 精修 / 产品·人物·场景

三个功能结构完全相同，只有描述与内置工作流不同：

| 功能 ID | 标签 | 针对 | 内置工作流 |
|---|---|---|---|
| `comfy.misc.retouch.product` | 产品 | 产品表面 | `wf.retouch.product` |
| `comfy.misc.retouch.person` | 人物 | 人物皮肤与五官 | `wf.retouch.person` |
| `comfy.misc.retouch.scene` | 场景 | 场景环境与道具 | `wf.retouch.scene` |

- **说明**：局部提亮、瑕疵清理与细节收拾，保持原构图。
- **输入**：必需 1 张

| 参数 | 控件 | 默认 |
|---|---|---|
| 提示词 | 多行 + ✨，占位「可指定要重点收拾的部分...」 | 空 |
| 负向提示词 | 高级 | 见通用 |
| 随机种子 | 三态 | 自动随机 |
| 精修强度 `strength` | 滑杆 0–1 | 0.50 |
| 重绘幅度 | 滑杆 0–1 | 0.20 |
| 采样器/调度器/步数/CFG/分辨率 | — | euler / normal / 20 / 7.0 / 1024 |

- **写回**：全部四种
- **验收标准**：① 构图与主体位置不变 ② 精修强度滑杆有可见影响 ③ 不产生多余肢体/物体

#### 4.2.11 其他功能 / 视角转换 / 360° 旋转 `comfy.misc.viewpoint.orbit`

- **入口**：生成 → comfyui → 其他功能 → 视角转换 → 360° 旋转
- **说明**：由单张图推出任意机位的同一主体，用于补齐多视角素材。
- **输入**：必需 1 张
- **内置工作流**：`wf.viewpoint.orbit`

| 参数 | 控件 | 默认 |
|---|---|---|
| **摄像机 3D 视窗调整 `camera`** | 立方体拖拽（见 §5.4） | 水平 0° / 垂直 0° |
| 提示词 | 多行 + ✨，占位「补充主体描述可提高一致性...」 | 空 |
| 负向提示词 | 高级 | 见通用 |
| 随机种子 | 三态 | 自动随机 |
| 一致性强度 `strength` | 滑杆 0–1 | 0.70 |
| 采样器/调度器/步数/CFG/分辨率 | — | euler / normal / 20 / 7.0 / 1024 |

- **写回**：智能对象 / 像素图层 / 仅存资产
- **验收标准**：① 水平角 0 / 垂直角 0 时输出接近输入 ② 水平角 −90 时输出为主体右侧视图 ③ 稳定度徽章随角度变化（0/0 显示 `S+ 最稳定`）

### 4.3 ComfyUI 分支 · 自定义工作流 `comfy.custom`

- **入口**：生成 → comfyui → 自定义工作流
- **说明**：运行用户导入的工作流，参数由导入时扫描出的可绑定字段动态生成。
- **列表**：该 L3 节点下动态列出所有 `source = imported` 的工作流；每项显示名称、版本、依赖状态（✅ 就绪 / ⚠ 缺节点 / ⚠ 缺模型）。
- **参数**：由 `ScanResult.fields` 动态生成：
  - 识别到语义的字段渲染成标准控件（`prompt` → 提示词框，`seed` → 种子控件，`denoise/steps/cfg` → 滑杆，`width/height` → 尺寸，`image/mask` → 图像输入，`sampler/scheduler` → 下拉）。
  - 未识别语义的字段渲染成通用控件（字符串 → 文本框，数字 → 数字框，布尔 → 开关），并按节点分组显示。
- **写回**：全部四种
- **验收标准**：① 导入的工作流出现在列表中 ② 扫描出的 Prompt/Seed/Steps/CFG/Denoise/Width/Height/Image 字段可在 UI 中调节 ③ 未绑定输出节点的工作流导入时明确报错
### 4.4 闭源模型分支

四个功能共享执行链路：

```
输入图 → Helper 资产库 →（可选）反推/优化：调用 vision/chat 接口拿文本
      → 组装最终提示词 → 调用图像接口 → 拿回 base64/URL → 入资产库 → 写回
```

Provider 由「设置 → 固定功能」里该功能的绑定决定；未绑定时用第一个已配置且具备所需能力的 Provider，并在界面上显式标出正在用哪一个。

#### 4.4.1 洗图 / 去噪 `cloud.wash`

- **入口**：生成 → 闭源模型 → 洗图 / 去噪
- **说明**：用闭源模型重绘输入图；可先用内置反推提示词把原图描述出来，再按稿型改写。
- **输入**：必需 1 张

| 参数 | 控件 | 默认 | 说明 |
|---|---|---|---|
| 模型 `model` | 下拉，来自「拉取模型」 | 空（用 Provider 默认） | |
| **通用内置反推提示词 `reversePrompt`** | 预设选择器 + 启用开关 | `通用内置反推提示词`，**开启** | 可选：通用内置反推提示词 / 内置反推场景 |
| **稿型预设 `stylePreset`** | 预设选择器 + 启用开关 | 空，**关闭** | 黑白线稿 / 纯色稿 / 白膜 / 白膜·带材质 / 黑白深度 / 法线 |
| 提示词 `prompt` | 多行 + ✨ | 空 | |
| 是否优化提示词 `promptEnhance` | 开关 | 关 | |
| 随机种子 `seed` | 三态 | 自动随机 | Provider 不支持 seed 时该控件禁用并注明 |
| 重绘幅度 `denoise` | 滑杆 0–1 | 0.25 | |
| 生图比例 `aspect` | 11 项分段 | 1:1 | |
| 分辨率 `resolution` | 滑杆 512–2048 | 1280 | |

- **提示词组装顺序**（面板上实时显示最终结果，可折叠查看）：
  ```
  [反推结果（若启用）] , [稿型预设正向词（若启用）] , [用户提示词（若启用优化则用优化后的）]
  负向 = [稿型预设负向词] , [用户负向词]
  ```
- **写回**：全部四种
- **验收标准**：① 反推开关关闭时不产生额外的视觉模型调用 ② 选中稿型预设后提示词面板显示最终拼接结果 ③ 未配置任何闭源 Provider 时按钮禁用并显示原因

#### 4.4.2 文生图 `cloud.t2i`

- **入口**：生成 → 闭源模型 → 文生图
- **说明**：纯文本生成图像。
- **输入**：无图像输入

| 参数 | 控件 | 默认 |
|---|---|---|
| 模型 | 下拉 | 空 |
| 提示词 `prompt` | 多行 5 行 + ✨，**必填** | 空 |
| 是否优化提示词 | 开关 | 关 |
| 负向提示词 | 高级 | 空 |
| 随机种子 | 三态 | 自动随机 |
| 生图比例 | 11 项分段 | 1:1 |
| 分辨率 | 滑杆 | 1280 |

- **写回**：智能对象 / 像素图层 / 仅存资产（无原位，因为没有源选区）
- **验收标准**：① 提示词为空时提交被拦截并提示 ② 优化开关开启时可看到优化后的提示词 ③ 出图比例与所选比例一致

#### 4.4.3 图生图 `cloud.i2i`

- **入口**：生成 → 闭源模型 → 图生图
- **说明**：以最多 **10 张**参考图 + 提示词生成新图。
- **输入**：`images` 图像列表，1–10 张，可拖拽排序、单张删除、单张预览。

| 参数 | 控件 | 默认 |
|---|---|---|
| 上传图 `images` | 图像列表，最多 10 | 空 |
| 模型 | 下拉 | 空 |
| 提示词 | 多行 + ✨，**必填** | 空 |
| 是否优化提示词 | 开关 | 关 |
| 负向提示词 | 高级 | 空 |
| 随机种子 | 三态 | 自动随机 |
| 重绘幅度 | 滑杆 0–1 | 0.50 |
| 生图比例 | 分段 | 1:1 |
| 分辨率 | 滑杆 | 1280 |

- **多图能力降级**：所选模型不支持多图输入时，**不静默丢图**，而是报 `PROVIDER_UNSUPPORTED` 并在 UI 上提供两个明确选项：「只用第 1 张」或「换一个支持多图的模型」。
- **写回**：全部四种
- **验收标准**：① 上传第 11 张时被拒绝并提示上限 ② 不支持多图的模型会明确报错，不静默丢图 ③ 每张参考图可单独删除并重排

#### 4.4.4 高质量产品渲染 / 产品多视角 `cloud.product.multiview`

- **入口**：生成 → 闭源模型 → 高质量产品渲染 → 产品多视角
- **说明**：上传产品多视角照片 → 用内置 skills 提示词反推出产品结构与材质描述 → 调整摄像机 → 渲染白底图或场景图。
- **输入**：`images` 1–10 张多视角照片

| 参数 | 控件 | 默认 |
|---|---|---|
| 上传产品多视角 `images` | 图像列表 1–10 | 空 |
| 模型 | 下拉 | 空 |
| **反推产品结构提示词 `structurePrompt`** | 技能预设 + 启用开关 | `反推产品结构提示词`，**开启** |
| **摄像机 3D 视窗调整 `camera`** | 立方体 | 0° / 0° |
| 输出类型 `outputType` | 分段：白底图 / 场景图 | 白底图 |
| 场景描述 `prompt` | 多行 3 行 + ✨ | 空 |
| 是否优化提示词 | 开关 | 关 |
| 随机种子 | 三态 | 自动随机 |
| 生图比例 | 分段 | 1:1 |
| 分辨率 | 滑杆 | 1280 |

- **两段式流程**：
  1. 点「反推结构」（或提交时自动执行）→ 把所有视角图 + skills 提示词发给视觉模型 → 结果显示在**可编辑文本框**里，用户可以改。
  2. 点「开始处理」→ 用「结构描述 + 机位片段 + 输出类型词 + 场景描述」组装最终提示词去生图。
- **输出类型词**：
  - 白底图 → `pure white seamless background, e-commerce product shot, soft even studio lighting, no props`
  - 场景图 → 使用用户填写的场景描述；为空时提示必填。
- **写回**：智能对象 / 像素图层 / 仅存资产
- **验收标准**：① 反推结果显示在可编辑的文本框里，用户可改后再生成 ② 输出类型为白底图时背景为纯白 ③ 摄像机角度改变会改变输出机位

#### 4.4.5 高质量产品渲染 / 精修白底图 `cloud.product.whitebg`

- **入口**：生成 → 闭源模型 → 高质量产品渲染 → 精修白底图
- **说明**：把一张产品照精修成电商可用的标准白底图：去背、修瑕、统一打光。
- **输入**：必需 1 张

| 参数 | 控件 | 默认 |
|---|---|---|
| 上传图 `image` | 单图 | — |
| 模型 | 下拉 | 空 |
| 提示词 | 多行 3 行 + ✨，占位「可补充要保留/去掉的细节...」 | 空 |
| 是否优化提示词 | 开关 | 关 |
| 随机种子 | 三态 | 自动随机 |
| 生图比例 | 分段 | 1:1 |
| 分辨率 | 滑杆 | 1280 |

- **写回**：智能对象 / 像素图层 / 仅存资产
- **验收标准**：① 输出背景为纯白（四角采样像素 > 250）② 产品主体完整不缺角 ③ 输出比例与所选比例一致

### 4.5 ComfyUI Web 面板

- **入口**：L1「ComfyUI」页 或 独立面板「ComfyUI Web」
- **说明**：把 ComfyUI 的网页图形编辑器嵌进 Photoshop，用于编辑节点图、管理队列、装扩展。

**能力探测与降级（重要）**

UXP 的 `<webview>` 对 `http://127.0.0.1` 的放行策略需要在真机验证。因此本功能设计为**两条路径，自动探测**：

| 路径 | 条件 | 行为 |
|---|---|---|
| A · 内嵌 | `<webview>` 能加载本机 ComfyUI 地址 | 面板内直接显示完整 ComfyUI 编辑器；顶部保留地址栏、连接/刷新按钮、渲染按钮 |
| B · 降级 | webview 被策略拦截 | 面板显示：连接状态卡片 + 「在浏览器中打开 ComfyUI」按钮 + 面板内自建的**工作流浏览器**（列出 ComfyUI 已有工作流、显示节点数与依赖状态、可一键导入为自定义工作流）+ **队列视图**（当前队列、运行中、历史，可取消） |

两条路径下 §4.5 的以下能力都必须可用：

| 编号 | 能力 |
|---|---|
| W-01 | 显示当前 ComfyUI 地址与在线状态（含版本号、节点数） |
| W-02 | 一键重连 / 修改地址（改后写回设置） |
| W-03 | 查看队列（等待中 / 运行中）与取消任意任务 |
| W-04 | 浏览 ComfyUI 侧的工作流并导入为本插件的自定义工作流 |
| W-05 | 从当前 Photoshop 文档发送一张图到 ComfyUI 的输入目录（便于在节点图里直接引用） |

**消息桥（路径 A 独有）**：启用 `enableMessageBridge`，支持 `工作流已保存 → 插件收到通知并提示导入`。

- **验收标准**：① 真机上明确判定走哪条路径并记录在文档里 ② 无论哪条路径，W-01~W-05 全部可用 ③ ComfyUI 未启动时给出明确的启动指引而非空白页

### 4.6 历史页

- **入口**：L1「历史」
- **说明**：所有任务的持久化列表。Photoshop 关闭重开后仍在。

| 编号 | 需求 |
|---|---|
| H-01 | 列表按创建时间倒序，每行显示：结果缩略图、功能名、状态徽标、Provider、耗时、创建时间 |
| H-02 | 筛选：按状态、按功能、按当前文档（只看与当前 PSD 相关的） |
| H-03 | 详情抽屉：完整参数表（含解析后的种子与宽高）、输入图、全部结果图、状态流转事件流、错误详情 |
| H-04 | 操作：**再次写回**（结果还在资产库就永远可以再写回）、**用这套参数重跑**、**取消**（活动态）、**重试**（失败态）、**删除** |
| H-05 | 血缘：显示 `由哪条任务重跑而来` 与 `衍生出哪些任务` |
| H-06 | 结果图支持前后对比（滑动分割线）与 1:1 放大查看 |
| H-07 | 「再次写回」前照样跑完整的写回安全校验（§10.4） |
| H-08 | 删除任务时提示是否同时删除结果资产；资产被其他任务引用时不物理删除 |

### 4.7 设置页

设置页分为 6 个分组。**所有设置的真相源在 Helper**；插件只缓存显示。

#### 4.7.1 本地（ComfyUI 连接）

| 项 | 控件 | 默认 | 说明 |
|---|---|---|---|
| 模式 | 分段：本地 / 远程 / 本地服务器 | 本地 | |
| 地址 | 文本 | `http://127.0.0.1:8188` | 「本地」模式也可改端口 |
| 服务启动命令 | 文本（仅本地服务器模式） | 空 | Helper 用它拉起 ComfyUI 进程 |
| 工作目录 | 文本（仅本地服务器模式） | 空 | |
| 连接超时 | 数字（毫秒） | 15000 | |
| 测试连接 | 按钮 | — | 显示：可达性、版本、节点数、延迟；失败时显示具体错误码与原因 |

#### 4.7.2 云端（RunningHub）

| 项 | 控件 | 说明 |
|---|---|---|
| API Key | 密码框（存 DPAPI，UI 只显示掩码） | 必填 |
| 默认工作流 ID | 文本 | 可被单个功能的绑定覆盖 |
| 验证 | 按钮 | 调真实接口验证 Key 与工作流 ID 是否可用，显示结果 |

#### 4.7.3 固定功能绑定

一张矩阵表，列出全部 11 个 ComfyUI 固定功能 + 5 个闭源功能：

| 列 | 说明 |
|---|---|
| 功能 | 面包屑路径 |
| 执行后端 | 下拉：ComfyUI / RunningHub / 闭源 Provider |
| 工作流 | 下拉（ComfyUI 时）：内置工作流 + 已导入工作流 |
| 云端工作流 ID | 文本（RunningHub 时） |
| 模型 | 下拉（闭源时），来自「拉取模型」 |
| 状态 | ✅ 就绪 / ⚠ 缺节点 / ⚠ 缺模型 / ❌ 未配置 |
| 操作 | 恢复出厂绑定 / 依赖检查 |

- 出厂时 11 个固定功能全部预绑定到对应内置工作流。
- 依赖检查会连真实 ComfyUI 比对节点类型与模型文件，缺什么列什么。

#### 4.7.4 工作流管理

| 编号 | 需求 |
|---|---|
| WF-01 | 列出全部工作流（内置 + 导入），显示名称、版本、来源、节点数、依赖状态 |
| WF-02 | **导入工作流**：选择 `.json` 文件或粘贴 JSON；自动识别 API 格式与 UI 格式；扫描出可绑定字段并显示 |
| WF-03 | 同名再次导入且内容变化 → 版本递增（1.0.0 → 1.1.0），旧版本保留可回退 |
| WF-04 | 绑定编辑器：把功能参数 id 映射到 `节点 / 输入`，支持线性映射变换 |
| WF-05 | 坏 JSON、无输出节点、绑定指向不存在的节点 → 明确报错，不允许保存 |
| WF-06 | 导出工作流（含绑定表）为 `.json` |
| WF-07 | 删除导入的工作流；内置工作流不可删除，只能"恢复默认" |

#### 4.7.5 推荐平台与 API

顶部为四张推荐平台卡片（出厂）：

| 平台 | 控制台地址 | 默认接口地址 |
|---|---|---|
| Comfly | `https://ai.comfly.org/token` | `https://ai.comfly.org/v1` |
| 魔搭 ModelScope | `https://www.modelscope.cn` | `https://api-inference.modelscope.cn/v1` |
| 火山引擎 · 方舟 | `https://www.volcengine.com/` | `https://ark.cn-beijing.volces.com/api/v3` |
| 阿里百炼 | `https://bailian.console.aliyun.com` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |

外加 **Google Gemini** 与 **自定义网站** 两张卡片。

每张卡片包含：

| 项 | 说明 |
|---|---|
| 启用开关 | 关闭后该 Provider 不参与任何自动选择 |
| 接口地址 | 可编辑，出厂默认见上表 |
| API Key | 密码框，存 DPAPI；显示为 `sk-••••••1234` |
| 前往申请 | 打开控制台地址（系统浏览器） |
| **拉取模型** | 调用该 Provider 的模型列表接口，把结果存起来供各功能的「模型」下拉使用；失败时显示错误码 |
| 默认模型 | 下拉，来自拉取结果 |
| 验证 | 真实调用一次最小请求，显示：鉴权是否通过、延迟、可用能力 |

#### 4.7.6 生成默认值与内置提示词

| 项 | 控件 | 默认 |
|---|---|---|
| 默认写回方式 | 下拉 | 新建智能对象图层 |
| 写回图层命名模板 | 文本，支持 `{feature}` `{date}` `{seed}` | `AI · {feature} · {date}` |
| 自动写回 | 开关 | 开 |
| 本地并发上限 | 数字 1–8 | 1 |
| 输入图最长边上限 | 数字，0 = 不缩放 | 2048 |
| 语言 | 下拉 简体中文 / English | 简体中文 |
| 高级参数默认展开 | 开关 | 关 |
| **内置提示词库** | 列表编辑器 | 见 §6 |

内置提示词库编辑器：列出全部出厂预设，可就地编辑正向/负向文本、可「恢复默认」、可「新建自定义预设」（指定归属功能）。出厂预设不可删除。

#### 4.7.7 关于与诊断

| 项 | 说明 |
|---|---|
| 版本 | 插件版本 / Helper 版本 / schema 版本，不一致时红色警示 |
| Helper 状态 | 运行中/已停止、端口、启动时间、数据目录路径 |
| GPU | 型号、显存占用、利用率、温度；读不到时显示原因 |
| 打开日志目录 | 按钮 |
| 重新配对 | 按钮，清除 token 并重新走配对流程 |
| 导出诊断包 | 按钮，打包最近日志 + 设置（**脱敏，不含任何密钥**） |

---

## 5. 通用组件规格

### 5.1 图像输入区

参考截图：卡片标题「图像输入」，标题左侧一条竖色条；卡片内是虚线圆角框的空态区，居中一个图片图标 + 文案「拖拽、粘贴或点击上传图片」。

**状态：**

| 状态 | 表现 |
|---|---|
| 空 | 虚线框 + 图标 + 文案 + 底部一排来源按钮：`当前图层` `当前选区` `合并可见` `粘贴` `上传` |
| 有图 | 缩略图铺满，右上角 `×` 移除、`⤢` 放大预览；底部一行元信息：来源 · 尺寸 · 文件大小 |
| 多图（imageList） | 网格缩略图，每格可删除、可拖拽排序；末尾一个 `+` 格；右上角计数 `3 / 10` |
| 加载中 | 缩略图位置显示进度环（导出快照/上传） |
| 失败 | 红色边框 + 错误文案 + `重试` |

**行为：**

| 编号 | 规则 |
|---|---|
| I-01 | 点击「当前图层」→ 调用 PhotoshopBridge 导出活动图层为 PNG；多选图层时导出合并结果 |
| I-02 | 点击「当前选区」→ 按选区边界裁剪合并可见结果；无选区时按钮禁用并提示 |
| I-03 | 「粘贴」读系统剪贴板图像；剪贴板无图时提示 |
| I-04 | 「上传」走 UXP `localFileSystem.getFileForOpening`，限 PNG/JPEG/WebP，单文件 ≤ 64MB |
| I-05 | 拖拽文件进面板等价于「上传」 |
| I-06 | 每张图上传后由 Helper 计算 sha256 去重；同一张图重复使用不重复存储 |
| I-07 | imageList 超过上限时拒绝并提示 `最多 N 张` |

### 5.2 参数面板

- 分组卡片，标题「参数设置」，与图像输入区同样的竖色条标题样式。
- 参数按 `ParamSpec` 顺序渲染；`advanced: true` 的收进底部「高级参数」折叠区。
- `visibleWhen` 决定条件显隐（例：输出类型 = 场景图 时才显示场景描述必填提示）。
- 每个滑杆右侧带一个数值输入框，可直接键入精确值。
- 所有控件在 360px 宽度下单列排布，标签在上、控件在下。

### 5.3 种子控件

一行三段按钮 + 数值框：

```
随机种子   [ 🎲 自动随机 ] [ 🎲 随机 ] [ 📌 固定 ]   [ 1234567890 ]
```

| 模式 | 行为 |
|---|---|
| 自动随机 | 每次提交生成新种子；数值框显示上次实际用的种子（只读、可复制） |
| 随机 | 点一次生成一个新种子填进数值框，提交时用它；便于"再来一张但记住这次" |
| 固定 | 用数值框里的值，提交多次结果一致 |

数值范围 0 – 4294967295。历史页可一键把某次任务的种子设为固定值。

### 5.4 3D 取景立方体（摄像机 3D 视窗调整）

这是本产品最具辨识度的控件，参考截图给出了完整形态。

**视觉：**

```
┌─────────────────────────────────────────────┐
│ 拖拽立方体：左右改变水平角，上下改变俯仰角   (S+)│
│                                          最稳定│
│                    ┌──────┐                   │
│                   ╱      ╱│                   │
│                  ┌──────┐ │                   │
│                  │FRONT │ │                   │
│                  │正面/  │╱                   │
│                  │主视图│                     │
│                  └──────┘                     │
│                 ╰──── ● ────╯   ← 地面椭圆轨道 │
│  ┌──────────┬──────────┬────────────────┬───┐ │
│  │  水平     │   垂直    │    视角名称     │ ↺ │ │
│  │  -30°     │   30°     │ 右前30度视角/   │   │ │
│  │           │           │ 俯视机位        │   │ │
│  └──────────┴──────────┴────────────────┴───┘ │
└─────────────────────────────────────────────┘
```

**实现约束**：UXP 对 CSS 3D 变换（`transform-style: preserve-3d`）支持不可靠，因此立方体用 **SVG 等轴测投影**绘制 —— JS 计算 8 个顶点在当前 yaw/pitch 下的二维投影，按面深度排序后绘制多边形，可见面上叠加文字标签。

**取值与交互：**

| 项 | 规格 |
|---|---|
| 水平角 yaw | −180° ~ 180°，步进 15°，拖拽左右 |
| 垂直角 pitch | −90° ~ 90°，步进 15°，拖拽上下 |
| 符号约定 | yaw 为负 → 露出产品**右**侧（右前视角）；pitch 为正 → **俯**视机位 |
| 键盘 | 方向键按步进微调；Shift + 方向键 = 5 倍步进 |
| 重置 `↺` | 回到 0° / 0° |
| 数值框 | 水平/垂直两格可直接键入 |
| 面标签 | FRONT 正面/产品主视图、BACK 背面、LEFT 左侧、RIGHT 右侧、TOP 顶部、BOTTOM 底部 |

**视角名称映射（水平）：**

| 水平角 | 名称 |
|---|---|
| 0° | 正视图 |
| −15° ~ −75°（步进 15） | 右前 15/30/45/60/75 度视角 |
| −90° | 右侧视图 |
| −105° ~ −165° | 右后 75/60/45/30/15 度视角 |
| ±180° | 背面视图 |
| 15° ~ 75° | 左前 N 度视角 |
| 90° | 左侧视图 |
| 105° ~ 165° | 左后 N 度视角 |

**机位名称映射（垂直）：**

| 垂直角 | 名称 |
|---|---|
| 0° | 平视机位 |
| 1° ~ 74° | 俯视机位 |
| ≥ 75° | 顶视机位 |
| −1° ~ −74° | 仰视机位 |
| ≤ −75° | 底视机位 |

**稳定度徽章：**

| 等级 | 徽章文案 | 判定条件 | 含义 |
|---|---|---|---|
| `S+` | 最稳定 | 垂直角 = 0 且 水平角是 90° 的整数倍 | 正交标准视图，模型训练数据最多 |
| `A` | 稳定可用 | \|垂直角\| ≤ 45 且 水平角是 15° 的整数倍 | 常见商业机位 |
| `B` | 可能偏差 | \|垂直角\| ≤ 75 | 结果可能失真，建议多出几张挑 |
| `C` | 高风险 | 其余（接近正顶/正底） | UI 显示黄色警示条 |

**提示词注入**：`injectPrompt = true` 的功能会把机位翻译成英文片段拼进提示词，格式为 `<水平英文>, <机位英文>`，例：

| 角度 | 注入片段 |
|---|---|
| 0° / 0° | `front view, eye-level camera` |
| −30° / 30° | `30-degree right three-quarter front view, high-angle camera 30 degrees above` |
| −90° / 0° | `right side view, eye-level camera` |
| 180° / −20° | `rear view, low-angle camera 20 degrees below` |

面板上可折叠查看「最终提示词」，让用户看到注入结果。

### 5.5 生图比例选择器

11 个分段按钮，两行排布：

```
[1:1] [4:5] [3:4] [2:3] [3:2] [4:3]
[5:4] [16:9] [9:16] [21:9] [自定义]
```

- 选中「自定义」时展开两个数字框（宽 / 高）。
- 实际出图尺寸 = `resolveSize(比例, 分辨率长边基准, 8)`，即按长边对齐到分辨率参数，再把宽高各自对齐到 8 的倍数。
- 每个按钮下方用极小字号显示推导结果（例 `1280×1024`），随分辨率滑杆实时更新。

### 5.6 提示词框

- 多行文本域，行数由 `ParamSpec.rows` 决定。
- 右下角 ✨ 按钮 = 「优化提示词」，点击后调用当前 Provider 的文本能力改写，改写结果替换文本域内容，并在下方显示 `已优化 · 撤销` 链接。
- 未配置具备文本能力的 Provider 时 ✨ 禁用并注明原因。
- 底部显示字符数；超过模型上限时黄色提示。

### 5.7 预设选择器（内置提示词）

```
┌ 通用内置反推提示词 ───────────────── [启用 ●] ┐
│ [ 通用内置反推提示词 ▾ ]              [预览]  │
│ 开启后先反推出原图描述，再拼到你的提示词前面   │
└──────────────────────────────────────────────┘
```

- 下拉只列出 `scope` 命中当前功能、且 `kind` 匹配的预设。
- 「预览」展开只读文本区显示预设全文；若用户在设置里改过，显示 `已自定义` 标记。
- 启用开关关闭时，该预设完全不参与提示词组装，也不触发任何额外的模型调用。

### 5.8 进度与结果

| 状态 | 表现 |
|---|---|
| 排队中 | 灰色进度条 + 「本地排队中 · 前面还有 N 个」 |
| 生成中 | 蓝色进度条 + 百分比 + `步 12/20` + 当前节点名（ComfyUI） |
| 下载中 | 进度条 + 「下载结果中」 |
| 完成 | 结果缩略图（多图时为横向列表，可切换） |
| 失败 | 红色卡片：错误码 + 中文原因 + `重试` / `查看详情` |

**前后对比**：结果区提供滑动分割线对比（左原图 / 右结果），可切换为「并排」「叠加闪烁」两种模式，支持同步缩放与拖动。

### 5.9 写回选择器

结果就绪后显示：

```
写回方式  [新建智能对象图层 ▾]      图层名 [AI · 人像 · 2026-08-22 ▾]
          [ 写回 Photoshop ]   [ 仅保存到资产库 ]
```

- 可选项由 `FeatureSpec.writeback.modes` 决定；不适用的模式不显示（例：放大功能没有「选区原位」）。
- 「选区原位」仅当任务带 `selectionBounds` 时可选。
- 写回前跑完整安全校验（§10.4）；校验不通过时不写回，显示具体原因并保留结果。

### 5.10 状态条（面板顶部常驻）

```
[● Helper 1.0.0]  [● ComfyUI 8188 · 42ms]  [GPU 4070Ti · 6.2/16G]  [▤ 2]
```

- 三个圆点分别是 Helper / ComfyUI / GPU 的健康状态，绿=正常 黄=降级 红=离线 灰=未配置。
- 点击任一项跳到设置页对应分组。
- `▤ 2` 是活动任务数，点击打开任务抽屉。
---

## 6. 内置提示词库

出厂 10 条预设，存在 Helper 的 SQLite 里。用户可编辑（存为覆盖）、可恢复默认、可新建自定义预设；出厂预设不可删除。

| ID | 名称 | 类型 | 归属功能 | 用途 |
|---|---|---|---|---|
| `preset.reverse.generic` | 通用内置反推提示词 | 反推 | `cloud.wash` `comfy.wash.*` | 反推出主体+材质+光照+机位+背景的完整描述 |
| `preset.reverse.scene` | 内置反推场景 | 反推 | `cloud.wash` `comfy.wash.scene` | 只反推环境，忽略主体（换背景保主体） |
| `preset.lineart.bw` | 黑白线稿 | 稿型 | `cloud.wash` `comfy.edit.texture` | 干净黑白线稿，无阴影无渐变 |
| `preset.flat.solid` | 纯色稿 | 稿型 | `cloud.wash` | 平涂纯色块，确定配色与体块 |
| `preset.whitemodel.plain` | 白膜 | 稿型 | `cloud.wash` `comfy.edit.texture` | 素白膜：只留形体与体积 |
| `preset.whitemodel.textured` | 白膜 · 带材质 | 稿型 | `cloud.wash` `comfy.edit.texture` | 保留表面微结构与分模线，去掉颜色贴图 |
| `preset.depth.bw` | 黑白深度 | 稿型 | `cloud.wash` `comfy.edit.texture` | 近白远黑深度图，可做 ControlNet 控制图 |
| `preset.normal` | 法线 | 稿型 | `cloud.wash` `comfy.edit.texture` | 切线空间法线图 |
| `preset.skills.productStructure` | 反推产品结构提示词 | 技能 | `cloud.product.multiview` | 按多视角详述产品材质结构设计 |
| `preset.skills.promptEnhance` | 提示词优化 | 技能 | 全部闭源功能 | 「是否优化提示词」开启时使用 |

**共用负向词基线**（稿型预设在此之上追加各自的禁忌项）：

```
lowres, blurry, jpeg artifacts, watermark, text, logo, extra limbs, deformed, oversaturated, cartoon
```

**优化提示词的调用约定**：使用当前功能绑定的 Provider 的文本/视觉能力；不额外新增 Provider 依赖。若该 Provider 无文本能力，✨ 按钮禁用并注明「当前后端不支持提示词优化」。

**反推的调用约定**：把输入图（多图时全部）+ 预设文本一起发给具备 `vision` 能力的 Provider。反推结果一律显示在可编辑文本框里，用户改完才进入生图，绝不静默使用。

---

## 7. Provider 规格

### 7.1 注册表

| ID | 名称 | 类型 | 默认地址 | 能力 | 取消支持 |
|---|---|---|---|---|---|
| `comfyui` | ComfyUI | comfyui | `http://127.0.0.1:8188` | 工作流·文生图·图生图·多图·编辑·取消·进度·模型列表 | 完整 |
| `runninghub` | RunningHub 云端 | runninghub | `https://www.runninghub.cn` | 工作流·文生图·图生图·多图·进度·模型列表 | **无** |
| `comfly` | Comfly | openai 兼容 | `https://ai.comfly.org/v1` | 文生图·图生图·多图·编辑·视觉·模型列表 | 无 |
| `modelscope` | 魔搭 ModelScope | openai 兼容 | `https://api-inference.modelscope.cn/v1` | 文生图·图生图·视觉·模型列表 | 无 |
| `volcengine` | 火山引擎 · 方舟 | openai 兼容 | `https://ark.cn-beijing.volces.com/api/v3` | 文生图·图生图·多图·编辑·视觉·模型列表 | 无 |
| `bailian` | 阿里百炼 | openai 兼容 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 文生图·图生图·视觉·模型列表 | 无 |
| `gemini` | Google Gemini | gemini | `https://generativelanguage.googleapis.com/v1beta` | 文生图·图生图·多图·编辑·视觉·模型列表 | 无 |
| `custom` | 自定义网站 | openai 兼容 | （用户填写） | 文生图·图生图·视觉·模型列表 | 无 |

### 7.2 统一适配器接口

每个 Provider 必须实现：

| 方法 | 说明 | 失败时 |
|---|---|---|
| `testConnection()` | 最小代价地验证「可达 + 鉴权通过」，返回延迟 | 返回具体错误码，不抛裸异常 |
| `listModels()` | 「拉取模型」按钮调用；返回模型 id 列表 | 不支持的返回 `PROVIDER_UNSUPPORTED` |
| `capabilities()` | 返回实际可用能力（可能因账号权限少于声明） | — |
| `submit(job)` | 提交任务，返回 `remoteId` | 映射到标准错误码 |
| `poll(remoteId)` / `subscribe(remoteId)` | 拿状态与进度 | — |
| `fetchResults(remoteId)` | 取结果图字节 | — |
| `cancel(remoteId)` | 取消 | 不支持时返回 `JOB_CANCEL_UNSUPPORTED`，**不假装成功** |

### 7.3 错误映射（HTTP → 错误码）

| 情况 | 错误码 |
|---|---|
| 连接被拒 / DNS 失败 / 超时 | `PROVIDER_UNREACHABLE` / `PROVIDER_TIMEOUT` |
| 401 / 403 | `PROVIDER_AUTH_FAILED` |
| 429 | `PROVIDER_RATE_LIMIT` |
| 402 / 余额不足文案 | `PROVIDER_QUOTA_EXCEEDED` |
| 400 参数错 | `JOB_PARAM_INVALID`（带服务端原文） |
| 5xx | `PROVIDER_BAD_RESPONSE` |
| 响应非预期结构 | `PROVIDER_BAD_RESPONSE` |

### 7.4 ComfyUI 适配器细则

| 环节 | 接口 | 说明 |
|---|---|---|
| 健康检查 | `GET /system_stats` | 取 ComfyUI 版本、显存信息 |
| 能力发现 | `GET /object_info` | 采样器 / 调度器 / checkpoint / upscale 模型的真实列表；也用于依赖预检 |
| 上传图 | `POST /upload/image` (multipart) | 返回 `{name, subfolder, type}`，写进 `LoadImage.image` |
| 提交 | `POST /prompt` `{prompt, client_id}` | 返回 `prompt_id` |
| 进度 | `WS /ws?clientId=` | `status`（队列长度）、`progress`（value/max）、`executing`（node）、`executed`（输出）、`execution_error` |
| 取结果 | `GET /history/{prompt_id}` | 从 outputs 里取 images 列表 |
| 下载图 | `GET /view?filename=&subfolder=&type=` | 二进制 |
| 取消 · 排队中 | `POST /queue` `{delete:[prompt_id]}` | 队列中直接删 |
| 取消 · 运行中 | `POST /interrupt` | 中断当前执行 |
| 重启恢复 | 先 `GET /history/{prompt_id}` 与 `GET /queue` | **有结果就直接取，在队列里就继续等，都没有才判定丢失** —— 绝不重复提交 |

### 7.5 RunningHub 适配器细则

- 提交：创建任务（携带云端工作流 ID + 节点参数覆盖），返回 `taskId`。
- 进度：轮询任务状态（间隔从 1s 起指数退避到 5s），映射到 `remote_queued / running / result_ready`。
- 结果：任务完成后取结果文件 URL 并下载入资产库。
- 取消：**官方无取消接口**。UI 上「取消」按钮点击后：任务标记为 `cancel_requested`，显示明确文案「RunningHub 不支持取消，任务将继续在云端执行并计费」，并提供「仍然丢弃结果」选项（本地标记 cancelled，不再下载结果）。
- 上传：输入图先上传到 RunningHub 的文件接口，拿到引用后写进节点参数。

### 7.6 OpenAI 兼容族细则

- 文生图 / 图生图：`POST {baseUrl}/images/generations` 与 `/images/edits`；不同厂商字段差异由适配器内部归一化（`size` / `n` / `response_format`）。
- 视觉（反推）：`POST {baseUrl}/chat/completions`，消息里带 `image_url`（data URI）。
- 模型列表：`GET {baseUrl}/models`。
- 多图输入：只有声明 `multiImageInput` 的 Provider 才允许 >1 张；否则报 `PROVIDER_UNSUPPORTED`。
- 结果可能是 URL 或 base64，两种都要支持。

### 7.7 Gemini 细则

- 生成：`POST {baseUrl}/models/{model}:generateContent`，`contents` 里混合 text part 与 `inline_data`（base64 图）。
- 结果从 `candidates[].content.parts[].inline_data` 里取。
- 模型列表：`GET {baseUrl}/models`。
- 鉴权：`x-goog-api-key` 头。

### 7.8 Provider 选择规则

1. 该功能在「设置 → 固定功能」里有绑定 → 用绑定的。
2. 无绑定 → 按功能 `engine` 选：
   - `comfy-workflow` → `comfyui`；`comfyui` 未配置时不回退到云端，直接报 `WORKFLOW_NOT_BOUND` / `PROVIDER_NOT_CONFIGURED`。
   - `cloud-image` / `cloud-vision` → 第一个「已启用 + 已配置 + 具备所需能力」的闭源 Provider，按注册表顺序。
3. 界面上永远显示本次实际使用的 Provider 名称。

---

## 8. 工作流规格

### 8.1 内置工作流清单

存放于 `psai/workflows/`，每份含 `graph.json`（ComfyUI API 格式）+ `binding.json`（参数绑定表）+ `meta.json`。

| 工作流 ID | 绑定功能 | 技术路线 |
|---|---|---|
| `wf.wash.portrait` | 洗图/人像 | Checkpoint + img2img（VAEEncode → KSampler → VAEDecode） |
| `wf.wash.scene` | 洗图/场景 | 同上，参数与提示词侧重环境 |
| `wf.relight.fixed` | 光影溶图/固定视角 | IC-Light（`iclight_sd15_fbc`，前景+背景条件） |
| `wf.relight.adaptive` | 光影溶图/自适应视角 | IC-Light + 机位提示词 |
| `wf.edit.texture` | 图像编辑/质感加强 | 低 denoise img2img + 细节增强 |
| `wf.upscale.general` | 放大/通用放大 | UpscaleModel → img2img 补细节 |
| `wf.upscale.lossless` | 放大/无损放大 | UpscaleModel 单步，无采样器 |
| `wf.retouch.product` | 精修/产品 | 低 denoise img2img |
| `wf.retouch.person` | 精修/人物 | 低 denoise img2img |
| `wf.retouch.scene` | 精修/场景 | 低 denoise img2img |
| `wf.viewpoint.orbit` | 视角转换/360°旋转 | Flux Kontext 图像编辑（机位指令驱动） |

每份内置工作流**必须在真实 ComfyUI 上跑通并留下实测记录**（提交耗时、输出尺寸、所用模型），记录在 `docs/WORKFLOWS.md`。

### 8.2 参数绑定

绑定表把功能参数映射到节点输入：

```json
{
  "bindings": [
    { "paramId": "prompt",     "nodeId": "6",  "input": "text",        "required": false },
    { "paramId": "camera",     "nodeId": "6",  "input": "text",        "required": false,
      "transform": { "type": "appendText", "separator": ", " } },
    { "paramId": "seed",       "nodeId": "3",  "input": "seed",        "required": true },
    { "paramId": "steps",      "nodeId": "3",  "input": "steps",       "required": true },
    { "paramId": "cfg",        "nodeId": "3",  "input": "cfg",         "required": true },
    { "paramId": "denoise",    "nodeId": "3",  "input": "denoise",     "required": true },
    { "paramId": "sampler",    "nodeId": "3",  "input": "sampler_name","required": true },
    { "paramId": "image",      "nodeId": "10", "input": "image",       "required": true },
    { "paramId": "resolution", "nodeId": "11", "input": "width",       "required": false,
      "transform": { "type": "sizeWidth" } }
  ]
}
```

**变换类型：**

| 类型 | 作用 |
|---|---|
| `linear` | UI 的 [inMin,inMax] 线性映射到节点期望的 [outMin,outMax]。例：`realism` 0–1 → LoRA 强度 0.2–1.2 |
| `const` | 固定值，忽略 UI 取值 |
| `appendText` | 拼接到节点已有文本后（机位片段、稿型预设） |
| `int` | 取整 |
| `sizeWidth` / `sizeHeight` | 取 `resolveSize(比例, 分辨率)` 的宽 / 高 |
| `not` | 布尔取反 |

### 8.3 导入与扫描

| 步骤 | 行为 |
|---|---|
| 1 格式识别 | 顶层每个值都有 `class_type` → API 格式；有 `nodes[]` + `links[]` → UI 格式（转换为 API 格式后入库，转换失败明确报错） |
| 2 输出节点 | 找 `SaveImage` / `PreviewImage` / `SaveImageWebsocket`；一个都没有 → `WORKFLOW_NO_OUTPUT`，拒绝导入 |
| 3 字段扫描 | 遍历所有节点的 `inputs`，跳过连线型输入（值是 `[nodeId, slot]` 数组的），只收字面量 |
| 4 语义识别 | 按「节点类型 + 输入名」推断语义：`text`→prompt（若节点标题含 negative 则 negativePrompt）、`seed/noise_seed`→seed、`steps`、`cfg`、`denoise`、`sampler_name`、`scheduler`、`width`、`height`、`image`、`mask`、`ckpt_name`、`lora_name`、`model_name`(upscale)、`batch_size` |
| 5 自动绑定 | 语义命中的字段自动生成绑定建议 |
| 6 依赖收集 | 收集全部 `class_type` 与模型文件名 |
| 7 版本 | 计算 graph 的 sha256；同名工作流且 hash 不同 → 版本号次版本位 +1，旧版本保留 |

### 8.4 依赖预检

对当前 ComfyUI 的 `/object_info` 做比对：

- 缺节点 → 列出节点类型名，并给出「可能来自哪个自定义节点包」的提示（按已知映射表尽力而为，不确定时说不确定）。
- 缺模型 → 列出文件名与类别（checkpoint / lora / upscale / controlnet）。
- 预检不通过的功能在导航里显示 ⚠ 徽标，但**仍允许强制提交**（用户可能知道自己在做什么），提交失败时把 ComfyUI 的原始报错原文展示出来。

---

## 9. 作业引擎

### 9.1 状态机（18 态）

```
created ──► inputs_uploading ──► inputs_ready ──► queued_local ──► submitting ──► submitted
                                                                                     │
                                    ┌────────────────────────────────────────────────┤
                                    ▼                                                ▼
                              remote_queued ──────────► running ──► downloading ──► result_ready
                                                                                     │
                                                              ┌──────────────────────┤
                                                              ▼                      ▼
                                                     writeback_pending ──► writeback_running ──► succeeded
                                                                                     │
                                                                                     ▼
                                                                    retryable_writeback_failure
                                                                             （结果永久保留，可重试）

任意活动态 ──► cancel_requested ──► cancelled
任意活动态 ──► failed ──► （重试）──► queued_local
submitted/remote_queued/running/downloading ──► lost（Helper 重启后远端也查不到）
```

| 状态 | 中文 | 说明 |
|---|---|---|
| `created` | 已创建 | 记录已落库 |
| `inputs_uploading` | 上传输入中 | 快照导出并上传资产库 |
| `inputs_ready` | 输入就绪 | |
| `queued_local` | 本地排队中 | 等并发额度 |
| `submitting` | 提交中 | |
| `submitted` | 已提交 | 已拿到 remoteId |
| `remote_queued` | 远端排队中 | |
| `running` | 生成中 | 有进度百分比 |
| `downloading` | 下载结果中 | |
| `result_ready` | 结果就绪 | **AI 侧已成功** |
| `writeback_pending` | 等待写回 | 自动写回关闭时停在这里 |
| `writeback_running` | 写回中 | |
| `succeeded` | 已完成 | |
| `cancel_requested` | 取消中 | |
| `cancelled` | 已取消 | |
| `failed` | 失败 | |
| `retryable_writeback_failure` | 写回失败（结果已保留） | **不是失败终态**，结果仍在，可随时重试写回 |
| `lost` | 状态丢失 | 如实上报，请用户重新提交 |

**铁律**：`AI 成功` 与 `写回成功` 必须分离。任何写回问题都不得把任务标记为 `failed`，否则用户会以为要重新烧一次显卡。

### 9.2 并发与排队

- 本地 ComfyUI 默认并发 1（同一张卡上并行只会更慢）；云 Provider 可放宽到 4。
- 队列先进先出；取消队列中的任务不影响正在运行的任务。
- 并发计数在任务进入终态时释放；**释放逻辑必须幂等**（历史教训：重复释放会导致计数泄漏，最终卡死队列）。

### 9.3 重启恢复

Helper 启动时扫描所有非终态任务：

| 任务状态 | 恢复动作 |
|---|---|
| `created` / `inputs_uploading` / `inputs_ready` / `queued_local` | 重新入队 |
| `submitting` | 无 remoteId → 重新提交；有 remoteId → 按下一行处理 |
| `submitted` / `remote_queued` / `running` / `downloading` | **先查远端**：有结果 → 直接取结果；在队列/运行中 → 继续监听；查不到 → `lost` |
| `result_ready` / `writeback_pending` / `retryable_writeback_failure` | 保持不动，等插件来写回 |

**绝不因为「本地不知道状态」就重新提交** —— 那会造成重复计费与重复占卡。

### 9.4 取消

| Provider | 队列中 | 运行中 |
|---|---|---|
| ComfyUI | `POST /queue {delete:[id]}` 直接删 | `POST /interrupt` |
| RunningHub | 不支持 → 明确告知 | 不支持 → 明确告知，可选择丢弃结果 |
| OpenAI 兼容 / Gemini | 请求已发出，中止本地等待并标记丢弃 | 同左 |

### 9.5 进度

- ComfyUI：WS 的 `progress` 事件给 `value/max`，`executing` 给当前节点，直接映射。
- RunningHub：轮询给出的阶段映射到粗粒度进度（排队 0%、运行 50%、完成 100%），并注明「云端不提供细粒度进度」。
- 同步型闭源接口：无进度，显示不确定态进度条 + 已等待时长。

---

## 10. Photoshop 集成

### 10.1 上下文读取

面板常驻显示当前文档信息：文档名、活动图层名、画布尺寸、色彩模式与位深、是否有选区。通过 `photoshop.action.addNotificationListener` 监听 `select` / `open` / `close` / `make` 等事件实时刷新，并做 200ms 节流。

### 10.2 捕获（导出输入图）

全部在 `core.executeAsModal` 内执行，命令名统一为 `AI for PS: 捕获输入快照`。

| 来源 | 管线 |
|---|---|
| 当前图层 | `duplicate` 副本 → 隐藏所有图层 → 按 `index + name` 双校验显示目标图层 → `mergeVisibleLayers` → `saveAs.png(asCopy)` → 关闭副本 |
| 多选图层 | 同上，显示多个目标后合并 |
| 合并可见 | `duplicate` → `mergeVisibleLayers` → 保存 |
| 当前选区 | `duplicate` → `mergeVisibleLayers` → `batchPlay crop` 到**提交时记录的** selectionBounds → 保存 |
| 图层蒙版 | 导出该图层（蒙版在渲染时已生效），附带 `polarity: whiteEditable` 与 `maskMode: appliedPixels` 元数据 |

**约束：**

| 编号 | 规则 |
|---|---|
| C-01 | 输出到插件数据目录（`localFileSystem.getDataFolder()`），不申请 `fullAccess` 权限 |
| C-02 | 任何一步失败都要关闭已创建的副本文档，不留垃圾文档 |
| C-03 | 副本文档命名带唯一前缀，便于异常时人工识别清理 |
| C-04 | 快照连同 `documentId / documentName / documentPath / 画布尺寸 / 图层 id 与名称 / selectionBounds / 色彩模式 / 位深` 一起冻结进任务 |
| C-05 | 独立蒙版灰度通道导出属增强项，v1.0 如实标注为「导出蒙版后像素」而非「导出蒙版通道」 |

### 10.3 写回

| 方式 | 管线 |
|---|---|
| 新建智能对象图层 | `batchPlay placeEvent`（ScriptListener 动作格式，全版本稳定）；置入后按模板重命名图层 |
| 新建像素图层 | `batchPlay open` 结果文件 → `selectAll` + `copy` → **按任务冻结的 documentId 找回目标文档并显式激活** → `paste` → 关闭临时结果文档 |
| 选区原位替换 | 先按上面任一方式置入 → 读**置入后图层的真实 bounds** → 按目标 selectionBounds 计算 `scale(百分比, AnchorPosition.TOPLEFT)` → 重读 bounds → `translate` 到目标左上角 |
| 仅存资产库 | 不碰 Photoshop |

**关键教训（必须遵守）：**

| 编号 | 规则 |
|---|---|
| B-01 | `open` 结果文件后 `activeDocument` 是结果文档，**绝不能**把它当成目标 PSD；必须用冻结的 documentId 找回目标文档并显式 `batchPlay select` 激活 |
| B-02 | 选区原位不能假设置入位置在画布中心，必须读真实 bounds 再算缩放与平移 |
| B-03 | 缩放百分比要钳制（0.1% – 4000%），防止极端值把图层缩没 |
| B-04 | 选区原位用**任务创建时**记录的 selectionBounds，不读"当前选区" |
| B-05 | 找目标文档 / 目标图层必须递归进组（嵌套组内的图层也要找得到） |

### 10.4 写回前安全校验 `validateWritebackTarget`

按顺序检查，任一不通过就**不写回**，任务转入 `retryable_writeback_failure`，结果保留：

| 检查 | 不通过时的错误码 |
|---|---|
| 任务带有完整 target 信息 | `WRITEBACK_TARGET_INVALID` |
| 冻结的 documentId 对应的文档仍然打开 | `PHOTOSHOP_DOCUMENT_NOT_FOUND` |
| 画布尺寸与冻结值一致 | `WRITEBACK_DOCUMENT_CHANGED` |
| 冻结的源图层 id 仍然存在（递归查找） | `PHOTOSHOP_LAYER_NOT_FOUND` |
| 当前没有其他模态操作占用 | `PHOTOSHOP_MODAL_BUSY` |

用户可以在历史页里，等文档重新打开后再点「再次写回」，校验会重新跑一遍。

### 10.5 UXP 环境约束

| 约束 | 应对 |
|---|---|
| 无 npm 运行时 | 插件代码 esbuild 打成单个 IIFE bundle |
| CSS 3D 变换不可靠 | 立方体用 SVG 等轴测投影 |
| CSS Grid 支持不完整 | 布局以 flexbox 为主 |
| 没有 `localStorage` | UI 偏好走 UXP 的 `storage.secureStorage` 与 Helper 设置接口 |
| 文件选择必须走 `localFileSystem` | 不使用 `<input type=file>` |
| 网络域名需在 manifest 声明 | `requiredPermissions.network.domains` 列出 Helper 地址；Helper 之外的域名一律不由插件直连 |
| webview 需要单独权限 | `requiredPermissions.webview`，真机验证放行策略后决定走内嵌还是降级 |

---

## 11. 数据模型与 API 契约

### 11.1 SQLite Schema（schemaVersion = 1）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `meta` | `key`, `value` | schema 版本、安装 id、首次启动时间 |
| `settings` | `key`, `json`, `updated_at` | 分组存储 `AppSettings` |
| `pairing` | `token_hash`, `client`, `created_at`, `last_seen_at`, `revoked` | 配对 token 只存哈希 |
| `credentials` | `provider_id`, `cipher`, `created_at`, `updated_at` | DPAPI 密文；**明文永不落盘** |
| `providers` | `id`, `enabled`, `base_url`, `default_model`, `models_json`, `last_status_json`, `last_checked_at` | |
| `workflows` | `id`, `name`, `version`, `source`, `format`, `graph_json`, `bindings_json`, `output_nodes_json`, `required_nodes_json`, `required_models_json`, `hash`, `feature_id`, `notes`, `created_at`, `updated_at` | 同名多版本并存 |
| `feature_bindings` | `feature_id`(PK), `provider_id`, `workflow_id`, `remote_workflow_id`, `model`, `enabled` | |
| `assets` | `id`, `sha256`, `mime`, `bytes`, `width`, `height`, `rel_path`, `kind`, `created_at`, `ref_count` | sha256 去重 |
| `jobs` | 见 §9 `JobRecord` 全字段 | |
| `job_inputs` | `job_id`, `param_id`, `asset_id`, `idx`, `source` | |
| `job_results` | `job_id`, `asset_id`, `idx`, `width`, `height`, `bytes` | |
| `job_events` | `id`, `job_id`, `at`, `from_state`, `to_state`, `note`, `error_code` | 全量状态流转审计 |
| `prompt_presets` | `id`, `label`, `kind`, `scope_json`, `prompt`, `negative_prompt`, `builtin`, `created_at`, `updated_at` | |
| `documents` | `document_id`, `name`, `path`, `last_seen_at` | 历史按文档筛选 |
| `usage` | `id`, `job_id`, `provider_id`, `at`, `gpu_ms`, `note` | 本地 GPU 时长如实记录；云费用不臆造 |

**迁移规则**：启动时比对 `meta.schema_version` → 不一致则先把 db 文件备份到 `backup/db-<时间戳>.sqlite` → 执行迁移 → 迁移抛错则回滚到备份并拒绝启动（把原因写进日志与 `/v1/health`）。

### 11.2 REST API

基址 `http://127.0.0.1:34117`。除标注为公开的以外，全部需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/health` | **公开**。在线状态、版本、schema 版本、ComfyUI 摘要 |
| POST | `/v1/pair/request` | **公开**。返回一次性 challenge |
| POST | `/v1/pair/confirm` | **公开**。用 challenge 换长期 token |
| GET | `/v1/system` | 系统信息（OS、内存、数据目录） |
| GET | `/v1/gpu` | GPU 信息；读不到时带 `reason` |
| GET / PATCH | `/v1/settings` | 读 / 增量更新 `AppSettings` |
| GET | `/v1/providers` | 全部 Provider 的运行时状态 |
| GET / PATCH | `/v1/providers/:id` | 单个读 / 改（启用、地址、默认模型） |
| POST / DELETE | `/v1/providers/:id/credentials` | 写入 / 清除 API Key（DPAPI） |
| POST | `/v1/providers/:id/test` | 「验证」：可达性 + 鉴权 + 延迟 + 能力 |
| GET | `/v1/providers/:id/models` | 「拉取模型」 |
| GET | `/v1/comfy/object-info` | 采样器/调度器/checkpoint/upscale 模型真实列表 |
| GET | `/v1/comfy/queue` | ComfyUI 队列 |
| POST | `/v1/comfy/queue/:promptId/cancel` | 取消队列或运行中的 ComfyUI 任务 |
| GET | `/v1/features` | 目录 + 绑定 + 就绪状态（导航渲染用） |
| PUT | `/v1/features/:id/binding` | 修改功能绑定 |
| GET | `/v1/workflows` | 工作流列表 |
| GET | `/v1/workflows/:id` | 详情（含 graph 与绑定） |
| POST | `/v1/workflows/scan` | 只扫描不入库，返回 `ScanResult` |
| POST | `/v1/workflows/import` | 导入并入库（自动版本化） |
| PUT | `/v1/workflows/:id/bindings` | 保存绑定表 |
| GET | `/v1/workflows/:id/dependencies` | 依赖预检 |
| DELETE | `/v1/workflows/:id` | 删除（内置不可删） |
| POST | `/v1/assets` | multipart 上传，返回 assetId（sha256 去重） |
| GET | `/v1/assets/:id` | 原图字节 |
| GET | `/v1/assets/:id/thumb` | 缩略图 |
| POST | `/v1/jobs` | 创建任务 |
| GET | `/v1/jobs` | 列表（按状态/功能/文档筛选、分页） |
| GET | `/v1/jobs/:id` | 详情 |
| GET | `/v1/jobs/:id/events` | 状态流转事件流 |
| POST | `/v1/jobs/:id/cancel` | 取消 |
| POST | `/v1/jobs/:id/retry` | 重试（失败态） |
| POST | `/v1/jobs/:id/writeback-result` | 插件上报写回结果（成功/失败+原因） |
| DELETE | `/v1/jobs/:id` | 删除 |
| GET / POST | `/v1/prompts` | 预设列表 / 新建自定义预设 |
| PUT / DELETE | `/v1/prompts/:id` | 编辑（含恢复默认）/ 删除自定义预设 |
| POST | `/v1/text/reverse` | 反推：图 + 预设 → 文本 |
| POST | `/v1/text/enhance` | 提示词优化 |

### 11.3 WebSocket

`ws://127.0.0.1:34117/v1/events?token=<token>`

| 事件 | 载荷 |
|---|---|
| `hello` | 版本、schema 版本 |
| `job:update` | 完整 `JobRecord` |
| `job:event` | 单条状态流转 |
| `provider:status` | Provider 上下线 |
| `gpu` | GPU 采样（2s 一次，仅在有活动任务时推送） |

断线后插件按 1s→2s→5s 退避重连；重连成功后主动拉一次任务列表补齐丢失的更新。

### 11.4 统一响应格式

成功：`{ "ok": true, ...payload }`
失败：`{ "ok": false, "error": { "code": "PROVIDER_AUTH_FAILED", "message": "鉴权失败（API Key 无效或过期）", "details": "...", "retryable": false } }`

HTTP 状态码与 `error.code` 一一对应，不允许 200 里塞失败。

---

## 12. 安全与隐私

| 编号 | 要求 |
|---|---|
| S-01 | Helper **仅监听 `127.0.0.1`**。局域网访问需要用户在设置里显式开启，且开启时强制要求设置访问密码。 |
| S-02 | 插件与 Helper 之间用两段式配对：`/v1/pair/request` 返回一次性 challenge（60 秒有效、用后即焚），`/v1/pair/confirm` 换取长期 token。 |
| S-03 | 长期 token 存 UXP `secureStorage`；Helper 侧**只存哈希**，不存原文。 |
| S-04 | API Key 只存在 Helper，用 Windows DPAPI（`CurrentUser` 作用域）加密；数据库里只有密文。 |
| S-05 | 插件**永远不接触** API Key，界面上只显示掩码（`sk-••••••1234`）。 |
| S-06 | 日志、诊断包、错误详情里对任何形如密钥的字符串做脱敏。 |
| S-07 | 插件不直连任何第三方 AI 服务；manifest 的网络域名白名单只包含 Helper 地址。所有外呼由 Helper 发起。 |
| S-08 | 用户图像默认只在本机流转；使用云 Provider 时，提交前在界面上明确提示「本次会把图片上传到 <平台名>」，首次使用需确认一次。 |
| S-09 | 卸载时询问是否删除数据目录（任务历史与资产）；默认保留。 |
| S-10 | Helper 单实例锁，防止多份实例抢同一个数据库。 |

---

## 13. 非功能需求

| 维度 | 指标 |
|---|---|
| 面板首次可交互 | ≤ 1.5s（Helper 已在运行时） |
| 导航切换 | ≤ 100ms |
| 捕获当前图层（4000×4000 文档） | ≤ 3s |
| 参数变更到 UI 反馈 | ≤ 16ms（不掉帧） |
| Helper 常驻内存 | ≤ 150MB（无活动任务时） |
| 面板在 360px 宽度 | 全部功能可用，单列布局 |
| 崩溃恢复 | Helper 异常退出后由自启动项拉起；任务状态不丢 |
| 可观测性 | 日志按天切分，保留 14 天；每个任务的完整状态流转可回溯 |
| i18n | 简体中文（默认）/ English，文案集中在 `i18n` 模块，不硬编码在组件里 |
| 无障碍 | 全部交互元素可键盘到达；颜色不是唯一的状态区分手段（同时用图标+文案） |
| 主题 | 跟随 Photoshop 的深/浅主题（`uxp.host.theme`） |

---

## 14. 边界情况清单

| # | 场景 | 期望行为 |
|---|---|---|
| E-01 | 提交后切换到别的文档 | 任务继续；写回时按冻结的 documentId 找回原文档并激活 |
| E-02 | 提交后关闭了源文档 | 写回失败 → `retryable_writeback_failure`，结果保留；文档重开后可在历史页再次写回 |
| E-03 | 提交后改了画布尺寸 | 写回被拦截，`WRITEBACK_DOCUMENT_CHANGED`，提示用户改用「新建图层」方式 |
| E-04 | 提交后删了源图层 | 智能对象/像素层写回照常；选区原位提示源图层已不存在 |
| E-05 | Photoshop 正在弹模态对话框 | `PHOTOSHOP_MODAL_BUSY`，自动重试 3 次（间隔 2s）后转 `retryable_writeback_failure` |
| E-06 | ComfyUI 中途掉线 | WS 断开 → 轮询 `/history` 兜底 → 恢复后继续；超过 60s 无响应标记失败并保留 remoteId 供恢复 |
| E-07 | Helper 被杀 / 重启 | 按 §9.3 恢复；先查远端不重复提交 |
| E-08 | 显存不足（ComfyUI 报 OOM） | 原样展示 ComfyUI 报错，并建议降低分辨率或放大倍数 |
| E-09 | 磁盘写满 | 上传/下载失败明确报错；Helper 在数据目录剩余空间 < 1GB 时提前警告 |
| E-10 | API Key 过期 | `PROVIDER_AUTH_FAILED`，界面直接给「去设置里更新 Key」的跳转 |
| E-11 | 云端限流 | `PROVIDER_RATE_LIMIT`，指数退避自动重试 3 次，仍失败则如实报告 |
| E-12 | 用户重复点「开始处理」 | 按钮提交后立即禁用直到任务进入队列；重复提交生成独立任务，不合并 |
| E-13 | 输入图超过 64MB | 上传前拒绝并提示 |
| E-14 | 图生图上传第 11 张 | 拒绝并提示上限 10 张 |
| E-15 | 所选模型不支持多图 | `PROVIDER_UNSUPPORTED` + 「只用第 1 张 / 换模型」二选一，绝不静默丢图 |
| E-16 | 工作流依赖的节点没装 | 导航里 ⚠ 徽标；仍可强制提交，失败时展示 ComfyUI 原始报错 |
| E-17 | 导入的工作流没有输出节点 | 导入时就拒绝，`WORKFLOW_NO_OUTPUT` |
| E-18 | 插件与 Helper 版本不一致 | 顶部红条警示 + 设置页显示两边版本；阻止提交新任务 |
| E-19 | 未配对 / token 失效 | 自动尝试重新配对一次；失败则引导用户手动重新配对 |
| E-20 | 同一张图重复使用 | sha256 去重，不重复存储也不重复上传到 ComfyUI |
| E-21 | 立方体拖到接近正顶/正底 | 稳定度降为 `C`，显示黄色警示条 |
| E-22 | 提示词为空但功能要求必填 | 提交拦截，输入框红框 + 具体提示 |
| E-23 | RunningHub 任务点了取消 | 明确告知不支持取消、会继续计费；提供「仍然丢弃结果」 |
| E-24 | 多个 Photoshop 文档同时用插件 | 每个任务绑定自己的 documentId；历史页可按文档筛选 |
| E-25 | 系统休眠后唤醒 | WS 重连；活动任务重新拉状态对齐 |

---

## 15. 安装、升级与分发

### 15.1 交付物

| 文件 | 说明 |
|---|---|
| `AI-for-PS-Setup.exe` | NSIS 安装器：安装 Helper、注册开机自启、写入卸载信息 |
| `AI-for-PS-Helper.exe` | Node SEA 单文件可执行，无需用户装 Node |
| `AI-for-PS.ccx` | Photoshop 插件包 |
| `checksums.txt` | 全部交付物的 SHA-256 |
| `CHANGELOG.md` | 变更记录 |

### 15.2 安装流程

1. 运行 `AI-for-PS-Setup.exe` → 安装 Helper 到 `%LOCALAPPDATA%\AIforPS`，注册自启动，立即启动一次。
2. 双击 `AI-for-PS.ccx` 由 Creative Cloud 安装插件（开发阶段用 UXP Developer Tool 加载源目录）。
3. 打开 Photoshop → 增效工具 → AI 面板 → 插件自动发现 Helper 并完成配对（无需用户操作）。
4. 首次进入设置页，引导三步：① 确认 ComfyUI 地址 ② 依赖检查 ③（可选）配置一个闭源 Provider。

### 15.3 升级与回滚

| 项 | 策略 |
|---|---|
| Helper | 安装器覆盖安装；升级前自动备份数据库 |
| 数据库 | 迁移前备份 → 迁移 → 失败回滚到备份并拒绝启动，把原因写进 `/v1/health` |
| 插件 | 通过 Creative Cloud / 重新加载 `.ccx` |
| 版本不匹配 | 插件与 Helper 主版本不一致时阻止提交新任务，并给出升级指引 |
| 内置工作流 | 随插件版本更新；用户对内置工作流的修改会另存为「导入工作流」，不会被覆盖 |

### 15.4 已知分发限制

- `.ccx` 未经 Adobe 签名时只能通过 UXP Developer Tool 以开发模式加载。正式分发需要 Adobe 开发者账号签名。
- macOS 版本不在 v1.0 范围内（DPAPI 需换成 Keychain，安装器需换成 pkg）。

---

## 16. 验收标准与里程碑

### 16.1 门禁（每一项都必须有真实执行输出）

| 门禁 | 命令 / 方式 | 通过标准 |
|---|---|---|
| 类型检查 | `npm run typecheck` | 三个包全绿 |
| 语法与规范 | `npm run lint` | 全绿 |
| 清单校验 | `npm run validate` | manifest 与入口 id 一致 |
| 自动化测试 | `npm test` | 全部套件通过 |
| 内置工作流实测 | `npm run test:comfy:real` | 11/11 在真实 ComfyUI 上出图 |
| 真机验收 | `docs/ACCEPTANCE.md` | 全部场景通过 |

### 16.2 真机验收场景（在 Photoshop 2026 中执行）

| # | 场景 | 通过标准 |
|---|---|---|
| A-01 | 插件加载与自动配对 | 面板打开，状态条 Helper 绿，无需手动操作 |
| A-02 | 重启 Photoshop 后插件仍在 | 面板可再次打开，历史仍在 |
| A-03 | 捕获当前图层 | 缩略图正确，尺寸与图层一致 |
| A-04 | 捕获选区 | 缩略图为选区范围内容 |
| A-05 | 洗图/人像 端到端 | 出图并写回为智能对象图层 |
| A-06 | 全部 11 个 ComfyUI 固定功能 | 逐个出图并写回成功 |
| A-07 | 选区原位写回 | 结果精确覆盖原选区范围，位置尺寸无偏差 |
| A-08 | 像素图层写回 | 目标文档正确（不是结果临时文档） |
| A-09 | 切换文档后写回 | 自动切回源文档写入 |
| A-10 | 关闭源文档后写回 | 报「结果已保留」，历史页可再次写回 |
| A-11 | 改画布尺寸后写回 | 被拦截并给出原因 |
| A-12 | 取消排队中的任务 | 仅取消目标任务，运行中的不受影响 |
| A-13 | 取消运行中的任务 | ComfyUI 被 interrupt，状态转 cancelled |
| A-14 | Helper 重启恢复 | 运行中的任务恢复后不重复提交，结果正确 |
| A-15 | 3D 立方体 | 角度、视角名称、稳定度徽章三者一致；结果机位随之变化 |
| A-16 | 导入自定义工作流 | 参数正确扫描出来并可调节，能出图 |
| A-17 | ComfyUI Web 面板 | 内嵌或降级路径可用，W-01~W-05 全部可用 |
| A-18 | 闭源模型文生图 | 出图并写回（需要真实 API Key） |
| A-19 | 图生图 10 张上限 | 第 11 张被拒 |
| A-20 | 未配置 Provider | 功能显示禁用 + 原因，点击可跳到设置 |

### 16.3 里程碑

| 阶段 | 内容 | 门禁 |
|---|---|---|
| P0 | 脚手架与工具链 | `npm run check` 绿 |
| P1 | 本文档 | 5 级 IA 全覆盖，每功能有参数表与验收标准 |
| P2 | 共享契约层 | 目录完整性测试通过 |
| P3 | Helper 骨架 | 集成测试全绿 |
| P4 | ComfyUI 适配器 | 对真实 ComfyUI 跑通提交/进度/结果/取消/恢复 |
| P5 | 11 份内置工作流 | 11/11 真实出图 |
| P6 | 插件骨架与 PhotoshopBridge | 真机验证捕获与三种写回 |
| P7 | 生成页 | ComfyUI 分支 11 功能端到端 |
| P8 | ComfyUI Web 面板 | 路径判定 + W-01~W-05 |
| P9 | 历史页与设置页 | 设置实时生效并持久化 |
| P10 | 云端与闭源 Provider | 协议测试全绿 + 有 Key 的真账号验证 |
| P11 | 打包与验收 | 全部门禁绿 + 真机验收全过 → 标 1.0.0 |

### 16.4 版本纪律

**未通过全部门禁一律不标 1.0.0。** 任何未验证的能力必须出现在「已知限制」里，不得在文档、界面或提交信息中表述为已完成。

---

## 附录 A · 功能与参数索引

| 功能 ID | 路径 | 引擎 | 内置工作流 | 参数数 |
|---|---|---|---|---|
| `comfy.wash.portrait` | 生成/comfyui/洗图/人像 | comfy-workflow | `wf.wash.portrait` | 13 |
| `comfy.wash.scene` | 生成/comfyui/洗图/场景 | comfy-workflow | `wf.wash.scene` | 13 |
| `comfy.relight.fixed` | 生成/comfyui/光影溶图/固定视角 | comfy-workflow | `wf.relight.fixed` | 13 |
| `comfy.relight.adaptive` | 生成/comfyui/光影溶图/自适应视角 | comfy-workflow | `wf.relight.adaptive` | 14 |
| `comfy.edit.texture` | 生成/comfyui/图像编辑/质感加强 | comfy-workflow | `wf.edit.texture` | 11 |
| `comfy.misc.upscale.general` | 生成/comfyui/其他功能/放大/通用放大 | comfy-workflow | `wf.upscale.general` | 9 |
| `comfy.misc.upscale.lossless` | 生成/comfyui/其他功能/放大/无损放大 | comfy-workflow | `wf.upscale.lossless` | 3 |
| `comfy.misc.retouch.product` | 生成/comfyui/其他功能/精修/产品 | comfy-workflow | `wf.retouch.product` | 11 |
| `comfy.misc.retouch.person` | 生成/comfyui/其他功能/精修/人物 | comfy-workflow | `wf.retouch.person` | 11 |
| `comfy.misc.retouch.scene` | 生成/comfyui/其他功能/精修/场景 | comfy-workflow | `wf.retouch.scene` | 11 |
| `comfy.misc.viewpoint.orbit` | 生成/comfyui/其他功能/视角转换/360°旋转 | comfy-workflow | `wf.viewpoint.orbit` | 11 |
| `comfy.custom` | 生成/comfyui/自定义工作流 | comfy-workflow | （用户绑定） | 动态 |
| `cloud.wash` | 生成/闭源模型/洗图·去噪 | cloud-image | — | 9 |
| `cloud.t2i` | 生成/闭源模型/文生图 | cloud-image | — | 7 |
| `cloud.i2i` | 生成/闭源模型/图生图 | cloud-image | — | 9 |
| `cloud.product.multiview` | 生成/闭源模型/高质量产品渲染/产品多视角 | cloud-image | — | 10 |
| `cloud.product.whitebg` | 生成/闭源模型/高质量产品渲染/精修白底图 | cloud-image | — | 7 |

## 附录 B · 错误码总表

见 `packages/shared/src/errors.ts`。共 8 组：环境、Helper 连接、Provider、工作流、作业、写回、资产、其他。

可自动重试的错误码：`PROVIDER_UNREACHABLE`、`PROVIDER_RATE_LIMIT`、`PROVIDER_TIMEOUT`、`PROVIDER_BAD_RESPONSE`、`WRITEBACK_FAILED`、`PHOTOSHOP_MODAL_BUSY`。
