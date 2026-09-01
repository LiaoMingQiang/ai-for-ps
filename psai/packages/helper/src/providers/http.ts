/**
 * 共用 HTTP 工具：超时、错误映射、multipart 组装。
 * 所有 Provider 的网络错误都要经过 mapHttpError，保证 UI 拿到的是统一错误码。
 */

import { PsaiError } from '@psai/shared';
import type { ErrorCode } from '@psai/shared';

/** 我们只会发这三种 body：JSON 字符串、二进制、或者没有。 */
export type HttpBody = string | Uint8Array;

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: HttpBody | undefined;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 查询串里这些参数名的值一律不外露。
 *
 * LiblibAI 的鉴权整个都在 URL 上：AccessKey 是身份、Signature 是用 SecretKey 算出来的。
 * 一条 `PROVIDER_TIMEOUT: https://…?AccessKey=…&Signature=… 超过 30000ms 未响应`
 * 会同时出现在日志、API 响应和用户随手截的图里 —— 那等于把密钥发出去了。
 */
const SECRET_QUERY_KEYS =
  /^(access[_-]?key|secret[_-]?key|signature|signature[_-]?nonce|sign|api[_-]?key|apikey|token|access[_-]?token|password|secret|credential|x-amz-signature|x-amz-credential|ossaccesskeyid|oss[_-]?access[_-]?key[_-]?id|x-oss-signature|x-oss-credential|sig|auth)$/i;

/**
 * 一个可以放进错误消息里的地址：协议 + 主机 + 路径照旧，敏感查询参数只留键名。
 *
 * 放在这里而不是各家适配器里，是因为"记得脱敏"这种事只要有一处忘了就等于没做，
 * 而且新加一个平台时最容易忘。收在这个唯一的出口上，所有 Provider 自动受保护。
 */
export function safeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      // 用纯 ASCII 占位：URLSearchParams 会把 • 编码成 %E2%80%A2，
      // 一串百分号会把本来为了排查而保留下来的地址弄得没法看。
      if (SECRET_QUERY_KEYS.test(key)) u.searchParams.set(key, 'REDACTED');
    }
    // http://user:pass@host/ 这种也是凭据，而且不在查询串里
    if (u.username) u.username = 'REDACTED';
    if (u.password) u.password = 'REDACTED';
    return u.toString();
  } catch {
    // 连 URL 都解析不了（相对路径、被截断的字符串…）：宁可只留问号前面那截，
    // 也不要把一个可能带签名的串原样带出去。
    const q = url.indexOf('?');
    return q >= 0 ? `${url.slice(0, q)}?REDACTED` : url;
  }
}

/**
 * 把一段**外部来的**文本清干净，再让它进日志、进库、或者返回给面板。
 *
 * safeEndpoint 只管我们自己拼的那个地址。可泄漏还有别的来路，而且更防不胜防：
 *   - 上游或中间代理把我们请求的完整 URL 原样回显在错误正文里
 *     （"failed to proxy https://…?AccessKey=…&Signature=…" 这种非常常见）
 *   - 平台的业务错误消息里带着 accessKey / token 字段
 *   - Node 或某些 SDK 的 Error.message 里嵌着请求地址
 * 这些文本我们一个字都没参与拼装，却会照原样存进 error_json 再显示给用户 ——
 * 而 error_json 会出现在诊断包、截图、工单里。
 *
 * 所以凡是外部文本，一律先过这里。宁可多打几个码，不可漏一个。
 */
