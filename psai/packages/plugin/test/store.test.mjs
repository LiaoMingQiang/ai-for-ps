/**
 * 状态容器测试。
 *
 * 守的是"面板不会自己卡死"这件事：health 每 5 秒轮询一次，每次都是新对象。
 * 如果只按引用比较，订阅方每 5 秒就整页重绘一次 ——
 * 正在输入的提示词、正在拖的立方体、滚动位置全被冲掉，用起来就像卡住点不动。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { getState, setState, subscribe, resetStore, upsertJob, setParam } = await import('../src/app/store.ts');

beforeEach(() => {
  resetStore();
});

function makeHealth(over = {}) {
  return {
    online: true,
    version: '0.9.0',
    paired: true,
    activeJobs: 0,
    comfyui: { configured: true, online: true, baseUrl: 'http://127.0.0.1:8188', reason: null },
    reason: null,
    ...over
  };
}

test('内容相同的 health 不触发订阅 —— 心跳不该引起重绘', () => {
  let calls = 0;
  subscribe(['health'], () => calls++);

  setState({ health: makeHealth() });
  assert.equal(calls, 1, '第一次是真变化');

  // 模拟之后每 5 秒一次心跳：每次都是新对象，但内容一模一样
  for (let i = 0; i < 20; i++) setState({ health: makeHealth() });
  assert.equal(calls, 1, `20 次心跳不该再触发重绘，实际触发 ${calls} 次`);
});

test('health 内容真的变了才触发', () => {
  let calls = 0;
  subscribe(['health'], () => calls++);

  setState({ health: makeHealth() });
  setState({ health: makeHealth({ activeJobs: 1 }) });
  setState({ health: makeHealth({ online: false }) });
  assert.equal(calls, 3);
});

test('内容没变时引用也保持不变，下游用 === 比较不会被骗', () => {
  const first = makeHealth();
  setState({ health: first });
  const afterFirst = getState().health;

  setState({ health: makeHealth() });
  assert.equal(getState().health, afterFirst, '内容相同就不该换引用');
});

test('gpu 与 doc 同样按内容比较（都是被轮询的）', () => {
  let gpuCalls = 0;
  let docCalls = 0;
  subscribe(['gpu'], () => gpuCalls++);
  subscribe(['doc'], () => docCalls++);

  const gpu = { available: true, name: 'RTX 4070 Ti SUPER', vramTotalMb: 16376, vramUsedMb: 4700, utilizationPct: 42, temperatureC: 41, reason: null };
  const doc = { documentId: 1, documentName: 'a.psd', documentPath: '', width: 100, height: 100, colorMode: 'RGB', bitDepth: 8, activeLayerName: 'L', activeLayerIds: [1], hasSelection: false, selectionBounds: null };

  for (let i = 0; i < 10; i++) {
    setState({ gpu: { ...gpu } });
    setState({ doc: { ...doc } });
  }
  assert.equal(gpuCalls, 1, `gpu 只该在首次变化时触发，实际 ${gpuCalls}`);
  assert.equal(docCalls, 1, `doc 只该在首次变化时触发，实际 ${docCalls}`);
});

test('普通键仍按引用比较，不会因为深比较而漏通知', () => {
  let calls = 0;
  subscribe(['jobs'], () => calls++);
  // 任务对象内容可能相同但确实是新一批数据，必须照常通知
  setState({ jobs: [] });
  setState({ jobs: [] });
  assert.equal(calls, 2);
});

test('一次 setState 里混合变化与未变化：只通知变了的那个', () => {
  let healthCalls = 0;
  let pageCalls = 0;
  subscribe(['health'], () => healthCalls++);
  subscribe(['page'], () => pageCalls++);

  setState({ health: makeHealth(), page: 'generate' });
  healthCalls = 0;
  pageCalls = 0;

  setState({ health: makeHealth(), page: 'settings' });
  assert.equal(healthCalls, 0, 'health 内容没变，不该通知');
  assert.equal(pageCalls, 1, 'page 变了，要通知');
});

test('订阅可以取消', () => {
  let calls = 0;
  const off = subscribe(['page'], () => calls++);
  setState({ page: 'history' });
  off();
  setState({ page: 'settings' });
  assert.equal(calls, 1);
});

test('任务更新按 id 覆盖而不是重复堆积', () => {
  const job = { id: 'j1', state: 'running' };
  upsertJob(job);
  upsertJob({ ...job, state: 'succeeded' });
  const jobs = getState().jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'succeeded');
});

test('参数按功能分开存，互不干扰', () => {
  setParam('comfy.wash.portrait', 'denoise', 0.3);
  setParam('comfy.wash.scene', 'denoise', 0.7);
  assert.equal(getState().paramValues['comfy.wash.portrait'].denoise, 0.3);
  assert.equal(getState().paramValues['comfy.wash.scene'].denoise, 0.7);
});
