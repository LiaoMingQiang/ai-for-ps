/**
 * 3D 取景立方体。
 *
 * 为什么不用 CSS 3D：UXP 对 `transform-style: preserve-3d` 支持不可靠，
 * 真机上很容易变成一堆压扁的方块。所以这里自己算投影，用 SVG 画多边形 ——
 * 完全可控，两个主题下表现一致。
 *
 * 数学：绕 Y 轴转 yaw，再绕 X 轴转 pitch，然后做一次带轻微透视的正交投影。
 * 面按平均深度排序后依次绘制（画家算法），可见面上叠面名。
 */

import { describeCamera, CAMERA_YAW_STEP, CAMERA_PITCH_STEP, CUBE_FACE_LABELS, normalizeYaw, clampInt } from '@psai/shared';
import type { CameraValue, CameraDescriptor } from '@psai/shared';
import { h, svgEl, clear } from '../app/dom.js';

type Vec3 = [number, number, number];

/** 立方体 8 个顶点（边长 2，中心在原点） */
const VERTS: Vec3[] = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1]
];

/**
 * 6 个面。顶点顺序保证从面外侧看是逆时针，用来算朝向。
 * z 负方向朝向观察者（正面）。
 */
const FACES: Array<{ key: keyof typeof CUBE_FACE_LABELS; idx: [number, number, number, number]; normal: Vec3 }> = [
  { key: 'front', idx: [0, 1, 2, 3], normal: [0, 0, -1] },
  { key: 'back', idx: [5, 4, 7, 6], normal: [0, 0, 1] },
  { key: 'left', idx: [4, 0, 3, 7], normal: [-1, 0, 0] },
  { key: 'right', idx: [1, 5, 6, 2], normal: [1, 0, 0] },
  { key: 'top', idx: [4, 5, 1, 0], normal: [0, -1, 0] },
  { key: 'bottom', idx: [3, 2, 6, 7], normal: [0, 1, 0] }
];

function rotate(v: Vec3, yawDeg: number, pitchDeg: number): Vec3 {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  // 绕 Y
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = v[0] * cy + v[2] * sy;
  const y1 = v[1];
  const z1 = -v[0] * sy + v[2] * cy;
  // 绕 X
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [x1, y1 * cp - z1 * sp, y1 * sp + z1 * cp];
}

function project(v: Vec3, size: number): { x: number; y: number; z: number } {
  // 轻微透视，让立体感更明显但不夸张
  const dist = 6;
  const k = dist / (dist + v[2]);
  return { x: size / 2 + v[0] * size * 0.26 * k, y: size / 2 + v[1] * size * 0.26 * k, z: v[2] };
}

export interface CubeOptions {
  value: CameraValue;
  onChange(next: CameraValue): void;
  size?: number;
}

const STABILITY_CLASS: Record<string, string> = {
  'S+': 'stab-s',
  A: 'stab-a',
  B: 'stab-b',
  C: 'stab-c'
};

