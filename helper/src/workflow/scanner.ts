/* workflow/scanner: ComfyUI Workflow 导入扫描 (规则十六/十七/十八)
 * - 支持 API 格式 {nodeId: {class_type, inputs}} 与 UI 格式 {nodes:[{id,type,widgets_values}],links}
 * - detectFieldType: 明确函数, 无运算符优先级陷阱
 * - 识别: IMAGE/MASK/STRING/TEXTAREA/INT/FLOAT/BOOLEAN/ENUM/SEED/MODEL/LORA/VAE/SAMPLER/SCHEDULER/SIZE/COLOR/CAMERA/ADVANCED
 * - 标准字段: Prompt/Checkpoint/Sampler/Scheduler/Seed/Steps/CFG/Denoise/Width/Height/Image/Mask/LoRA */
import { detectFieldType } from "../providers/comfyui.js";

export interface WorkflowNode {
  id: string;
  classType: string;
  inputs: Record<string, unknown>;
}

export interface ScannedField {
  nodeId: string;
  nodeType: string;
  inputKey: string;
  fieldType: string;      /* detectFieldType 结果 */
  label: string;
  group: string;
  sortOrder: number;
  defaultValue: unknown;
  advanced: boolean;
  semantic?: string;      /* prompt | seed | size | output | image | mask | model | lora | vae */
  min?: number;
  max?: number;
}

export interface Dependency {
  kind: "comfyui" | "custom_node" | "checkpoint" | "lora" | "vae" | "controlnet" | "upscaler";
  name: string;
}

export interface ScanResult {
  nodes: WorkflowNode[];
  fields: ScannedField[];
  outputNodes: Array<{ nodeId: string; classType: string }>;
  dependencies: Dependency[];
  lockfile: {
    comfyui: string | null;
    nodes: Record<string, unknown>;
    models: Record<string, unknown>;
    loras: Record<string, unknown>;
    vae: Record<string, unknown>;
    hashes: Record<string, unknown>;
  };
  inputImages: string[];
  inputMasks: string[];
}

/* 节点类型 -> 语义分组 */
const NODE_HINTS: Array<{ re: RegExp; semantic: string; group: string; advanced: boolean }> = [
  { re: /CLIPTextEncode|TextEncode/i, semantic: "prompt", group: "提示词", advanced: false },
  { re: /KSampler/i, semantic: "sampler", group: "采样", advanced: false },
  { re: /CheckpointLoader/i, semantic: "model", group: "模型", advanced: false },
  { re: /LoraLoader/i, semantic: "lora", group: "模型", advanced: false },
  { re: /VAELoader|VAEDecode/i, semantic: "vae", group: "模型", advanced: true },
  { re: /LoadImage/i, semantic: "image", group: "输入", advanced: false },
  { re: /LoadImageMask/i, semantic: "mask", group: "输入", advanced: false },
  { re: /SaveImage|PreviewImage/i, semantic: "output", group: "输出", advanced: true },
  { re: /EmptyLatentImage/i, semantic: "size", group: "尺寸", advanced: false },
  { re: /Latent/i, semantic: "latent", group: "高级", advanced: true },
  { re: /ControlNet/i, semantic: "controlnet", group: "控制", advanced: true },
  { re: /Upscale|Ultimate/i, semantic: "upscaler", group: "高清", advanced: true }
];

function hintFor(classType: string) {
  for (const h of NODE_HINTS) {
    if (h.re.test(classType)) return h;
  }
  return null;
}

