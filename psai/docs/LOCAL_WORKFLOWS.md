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
| upscale models | 4x-UltraSharp、4x_NMKD-Siax_200k、4x_foolhardy_Remacri、RealESRGAN_x4plus(.pth/.safetensors) |
| 抠图 | BiRefNet 全家桶（RembgByBiRefNet / BiRefNetRMBG / LayerMask: BiRefNetUltraV2 / RMBG）、RemBGSession+、TransparentBGSession+ |
| 分割 | SAM3_Detect、SAMLoader、SAMDetectorCombined、easy humanSegmentation |
| 人脸 | FaceDetailer、FaceDetailerPipe、easy instantIDApply、easy pulIDApply |
| 放大流程节点 | UltimateSDUpscale、SUPIRApply、ImageUpscaleWithModel、IterativeLatentUpscale |
| 编辑 | FluxKontextImageScale、TextEncodeQwenImageEdit、SkipLayerGuidanceDiT |
| 套件 | Impact/Inspire（121 个）、LayerStyle、Essentials、easy-use |

> **上一版这里写错了，已更正。** 上一版说"没有任何放大模型文件"，
> 依据是 `UpscaleModelLoader` 的枚举读出来是空的 —— 那是**我的解析写错了**：
> 新版 ComfyUI 的枚举返回 `["COMBO", { options: [...] }]`，而旧版是 `[[...], {...}]`，
> 采集脚本只认旧版，于是把 5 个放大模型读成了 0 个。
> 用两种格式都认的解析重跑一遍，其余各类（checkpoints / controlnet / vae / lora / unet）
> 的结论都不变，**只有 upscale_models 这一项是错的**。
>
> 实际情况：放大模型齐备，两个放大工作流不需要任何补件。

## 二、已有内置工作流（11 个）—— 全部通过静态校验

校验项：节点类型是否存在、Loader 引用的模型文件是否存在、是否有输出节点、参数绑定数量。

| 功能 | 工作流 ID | 节点数 | 绑定参数数 | 输出节点 | 缺节点 | 缺模型 | 状态 |
|---|---|---|---|---|---|---|---|
| 洗图·人像 | `wf.wash.portrait` | 9 | 11 | 1 | 无 | 无 | **PASS（静态）** |
| 洗图·场景 | `wf.wash.scene` | 9 | 11 | 1 | 无 | 无 | **PASS（静态）** |
| 光影溶图·固定视角 | `wf.relight.fixed` | 14 | 15 | 1 | 无 | 无 | **PASS（静态）** |
| 光影溶图·自适应视角 | `wf.relight.adaptive` | 14 | 16 | 1 | 无 | 无 | **PASS（静态）** |
| 质感加强 | `wf.edit.texture` | 9 | 11 | 1 | 无 | 无 | **PASS（静态）** |
| 通用放大 | `wf.upscale.general` | 9 | 10 | 1 | 无 | 无 | **PASS（静态）** |
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

> **放大功能的真实状态**：本机已有 5 个放大模型（含 4x-UltraSharp、RealESRGAN_x4plus），
> `models/upscale_models/` 不缺东西。当前两个工作流的图里用的是 `ImageScaleBy` 重采样，
> 那是**工作流本身的写法**，不是缺模型 —— 想要真超分，把图改成
> `UpscaleModelLoader → ImageUpscaleWithModel` 即可，权重现成的。

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
| 高清修复 | ✅ 放大模型齐备 | 部分 |
| 放大 | ✅ 放大模型齐备 | ✅ 但图里用的是重采样，未接超分节点 |
| 去噪 / 清理 | ✅ | ✅ `wf.wash.*` |
| 细节增强 | ✅ | ✅ `wf.edit.texture` |
| 人脸修复 | ✅ FaceDetailer | ❌ 未建 |
| 人像精修 | ✅ | ✅ `wf.retouch.person` |
| 参考图生成 | ✅ InstantID/PuLID | ❌ 未建 |
| 结构保持重绘 | ✅ ControlNet union | ❌ 未建 |
| 姿态/深度/边缘控制 | ✅ canny/depth ControlNet + lotus-depth | ❌ 未建 |
| ControlNet 工作流 | ✅ | ❌ 未建 |
| 遮罩工作流 | ✅ LoadImageMask/GrowMask/InvertMask | 部分（relight 用到） |

## 五、抠图 / 白底图（新增，comfy.edit.matting）

给原本**只有闭源实现**的白底图能力补上本机替代。

| 项 | 内容 |
|---|---|
| 功能 | `comfy.edit.matting` 「抠图 / 白底图」，挂在 生成 → comfyui → 图像编辑 下 |
| 工作流 | `wf.edit.matting`（3 节点：LoadImage → BiRefNetRMBG → SaveImage） |
| 依赖自定义节点 | **ComfyUI-RMBG**（提供 `BiRefNetRMBG`）—— 本机已装 |
| 依赖模型 | `BiRefNet-general`，由节点在**首次运行时自动从 HuggingFace 下载** |
| 输入映射 | image → LoadImage.image（支持当前图层/选区/合并可见/上传） |
| 参数 | 背景（纯白底 / 透明）、边缘羽化 0–20、边缘收缩扩张 ±10 |
| 输出分辨率 | 不做任何缩放，严格等于输入尺寸 |
| 静态校验 | **PASS** —— 节点存在、无缺模型、有输出节点、4 条绑定 |
| ComfyUI 接受提交 | **PASS** —— prompt 通过校验并进入队列 |
| 真机出图 | **BLOCKED** —— 见下 |

### 为什么是 BLOCKED

