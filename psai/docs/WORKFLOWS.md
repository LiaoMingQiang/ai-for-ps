# 内置工作流

本文件由 `node tools/build-workflows-doc.mjs` 生成，数据来自 `psai/workflows/` 下的实际文件，不要手工编辑。

## 为什么每个滑杆都必须有落点

参考图谱把「真实感 / 光影 / 强度」画成一排共享参数，看上去每个功能都该有这三个滑杆。
但同一个滑杆在不同功能里未必都有对应的节点输入 —— 摆一个转不动的旋钮，比不摆更糟：用户会以为自己调了，实际什么也没发生。

所以这里的规则是：**功能声明的每个参数，都必须在它绑定的工作流里落到某个真实的节点输入上**。
`packages/helper/test/builtin-workflows.test.mjs` 里的「面板上没有转不动的旋钮」这条测试会强制这一点。

语义滑杆到节点输入的映射：

| 滑杆 | 落到哪 | 映射区间 | 为什么这么接 |
|---|---|---|---|
| 真实感 | `KSampler.cfg` | 0–1 → 4.5–9 | 工作流的正向提示词里埋了写实细节词，CFG 越高越贴合这组词 |
| 质感强度 | `KSampler.cfg` | 0–1 → 5–10 | 同上，提示词种子换成材质微结构 |
| 光影 | `ICLightConditioning.multiplier` | 0–1 → 0.1–1.0 | IC-Light 自己就有重打光强度这个输入 |
| 精修强度 | `KSampler.denoise` | 0–1 → 0.05–0.5 | 精修就是低幅度重绘，量程收窄保证不会把画面重画 |
| 视角改动幅度 | `KSampler.denoise` | 0–1 → 0.4–0.95 | 改机位需要较高幅度才推得动 |
| 重绘幅度 | `KSampler.denoise` | 直连 | |
| 分辨率 | `ImageScale.width/height` | 按输入图比例推导 | 图生图保持原始长宽比，只把长边缩到该值 |
| 放大倍数 | `ImageScaleBy.scale_by` | 转为数字 | 分段控件的值是字符串 |
| 摄像机 | 正向提示词节点 | 追加 | 机位翻译成英文片段拼在用户提示词后，不覆盖 |

## 出厂模型

全部基于 SD1.5 系：显存友好、出图快，而且 IC-Light 只支持 SD1.5。

| 用途 | 模型 |
|---|---|
| 写实（人像 / 产品 / 精修 / 放大 / 视角） | `majicmix_realistic_v7.safetensors` |
| 重打光底模 | `v1-5-pruned-emaonly-fp16.safetensors` + `IC-Light\iclight_sd15_fbc.safetensors` |

换模型：在「设置 → 工作流」里改对应工作流的 `ckpt_name`，或者导入自己的工作流再到「设置 → 固定功能」重新绑定。

## 清单

| 功能 | 工作流 | 节点数 | 绑定数 | 实测 |
|---|---|---|---|---|
| comfyui / 洗图 / 人像 | `wf.wash.portrait` | 9 | 11 | 512×512 · 2.7s |
| comfyui / 洗图 / 场景 | `wf.wash.scene` | 9 | 11 | 512×512 · 2.7s |
| comfyui / 光影溶图 / 固定视角 | `wf.relight.fixed` | 14 | 15 | 512×512 · 6.4s |
| comfyui / 光影溶图 / 自适应视角 | `wf.relight.adaptive` | 14 | 16 | 512×512 · 3.0s |
| comfyui / 图像编辑 / 质感加强 | `wf.edit.texture` | 9 | 11 | 512×512 · 5.0s |
| comfyui / 其他功能 / 放大 / 通用放大 | `wf.upscale.general` | 9 | 10 | 1536×1536 · 11.4s |
| comfyui / 其他功能 / 放大 / 无损放大 | `wf.upscale.lossless` | 3 | 3 | 1536×1536 · 1.4s |
| comfyui / 其他功能 / 精修 / 产品 | `wf.retouch.product` | 9 | 11 | 512×512 · 3.7s |
| comfyui / 其他功能 / 精修 / 人物 | `wf.retouch.person` | 9 | 11 | 512×512 · 2.7s |
| comfyui / 其他功能 / 精修 / 场景 | `wf.retouch.scene` | 9 | 11 | 512×512 · 2.7s |
| comfyui / 其他功能 / 视角转换 / 360° 旋转 | `wf.viewpoint.orbit` | 9 | 12 | 512×512 · 2.7s |

