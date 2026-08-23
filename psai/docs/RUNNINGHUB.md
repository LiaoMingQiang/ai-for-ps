# 内置云端工作流预设（RunningHub）

> 本文件由 `npm run docs:rh` 从 `packages/shared/src/runninghub.ts` 生成，请勿手工编辑。

每条预设都对应 runninghub.cn 上一个真实存在、公开可跑的工作流。
节点号与字段名不是猜的 —— 全部来自 `POST /api/openapi/getJsonApiFormat` 返回的真实 API 格式图，逐个核对过。

```bash
npm run verify:rh        # 拿真实 API Key 重新核对每条绑定是否还成立
```

云端作者随时可能改图。改了之后我们的 `nodeInfoList` 会打到不存在的节点上，
而 RunningHub **不会报错**，它只是默默忽略那条覆盖 —— 用户拿到的是一张「参数全没生效」的图。
这是最难被发现的一类失败，所以 `verify:rh` 必须在每次发版前跑。

## 总览

| 预设 | 能力 | 云端工作流 | 节点数 | 需要遮罩 | 绑定数 |
| --- | --- | --- | ---: | :---: | ---: |
| `rh.t2i.flux` | 文生图 | [1909669429062631425](https://www.runninghub.cn/post/1909669429062631425) | 16 | — | 7 |
| `rh.i2i.hidream` | 图生图 | [1915248465113452546](https://www.runninghub.cn/post/1915248465113452546) | 16 | — | 8 |
| `rh.matting.birefnet` | 抠图去背景 | [1897193863243878401](https://www.runninghub.cn/post/1897193863243878401) | 4 | — | 3 |
| `rh.bg.flux` | 换背景 | [1897953978448039938](https://www.runninghub.cn/post/1897953978448039938) | 36 | — | 7 |
| `rh.product.background` | 换背景 | [1896098010688847873](https://www.runninghub.cn/post/1896098010688847873) | 24 | — | 5 |
| `rh.inpaint.fluxfill` | 局部重绘 | [1901904713074548737](https://www.runninghub.cn/post/1901904713074548737) | 15 | 是 | 7 |
| `rh.outpaint.fluxfill` | 扩图 | [1894045000794046466](https://www.runninghub.cn/post/1894045000794046466) | 14 | — | 10 |
| `rh.upscale.fluxcn` | 高清放大 | [1839649528810000386](https://www.runninghub.cn/post/1839649528810000386) | 17 | — | 5 |
| `rh.relight.iclight` | 重打光 | [1897257503439147010](https://www.runninghub.cn/post/1897257503439147010) | 23 | — | 6 |
| `rh.lineart.colorize` | 线稿 | [1895671416807686145](https://www.runninghub.cn/post/1895671416807686145) | 21 | — | 6 |
| `rh.lineart.extract` | 线稿 | [1899080497694425090](https://www.runninghub.cn/post/1899080497694425090) | 17 | — | 7 |
| `rh.restore.oldphoto` | 修复 | [1895765097086320642](https://www.runninghub.cn/post/1895765097086320642) | 23 | — | 6 |
| `rh.erase.oneclick` | 消除 | [1909791576560758785](https://www.runninghub.cn/post/1909791576560758785) | 18 | 是 | 6 |

## 逐条明细

### Flux Turbo 文生图（8 步）

- **预设 id**：`rh.t2i.flux`
- **能力分类**：文生图
- **云端工作流**：[1909669429062631425](https://www.runninghub.cn/post/1909669429062631425)（16 个节点）
- **模型栈**：Nunchaku Flux.1-dev + FLUX.1-Turbo-Alpha
- **说明**：Nunchaku 加速的官方 Flux.1-dev，8 步出图。作者挂的吉卜力风格 LoRA 被我们置零，出来的是中性写实的 Flux。
- **可绑定到**：生成 / 闭源模型 / 文生图（`cloud.t2i`）
- **出图节点**：`9`

| 参数 | 节点 | 字段 | 变换 | 必填 |
| --- | ---: | --- | --- | :---: |
| prompt | `6` | `text` | — | ✓ |
| seed | `25` | `noise_seed` | — | ✓ |
| steps | `17` | `steps` | — | — |
| sampler | `16` | `sampler_name` | — | — |
| aspect | `27` | `width` | `sizeWidth` | — |
| aspect | `27` | `height` | `sizeHeight` | — |
| __styleLora（内部固定值） | `47` | `lora_strength` | `const` = 0 | — |

### HiDream 图生图（提示词 + 自动反推）

- **预设 id**：`rh.i2i.hidream`
- **能力分类**：图生图
- **云端工作流**：[1915248465113452546](https://www.runninghub.cn/post/1915248465113452546)（16 个节点）
- **模型栈**：hidream_i1_full + llama-3.1-8b 文本编码 + RH_Captioner
- **说明**：RH_Captioner 先反推原图内容，再把你的提示词拼在前面一起送进去，既保内容又听指令。
- **可绑定到**：生成 / 闭源模型 / 图生图（`cloud.i2i`）
- **出图节点**：`9`
- **推荐默认值**：`denoise` = 0.85、`steps` = 25（盖过功能自身的默认值。这些值照常显示在参数面板里，用户随时能改 —— 不是背着他改）

| 参数 | 节点 | 字段 | 变换 | 必填 |
| --- | ---: | --- | --- | :---: |
| image | `76` | `image` | — | ✓ |
| prompt | `90` | `value` | — | ✓ |
| negativePrompt | `40` | `text` | — | — |
| denoise | `82` | `denoise` | — | — |
| steps | `82` | `steps` | — | — |
| cfg | `82` | `cfg` | — | — |
| sampler | `82` | `sampler_name` | — | — |
| seed | `82` | `seed` | — | ✓ |

### BiRefNet 复杂背景抠图

- **预设 id**：`rh.matting.birefnet`
- **能力分类**：抠图去背景
- **云端工作流**：[1897193863243878401](https://www.runninghub.cn/post/1897193863243878401)（4 个节点）
- **模型栈**：BiRefNet-General + PyMatting
- **说明**：四个节点的纯抠图流程，输出带透明通道的 PNG，适合直接当图层贴回 Photoshop。
- **可绑定到**：生成 / 闭源模型 / 高质量产品渲染 / 精修白底图（`cloud.product.whitebg`）
- **出图节点**：`31`

| 参数 | 节点 | 字段 | 变换 | 必填 |
| --- | ---: | --- | --- | :---: |
| image | `32` | `image` | — | ✓ |
| edgeBlack | `33` | `black_point` | — | — |
| edgeWhite | `33` | `white_point` | — | — |

### Flux 换背景（深度 + Redux 参考）

- **预设 id**：`rh.bg.flux`
- **能力分类**：换背景
- **云端工作流**：[1897953978448039938](https://www.runninghub.cn/post/1897953978448039938)（36 个节点）
- **模型栈**：flux1-depth-dev + F.1-Fill + flux1-redux + BiRefNet
- **说明**：主体走 Depth ControlNet 保形，背景由提示词或参考图（Redux）决定，抠像用 BiRefNet。
- **可绑定到**：生成 / 闭源模型 / 高质量产品渲染 / 精修白底图（`cloud.product.whitebg`）、生成 / comfyui / 图像编辑 / 质感加强（`comfy.edit.texture`）
- **出图节点**：`316`、`345`

| 参数 | 节点 | 字段 | 变换 | 必填 |
| --- | ---: | --- | --- | :---: |
| image | `285` | `image` | — | ✓ |
| reference | `333` | `image` | — | — |
| prompt | `280` | `text` | — | ✓ |
| seed | `279` | `seed` | — | ✓ |
| steps | `279` | `steps` | — | — |
| aspect | `283` | `width` | `sizeWidth` | — |
| aspect | `283` | `height` | `sizeHeight` | — |

### 产品场景图（ACE++ 保形换景）

- **预设 id**：`rh.product.background`
- **能力分类**：换背景
- **云端工作流**：[1896098010688847873](https://www.runninghub.cn/post/1896098010688847873)（24 个节点）
- **模型栈**：F.1-Fill + ace++_subject_lora16
- **说明**：ACE++ subject LoRA 锁住产品本体不变形，按提示词生成整套场景，电商主图直接可用。
- **可绑定到**：生成 / comfyui / 其他功能 / 精修 / 产品（`comfy.misc.retouch.product`）、生成 / 闭源模型 / 高质量产品渲染 / 精修白底图（`cloud.product.whitebg`）
- **出图节点**：`300`

| 参数 | 节点 | 字段 | 变换 | 必填 |
| --- | ---: | --- | --- | :---: |
| image | `296` | `image` | — | ✓ |
| prompt | `288` | `text` | — | ✓ |
| negativePrompt | `301` | `text` | — | — |
| seed | `364` | `seed` | — | ✓ |
| steps | `364` | `steps` | — | — |

### Flux Fill 局部重绘（无痕）

- **预设 id**：`rh.inpaint.fluxfill`
- **能力分类**：局部重绘
- **云端工作流**：[1901904713074548737](https://www.runninghub.cn/post/1901904713074548737)（15 个节点）
- **模型栈**：flux1-fill-dev + DifferentialDiffusion
- **说明**：需要带 alpha 的 PNG：透明处即为要重绘的区域。DifferentialDiffusion 让接缝几乎看不出来，Photoshop 选区可直接转成遮罩。
- **需要遮罩**：输入图必须带 alpha 通道，透明处即处理区域。不带 alpha 提交会被 Helper 拦下（整张图都会被当成处理区，出来的结果和用户圈的选区毫无关系）。
- **可绑定到**：生成 / comfyui / 图像编辑 / 质感加强（`comfy.edit.texture`）
- **出图节点**：`20`
- **推荐默认值**：`denoise` = 1、`steps` = 20、`cfg` = 1（盖过功能自身的默认值。这些值照常显示在参数面板里，用户随时能改 —— 不是背着他改）

| 参数 | 节点 | 字段 | 变换 | 必填 |
| --- | ---: | --- | --- | :---: |
| image | `14` | `image` | — | ✓ |
| prompt | `19` | `text` | — | ✓ |
| negativePrompt | `9` | `text` | — | — |
| seed | `3` | `seed` | — | ✓ |
| steps | `3` | `steps` | — | — |
| denoise | `3` | `denoise` | — | — |
| cfg | `3` | `cfg` | — | — |

### Flux Fill 扩图

- **预设 id**：`rh.outpaint.fluxfill`
- **能力分类**：扩图
- **云端工作流**：[1894045000794046466](https://www.runninghub.cn/post/1894045000794046466)（14 个节点）
- **模型栈**：F.1-Fill-fp16 + ImagePadForOutpaint
- **说明**：四个方向分别给扩展像素数，边缘羽化过渡。不需要遮罩，扩出来的区域由 Flux Fill 补全。
- **可绑定到**：生成 / comfyui / 图像编辑 / 质感加强（`comfy.edit.texture`）
- **出图节点**：`9`

| 参数 | 节点 | 字段 | 变换 | 必填 |
| --- | ---: | --- | --- | :---: |
| image | `53` | `image` | — | ✓ |
| prompt | `23` | `text` | — | — |
| negativePrompt | `7` | `text` | — | — |
| seed | `3` | `seed` | — | ✓ |
| steps | `3` | `steps` | — | — |
| expandTop | `44` | `top` | — | — |
| expandBottom | `44` | `bottom` | — | — |
| expandLeft | `44` | `left` | — | — |
| expandRight | `44` | `right` | — | — |
| feather | `44` | `feathering` | — | — |

### Flux ControlNet 高清放大

- **预设 id**：`rh.upscale.fluxcn`
- **能力分类**：高清放大
- **云端工作流**：[1839649528810000386](https://www.runninghub.cn/post/1839649528810000386)（17 个节点）
- **模型栈**：flux1-dev-fp8 + Flux.1-dev-Controlnet-Upscaler + Florence-2
- **说明**：jasperai 的 Flux Upscaler ControlNet，倍数可调，Florence2 自动补描述以保住细节语义。
- **可绑定到**：生成 / comfyui / 其他功能 / 放大 / 通用放大（`comfy.misc.upscale.general`）
- **出图节点**：`9`

| 参数 | 节点 | 字段 | 变换 | 必填 |
| --- | ---: | --- | --- | :---: |
| image | `17` | `image` | — | ✓ |
| upscaleFactor | `31` | `value` | `number` | — |
| strength | `14` | `strength` | — | — |
| seed | `3` | `seed` | — | ✓ |
| steps | `3` | `steps` | — | — |

### IC-Light 重打光

- **预设 id**：`rh.relight.iclight`
- **能力分类**：重打光
- **云端工作流**：[1897257503439147010](https://www.runninghub.cn/post/1897257503439147010)（23 个节点）
- **模型栈**：majicmixRealistic_v7 + iclight_sd15_fc
- **说明**：八向光源可选（左/右/上/下/四角），细节用 soft-light 回贴，主体不会被重打光洗掉。
- **可绑定到**：生成 / comfyui / 光影溶图 / 固定视角（`comfy.relight.fixed`）、生成 / comfyui / 光影溶图 / 自适应视角（`comfy.relight.adaptive`）
- **出图节点**：`123`

| 参数 | 节点 | 字段 | 变换 | 必填 |
| --- | ---: | --- | --- | :---: |
| image | `111` | `image` | — | ✓ |
| prompt | `76` | `text` | — | — |
| negativePrompt | `77` | `text` | — | — |
| lightPosition | `114` | `light_position` | — | — |
| seed | `80` | `seed` | — | ✓ |
| steps | `80` | `steps` | — | — |

### Canny + Redux 线稿上色

- **预设 id**：`rh.lineart.colorize`
- **能力分类**：线稿
- **云端工作流**：[1895671416807686145](https://www.runninghub.cn/post/1895671416807686145)（21 个节点）
- **模型栈**：flux1-canny-dev + flux1-redux-dev
- **说明**：线稿走 Canny ControlNet 保结构，配色参考图走 Redux 风格迁移。两张图一起给效果最好。
- **可绑定到**：生成 / comfyui / 洗图 / 人像（`comfy.wash.portrait`）、生成 / comfyui / 洗图 / 场景（`comfy.wash.scene`）
- **出图节点**：`9`

| 参数 | 节点 | 字段 | 变换 | 必填 |
| --- | ---: | --- | --- | :---: |
| image | `34` | `image` | — | ✓ |
| reference | `53` | `image` | — | — |
| prompt | `21` | `text` | — | — |
| strength | `32` | `strength` | — | — |
| seed | `3` | `seed` | — | ✓ |
| steps | `3` | `steps` | — | — |

### 图片转线稿

- **预设 id**：`rh.lineart.extract`
- **能力分类**：线稿
- **云端工作流**：[1899080497694425090](https://www.runninghub.cn/post/1899080497694425090)（17 个节点）
- **模型栈**：Lineart_v1.1 + control_v11p_sd15_lineart + IPAdapter
- **说明**：把照片或渲染图转成干净线稿，可用来做产品结构稿或上色底稿。
- **可绑定到**：生成 / comfyui / 洗图 / 场景（`comfy.wash.scene`）
- **出图节点**：`9`

| 参数 | 节点 | 字段 | 变换 | 必填 |
| --- | ---: | --- | --- | :---: |
| image | `16` | `image` | — | ✓ |
| prompt | `6` | `text` | — | — |
| negativePrompt | `44` | `text` | — | — |
| strength | `18` | `strength` | — | — |
| seed | `3` | `seed` | — | ✓ |
| steps | `3` | `steps` | — | — |
| cfg | `3` | `cfg` | — | — |

### 老照片修复 + 上色

- **预设 id**：`rh.restore.oldphoto`
- **能力分类**：修复
- **云端工作流**：[1895765097086320642](https://www.runninghub.cn/post/1895765097086320642)（23 个节点）
- **模型栈**：majicmixRealistic_v7 + ioclab_sd15_recolor + CodeFormer
- **说明**：Recolor ControlNet 上色 + CodeFormer 面部修复，黑白老照片一步到彩色。
- **可绑定到**：生成 / comfyui / 洗图 / 人像（`comfy.wash.portrait`）
- **出图节点**：`498`

| 参数 | 节点 | 字段 | 变换 | 必填 |
| --- | ---: | --- | --- | :---: |
| image | `1` | `image` | — | ✓ |
| prompt | `65` | `text` | — | — |
| negativePrompt | `123` | `text` | — | — |
| seed | `280` | `seed` | — | ✓ |
| steps | `280` | `steps` | — | — |
| denoise | `121` | `denoise` | — | — |

### 万物消除 / 去水印

- **预设 id**：`rh.erase.oneclick`
- **能力分类**：消除
- **云端工作流**：[1909791576560758785](https://www.runninghub.cn/post/1909791576560758785)（18 个节点）
- **模型栈**：DreamShaper XL Turbo + fooocus_inpaint + LaMa(Places_512)
- **说明**：需要带 alpha 的 PNG：透明处即为要擦掉的区域。先用 LaMa 补大面积，再用 Fooocus Inpaint 精修，8 步出图。
- **需要遮罩**：输入图必须带 alpha 通道，透明处即处理区域。不带 alpha 提交会被 Helper 拦下（整张图都会被当成处理区，出来的结果和用户圈的选区毫无关系）。
- **可绑定到**：生成 / comfyui / 图像编辑 / 质感加强（`comfy.edit.texture`）
- **出图节点**：`383`
- **推荐默认值**：`denoise` = 0.6、`steps` = 8（盖过功能自身的默认值。这些值照常显示在参数面板里，用户随时能改 —— 不是背着他改）

| 参数 | 节点 | 字段 | 变换 | 必填 |
| --- | ---: | --- | --- | :---: |
| image | `199` | `image` | — | ✓ |
| prompt | `196` | `text` | — | — |
| negativePrompt | `197` | `text` | — | — |
| seed | `210` | `seed` | — | ✓ |
| steps | `210` | `steps` | — | — |
| denoise | `210` | `denoise` | — | — |

## 怎么再加一条预设

1. 在 runninghub.cn 上找到工作流，作品页地址就是 `https://www.runninghub.cn/post/<workflowId>`。
2. 拉它的真实节点图：

```bash
curl -s -X POST https://www.runninghub.cn/api/openapi/getJsonApiFormat \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"$RUNNINGHUB_API_KEY\",\"workflowId\":\"<workflowId>\"}"
```

3. 挑绑定的时候盯住两件事：
   - **提示词必须能顺着连线走到 `CLIPTextEncode`**。经过 `ArgosTranslateTextNode` 这类第三方节点的不要选 ——
     实测它在 RunningHub 上不工作、输出空串，任务照样「成功」，出来的是拿空提示词生成的乱图。
   - **要覆盖的字段必须是标量，不能是连线输入**。已经被连线占用的字段，覆盖会被忽略。
4. 把节点号写进 `RUNNINGHUB_PRESETS`，跑 `npm run verify:rh` 确认全部命中。
5. 跑一次真实出图，**用眼睛看图确认提示词生效了**。这一步不能省 —— 前面所有检查都通过、图也出来了，
   却和提示词毫无关系，这种情况真实发生过。

