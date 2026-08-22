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

export async function httpFetch(url: string, opts: FetchOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onAbort);
  try {
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      signal: controller.signal
    };
    if (opts.headers) init.headers = opts.headers;
    if (opts.body !== undefined) init.body = opts.body as RequestInit['body'];
    return await fetch(url, init);
  } catch (e) {
    throw mapNetworkError(e, url, timeout);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export function mapNetworkError(e: unknown, url: string, timeoutMs: number): PsaiError {
  const msg = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : '';
  if (name === 'AbortError' || /aborted/i.test(msg)) {
    return new PsaiError('PROVIDER_TIMEOUT', `${url} 超过 ${timeoutMs}ms 未响应`);
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|network/i.test(msg)) {
    return new PsaiError('PROVIDER_UNREACHABLE', `${url}: ${msg}`);
  }
  return new PsaiError('PROVIDER_BAD_RESPONSE', `${url}: ${msg}`);
}

/** 把 HTTP 状态码映射到标准错误码。 */
export function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_FAILED';
  if (status === 402) return 'PROVIDER_QUOTA_EXCEEDED';
  if (status === 404) return 'PROVIDER_BAD_RESPONSE';
  if (status === 429) return 'PROVIDER_RATE_LIMIT';
  if (status === 400 || status === 422) return 'JOB_PARAM_INVALID';
  if (status >= 500) return 'PROVIDER_BAD_RESPONSE';
  return 'PROVIDER_BAD_RESPONSE';
}

/** 非 2xx 时抛出带服务端原文的标准错误。 */
export async function ensureOk(res: Response, url: string): Promise<Response> {
  if (res.ok) return res;
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 600);
  } catch {
    /* noop */
  }
  throw new PsaiError(codeForStatus(res.status), `${url} → HTTP ${res.status} ${detail}`);
}

export async function jsonOf<T>(res: Response, url: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PsaiError('PROVIDER_BAD_RESPONSE', `${url} 返回的不是 JSON: ${text.slice(0, 300)}`);
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