## comfyui / 洗图 / 人像

- **功能 ID**：`comfy.wash.portrait`
- **工作流**：`wf.wash.portrait` v1.0.0
- **说明**：真实感滑杆映射到 KSampler.cfg（4.5–9），重绘幅度直连 KSampler.denoise。

### 节点

| ID | 类型 | 标题 |
|---|---|---|
| `1` | `CheckpointLoaderSimple` | 基础模型 |
| `2` | `LoadImage` | 输入图 |
| `3` | `KSampler` | 采样器 |
| `4` | `CLIPTextEncode` | 正向提示词 |
| `5` | `CLIPTextEncode` | Negative 负向提示词 |
| `6` | `VAEEncode` | 编码主图 |
| `7` | `ImageScale` | 缩放到目标尺寸 |
| `8` | `VAEDecode` | 解码 |
| `9` | `SaveImage` | 输出 |

### 参数绑定

| 参数 | 节点.输入 | 变换 | 必填 |
|---|---|---|---|
| 图像输入 `image` | `2.image` | 直连 | 是 |
| 提示词 `prompt` | `4.text` | 直连 | 否 |
| 负向提示词 `negativePrompt` | `5.text` | 直连 | 否 |
| 随机种子 `seed` | `3.seed` | 直连 | 是 |
| 步数 `steps` | `3.steps` | 直连 | 否 |
| 采样器 `sampler` | `3.sampler_name` | 直连 | 否 |
| 调度器 `scheduler` | `3.scheduler` | 直连 | 否 |
| 分辨率 `resolution` | `7.width` | 取推导出的宽 | 否 |
| 分辨率 `resolution` | `7.height` | 取推导出的高 | 否 |
| 重绘幅度 `denoise` | `3.denoise` | 直连 | 否 |
| 真实感 `realism` | `3.cfg` | 线性映射 0–1 → 4.5–9 | 否 |

## comfyui / 洗图 / 场景

- **功能 ID**：`comfy.wash.scene`
- **工作流**：`wf.wash.scene` v1.0.0
- **说明**：与人像同构，提示词种子与默认重绘幅度偏向环境重绘。

### 节点

| ID | 类型 | 标题 |
|---|---|---|
| `1` | `CheckpointLoaderSimple` | 基础模型 |
| `2` | `LoadImage` | 输入图 |
| `3` | `KSampler` | 采样器 |
| `4` | `CLIPTextEncode` | 正向提示词 |
| `5` | `CLIPTextEncode` | Negative 负向提示词 |
| `6` | `VAEEncode` | 编码主图 |
| `7` | `ImageScale` | 缩放到目标尺寸 |
| `8` | `VAEDecode` | 解码 |
| `9` | `SaveImage` | 输出 |

### 参数绑定

| 参数 | 节点.输入 | 变换 | 必填 |
|---|---|---|---|
| 图像输入 `image` | `2.image` | 直连 | 是 |
| 提示词 `prompt` | `4.text` | 直连 | 否 |
| 负向提示词 `negativePrompt` | `5.text` | 直连 | 否 |
| 随机种子 `seed` | `3.seed` | 直连 | 是 |
| 步数 `steps` | `3.steps` | 直连 | 否 |
| 采样器 `sampler` | `3.sampler_name` | 直连 | 否 |
| 调度器 `scheduler` | `3.scheduler` | 直连 | 否 |
| 分辨率 `resolution` | `7.width` | 取推导出的宽 | 否 |
| 分辨率 `resolution` | `7.height` | 取推导出的高 | 否 |
| 重绘幅度 `denoise` | `3.denoise` | 直连 | 否 |
| 真实感 `realism` | `3.cfg` | 线性映射 0–1 → 4.5–9 | 否 |

## comfyui / 光影溶图 / 固定视角

- **功能 ID**：`comfy.relight.fixed`
- **工作流**：`wf.relight.fixed` v1.0.0
- **说明**：光影滑杆映射到 ICLightConditioning.multiplier（0.1–1.0），机位不动。

### 节点

