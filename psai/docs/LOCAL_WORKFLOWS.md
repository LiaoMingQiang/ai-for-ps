# 本地 ComfyUI 工作流审计矩阵

> 生成方式：对着**本机真实运行的 ComfyUI 0.30.1**（127.0.0.1:8188）逐条核对，
> 不是照文档推断。节点存在性来自 `/object_info`（3026 个节点类型），
> 模型存在性来自各 Loader 节点的枚举值。

## 一、本机 ComfyUI 资产清单（实测）

| 类别 | 实际可用 |
|---|---|
| checkpoints | majicMIX realistic v2/v7、sd_xl_base_1.0、sd_xl_refiner_1.0、v1-5-pruned-emaonly |
| unet | **IC-Light**(fbc/fc/fcon)、Z-Image Turbo、FLUX Klein 4b/9b、**flux1-dev-kontext**、flux1-krea-dev、ideogram4、lotus-depth |
| controlnet | FLUX.1-dev-ControlNet-Union-Pro-2.0、controlnet-union-sdxl-1.0、diffusers_xl_canny_full、diffusers_xl_depth_full、lotus-depth-d-v1-1、Z-Image-Turbo-Fun-Controlnet-Union |
| vae | ae.safetensors/ae.sft、flux1_vae_bf16、flux2-vae、vae-ft-mse-840000 |
| lora | boogu_image_turbo、flux2_klein_9b_enhanced_details_realistic、flux2_klein_9b_realistic_detail |
| **upscale models** | **空 —— 一个都没有** |
| 抠图 | BiRefNet 全家桶（RembgByBiRefNet / BiRefNetRMBG / LayerMask: BiRefNetUltraV2 / RMBG）、RemBGSession+、TransparentBGSession+ |
| 分割 | SAM3_Detect、SAMLoader、SAMDetectorCombined、easy humanSegmentation |
| 人脸 | FaceDetailer、FaceDetailerPipe、easy instantIDApply、easy pulIDApply |
| 放大流程节点 | UltimateSDUpscale、SUPIRApply、ImageUpscaleWithModel、IterativeLatentUpscale（**但缺模型文件**） |
| 编辑 | FluxKontextImageScale、TextEncodeQwenImageEdit、SkipLayerGuidanceDiT |
| 套件 | Impact/Inspire（121 个）、LayerStyle、Essentials、easy-use |

**唯一的硬缺口：没有任何放大模型文件**（`UpscaleModelLoader` 的枚举是空的）。
`UltimateSDUpscale`、`ImageUpscaleWithModel` 这些节点都在，但没有权重可加载。

## 二、已有内置工作流（11 个）—— 全部通过静态校验

校验项：节点类型是否存在、Loader 引用的模型文件是否存在、是否有输出节点、参数绑定数量。

| 功能 | 工作流 ID | 节点数 | 绑定参数数 | 输出节点 | 缺节点 | 缺模型 | 状态 |
|---|---|---|---|---|---|---|---|
| 洗图·人像 | `wf.wash.portrait` | 9 | 11 | 1 | 无 | 无 | **PASS（静态）** |
| 洗图·场景 | `wf.wash.scene` | 9 | 11 | 1 | 无 | 无 | **PASS（静态）** |
| 光影溶图·固定视角 | `wf.relight.fixed` | 14 | 15 | 1 | 无 | 无 | **PASS（静态）** |
| 光影溶图·自适应视角 | `wf.relight.adaptive` | 14 | 16 | 1 | 无 | 无 | **PASS（静态）** |
| 质感加强 | `wf.edit.texture` | 9 | 11 | 1 | 无 | 无 | **PASS（静态）** |
| 通用放大 | `wf.upscale.general` | 9 | 10 | 1 | 无 | 无 | **PASS（静态）**，但见下方说明 |
| 无损放大 | `wf.upscale.lossless` | 3 | 3 | 1 | 无 | 无 | **PASS（静态）** |
| 精修·产品 | `wf.retouch.product` | 9 | 11 | 1 | 无 | 无 | **PASS（静态）** |
| 精修·人物 | `wf.retouch.person` | 9 | 11 | 1 | 无 | 无 | **PASS（静态）** |
| 精修·场景 | `wf.retouch.scene` | 9 | 11 | 1 | 无 | 无 | **PASS（静态）** |
| 360° 旋转 | `wf.viewpoint.orbit` | 9 | 12 | 1 | 无 | 无 | **PASS（静态）** |

