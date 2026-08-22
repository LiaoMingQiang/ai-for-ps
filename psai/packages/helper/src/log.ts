/**
 * 日志：按天切分文件，保留 14 天，密钥自动脱敏。
 * 诊断包直接打包这个目录，所以脱敏必须在写入时就完成，不能指望导出时再处理。
 */

import { appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

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

  constructor(
    private readonly dir: string,
    level: LogLevel = 'info',
    private readonly echo = true
  ) {
    this.minLevel = LEVEL_ORDER[level];
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
      appendFileSync(this.file(), line + '\n', 'utf8');
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

  /** 删掉 14 天前的日志。 */
  private prune(): void {
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
    try {
      for (const name of readdirSync(this.dir)) {
        if (!name.startsWith('helper-') || !name.endsWith('.log')) continue;
        const p = join(this.dir, name);
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      }
    } catch {
      /* best-effort */
    }
  }
}