| ID | 类型 | 标题 |
|---|---|---|
| `1` | `CheckpointLoaderSimple` | 基础模型 |
| `2` | `LoadImage` | 输入图 |
| `3` | `KSampler` | 采样器 |
| `4` | `CLIPTextEncode` | 正向提示词 |
| `5` | `CLIPTextEncode` | Negative 负向提示词 |
| `6` | `VAEEncode` | 编码主图 |
| `7` | `ImageScale` | 缩放到目标尺寸 |
| `8` | `VAEDecode` | 解码 |
| `9` | `SaveImage` | 输出 |
| `10` | `LoadAndApplyICLightUnet` | IC-Light 重打光模型 |
| `11` | `LoadImage` | 背景 / 参考光图 |
| `12` | `ImageScale` | 缩放背景 |
| `13` | `VAEEncode` | 编码背景 |
| `15` | `ICLightConditioning` | IC-Light 条件 |

### 参数绑定

| 参数 | 节点.输入 | 变换 | 必填 |
|---|---|---|---|
| 主体图 `image` | `2.image` | 直连 | 是 |
| 背景 / 参考光图 `background` | `11.image` | 直连 | 是 |
| 提示词 `prompt` | `4.text` | 直连 | 否 |
| 负向提示词 `negativePrompt` | `5.text` | 直连 | 否 |
| 随机种子 `seed` | `3.seed` | 直连 | 是 |
| 步数 `steps` | `3.steps` | 直连 | 否 |
| 采样器 `sampler` | `3.sampler_name` | 直连 | 否 |
| 调度器 `scheduler` | `3.scheduler` | 直连 | 否 |
| CFG `cfg` | `3.cfg` | 直连 | 否 |
| 重绘幅度 `denoise` | `3.denoise` | 直连 | 否 |
| 分辨率 `resolution` | `7.width` | 取推导出的宽 | 否 |
| 分辨率 `resolution` | `7.height` | 取推导出的高 | 否 |
| 分辨率 `resolution` | `12.width` | 取推导出的宽 | 否 |
| 分辨率 `resolution` | `12.height` | 取推导出的高 | 否 |
| 光影 `lighting` | `15.multiplier` | 线性映射 0–1 → 0.1–1 | 否 |

## comfyui / 光影溶图 / 自适应视角

- **功能 ID**：`comfy.relight.adaptive`
- **工作流**：`wf.relight.adaptive` v1.0.0
- **说明**：在固定视角基础上，把摄像机立方体翻译出的英文机位片段追加到正向提示词。

### 节点

| ID | 类型 | 标题 |
|---|---|---|
| `1` | `CheckpointLoaderSimple` | 基础模型 |
| `2` | `LoadImage` | 输入图 |
| `3` | `KSampler` | 采样器 |
| `4` | `CLIPTextEncode` | 正向提示词 |
| `5` | `CLIPTextEncode` | Negative 负向提示词 |
| `6` | `VAEEncode` | 编码主图 |
| `7` | `ImageScale` | 缩放到目标尺寸 |
| `8` | `VAEDecode` | 解码 |
| `9` | `SaveImage` | 输出 |
| `10` | `LoadAndApplyICLightUnet` | IC-Light 重打光模型 |
| `11` | `LoadImage` | 背景 / 参考光图 |
| `12` | `ImageScale` | 缩放背景 |
| `13` | `VAEEncode` | 编码背景 |
| `15` | `ICLightConditioning` | IC-Light 条件 |

### 参数绑定

| 参数 | 节点.输入 | 变换 | 必填 |
|---|---|---|---|
| 主体图 `image` | `2.image` | 直连 | 是 |
| 背景 / 参考光图 `background` | `11.image` | 直连 | 是 |
| 提示词 `prompt` | `4.text` | 直连 | 否 |
| 负向提示词 `negativePrompt` | `5.text` | 直连 | 否 |
| 随机种子 `seed` | `3.seed` | 直连 | 是 |
| 步数 `steps` | `3.steps` | 直连 | 否 |
| 采样器 `sampler` | `3.sampler_name` | 直连 | 否 |
| 调度器 `scheduler` | `3.scheduler` | 直连 | 否 |
| CFG `cfg` | `3.cfg` | 直连 | 否 |
| 重绘幅度 `denoise` | `3.denoise` | 直连 | 否 |
| 分辨率 `resolution` | `7.width` | 取推导出的宽 | 否 |
| 分辨率 `resolution` | `7.height` | 取推导出的高 | 否 |
| 分辨率 `resolution` | `12.width` | 取推导出的宽 | 否 |
| 分辨率 `resolution` | `12.height` | 取推导出的高 | 否 |
| 光影 `lighting` | `15.multiplier` | 线性映射 0–1 → 0.1–1 | 否 |
| 摄像机 3D 视窗调整 `camera` | `4.text` | 追加到已有文本后 | 否 |