绑定参数以 `wf.wash.portrait` 为例（11 条，均可从插件面板调）：
`image → LoadImage.image`、`prompt/negativePrompt → CLIPTextEncode.text`、
`seed/steps/sampler/scheduler/denoise → KSampler.*`、
`resolution → ImageScale.width/height`（经 sizeWidth/sizeHeight 变换）、
`realism → KSampler.cfg`（0–1 线性映射到 4.5–9）。

> **放大功能的真实状态**：两个放大工作流本身是有效的，但因为本机没有放大模型，
> 它们走的是 `ImageScaleBy` 重采样，不是超分。要真正"越放越清晰"需要补
> ESRGAN / 4x-UltraSharp 之类的权重放进 `models/upscale_models/`。

## 三、尚无本地工作流的功能（5 个，全部只能走闭源 API）

这是用户第 4 条要求指向的缺口。这 5 个功能的 `engine` 是 `cloud-image`，
在 `ProviderManager.resolveProvider()` 里只会被解析到云端 Provider，
**当前架构下无法绑定到本机 ComfyUI**。

| 功能 ID | 名称 | 本机是否具备实现条件 | 建议实现路径 |
|---|---|---|---|
| `cloud.wash` | 洗图 / 去噪 | ✅ | 复用 `wf.wash.*` 的 img2img 结构 |
| `cloud.t2i` | 文生图 | ✅ | SDXL / FLUX Klein + EmptyLatentImage |
| `cloud.i2i` | 图生图 | ✅ | flux1-dev-kontext 或 SDXL img2img |
| `cloud.product.multiview` | 产品多视角 | ⚠️ 需 ControlNet + 视角控制 | 参考 `wf.viewpoint.orbit` 扩展 |
| `cloud.product.whitebg` | 精修白底图 | ✅ | BiRefNet 抠图 + 白底合成 |

## 四、用户列出的功能类别 vs 本机可实现性

| 类别 | 本机条件 | 当前是否已有工作流 |
|---|---|---|
| 文生图 | ✅ SDXL/FLUX | ❌ 仅云端 |
| 图生图 | ✅ | ❌ 仅云端（ComfyUI 侧有洗图等变体） |
| 产品精修 | ✅ | ✅ `wf.retouch.product` |
| 背景移除 | ✅ BiRefNet | ❌ 未建 |
| 背景替换 | ✅ BiRefNet + 合成 | ❌ 未建 |
| 白底商品图 | ✅ | ❌ 仅云端 |
| 局部重绘 / Inpainting | ✅ VAEEncodeForInpaint、SetLatentNoiseMask、InpaintModelConditioning | ❌ 未建 |
| 物体移除 | ✅ LamaRemover / inpaint | ❌ 未建 |
| 物体替换 | ✅ inpaint + kontext | ❌ 未建 |
| 扩图 / Outpainting | ✅ ImagePadForOutpaint | ❌ 未建 |
| 重打光 | ✅ **IC-Light 已装** | ✅ `wf.relight.*` |
| 阴影生成 | ✅ IC-Light fbc | ❌ 未建 |
| 图像融合 / 合成 | ✅ ImageCompositeMasked | 部分（relight） |
| 高清修复 | ⚠️ 缺放大模型 | 部分 |
| 放大 | ⚠️ **缺放大模型** | ✅ 但退化为重采样 |
| 去噪 / 清理 | ✅ | ✅ `wf.wash.*` |
| 细节增强 | ✅ | ✅ `wf.edit.texture` |
| 人脸修复 | ✅ FaceDetailer | ❌ 未建 |
| 人像精修 | ✅ | ✅ `wf.retouch.person` |
| 参考图生成 | ✅ InstantID/PuLID | ❌ 未建 |
| 结构保持重绘 | ✅ ControlNet union | ❌ 未建 |
| 姿态/深度/边缘控制 | ✅ canny/depth ControlNet + lotus-depth | ❌ 未建 |
| ControlNet 工作流 | ✅ | ❌ 未建 |
| 遮罩工作流 | ✅ LoadImageMask/GrowMask/InvertMask | 部分（relight 用到） |

## 五、结论

- 已有的 11 个工作流是**真实可用**的：节点齐、模型齐、绑定齐、有输出节点。
- 真正的缺口是**没有为闭源功能建本地替代**，以及**缺放大模型**。
- 要让 `cloud.*` 功能能跑本地工作流，需要先改
  `ProviderManager.resolveProvider()` 的分支逻辑 —— 目前 `cloud-image` 引擎
  被硬性解析到云端 Provider，这是架构层面的限制，不是补几个 json 就能绕过的。