function parseWorkflowJson(raw: unknown): { nodes: WorkflowNode[]; error?: string } {
  if (!raw || typeof raw !== "object") return { nodes: [], error: "不是有效的 JSON 对象" };
  const obj = raw as Record<string, unknown>;

  /* API 格式 */
  if (obj.nodes === undefined && obj.links === undefined && Object.keys(obj).length > 0) {
    const first = obj[Object.keys(obj)[0]] as Record<string, unknown> | undefined;
    if (first && typeof first === "object" && ("class_type" in first || "inputs" in first)) {
      const nodes: WorkflowNode[] = [];
      for (const id of Object.keys(obj)) {
        const n = obj[id] as { class_type?: string; inputs?: Record<string, unknown> };
        if (!n || typeof n !== "object" || !n.class_type) return { nodes: [], error: "节点 " + id + " 缺少 class_type" };
        nodes.push({ id, classType: n.class_type, inputs: n.inputs || {} });
      }
      return { nodes };
    }
  }

  /* UI 格式: { nodes: [{id, type, widgets_values, inputs}], links: [...] } */
  if (Array.isArray(obj.nodes)) {
    const nodes: WorkflowNode[] = [];
    for (const n of obj.nodes as Array<Record<string, unknown>>) {
      const id = String(n.id);
      const classType = String(n.type || n.class_type || "");
      if (!classType) return { nodes: [], error: "节点 " + id + " 缺少 type" };
      const inputs: Record<string, unknown> = {};
      /* widgets_values: 顺序对应前端定义的 widget 顺序 (按 UI 格式约定) */
      const widgetKeys = (n.inputs as Record<string, { name?: string; widget?: { name?: string } }> | undefined);
      const order: string[] = [];
      if (widgetKeys && typeof widgetKeys === "object") {
        for (const k of Object.keys(widgetKeys)) {
          const w = widgetKeys[k];
          const name = w && typeof w === "object" ? (w.name || (w.widget && w.widget.name)) : null;
          if (name) order.push(String(name));
        }
      }
      if (Array.isArray(n.widgets_values)) {
        (n.widgets_values as unknown[]).forEach((v, i) => {
          inputs[order[i] || ("widget_" + i)] = v;
        });
      }
      /* inputs 中的 link 连接 (非字面量) */
      if (n.inputs && typeof n.inputs === "object") {
        for (const k of Object.keys(n.inputs as Record<string, unknown>)) {
          const v = (n.inputs as Record<string, unknown>)[k];
          if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            /* {link: id} 是连接, 跳过 */
          } else if (Array.isArray(v)) {
            /* 可能是 [val] 字面量或链接 */
            if (v.length === 1) {
              inputs[k] = v[0];
            }
          } else if (v !== null) {
            inputs[k] = v;
          }
        }
      }
      nodes.push({ id, classType, inputs });
    }
    return { nodes };
  }

  return { nodes: [], error: "无法识别的 Workflow 格式（需要 API JSON 或 UI JSON）" };
}

const IMAGE_NODES = ["LoadImage", "ImageUpload", "VHS_VideoUpload"];
const MASK_NODES = ["LoadImageMask", "ImageMask"];