## comfyui / 图像编辑 / 质感加强

- **功能 ID**：`comfy.edit.texture`
- **工作流**：`wf.edit.texture` v1.0.0
- **说明**：质感强度映射到 KSampler.cfg（5–10）；默认低重绘幅度以保住形体。

### 节点

| ID | 类型 | 标题 |
|---|---|---|
| `1` | `CheckpointLoaderSimple` | 基础模型 |
| `2` | `LoadImage` | 输入图 |
| `3` | `KSampler` | 采样器 |
| `4` | `CLIPTextEncode` | 正向提示词 |
| `5` | `CLIPTextEncode` | Negative 负向提示词 |
| `6` | `VAEEncode` | 编码主图 |
| `7` | `ImageScale` | 缩放到目标尺寸 |
| `8` | `VAEDecode` | 解码 |
| `9` | `SaveImage` | 输出 |

### 参数绑定

| 参数 | 节点.输入 | 变换 | 必填 |
|---|---|---|---|
| 图像输入 `image` | `2.image` | 直连 | 是 |
| 提示词 `prompt` | `4.text` | 直连 | 否 |
| 负向提示词 `negativePrompt` | `5.text` | 直连 | 否 |
| 随机种子 `seed` | `3.seed` | 直连 | 是 |
| 步数 `steps` | `3.steps` | 直连 | 否 |
| 采样器 `sampler` | `3.sampler_name` | 直连 | 否 |
| 调度器 `scheduler` | `3.scheduler` | 直连 | 否 |
| 分辨率 `resolution` | `7.width` | 取推导出的宽 | 否 |
| 分辨率 `resolution` | `7.height` | 取推导出的高 | 否 |
| 重绘幅度 `denoise` | `3.denoise` | 直连 | 否 |
| 质感强度 `texture` | `3.cfg` | 线性映射 0–1 → 5–10 | 否 |

## comfyui / 其他功能 / 放大 / 通用放大

- **功能 ID**：`comfy.misc.upscale.general`
- **工作流**：`wf.upscale.general` v1.0.0
- **说明**：先 ImageScaleBy 按倍数重采样，再低重绘幅度过一遍扩散模型补细节。

### 节点

| ID | 类型 | 标题 |
|---|---|---|
| `1` | `CheckpointLoaderSimple` | 基础模型 |
| `2` | `LoadImage` | 输入图 |
| `3` | `KSampler` | 采样器 |
| `4` | `CLIPTextEncode` | 正向提示词 |
| `5` | `CLIPTextEncode` | Negative 负向提示词 |
| `6` | `VAEEncode` | 编码 |
| `8` | `VAEDecode` | 解码 |
| `9` | `SaveImage` | 输出 |
| `20` | `ImageScaleBy` | 按倍数放大 |

### 参数绑定

| 参数 | 节点.输入 | 变换 | 必填 |
|---|---|---|---|
| 图像输入 `image` | `2.image` | 直连 | 是 |
| 放大倍数 `upscaleFactor` | `20.scale_by` | 转为数字 | 是 |
| 提示词 `prompt` | `4.text` | 直连 | 否 |
| 负向提示词 `negativePrompt` | `5.text` | 直连 | 否 |
| 随机种子 `seed` | `3.seed` | 直连 | 是 |
| 步数 `steps` | `3.steps` | 直连 | 否 |
| 采样器 `sampler` | `3.sampler_name` | 直连 | 否 |
| 调度器 `scheduler` | `3.scheduler` | 直连 | 否 |
| CFG `cfg` | `3.cfg` | 直连 | 否 |
| 重绘幅度 `denoise` | `3.denoise` | 直连 | 否 |

## comfyui / 其他功能 / 放大 / 无损放大

- **功能 ID**：`comfy.misc.upscale.lossless`
- **工作流**：`wf.upscale.lossless` v1.0.0
- **说明**：纯 ImageScaleBy 重采样，不经过扩散模型，同输入必得同输出。装了 ESRGAN 类放大模型后可换成 ImageUpscaleWithModel 获得更好效果。