第一次真跑时 ComfyUI 接受了 prompt 并开始执行节点 2，然后停在那里 45 分钟以上。
查下来不是工作流的问题，是 `BiRefNetRMBG` 在下载 BiRefNet-general 权重，
而 HuggingFace 这条链路很不稳定 —— `~/.cache/huggingface/xet/logs` 里刷满了：

```
Concurrency control for download: Decreased concurrency from 1 to 1;
reason: success ratio below threshold (connection struggling)
```

同期 `D:\comfy` 下没有任何大文件写入，GPU 只有 17% 占用 —— 确认是卡在下载，
不是在算。**工作流本身已经被 ComfyUI 判定为合法并接受执行**，
差的只是把权重弄到本地。

解决办法（任选其一）：
- 挂代理后重跑一次，让节点自己下完；
- 或手动把 BiRefNet-general 的权重放进 ComfyUI 的 `models/RMBG/` 目录。

### 顺带修掉的两个真问题

1. **binding.json 改了不生效。** `seedBuiltins` 用 `existing.hash === hash` 判断
   要不要重新播种，而那个 hash **只覆盖 graph.json**。改完绑定重启，
   播种认为"没变"直接跳过，库里还是旧绑定 —— 参数怎么调都没反应，
   日志里一个字都没有。工作流作者只会以为自己绑定写错了。现在绑定也参与比较。
2. **枚举值没法映射。** 节点的枚举词是给 ComfyUI 用户看的（`Alpha`/`Color`），
   不是给产品用户看的。新增 `map` 变换把界面取值翻译过去；
   映射不中时**不写这个字段**，让节点保持默认 —— 硬塞非法枚举会让 ComfyUI
   在提交阶段整个拒绝，而错误信息里看不出是哪个参数干的（真机踩过）。

## 六、结论与更正

**更正上一版写错的一处结论。** 上一版说「`cloud.*` 功能要跑本地工作流需要改
`resolveProvider()`，是架构限制」—— 这是错的。实际代码里 binding 分支排在
engine 判断**前面**：

```ts
const binding = this.settings.binding(featureId);
if (binding?.enabled && binding.providerId) return { providerId: binding.providerId, feature };
if (feature.engine === 'comfy-workflow') { ... }
```

只要把某个 `cloud.*` 功能显式绑定到 `comfyui`，它现在就会走本地。
再加上这一轮把设置页的候选 Provider 改成按**能力**筛（ComfyUI 声明了
`textToImage`/`imageToImage`），云功能的下拉里本来就能选到 ComfyUI。
所以缺的从来不是架构，而是**没有对应的本地工作流**。

真正剩下的缺口：

- **放大工作流用的是重采样而非超分**（不是缺模型 —— 权重是齐的）。
  把 `wf.upscale.general` 的图改成 `UpscaleModelLoader → ImageUpscaleWithModel`
  就能用上已有的 4x-UltraSharp / RealESRGAN_x4plus。
- **还有 4 个功能只有闭源实现**：`cloud.wash` / `cloud.t2i` / `cloud.i2i` /
  `cloud.product.multiview`。本机资产足够实现（SDXL、FLUX Kontext、ControlNet union），
  按 `wf.edit.matting` 这一套（新增功能 + 工作流 + 绑定 + PRD 同步 + 计数断言）
  逐个补即可。
- 用户列表里的背景替换 / 局部重绘 / 物体移除 / 扩图 / 阴影 / 人脸修复 /
  ControlNet 系列同理，本机节点与模型都具备，尚未建工作流。

## 七、还需要下载的东西（截至本次核对）

对着运行中的 ComfyUI（`D:\comfy\核心工作\ComfyUI`）逐项核对后，**只差一样**：

### BiRefNet-general 权重 —— `wf.edit.matting` 的唯一阻塞项

节点包 `ComfyUI-RMBG` 已装，`models/RMBG/BiRefNet/` 里已有 `birefnet.py`
和 `BiRefNet_config.py`，**缺的是权重本身**。节点源码
（`py/AILab_BiRefNet.py` 的 `MODEL_CONFIG`）声明 BiRefNet-general 需要 4 个文件：

| 文件 | 状态 | 大小 |
|---|---|---|
| `birefnet.py` | ✅ 已有 | 92 KB |
| `BiRefNet_config.py` | ✅ 已有 | 298 B |
| `BiRefNet-general.safetensors` | ❌ **缺** | 843 MB |
| `config.json` | ❌ **缺** | < 1 KB |

- 仓库：`1038lab/BiRefNet`
- 落盘目录：`D:\comfy\核心工作\ComfyUI\models\RMBG\BiRefNet\`

两个地址都实测返回 200：

```
https://huggingface.co/1038lab/BiRefNet/resolve/main/BiRefNet-general.safetensors
https://huggingface.co/1038lab/BiRefNet/resolve/main/config.json
```

国内直连 huggingface.co 会卡在 Xet 传输后端上（真机现象：接受任务后停在节点 2
超过 45 分钟，`~/.cache/huggingface/xet/logs` 刷满 connection struggling，
磁盘无写入、GPU 17%）。改用镜像可绕开：

```
https://hf-mirror.com/1038lab/BiRefNet/resolve/main/BiRefNet-general.safetensors
https://hf-mirror.com/1038lab/BiRefNet/resolve/main/config.json
```

### 不需要下载的

- **放大模型**：已有 5 个，见上文更正。
- 其余尚未建工作流的功能（背景替换 / 局部重绘 / 物体移除 / 扩图 / 阴影 /
  人脸修复 / ControlNet 系列）所需的节点与模型**本机都已具备**，
  缺的是工作流本身，不是权重。
