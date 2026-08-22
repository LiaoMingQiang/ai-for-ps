/**
 * 参数值域与推导逻辑的测试。
 * 重点：3D 取景立方体的角度 → 视角名称 → 稳定度 → 提示词片段这条链，
 * 是产品最具辨识度的部分，规格必须可验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASPECT_RATIOS,
  resolveSize,
  resolveSeed,
  describeCamera,
  cameraStability,
  normalizeYaw,
  clampInt,
  roundTo,
  JOB_STATES,
  JOB_TRANSITIONS,
  canTransition,
  isTerminal,
  isActive,
  AI_SUCCEEDED_STATES,
  ERROR_CODES,
  RETRYABLE_CODES,
  PsaiError,
  toErrorShape,
  renderLayerName,
  defaultSettings,
  MAX_REFERENCE_IMAGES
} from '../dist/index.js';

/* ---------------- 比例与尺寸 ---------------- */

test('比例列表就是图谱给的 10 项 + 自定义', () => {
  assert.deepEqual(
    ASPECT_RATIOS.map((a) => a.id),
    ['1:1', '4:5', '3:4', '2:3', '3:2', '4:3', '5:4', '16:9', '9:16', '21:9', 'custom']
  );
});

test('resolveSize 按长边对齐分辨率，且宽高都是 8 的倍数', () => {
  for (const a of ASPECT_RATIOS) {
    if (a.id === 'custom') continue;
    const { width, height } = resolveSize({ id: a.id }, 1024);
    assert.equal(width % 8, 0, `${a.id} 宽不是 8 的倍数`);
    assert.equal(height % 8, 0, `${a.id} 高不是 8 的倍数`);
    assert.ok(Math.abs(Math.max(width, height) - 1024) <= 8, `${a.id} 长边偏离 1024 太多`);
    const ratio = width / height;
    const want = a.w / a.h;
    assert.ok(Math.abs(ratio - want) < 0.03, `${a.id} 比例偏差过大: ${ratio} vs ${want}`);
  }
});

test('resolveSize 支持自定义宽高', () => {
  const r = resolveSize({ id: 'custom', customW: 1000, customH: 500 }, 1024);
  assert.equal(r.width / r.height, 2);
});

test('16:9 在 1280 分辨率下得到 1280×720', () => {
  assert.deepEqual(resolveSize({ id: '16:9' }, 1280), { width: 1280, height: 720 });
});

/* ---------------- 种子 ---------------- */

test('固定种子每次都返回同一个值', () => {
  assert.equal(resolveSeed({ mode: 'fixed', value: 42 }), 42);
  assert.equal(resolveSeed({ mode: 'fixed', value: 42 }), 42);
});

test('随机种子落在合法范围内', () => {
  for (const mode of ['random', 'autoRandom']) {
    for (let i = 0; i < 200; i++) {
      const s = resolveSeed({ mode, value: 0 });
      assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff);
    }
  }
});

test('固定种子超范围会被钳制', () => {
  assert.equal(resolveSeed({ mode: 'fixed', value: -5 }), 0);
  assert.equal(resolveSeed({ mode: 'fixed', value: 1e12 }), 0xffffffff);
});

/* ---------------- 3D 取景立方体 ---------------- */

test('参考图给出的两个机位，名称与稳定度必须完全对得上', () => {
  const front = describeCamera({ yaw: 0, pitch: 0 });
  assert.equal(front.horizontalName, '正视图');
  assert.equal(front.verticalName, '平视机位');
  assert.equal(front.stability, 'S+');
  assert.equal(front.stabilityLabel, '最稳定');

  const threeQuarter = describeCamera({ yaw: -30, pitch: 30 });
  assert.equal(threeQuarter.horizontalName, '右前 30 度视角');
  assert.equal(threeQuarter.verticalName, '俯视机位');
  assert.equal(threeQuarter.stability, 'A');
  assert.equal(threeQuarter.stabilityLabel, '稳定可用');
});

test('水平角符号约定：负数看到右侧，正数看到左侧', () => {
  assert.equal(describeCamera({ yaw: -90, pitch: 0 }).horizontalName, '右侧视图');
  assert.equal(describeCamera({ yaw: 90, pitch: 0 }).horizontalName, '左侧视图');
  assert.equal(describeCamera({ yaw: 180, pitch: 0 }).horizontalName, '背面视图');
  assert.equal(describeCamera({ yaw: -135, pitch: 0 }).horizontalName, '右后 45 度视角');
});

test('机位名称按俯仰角分五档', () => {
  assert.equal(describeCamera({ yaw: 0, pitch: 0 }).verticalName, '平视机位');
  assert.equal(describeCamera({ yaw: 0, pitch: 30 }).verticalName, '俯视机位');
  assert.equal(describeCamera({ yaw: 0, pitch: 90 }).verticalName, '顶视机位');
  assert.equal(describeCamera({ yaw: 0, pitch: -30 }).verticalName, '仰视机位');
  assert.equal(describeCamera({ yaw: 0, pitch: -90 }).verticalName, '底视机位');
});

test('稳定度分级符合 PRD 的判定条件', () => {
  assert.equal(cameraStability({ yaw: 0, pitch: 0 }), 'S+');
  assert.equal(cameraStability({ yaw: -90, pitch: 0 }), 'S+');
  assert.equal(cameraStability({ yaw: 180, pitch: 0 }), 'S+');
  assert.equal(cameraStability({ yaw: -30, pitch: 45 }), 'A');
  assert.equal(cameraStability({ yaw: -30, pitch: 60 }), 'B');
  assert.equal(cameraStability({ yaw: -30, pitch: 80 }), 'C');
});