export function sanitizeExternalText(text: string, max = 600): string {
  if (!text) return text;
  let out = text.slice(0, max);

  // 1. 文本里嵌着的完整 URL：整段交给 safeEndpoint 处理，保留主机和路径
  out = out.replace(/\bhttps?:\/\/[^\s"'<>)\]]+/gi, (m) => safeEndpoint(m));

  // 2. 裸的 key=value 形态（不在 URL 里，比如日志片段、JSON 被拍平之后）
  out = out.replace(
    /\b(access[_-]?key|secret[_-]?key|signature[_-]?nonce|signature|api[_-]?key|apikey|token|access[_-]?token|password|secret|credential|session[_-]?token|security[_-]?token|ossaccesskeyid|x-goog-api-key|x-amz-security-token|x-amz-signature|x-amz-credential)(["']?\s*[:=]\s*["']?)([^\s,;&"'}]{4,})/gi,
    (_m, k: string, sep: string) => `${k}${sep}REDACTED`
  );

  // 3. 明面上的密钥前缀，正文里直接出现也要打掉
  out = out
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-REDACTED')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, 'AIza-REDACTED')
    .replace(/\bms-[A-Za-z0-9-]{16,}/g, 'ms-REDACTED')
    // AWS/OSS 的临时凭据 id 有很好认的前缀
    .replace(/\b(?:ASIA|AKIA|LTAI)[A-Z0-9]{8,}/g, 'REDACTED');

  return out;
}

/** 用户在请求发出**之前**就取消了。和超时区分开，上层要据此判"确定没花钱"。 */
export class RequestAbortedError extends Error {
  readonly aborted = true;
  constructor(message = '请求已被取消') {
    super(message);
    this.name = 'RequestAbortedError';
  }
}

export async function httpFetch(url: string, opts: FetchOptions = {}): Promise<Response> {
  /*
   * 传进来的信号**已经**是 aborted 时，立刻失败，一个字节都不发出去。
   *
   * 少了这一句，一次已经取消的提交照样会完整发到付费平台上：
   * addEventListener('abort') 只会在**将来**触发，对一个已经触发过的信号
   * 什么都不做。用户在提交的准备阶段点了取消，等到真正发请求的那一刻
   * 信号早就 abort 了 —— 而我们照发不误，钱照花。
   */
  if (opts.signal?.aborted) throw new RequestAbortedError();

  const controller = new AbortController();
  const timeout = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  /*
   * 不让这个定时器把事件循环钉住。
   *
   * 清理推迟到正文读完之后了 —— 而不是每个调用方都会去读正文
   * （比如 POST /interrupt，成功时没人碰它的 body）。那种情况下定时器
   * 会一直挂到超时为止，进程该退的时候退不掉，表现成"关不掉"。
   * unref 之后它只在事件循环本来就活着时才有意义，而请求进行中
   * 那个 socket 自己会把循环撑住，超时该触发照样触发。
   */
  timer.unref?.();
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      signal: controller.signal
    };
    if (opts.headers) init.headers = opts.headers;
    if (opts.body !== undefined) init.body = opts.body as RequestInit['body'];
    res = await fetch(url, init);
  } catch (e) {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    if (opts.signal?.aborted) throw new RequestAbortedError();
    throw mapNetworkError(e, url, timeout);
  }

  /*
   * 响应头回来了不等于事情结束了 —— 图片正文可能还有几十兆要读。
   *
   * 以前 finally 在这里就把监听摘了、把定时器清了，于是读 body 的那一段
   * 既不受超时管、也不受取消管：用户点了取消，进度条停了，
   * 而后台还在老老实实地把一张 4K 图下完。
   * 把清理推迟到 body 读完（或出错）之后，整个请求周期都在同一把伞下面。
   */
  const cleanup = (): void => {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  };
  return wrapBodyLifetime(res, cleanup, url, timeout, opts.signal);
}

/**
 * 把响应包一层，让"读正文"这一段也归超时和取消管。
 *
 * 只包我们真正会用的那几个读法。返回的仍然是一个 Response，
 * 调用方不需要知道这层存在。
 */
