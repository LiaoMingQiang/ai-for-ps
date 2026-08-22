/**
 * GPU 信息：调用 nvidia-smi 真实读取。
 * 读不到就如实返回 available:false + reason，绝不编造数字。
 */

import { execFileSync } from 'node:child_process';
import type { GpuInfo } from '@psai/shared';

let cached: { at: number; info: GpuInfo } | null = null;
const TTL_MS = 1500;

export function readGpuInfo(force = false): GpuInfo {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.info;
  const info = probe();
  cached = { at: Date.now(), info };
  return info;
}

function probe(): GpuInfo {
  try {
    const out = execFileSync(
      'nvidia-smi',
      [
        '--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu',
        '--format=csv,noheader,nounits'
      ],
      { encoding: 'utf8', timeout: 4000, windowsHide: true }
    ).trim();

    const first = out.split('\n')[0];
    if (!first) {
      return offline('nvidia-smi 没有返回任何 GPU');
    }
    const parts = first.split(',').map((s) => s.trim());
    if (parts.length < 5) return offline(`nvidia-smi 输出格式不符合预期: ${first}`);

    return {
      available: true,
      name: parts[0] ?? null,
      vramTotalMb: numOrNull(parts[1]),
      vramUsedMb: numOrNull(parts[2]),
      utilizationPct: numOrNull(parts[3]),
      temperatureC: numOrNull(parts[4]),
      reason: null
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ENOENT/.test(msg)) return offline('未找到 nvidia-smi（没有 NVIDIA 显卡或驱动未安装）');
    return offline(`读取 GPU 失败: ${msg.slice(0, 160)}`);
  }
}

function numOrNull(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function offline(reason: string): GpuInfo {
  return {
    available: false,
    name: null,
    vramTotalMb: null,
    vramUsedMb: null,
    utilizationPct: null,
    temperatureC: null,
    reason
  };
}