test('机位会翻译成可用的英文提示词片段', () => {
  assert.equal(describeCamera({ yaw: 0, pitch: 0 }).promptFragment, 'front view, eye-level camera');
  assert.equal(
    describeCamera({ yaw: -30, pitch: 30 }).promptFragment,
    '30-degree right three-quarter front view, high-angle camera 30 degrees above'
  );
  assert.equal(describeCamera({ yaw: -90, pitch: 0 }).promptFragment, 'right side view, eye-level camera');
});

test('水平角归一化到 [-180,180]', () => {
  assert.equal(normalizeYaw(190), -170);
  assert.equal(normalizeYaw(-190), 170);
  assert.equal(normalizeYaw(360), 0);
  assert.equal(normalizeYaw(-720), 0);
});

test('俯仰角超范围被钳制而不是绕回', () => {
  assert.equal(describeCamera({ yaw: 0, pitch: 200 }).pitch, 90);
  assert.equal(describeCamera({ yaw: 0, pitch: -200 }).pitch, -90);
});

/* ---------------- 数值工具 ---------------- */

test('clampInt 与 roundTo', () => {
  assert.equal(clampInt(5.6, 0, 10), 6);
  assert.equal(clampInt(-3, 0, 10), 0);
  assert.equal(clampInt(NaN, 2, 10), 2);
  assert.equal(roundTo(1020, 8), 1024);
  assert.equal(roundTo(3, 8), 8);
});

/* ---------------- 作业状态机 ---------------- */

test('状态机是 18 态', () => {
  assert.equal(JOB_STATES.length, 18);
});

test('每个状态都有转移表，且目标状态都合法', () => {
  for (const s of JOB_STATES) {
    assert.ok(Array.isArray(JOB_TRANSITIONS[s]), `${s} 没有转移表`);
    for (const t of JOB_TRANSITIONS[s]) {
      assert.ok(JOB_STATES.includes(t), `${s} → ${t} 目标状态不存在`);
    }
  }
});

test('成功/取消/丢失是终态', () => {
  for (const s of ['succeeded', 'cancelled', 'lost']) {
    assert.equal(JOB_TRANSITIONS[s].length, 0, `${s} 不该还有出边`);
    assert.ok(isTerminal(s));
  }
});

test('写回失败不是失败终态：结果保留且可重新写回', () => {
  assert.ok(isTerminal('retryable_writeback_failure'));
  assert.deepEqual(JOB_TRANSITIONS.retryable_writeback_failure, ['writeback_running']);
  assert.ok(AI_SUCCEEDED_STATES.has('retryable_writeback_failure'), '写回失败时 AI 侧应算成功');
  assert.ok(!AI_SUCCEEDED_STATES.has('failed'));
});

test('失败可以被重试回到本地队列', () => {
  assert.ok(canTransition('failed', 'queued_local'));
});

test('从 created 出发能走到 succeeded', () => {
  const path = [
    'created',
    'inputs_uploading',
    'inputs_ready',
    'queued_local',
    'submitting',
    'submitted',
    'remote_queued',
    'running',
    'downloading',
    'result_ready',
    'writeback_pending',
    'writeback_running',
    'succeeded'
  ];
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(canTransition(path[i], path[i + 1]), `${path[i]} → ${path[i + 1]} 不可达`);
  }
});

test('活动态与终态互不重叠', () => {
  for (const s of JOB_STATES) {
    assert.ok(!(isActive(s) && isTerminal(s)), `${s} 不能既是活动态又是终态`);
  }
});

/* ---------------- 错误码 ---------------- */

test('所有可重试错误码都在错误表里', () => {
  for (const c of RETRYABLE_CODES) {
    assert.ok(c in ERROR_CODES, `${c} 不在错误码表里`);
  }
});

test('每个错误码都有非空中文文案', () => {
  for (const [code, msg] of Object.entries(ERROR_CODES)) {
    assert.ok(msg && msg.length >= 2, `${code} 的文案为空`);
  }
});

test('PsaiError 会正确带上可重试标记', () => {
  assert.equal(new PsaiError('PROVIDER_RATE_LIMIT').retryable, true);
  assert.equal(new PsaiError('PROVIDER_AUTH_FAILED').retryable, false);
});

test('任意抛出物都能被规范化成带 code 的错误结构', () => {
  const a = toErrorShape(new Error('boom'));
  assert.equal(a.code, 'INTERNAL_ERROR');
  assert.equal(a.details, 'boom');

  const b = toErrorShape({ code: 'PROVIDER_TIMEOUT', message: '超时了' });
  assert.equal(b.code, 'PROVIDER_TIMEOUT');
  assert.equal(b.retryable, true);

  const c = toErrorShape(new PsaiError('WORKFLOW_NOT_BOUND'));
  assert.equal(c.code, 'WORKFLOW_NOT_BOUND');
});

/* ---------------- 设置 ---------------- */

test('默认设置结构完整', () => {
  const s = defaultSettings();
  assert.equal(s.comfy.mode, 'local');
  assert.equal(s.comfy.baseUrl, 'http://127.0.0.1:8188');
  assert.equal(s.generation.writebackMode, 'smartObject');
  assert.equal(s.generation.maxConcurrency, 1);
  assert.equal(s.ui.language, 'zh-CN');
});

test('图层命名模板可以渲染', () => {
  const name = renderLayerName('AI · {feature} · {seed}', { feature: '人像', seed: 7 });
  assert.equal(name, 'AI · 人像 · 7');
});

test('参考图上限常量是 10', () => {
  assert.equal(MAX_REFERENCE_IMAGES, 10);
});
