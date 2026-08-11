/* gpu: 真实 GPU 读取 (Windows: nvidia-smi 解析; 无 NVIDIA 时返回空态)
 * 规则二十九: UI 只消费 GET /v1/gpu 或 WS events */
import { execFile } from "node:child_process";

export interface GpuInfo {
  gpu: number;            /* 使用率 % */
  vramUsedMb: number;
  vramTotalMb: number;
  vramUsed: number;       /* 使用率 % */
  ramUsedMb: number;
  ramTotalMb: number;
  queue: number;
  ping: number | null;
  comfyVersion: string | null;
  gpuName: string | null;
  available: boolean;
}

export function readGpuInfo(): Promise<GpuInfo> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", [
      "--query-gpu=utilization.gpu,memory.used,memory.total,name",
      "--format=csv,noheader,nounits"
    ], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve({
          gpu: 0, vramUsedMb: 0, vramTotalMb: 0, vramUsed: 0,
          ramUsedMb: 0, ramTotalMb: 0, queue: 0, ping: null,
          comfyVersion: null, gpuName: null, available: false
        });
        return;
      }
      const line = stdout.trim().split(/\r?\n/)[0];
      const [utilPct, memUsedMb, memTotalMb, name] = line.split(",").map((s) => s.trim());
      const gpuPct = Number(utilPct) || 0;
      const used = Number(memUsedMb) || 0;
      const total = Number(memTotalMb) || 0;
      resolve({
        gpu: gpuPct,
        vramUsedMb: used,
        vramTotalMb: total,
        vramUsed: total > 0 ? Math.round((used / total) * 100) : 0,
        ramUsedMb: 0, ramTotalMb: 0, queue: 0, ping: null,
        comfyVersion: null,
        gpuName: name || null,
        available: total > 0
      });
    });
  });
}