/** 创建立方体控件。返回根元素与一个刷新函数。 */
export function createCameraCube(opts: CubeOptions): { el: HTMLElement; setValue(v: CameraValue): void } {
  const size = opts.size ?? 260;
  let value: CameraValue = { ...opts.value };

  const svgHost = h('div', { class: 'cube-stage' });
  const badge = h('div', { class: 'cube-badge' });
  const hint = h('div', { class: 'cube-hint' }, '拖拽立方体：左右改变水平角，上下改变俯仰角');

  const yawField = h('div', { class: 'cube-field' });
  const pitchField = h('div', { class: 'cube-field' });
  const nameField = h('div', { class: 'cube-field cube-field-wide' });
  const resetBtn = h(
    'button',
    { class: 'cube-reset', title: '重置到正视图 / 平视机位', type: 'button', onclick: () => commit({ yaw: 0, pitch: 0 }) },
    '↺'
  );

  const readout = h('div', { class: 'cube-readout' }, yawField, pitchField, nameField, resetBtn);
  const root = h('div', { class: 'cube' }, h('div', { class: 'cube-top' }, hint, badge), svgHost, readout);

  function numberField(host: HTMLElement, label: string, val: number, onCommit: (n: number) => void): void {
    const input = h('input', {
      class: 'cube-input',
      type: 'text',
      value: `${val}°`,
      onfocus: (e: Event) => (e.target as HTMLInputElement).select?.(),
      onchange: (e: Event) => {
        const raw = (e.target as HTMLInputElement).value.replace(/[^\-0-9.]/g, '');
        const n = Number(raw);
        if (Number.isFinite(n)) onCommit(n);
        else render();
      }
    });
    clear(host);
    host.appendChild(h('label', { class: 'cube-label' }, label));
    host.appendChild(input);
  }

  function drawCube(d: CameraDescriptor): SVGElement {
    const svg = svgEl('svg', {
      viewBox: `0 0 ${size} ${size}`,
      width: '100%',
      height: '100%',
      class: `cube-svg ${STABILITY_CLASS[d.stability]}`
    });

    // 地面轨道椭圆：帮助理解当前俯仰
    const pitchRad = (d.pitch * Math.PI) / 180;
    const ry = Math.max(3, Math.abs(Math.sin(pitchRad)) * size * 0.19 + 4);
    svg.appendChild(
      svgEl('ellipse', {
        cx: size / 2,
        cy: size / 2 + size * 0.2,
        rx: size * 0.31,
        ry,
        class: 'cube-orbit'
      })
    );

    const rotated = VERTS.map((v) => rotate(v, d.yaw, d.pitch));
    const projected = rotated.map((v) => project(v, size));

    const faces = FACES.map((f) => {
      const n = rotate(f.normal, d.yaw, d.pitch);
      const depth = f.idx.reduce((s, i) => s + rotated[i]![2], 0) / 4;
      // 法线 z 为负 = 朝向观察者
      return { ...f, depth, facing: -n[2] };
    }).sort((a, b) => b.depth - a.depth);

    for (const f of faces) {
      const pts = f.idx.map((i) => `${projected[i]!.x.toFixed(2)},${projected[i]!.y.toFixed(2)}`).join(' ');
      const visible = f.facing > 0.06;
      svg.appendChild(
        svgEl('polygon', {
          points: pts,
          class: `cube-face ${visible ? 'is-front' : 'is-back'}`,
          'fill-opacity': visible ? 0.92 : 0.16
        })
      );

      if (visible && f.facing > 0.5) {
        const cx = f.idx.reduce((s, i) => s + projected[i]!.x, 0) / 4;
        const cy = f.idx.reduce((s, i) => s + projected[i]!.y, 0) / 4;
        const meta = CUBE_FACE_LABELS[f.key];
        const code = svgEl('text', {
          x: cx.toFixed(1),
          y: (cy - 4).toFixed(1),
          class: 'cube-face-code',
          'text-anchor': 'middle'
        });
        code.textContent = meta.code;
        svg.appendChild(code);

        if (f.key === 'front') {
          const zh = svgEl('text', {
            x: cx.toFixed(1),
            y: (cy + 11).toFixed(1),
            class: 'cube-face-zh',
            'text-anchor': 'middle'
          });
          zh.textContent = meta.zh;
          svg.appendChild(zh);
        }
      }
    }

    // 底部把手，提示可拖拽
    svg.appendChild(
      svgEl('circle', { cx: size / 2, cy: size / 2 + size * 0.2, r: 5, class: 'cube-handle' })
    );
    return svg;
  }

  function render(): void {
    const d = describeCamera(value);

    clear(svgHost);
    svgHost.appendChild(drawCube(d));

    clear(badge);
    badge.className = `cube-badge ${STABILITY_CLASS[d.stability]}`;
    badge.appendChild(h('span', { class: 'cube-badge-grade' }, d.stability));
    badge.appendChild(h('span', { class: 'cube-badge-text' }, d.stabilityLabel));

    numberField(yawField, '水平', d.yaw, (n) => commit({ yaw: n, pitch: value.pitch }));
    numberField(pitchField, '垂直', d.pitch, (n) => commit({ yaw: value.yaw, pitch: n }));

    clear(nameField);
    nameField.appendChild(h('label', { class: 'cube-label' }, '视角名称'));
    nameField.appendChild(h('div', { class: 'cube-name' }, d.name));

    root.classList.toggle('is-risky', d.stability === 'C');
    let warn = root.querySelector('.cube-warn');
    if (d.stability === 'C') {
      if (!warn) {
        warn = h('div', { class: 'cube-warn' }, '接近正顶/正底机位，模型在这个角度上很不稳定，建议多出几张挑选');
        root.appendChild(warn);
      }
    } else if (warn) {
      root.removeChild(warn);
    }
  }

  function commit(next: CameraValue): void {
    const snapped: CameraValue = {
      yaw: normalizeYaw(Math.round(next.yaw / CAMERA_YAW_STEP) * CAMERA_YAW_STEP),
      pitch: clampInt(Math.round(next.pitch / CAMERA_PITCH_STEP) * CAMERA_PITCH_STEP, -90, 90)
    };
    if (snapped.yaw === value.yaw && snapped.pitch === value.pitch) {
      render();
      return;
    }
    value = snapped;
    render();
    opts.onChange({ ...value });
  }

  /* ---------------- 拖拽 ---------------- */

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let accYaw = 0;
  let accPitch = 0;

  const onDown = (e: PointerEvent): void => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    accYaw = value.yaw;
    accPitch = value.pitch;
    svgHost.classList.add('is-dragging');
    try {
      svgHost.setPointerCapture?.(e.pointerId);
    } catch {
      /* UXP 可能没有实现 pointer capture */
    }
  };

  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    // 每 4px 走一档，手感接近 Photoshop 里的角度控件
    accYaw += (e.clientX - lastX) * -0.6;
    accPitch += (e.clientY - lastY) * 0.6;
    lastX = e.clientX;
    lastY = e.clientY;
    commit({ yaw: accYaw, pitch: accPitch });
  };

  const onUp = (e: PointerEvent): void => {
    dragging = false;
    svgHost.classList.remove('is-dragging');
    try {
      svgHost.releasePointerCapture?.(e.pointerId);
    } catch {
      /* noop */
    }
  };

  svgHost.addEventListener('pointerdown', onDown as EventListener);
  svgHost.addEventListener('pointermove', onMove as EventListener);
  svgHost.addEventListener('pointerup', onUp as EventListener);
  svgHost.addEventListener('pointercancel', onUp as EventListener);
  svgHost.addEventListener('pointerleave', onUp as EventListener);

  // 键盘可达：方向键按步进微调，Shift 加速
  svgHost.setAttribute('tabindex', '0');
  svgHost.setAttribute('role', 'slider');
  svgHost.setAttribute('aria-label', '摄像机取景角度');
  svgHost.addEventListener('keydown', ((e: KeyboardEvent) => {
    const mult = e.shiftKey ? 5 : 1;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        commit({ yaw: value.yaw + CAMERA_YAW_STEP * mult, pitch: value.pitch });
        break;
      case 'ArrowRight':
        commit({ yaw: value.yaw - CAMERA_YAW_STEP * mult, pitch: value.pitch });
        break;
      case 'ArrowUp':
        commit({ yaw: value.yaw, pitch: value.pitch - CAMERA_PITCH_STEP * mult });
        break;
      case 'ArrowDown':
        commit({ yaw: value.yaw, pitch: value.pitch + CAMERA_PITCH_STEP * mult });
        break;
      case 'Home':
        commit({ yaw: 0, pitch: 0 });
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }) as EventListener);

  render();

  return {
    el: root,
    setValue(v: CameraValue) {
      value = { ...v };
      render();
    }
  };
}
