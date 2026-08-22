/**
 * 全局错误码表 —— Helper 与插件共用。
 *
 * 约定：
 *  - 每个错误必须有稳定的 code、面向用户的中文 message、以及 retryable 标记。
 *  - 严禁用「成功」掩盖失败：任何未配置 / 不支持的能力都必须走这里的错误码。
 */

export const ERROR_CODES = {
  /* ---- 环境 ---- */
  PHOTOSHOP_NOT_AVAILABLE: '未在 Photoshop 中运行',
  PHOTOSHOP_DOCUMENT_NOT_FOUND: '源文档已关闭或不存在',
  PHOTOSHOP_LAYER_NOT_FOUND: '源图层不存在',
  PHOTOSHOP_SELECTION_INVALID: '当前文档没有有效选区',
  PHOTOSHOP_READ_FAILED: '读取 Photoshop 状态失败',
  PHOTOSHOP_MODAL_BUSY: 'Photoshop 正忙（有其他模态操作进行中）',

  /* ---- Helper 连接 ---- */
  HELPER_OFFLINE: '本地 Helper 未运行',
  HELPER_UNAUTHORIZED: '未配对或配对已失效',
  HELPER_PAIR_FAILED: '配对失败',
  HELPER_VERSION_MISMATCH: 'Helper 与插件版本不匹配',

  /* ---- Provider ---- */
  PROVIDER_NOT_CONFIGURED: 'Provider 未配置',
  PROVIDER_DISABLED: 'Provider 已禁用',
  PROVIDER_UNREACHABLE: '无法连接到服务地址',
  PROVIDER_AUTH_FAILED: '鉴权失败（API Key 无效或过期）',
  PROVIDER_RATE_LIMIT: '触发限流，请稍后重试',
  PROVIDER_QUOTA_EXCEEDED: '额度已用尽',
  PROVIDER_BAD_RESPONSE: '服务返回了无法解析的响应',
  PROVIDER_UNSUPPORTED: '该 Provider 不支持此操作',
  PROVIDER_TIMEOUT: '请求超时',

  /* ---- 工作流 ---- */
  WORKFLOW_NOT_BOUND: '该功能尚未绑定工作流',
  WORKFLOW_NOT_FOUND: '工作流不存在',
  WORKFLOW_INVALID_JSON: '工作流 JSON 无法解析',
  WORKFLOW_NO_OUTPUT: '工作流没有输出节点（SaveImage/PreviewImage）',
  WORKFLOW_MISSING_NODE: '工作流依赖的节点未安装',
  WORKFLOW_MISSING_MODEL: '工作流依赖的模型文件缺失',
  WORKFLOW_BINDING_INVALID: '参数绑定指向了不存在的节点或输入',

  /* ---- 作业 ---- */
  JOB_NOT_FOUND: '任务不存在',
  JOB_CANCELLED: '任务已取消',
  JOB_CANCEL_UNSUPPORTED: '该 Provider 不支持取消，任务将继续执行',
  JOB_FAILED: '任务执行失败',
  JOB_LOST: '任务状态在 Helper 重启后无法恢复，请重新提交',
  JOB_INPUT_MISSING: '缺少必需的输入图像',
  JOB_PARAM_INVALID: '参数不合法',
  JOB_CONCURRENCY_LIMIT: '并发数已达上限',

  /* ---- 写回 ---- */
  WRITEBACK_TARGET_INVALID: '写回目标信息不完整',
  WRITEBACK_DOCUMENT_CHANGED: '文档尺寸已变化，禁止自动写回',
  WRITEBACK_FAILED: '写回 Photoshop 失败（结果已保留，可重试）',

  /* ---- 资产 ---- */
  ASSET_NOT_FOUND: '资产不存在',
  ASSET_TOO_LARGE: '文件超过大小上限',
  ASSET_UNSUPPORTED_TYPE: '不支持的文件类型',

  /* ---- 其他 ---- */
  INTERNAL_ERROR: '内部错误',
  NOT_IMPLEMENTED: '该能力尚未实现'
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** 可自动重试的错误（作业引擎据此决定是否进入 retry 队列）。 */
export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'PROVIDER_UNREACHABLE',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_TIMEOUT',
  'PROVIDER_BAD_RESPONSE',
  'WRITEBACK_FAILED',
  'PHOTOSHOP_MODAL_BUSY'
]);

export interface PsaiErrorShape {
  code: ErrorCode;
  message: string;
  details?: string;
  retryable: boolean;
}

export class PsaiError extends Error implements PsaiErrorShape {
  readonly code: ErrorCode;
  readonly details?: string;
  readonly retryable: boolean;

  constructor(code: ErrorCode, details?: string, messageOverride?: string) {
    super(messageOverride ?? ERROR_CODES[code]);
    this.name = 'PsaiError';
    this.code = code;
    if (details !== undefined) this.details = details;
    this.retryable = RETRYABLE_CODES.has(code);
  }

  toJSON(): PsaiErrorShape {
    const out: PsaiErrorShape = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export function isPsaiError(x: unknown): x is PsaiError {
  return x instanceof PsaiError;
}

/** 把任意抛出物规范化成 PsaiErrorShape，保证 UI 永远能显示原因。 */
export function toErrorShape(x: unknown, fallback: ErrorCode = 'INTERNAL_ERROR'): PsaiErrorShape {
  if (isPsaiError(x)) return x.toJSON();
  if (x && typeof x === 'object' && 'code' in x && typeof (x as { code: unknown }).code === 'string') {
    const code = (x as { code: string }).code as ErrorCode;
    if (code in ERROR_CODES) {
      const msg = 'message' in x && typeof (x as { message: unknown }).message === 'string'
        ? (x as { message: string }).message
        : ERROR_CODES[code];
      return { code, message: msg, retryable: RETRYABLE_CODES.has(code) };
    }
  }
  const details = x instanceof Error ? x.message : String(x);
  return { code: fallback, message: ERROR_CODES[fallback], details, retryable: RETRYABLE_CODES.has(fallback) };
}