### 节点

| ID | 类型 | 标题 |
|---|---|---|
| `2` | `LoadImage` | 输入图 |
| `9` | `SaveImage` | 输出 |
| `20` | `ImageScaleBy` | 按倍数放大 |

### 参数绑定

| 参数 | 节点.输入 | 变换 | 必填 |
|---|---|---|---|
| 图像输入 `image` | `2.image` | 直连 | 是 |
| 放大倍数 `upscaleFactor` | `20.scale_by` | 转为数字 | 是 |
| 重采样方式 `upscaleMethod` | `20.upscale_method` | 直连 | 否 |

## comfyui / 其他功能 / 精修 / 产品

- **功能 ID**：`comfy.misc.retouch.product`
- **工作流**：`wf.retouch.product` v1.0.0
- **说明**：精修强度映射到 KSampler.denoise（0.05–0.5），保证只收拾细节不重画。

### 节点

| ID | 类型 | 标题 |
|---|---|---|
| `1` | `CheckpointLoaderSimple` | 基础模型 |
| `2` | `LoadImage` | 输入图 |
| `3` | `KSampler` | 采样器 |
| `4` | `CLIPTextEncode` | 正向提示词 |
| `5` | `CLIPTextEncode` | Negative 负向提示词 |
| `6` | `VAEEncode` | 编码主图 |
| `7` | `ImageScale` | 缩放到目标尺寸 |
| `8` | `VAEDecode` | 解码 |
| `9` | `SaveImage` | 输出 |

### 参数绑定

| 参数 | 节点.输入 | 变换 | 必填 |
|---|---|---|---|
| 图像输入 `image` | `2.image` | 直连 | 是 |
| 提示词 `prompt` | `4.text` | 直连 | 否 |
| 负向提示词 `negativePrompt` | `5.text` | 直连 | 否 |
| 随机种子 `seed` | `3.seed` | 直连 | 是 |
| 步数 `steps` | `3.steps` | 直连 | 否 |
| 采样器 `sampler` | `3.sampler_name` | 直连 | 否 |
| 调度器 `scheduler` | `3.scheduler` | 直连 | 否 |
| 分辨率 `resolution` | `7.width` | 取推导出的宽 | 否 |
| 分辨率 `resolution` | `7.height` | 取推导出的高 | 否 |
| CFG `cfg` | `3.cfg` | 直连 | 否 |
| 精修强度 `strength` | `3.denoise` | 线性映射 0–1 → 0.05–0.5 | 否 |

## comfyui / 其他功能 / 精修 / 人物

- **功能 ID**：`comfy.misc.retouch.person`
- **工作流**：`wf.retouch.person` v1.0.0
- **说明**：精修强度映射到 KSampler.denoise（0.05–0.5），保证只收拾细节不重画。

### 节点

| ID | 类型 | 标题 |
|---|---|---|
| `1` | `CheckpointLoaderSimple` | 基础模型 |
| `2` | `LoadImage` | 输入图 |
| `3` | `KSampler` | 采样器 |
| `4` | `CLIPTextEncode` | 正向提示词 |
| `5` | `CLIPTextEncode` | Negative 负向提示词 |
| `6` | `VAEEncode` | 编码主图 |
| `7` | `ImageScale` | 缩放到目标尺寸 |
| `8` | `VAEDecode` | 解码 |
| `9` | `SaveImage` | 输出 |

### 参数绑定

| 参数 | 节点.输入 | 变换 | 必填 |
|---|---|---|---|
| 图像输入 `image` | `2.image` | 直连 | 是 |
| 提示词 `prompt` | `4.text` | 直连 | 否 |
| 负向提示词 `negativePrompt` | `5.text` | 直连 | 否 |
| 随机种子 `seed` | `3.seed` | 直连 | 是 |
| 步数 `steps` | `3.steps` | 直连 | 否 |
| 采样器 `sampler` | `3.sampler_name` | 直连 | 否 |
| 调度器 `scheduler` | `3.scheduler` | 直连 | 否 |
| 分辨率 `resolution` | `7.width` | 取推导出的宽 | 否 |
| 分辨率 `resolution` | `7.height` | 取推导出的高 | 否 |
| CFG `cfg` | `3.cfg` | 直连 | 否 |
| 精修强度 `strength` | `3.denoise` | 线性映射 0–1 → 0.05–0.5 | 否 |