function wrapBodyLifetime(
  res: Response,
  cleanup: () => void,
  url: string,
  timeoutMs: number,
  signal?: AbortSignal
): Response {
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    cleanup();
  };
  const guard = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      const out = await read();
      finish();
      return out;
    } catch (e) {
      finish();
      if (signal?.aborted) throw new RequestAbortedError('读取响应正文时被取消');
      throw mapNetworkError(e, url, timeoutMs);
    }
  };

  const proxied = {
    text: () => guard(() => Response.prototype.text.call(res)),
    json: () => guard(() => Response.prototype.json.call(res)),
    arrayBuffer: () => guard(() => Response.prototype.arrayBuffer.call(res))
  };
  return new Proxy(res, {
    get(target, prop, receiver) {
      if (prop in proxied) return proxied[prop as keyof typeof proxied];
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
}

export function mapNetworkError(e: unknown, url: string, timeoutMs: number): PsaiError {
  // 我们自己掐的那种，别翻译成超时 —— 上层要靠它区分"确定没花钱"
  if (e instanceof RequestAbortedError) throw e;
  const msg = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : '';
  const where = safeEndpoint(url);
  if (name === 'AbortError' || /aborted/i.test(msg)) {
    return new PsaiError('PROVIDER_TIMEOUT', `${where} 超过 ${timeoutMs}ms 未响应`);
  }
  // msg 来自 fetch / 代理 / SDK —— 我们没参与拼装，里面完全可能嵌着完整的签名地址
  const safeMsg = sanitizeExternalText(msg, 300);
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|network|CONNECT_TIMEOUT/i.test(msg)) {
    return new PsaiError('PROVIDER_UNREACHABLE', `${where}: ${safeMsg}${proxyHint()}`);
  }
  return new PsaiError('PROVIDER_BAD_RESPONSE', `${where}: ${safeMsg}`);
}

/**
 * 连不上时，如果这台机器配了代理而 Helper 没走代理，把这件事说出来。
 *
 * Node 的 fetch 不认 HTTP_PROXY / HTTPS_PROXY（curl 认）。在配了代理的机器上
 * 表现是：同一个地址 curl 一秒拿到 401，Node 十秒后 CONNECT_TIMEOUT，
 * 而界面只说一句「无法连接到服务地址：fetch failed」——
 * 用户会以为是 Key 填错了或者平台挂了，把时间全花在错的地方。
 *
 * 正常情况下启动时会自动带上代理开关重启（见 index.ts），
 * 走到这里说明那一步没生效（比如 Node 版本不认那个变量）。
 * 那就至少把线索给出来。
 *
 * 只说"配了代理"，不回显代理地址本身 —— 那可能带着账号密码。
 */
function proxyHint(): string {
  if (process.env['NODE_USE_ENV_PROXY']) return '';
  const has = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some(
    (k) => (process.env[k] ?? '').trim()
  );
  return has
    ? '（这台机器配了系统代理，而 Helper 当前没有走代理 —— 多半是这个原因，不是 Key 的问题。重启 Helper 会自动启用代理。）'
    : '';
}

/** 把 HTTP 状态码映射到标准错误码。 */
export function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_FAILED';
  if (status === 402) return 'PROVIDER_QUOTA_EXCEEDED';
  if (status === 404) return 'PROVIDER_BAD_RESPONSE';
  if (status === 429) return 'PROVIDER_RATE_LIMIT';
  if (status === 400 || status === 422) return 'JOB_PARAM_INVALID';
  // 5xx 是平台自己出错，不是我们解析不了它的响应 —— 分开报，排查方向才不会歪
  if (status >= 500) return 'PROVIDER_UPSTREAM_ERROR';
  return 'PROVIDER_BAD_RESPONSE';
}

/** 非 2xx 时抛出带服务端原文的标准错误。 */
export async function ensureOk(res: Response, url: string): Promise<Response> {
  if (res.ok) return res;
  let detail = '';
  try {
    // 服务端原文是外部文本：它可能把我们那个带签名的 URL 原样回显出来
    detail = sanitizeExternalText(await res.text());
  } catch {
    /* noop */
  }
  throw new PsaiError(codeForStatus(res.status), `${safeEndpoint(url)} → HTTP ${res.status} ${detail}`);
}

export async function jsonOf<T>(res: Response, url: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PsaiError(
      'PROVIDER_BAD_RESPONSE',
      `${safeEndpoint(url)} 返回的不是 JSON: ${sanitizeExternalText(text, 300)}`
    );
  }
}

/** 手工组装 multipart/form-data（Node 的 FormData 对 Buffer 支持不够直观，这里显式控制边界）。 */
export function buildMultipart(
  parts: Array<{ name: string; value: string } | { name: string; filename: string; mime: string; data: Buffer }>
): { body: Buffer; contentType: string } {
  const boundary = `----psai${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    if ('data' in p) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.mime}\r\n\r\n`,
          'utf8'
        )
      );
      chunks.push(p.data);
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`, 'utf8'));
      chunks.push(Buffer.from(p.value, 'utf8'));
    }
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export function normalizeBaseUrl(u: string): string {
  return u.replace(/\/+$/, '');
}