export function scanWorkflow(raw: unknown): ScanResult {
  const parsed = parseWorkflowJson(raw);
  if (parsed.error || !parsed.nodes.length) {
    throw new Error(parsed.error || "Workflow 为空");
  }
  const nodes = parsed.nodes;
  const fields: ScannedField[] = [];
  const outputNodes: Array<{ nodeId: string; classType: string }> = [];
  const deps: Dependency[] = [];
  const lockModels: Record<string, unknown> = {};
  const lockLoras: Record<string, unknown> = {};
  const lockVae: Record<string, unknown> = {};
  const inputImages: string[] = [];
  const inputMasks: string[] = [];
  let sort = 0;

  for (const node of nodes) {
    const hint = hintFor(node.classType);
    if (hint && hint.semantic === "output") {
      outputNodes.push({ nodeId: node.id, classType: node.classType });
    }
    for (const key of Object.keys(node.inputs)) {
      const value = node.inputs[key];
      /* 跳过链接引用 (数组 [nodeId, slot] 或对象 {link}) */
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number") continue;
      if (value !== null && typeof value === "object") continue;

      const fieldType = detectFieldType(value, { class_type: node.classType, inputs: node.inputs }, key);
      const h = hintFor(node.classType);
      const isImgNode = IMAGE_NODES.some((t) => node.classType.startsWith(t));
      const isMaskNode = MASK_NODES.some((t) => node.classType.startsWith(t));

      let semantic: string | undefined;
      let advanced = !!(h && h.advanced);
      let min: number | undefined;
      let max: number | undefined;

      if (isImgNode && /image/i.test(key)) semantic = "image";
      else if (isMaskNode && /mask/i.test(key)) semantic = "mask";
      else if (/seed/i.test(key)) { semantic = "seed"; advanced = false; }
      else if (key === "steps" || key === "cfg") { semantic = "sampler"; advanced = false; }
      else if (key === "denoise") { semantic = "sampler"; advanced = false; min = 0; max = 1; }
      else if (/sampler_name/i.test(key)) { semantic = "sampler"; advanced = false; }
      else if (/scheduler/i.test(key)) { semantic = "sampler"; advanced = false; }
      else if (/ckpt_name|unet_name|model_name/i.test(key)) { semantic = "model"; advanced = false; }
      else if (/lora_name/i.test(key)) { semantic = "lora"; advanced = false; }
      else if (/vae_name/i.test(key)) { semantic = "vae"; advanced = true; }
      else if (/width|height/i.test(key) && /EmptyLatent|Latent/i.test(node.classType)) { semantic = "size"; advanced = false; }
      else if (h && h.semantic === "prompt" && /text/i.test(key)) { semantic = "prompt"; advanced = false; }

      /* 依赖提取 */
      if (/ckpt_name|unet_name|model_name/i.test(key) && typeof value === "string" && value) {
        lockModels[String(value)] = null;
        if (!deps.some((d) => d.kind === "checkpoint" && d.name === String(value))) deps.push({ kind: "checkpoint", name: String(value) });
      } else if (/lora_name/i.test(key) && typeof value === "string" && value) {
        lockLoras[String(value)] = null;
        if (!deps.some((d) => d.kind === "lora" && d.name === String(value))) deps.push({ kind: "lora", name: String(value) });
      } else if (/vae_name/i.test(key) && typeof value === "string" && value) {
        lockVae[String(value)] = null;
        if (!deps.some((d) => d.kind === "vae" && d.name === String(value))) deps.push({ kind: "vae", name: String(value) });
      }

      const isLink = Array.isArray(value) || (value !== null && typeof value === "object");
      if (isLink) continue;

      fields.push({
        nodeId: node.id,
        nodeType: node.classType,
        inputKey: key,
        fieldType,
        label: semantic === "prompt" ? "Prompt" : key,
        group: (h && h.group) || "其他",
        sortOrder: sort++,
        defaultValue: value,
        advanced,
        semantic,
        min,
        max
      });
    }
  }

  /* 输入图/蒙版引用 */
  for (const node of nodes) {
    if (IMAGE_NODES.some((t) => node.classType.startsWith(t)) && typeof node.inputs.image === "string" && node.inputs.image) {
      inputImages.push(String(node.inputs.image));
    }
    if (MASK_NODES.some((t) => node.classType.startsWith(t)) && typeof node.inputs.mask === "string" && node.inputs.mask) {
      inputMasks.push(String(node.inputs.mask));
    }
  }

  return {
    nodes,
    fields,
    outputNodes,
    dependencies: deps,
    lockfile: {
      comfyui: null,
      nodes: {},
      models: lockModels,
      loras: lockLoras,
      vae: lockVae,
      hashes: {}
    },
    inputImages,
    inputMasks
  };
}

/* 生成默认 bindings (规则十九: Studio Lite 暴露字段) */
export function defaultBindings(scan: ScanResult): Array<{
  fieldKey: string; nodeId: string; inputKey: string; fieldType: string; label: string;
  sortOrder: number; groupName: string; defaultValue: unknown; displayCondition: string | null;
}> {
  const exposed = scan.fields.filter((f) => !f.advanced);
  /* 去重: 同 (nodeId, inputKey) 只暴露一次 */
  const seen = new Set<string>();
  const bindings = [];
  for (const f of exposed) {
    const k = f.nodeId + ":" + f.inputKey;
    if (seen.has(k)) continue;
    seen.add(k);
    bindings.push({
      fieldKey: f.semantic === "prompt" ? "prompt" : f.semantic === "seed" ? "seed" : f.semantic === "image" ? "image" : f.semantic === "mask" ? "mask" : f.inputKey,
      nodeId: f.nodeId,
      inputKey: f.inputKey,
      fieldType: f.fieldType,
      label: f.label,
      sortOrder: f.sortOrder,
      groupName: f.group,
      defaultValue: f.defaultValue,
      displayCondition: null
    });
  }
  return bindings;
}
