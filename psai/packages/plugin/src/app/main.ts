/**
 * 应用装配层。
 *
 * P0 阶段这里只建立生命周期骨架与根节点渲染；
 * 具体页面（生成 / 历史 / 设置 / ComfyUI Web）在后续阶段接上。
 */

import { PSAI_VERSION } from '@psai/shared';

let booted = false;

export async function bootPlugin(): Promise<void> {
  if (booted) return;
  booted = true;
}

export function teardownPlugin(): void {
  booted = false;
}

function placeholder(root: HTMLElement, title: string, detail: string): void {
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'psai-boot';
  const h = document.createElement('strong');
  h.textContent = title;
  const p = document.createElement('span');
  p.textContent = detail;
  const v = document.createElement('small');
  v.textContent = 'AI for PS ' + PSAI_VERSION;
  wrap.appendChild(h);
  wrap.appendChild(p);
  wrap.appendChild(v);
  root.appendChild(wrap);
}

export async function mountMainPanel(root: HTMLElement): Promise<void> {
  await bootPlugin();
  placeholder(root, '正在初始化', '主面板正在装配中');
}

export async function mountComfyWebPanel(root: HTMLElement): Promise<void> {
  await bootPlugin();
  placeholder(root, '正在初始化', 'ComfyUI Web 面板正在装配中');
}

export async function openSettings(): Promise<void> {
  await bootPlugin();
}