## comfyui / 其他功能 / 精修 / 场景

- **功能 ID**：`comfy.misc.retouch.scene`
- **工作流**：`wf.retouch.scene` v1.0.0
- **说明**：精修强度映射到 KSampler.denoise（0.05–0.5），保证只收拾细节不重画。

### 节点

| ID | 类型 | 标题 |
|---|---|---|
| `1` | `CheckpointLoaderSimple` | 基础模型 |
| `2` | `LoadImage` | 输入图 |
| `3` | `KSampler` | 采样器 |
| `4` | `CLIPTextEncode` | 正向提示词 |
| `5` | `CLIPTextEncode` | Negative 负向提示词 |
| `6` | `VAEEncode` | 编码主图 |
| `7` | `ImageScale` | 缩放到目标尺寸 |
| `8` | `VAEDecode` | 解码 |
| `9` | `SaveImage` | 输出 |

### 参数绑定

| 参数 | 节点.输入 | 变换 | 必填 |
|---|---|---|---|
| 图像输入 `image` | `2.image` | 直连 | 是 |
| 提示词 `prompt` | `4.text` | 直连 | 否 |
| 负向提示词 `negativePrompt` | `5.text` | 直连 | 否 |
| 随机种子 `seed` | `3.seed` | 直连 | 是 |
| 步数 `steps` | `3.steps` | 直连 | 否 |
| 采样器 `sampler` | `3.sampler_name` | 直连 | 否 |
| 调度器 `scheduler` | `3.scheduler` | 直连 | 否 |
| 分辨率 `resolution` | `7.width` | 取推导出的宽 | 否 |
| 分辨率 `resolution` | `7.height` | 取推导出的高 | 否 |
| CFG `cfg` | `3.cfg` | 直连 | 否 |
| 精修强度 `strength` | `3.denoise` | 线性映射 0–1 → 0.05–0.5 | 否 |

## comfyui / 其他功能 / 视角转换 / 360° 旋转

- **功能 ID**：`comfy.misc.viewpoint.orbit`
- **工作流**：`wf.viewpoint.orbit` v1.0.0
- **说明**：机位片段追加到正向提示词；视角改动幅度映射到 KSampler.denoise（0.4–0.95）。

### 节点

| ID | 类型 | 标题 |
|---|---|---|
| `1` | `CheckpointLoaderSimple` | 基础模型 |
| `2` | `LoadImage` | 输入图 |
| `3` | `KSampler` | 采样器 |
| `4` | `CLIPTextEncode` | 正向提示词 |
| `5` | `CLIPTextEncode` | Negative 负向提示词 |
| `6` | `VAEEncode` | 编码主图 |
| `7` | `ImageScale` | 缩放到目标尺寸 |
| `8` | `VAEDecode` | 解码 |
| `9` | `SaveImage` | 输出 |

### 参数绑定

| 参数 | 节点.输入 | 变换 | 必填 |
|---|---|---|---|
| 图像输入 `image` | `2.image` | 直连 | 是 |
| 提示词 `prompt` | `4.text` | 直连 | 否 |
| 负向提示词 `negativePrompt` | `5.text` | 直连 | 否 |
| 随机种子 `seed` | `3.seed` | 直连 | 是 |
| 步数 `steps` | `3.steps` | 直连 | 否 |
| 采样器 `sampler` | `3.sampler_name` | 直连 | 否 |
| 调度器 `scheduler` | `3.scheduler` | 直连 | 否 |
| 分辨率 `resolution` | `7.width` | 取推导出的宽 | 否 |
| 分辨率 `resolution` | `7.height` | 取推导出的高 | 否 |
| 摄像机 3D 视窗调整 `camera` | `4.text` | 追加到已有文本后 | 否 |
| CFG `cfg` | `3.cfg` | 直连 | 否 |
| 视角改动幅度 `strength` | `3.denoise` | 线性映射 0–1 → 0.4–0.95 | 否 |

---

## 验证方式

```bash
npm test                      # 静态校验：绑定落点、依赖声明、无死旋钮
npm run test:workflows:real   # 逐个提交到真实 ComfyUI，确认都出得来图
```
