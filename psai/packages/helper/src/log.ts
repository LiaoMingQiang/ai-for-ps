/**
 * 日志：按天切分文件，保留 14 天，密钥自动脱敏。
 * 诊断包直接打包这个目录，所以脱敏必须在写入时就完成，不能指望导出时再处理。
 */

import { appendFileSync, readdirSync, statSync, unlinkSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 单个日志文件上限，超过就轮转。 */
const MAX_LOG_BYTES = 8 * 1024 * 1024;

/** 看起来像密钥的片段一律替换掉。宁可多脱敏，不可漏一个。 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(AIza[A-Za-z0-9_-]{20,})\b/g,
  /\b(ms-[A-Za-z0-9-]{16,})\b/g,
  /("(?:api[_-]?key|apiKey|token|password|secret)"\s*:\s*")([^"]{4,})(")/gi,
  /(Bearer\s+)([A-Za-z0-9._~+/-]{12,}=*)/g
];

export function redact(text: string): string {
  let out = text;
  out = out.replace(SECRET_PATTERNS[0]!, (_m, g1: string) => mask(g1));
  out = out.replace(SECRET_PATTERNS[1]!, (_m, g1: string) => mask(g1));
  out = out.replace(SECRET_PATTERNS[2]!, (_m, g1: string) => mask(g1));
  out = out.replace(SECRET_PATTERNS[3]!, (_m, a: string, b: string, c: string) => a + mask(b) + c);
  out = out.replace(SECRET_PATTERNS[4]!, (_m, a: string, b: string) => a + mask(b));
  return out;
}

function mask(s: string): string {
  if (s.length <= 8) return '••••';
  return s.slice(0, 4) + '••••••' + s.slice(-4);
}

export class Logger {
  private minLevel: number;

  private written = 0;

  constructor(
    private readonly dir: string,
    level: LogLevel = 'info',
    private readonly echo = true
  ) {
    this.minLevel = LEVEL_ORDER[level];
    this.prune();
    try {
      const p = this.file();
      if (existsSync(p)) this.written = statSync(p).size;
    } catch {
      /* 读不到就从 0 算起 */
    }
  }

  /** 把当前日志改名归档，重新从空文件开始写。 */
  private rotate(path: string): void {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      renameSync(path, `${path}.${stamp}.old`);
    } catch {
      /* 改名失败就继续往原文件写，总比丢日志强 */
    }
    this.written = 0;
    this.prune();
  }

  private file(): string {
    return join(this.dir, `helper-${new Date().toISOString().slice(0, 10)}.log`);
  }

  private write(level: LogLevel, msg: string, extra?: unknown): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const at = new Date().toISOString();
    let line = `${at} ${level.toUpperCase().padEnd(5)} ${msg}`;
    if (extra !== undefined) {
      let tail: string;
      try {
        tail = typeof extra === 'string' ? extra : JSON.stringify(extra);
      } catch {
        tail = String(extra);
      }
      line += ' ' + tail;
    }
    line = redact(line);
    try {
      const path = this.file();
      // 单文件上限：throttled() 只能压住重复内容，压不住"每条都不一样"的洪水。
      // 超过上限就轮转一次，保证日志目录不会无限长。
      this.written += line.length + 1;
      if (this.written > MAX_LOG_BYTES) {
        this.rotate(path);
      }
      appendFileSync(path, line + '\n', 'utf8');
    } catch {
      /* 日志写不进去不能让主流程崩掉 */
    }
    if (this.echo) {
      const sink = level === 'error' || level === 'warn' ? console.error : console.log;
      sink(line);
    }
  }

  debug(msg: string, extra?: unknown): void {
    this.write('debug', msg, extra);
  }
  info(msg: string, extra?: unknown): void {
    this.write('info', msg, extra);
  }
  warn(msg: string, extra?: unknown): void {
    this.write('warn', msg, extra);
  }
  error(msg: string, extra?: unknown): void {
    this.write('error', msg, extra);
  }

  /**
   * 会被反复触发的同类事件用这个，别用 warn。
   *
   * 起因：一个卡在重试循环里的客户端，几分钟就往日志里写了 2.9MB
   * 同一句"拒绝跨域来源"。日志无上限意味着任何一个行为不端的客户端
   * 都能把用户磁盘写满、顺带拖慢 Helper。
   *
   * 策略：同一个 key 第一次照常写，之后在窗口内只计数不写；
   * 窗口结束时补一行汇总，说明这段时间被抑制了多少次。
   */
  throttled(level: LogLevel, key: string, msg: string, extra?: unknown, windowMs = 30_000): void {
    const now = Date.now();
    const hit = this.throttleState.get(key);

    if (!hit) {
      this.throttleState.set(key, { firstAt: now, suppressed: 0 });
      this.write(level, msg, extra);
      return;
    }

    if (now - hit.firstAt < windowMs) {
      hit.suppressed++;
      return;
    }

    if (hit.suppressed > 0) {
      this.write(level, msg, {
        ...(typeof extra === 'object' && extra !== null ? extra : { detail: extra }),
        重复次数: hit.suppressed + 1,
        窗口秒: Math.round((now - hit.firstAt) / 1000)
      });
    } else {
      this.write(level, msg, extra);
    }
    this.throttleState.set(key, { firstAt: now, suppressed: 0 });
  }

  private throttleState = new Map<string, { firstAt: number; suppressed: number }>();

  /** 删掉 14 天前的日志。 */
  private prune(): void {
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
    try {
      for (const name of readdirSync(this.dir)) {
        if (!name.startsWith('helper-')) continue;
        if (!name.endsWith('.log') && !name.endsWith('.old')) continue;
        const p = join(this.dir, name);
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      }
    } catch {
      /* best-effort */
    }
  }
}
