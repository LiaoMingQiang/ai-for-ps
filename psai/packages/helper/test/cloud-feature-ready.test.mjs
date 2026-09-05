/**
 * 闭源模型功能：**Provider 配好了不等于这个功能能跑**。
 *
 * 真机上出过一次很难查的状态：设置页里「闭源模型 / 文生图」显示绿色的
 * 「就绪」，点生成却立刻报 WORKFLOW_NOT_BOUND —— 它绑的是 LiblibAI，
 * 而 LiblibAI 要么给一个云端工作流 uuid、要么给一个托管模型，两个都没填。
 * 密钥是配好的，所以 configured 为真，就绪判定一路放行。
 *
 * 「界面说能用、点下去必然失败」比直接标成未就绪坏得多：用户会反复怀疑
 * 是自己参数填错了，而真正缺的东西界面上一个字都没提。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startHelper } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
let helper;
let dataDir;
let PORT = 0;
let token;

async function api(method, path, body) {
  if (!Number.isInteger(PORT) || PORT <= 0) {
    throw new Error(`测试用的 Helper 端口无效：PORT=${PORT}`);
  }
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: payload });
  return res.json();
}

const findFeature = (list, id) => list.find((f) => f.id === id);

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'psai-cloudready-'));
  helper = await startHelper({
    port: 0,
    dataDir,
    ephemeral: true,
    workflowsDir: resolve(here, '../../../workflows')
  });
  PORT = helper.port;
  token = helper.issueToken();
  await helper.recovered;

  // 只配密钥，不给任何可提交的目标 —— 正是真机上那个状态
  await api('PATCH', '/v1/providers/liblib', { enabled: true });
  await api('POST', '/v1/providers/liblib/credentials', {
    accessKey: 'AkFAKEqQiNwvya8a8OHv',
    secretKey: 'SkFAKEahLszRjWGYSCjxF31Vui8heO7l'
  });
});

after(async () => {
  await helper?.stop();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

test('只配了密钥、没有模型也没有工作流：不许显示「就绪」', async () => {
  await api('PUT', '/v1/features/cloud.t2i/binding', { providerId: 'liblib', enabled: true });
  const f = findFeature((await api('GET', '/v1/features')).features, 'cloud.t2i');
  assert.ok(f, '找得到 cloud.t2i');
  assert.equal(f.ready, false, '密钥配好但没有可提交的目标时，绝不能报「就绪」');
  assert.match(String(f.reason ?? ''), /可提交的目标|默认工作流|默认模型/, `原因要说清缺什么：${f.reason}`);
});

test('绑定里给了模型就算就绪', async () => {
  await api('PUT', '/v1/features/cloud.t2i/binding', {
    providerId: 'liblib',
    model: '5d7e67009b344550bc1aa6ccbfa1d7f4',
    enabled: true
  });
  const f = findFeature((await api('GET', '/v1/features')).features, 'cloud.t2i');
  assert.equal(f.ready, true, `绑了模型就该就绪，实际原因：${f.reason}`);
});

test('Provider 上的默认工作流 ID 也算数', async () => {
  // 兜底值同样能让功能跑起来 —— 判定不能只看绑定那一行。
  await api('PUT', '/v1/features/cloud.t2i/binding', { providerId: 'liblib', enabled: true });
  await api('PATCH', '/v1/providers/liblib', { defaultWorkflowId: '6a40234cc28b49de806ed9bac9eeb333' });
  const f = findFeature((await api('GET', '/v1/features')).features, 'cloud.t2i');
  assert.equal(f.ready, true, `Provider 有默认工作流就该就绪，实际原因：${f.reason}`);
  await api('PATCH', '/v1/providers/liblib', { defaultWorkflowId: '' });
});

test('这道判定不碰本机 ComfyUI 那一族', async () => {
  /*
   * comfy-workflow 类功能靠的是本机工作流绑定，跟"云端有没有可提交目标"无关。
   * 加这道闸门时最容易误伤它们 —— 那会让 12 个内置功能集体变成未就绪。
   */
  const feats = (await api('GET', '/v1/features')).features;
  const comfy = feats.filter((f) => f.engine === 'comfy-workflow' && f.id !== 'comfy.custom');
  assert.ok(comfy.length >= 12, `内置的 comfy 功能应当都在，实际 ${comfy.length} 个`);
  const broken = comfy.filter((f) => /可提交的目标/.test(String(f.reason ?? '')));
  assert.deepEqual(broken.map((f) => f.id), [], '本机工作流功能不该被这道云端判定误伤');
});
