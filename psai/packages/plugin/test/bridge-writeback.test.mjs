/**
 * Photoshop 桥的捕获 / 写回契约。
 *
 * 这里用一个可控的假 `photoshop` 模块驱动真实的桥代码：图层树、文档列表、
 * batchPlay 的返回值全都由用例摆布。测得到的是**判断逻辑** ——
 * 校验按写回方式分档、嵌套组的祖先可见性、同名图层去重、空图拦截。
 *
 * 测不到的是 Photoshop 自己的行为：placeEvent 到底放出什么样的图层、
 * imaging.getSelection 给的灰度对不对、executeAsModal 的并发语义。
 * 那些只能在 Photoshop 里验，清单见 docs/PHOTOSHOP_ACCEPTANCE.md。
 * 本机没有 Photoshop，那部分**没有**跑过。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* ---------------- 假的 Photoshop ---------------- */

/** 造一个图层。传 children 就是组。 */
function layer(id, name, opts = {}) {
  return {
    id,
    name,
    kind: opts.children ? 'group' : 'pixel',
    visible: opts.visible ?? true,
    ...(opts.children ? { layers: opts.children } : {}),
    ...(opts.bounds ? { bounds: opts.bounds } : {}),
    scale: async () => {},
    translate: async () => {},
    delete: async function () {
      deleted.push(this.name);
      /*
       * 真的把自己从图层树里摘掉 —— Photoshop 就是这么做的。
       *
       * 只记一笔不摘掉的话，桥那边下一轮还会看到它，
       * 于是"同一条任务找到不止一个带标记的图层"这条保护会误触发，
       * 而那是假环境造出来的假象。桩不忠实，测出来的结论就不作数。
       */
      const drop = (c) => {
        if (!c.layers) return;
        const i = c.layers.findIndex((l) => l.id === this.id);
        if (i >= 0) c.layers.splice(i, 1);
        else c.layers.forEach(drop);
      };
      drop(doc);
    }
  };
}

let deleted = [];
let nextLayerId = 900;
let doc;
let histogram;
let batchCalls;

function makeDoc(layers, over = {}) {
  return {
    id: 1,
    name: 'a.psd',
    path: '',
    width: 1000,
    height: 800,
    resolution: 72,
    mode: { _value: 'RGBColor' },
    bitsPerChannel: 8,
    activeLayers: [],
    layers,
    selection: {},
    duplicate: async () => makeDoc(JSON.parse(JSON.stringify(layers))),
    close: async () => {},
    saveAs: { png: async () => {} },
    mergeVisibleLayers: async () => {},
    ...over
  };
}

function installFakePhotoshop() {
  deleted = [];
  nextLayerId = 900;
  batchCalls = [];
  histogram = [0, 5, 9, 3]; // 默认：有内容
  doc = makeDoc([
    layer(10, '背景'),
    layer(20, '外组', {
      visible: false,
      children: [layer(21, '内组', { visible: false, children: [layer(22, '深层图层', { visible: false })] })]
    }),
    layer(30, 'AI 结果')
  ]);

  const photoshop = {
    app: {
      get activeDocument() {
        return doc;
      },
      get documents() {
        return [doc];
      }
    },
    core: { executeAsModal: async (fn) => fn() },
    action: {
      batchPlay: async (cmds) => {
        batchCalls.push(cmds);
        if (cmds?.[0]?._obj === 'get') return [{ histogram }];
        // placeEvent 之后，Photoshop 会把新置入的图层设成当前图层。
        // 桥就是从 activeLayers[0] 拿到它的 —— 假模块得照着做，
        // 否则测的就不是真实路径了。
        if (cmds?.[0]?._obj === 'placeEvent') {
          // id 单调递增，绝不复用 —— 真 Photoshop 就是这样。
          // 用 layers.length 当 id 的话，删掉一个之后新图层会拿到旧 id，
          // 于是"这是不是新建的图层"那道校验会误判成"没新建"。
          const placed = layer(nextLayerId++, '（刚置入）');
          doc.layers.push(placed);
          doc.activeLayers = [placed];
        }
        return [{}];
      },
      addNotificationListener: () => {}
    },
    constants: { SaveOptions: { DONOTSAVECHANGES: 'no' }, ChangeMode: { RGB: 'rgb' } },
    apiVersion: '2.0'
  };

  globalThis.require = (m) => {
    if (m === 'photoshop') return photoshop;
    if (m === 'uxp') {
      return {
        storage: {
          formats: { binary: 'binary' },
          localFileSystem: {
            getDataFolder: async () => ({
              createFile: async () => ({
                read: async () => new ArrayBuffer(8),
                write: async () => {},
                delete: async () => {}
              })
            }),
            getFileForOpening: async () => null,
            createSessionToken: () => 'tok'
          }
        }
      };
    }
    throw new Error(`没有这个模块: ${m}`);
  };
  return photoshop;
}

const bridge = await import('../src/ps/bridge.ts');

beforeEach(() => {
  installFakePhotoshop();
  const init = bridge.initBridge();
  assert.equal(init.ok, true, `桥应该能初始化: ${init.reason}`);
});

function target(over = {}) {
  return {
    documentId: 1,
    documentName: 'a.psd',
    documentPath: '',
    canvasWidth: 1000,
    canvasHeight: 800,
    sourceLayerIds: [10],
    sourceLayerNames: ['背景'],
    selectionBounds: { left: 10, top: 10, right: 100, bottom: 100 },
    colorMode: 'RGB',
    bitDepth: 8,
    ...over
  };
}

/* ==================== 校验按写回方式分档 ==================== */

test('画布尺寸变了：只挡原位写回，不挡新建图层', () => {
  /*
   * 老代码对三种方式一视同仁地严格。用户裁了一下画布，
   * 连"新建一个图层"都被拦下来，理由还是"自动写回可能错位"——
   * 可新建图层根本不存在错位这回事。他只能去历史页反复点，
   * 每次被同一条不相干的理由挡回来。
   */
  doc.width = 1200; // 画布被改过

  const inPlace = bridge.validateWritebackTarget(target(), 'inPlaceSelection');
  assert.equal(inPlace.ok, false, '原位写回会错位，必须挡');
  assert.equal(inPlace.code, 'WRITEBACK_DOCUMENT_CHANGED');
  assert.match(inPlace.message, /智能对象|像素图层/, '要告诉用户还有别的路可以走');

  for (const mode of ['smartObject', 'pixelLayer']) {
    const r = bridge.validateWritebackTarget(target(), mode);
    assert.equal(r.ok, true, `${mode} 不该被画布变化挡住：${r.message}`);
  }
});

test('源图层没了：同样只挡原位写回', () => {
  const r0 = bridge.validateWritebackTarget(target({ sourceLayerIds: [999] }), 'inPlaceSelection');
  assert.equal(r0.ok, false);
  assert.equal(r0.code, 'PHOTOSHOP_LAYER_NOT_FOUND');

  assert.equal(
    bridge.validateWritebackTarget(target({ sourceLayerIds: [999] }), 'smartObject').ok,
    true,
    '新建图层不需要原来那些图层还在'
  );
});

test('嵌套在组里的源图层找得到，不会误判成"已不存在"', () => {
  // 22 埋在 外组 > 内组 里。递归找不到的话，一次完全正常的写回会被判成失败。
  const r = bridge.validateWritebackTarget(target({ sourceLayerIds: [22] }), 'inPlaceSelection');
  assert.equal(r.ok, true, `嵌套图层应该找得到：${r.message}`);
});

test('文档关掉了：所有写回方式都挡，理由要说清结果还在', () => {
  const r = bridge.validateWritebackTarget(target({ documentId: 77, documentName: '别的.psd' }), 'smartObject');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PHOTOSHOP_DOCUMENT_NOT_FOUND');
  assert.match(r.message, /结果已保留|再次写回/, '要让用户知道图没丢');
});

test('assetOnly 压根不碰 Photoshop，什么都不校验', () => {
  doc.width = 1200;
  const r = bridge.validateWritebackTarget(target({ sourceLayerIds: [999] }), 'assetOnly');
  assert.equal(r.ok, true, 'assetOnly 不写文档，没有什么可校验的');
});

/* ==================== assetOnly 的措辞 ==================== */

test('assetOnly 的说法要分清是"按设置"还是"没有可写的文档"', async () => {
  /*
   * 两种情况最后都走到 assetOnly，可原因完全不同。
   * 用同一句话打发的话，第二种情况下用户会以为是自己设置错了，
   * 跑去设置页翻半天 —— 而实际原因是提交时没有打开的文档。
   */
  const bySetting = await bridge.writeback({
    bytes: new ArrayBuffer(4),
    mode: 'assetOnly',
    layerName: 'x',
    target: target()
  });
  assert.equal(bySetting.ok, true);
  assert.match(bySetting.detail, /按设置/);

  const noDoc = await bridge.writeback({
    bytes: new ArrayBuffer(4),
    mode: 'assetOnly',
    layerName: 'x',
    target: target({ documentId: 0 })
  });
  assert.equal(noDoc.ok, true);
  assert.match(noDoc.detail, /没有可写回|历史页/);
  assert.notEqual(bySetting.detail, noDoc.detail, '两种情况不该给同一句话');
});

/* ==================== 图层替换：认出处，不认名字 ==================== */

/** 我们自己写进去的图层长什么样：名字后面带出处标记。 */
function ownedLayer(id, layerName, jobId, assetId) {
  return layer(id, `${layerName} [psai:${jobId}/${assetId}]`);
}

const PROV = { jobId: 'job_1', attemptId: 'att_1', assetId: 'asset_1' };

function wbOpts(over = {}) {
  return {
    bytes: new ArrayBuffer(4),
    mode: 'smartObject',
    layerName: 'AI 结果',
    target: target(),
    provenance: PROV,
    ...over
  };
}

test('再次写回替换掉上一次那个图层，不越堆越多', async () => {
  /*
   * 「再次写回」是明确支持的动作（结果永久保留，随时可以再写一次）。
   * 不替换的话，用户点三次就得到三个一模一样的图层叠在一起，
   * 从面板上根本看不出哪个是最新的，只能一个个关掉试。
   */
  doc.layers.push(ownedLayer(50, 'AI 结果', PROV.jobId, 'asset_0'));
  const res = await bridge.writeback(wbOpts());
  assert.equal(res.ok, true, res.detail);
  assert.equal(deleted.length, 1, '上一次那个图层应该被替换掉');
  assert.match(deleted[0], /psai:job_1\//, '删的必须是带我们出处标记的那一个');
});

test('用户自己建的同名图层，一根汗毛都不许动', async () => {
  /*
   * 这是这一组里最要紧的一条。去重曾经按**图层名**匹配，
   * 而"AI 结果"这种默认名用户随手就会占用：自己建一个、
   * 或者从别处粘一个进来，太正常了 —— 然后我们的下一次写回就把它删了。
   * 删的是用户的东西，而且没有任何提示，撤销栈里只有一次"删除图层"。
   */
  doc.layers.push(layer(60, 'AI 结果')); // 用户建的，没有出处标记
  const res = await bridge.writeback(wbOpts());
  assert.equal(res.ok, true, res.detail);
  assert.deepEqual(deleted, [], '没有出处标记就不是我们的，绝不能删');
  assert.ok(
    doc.layers.some((l) => l.id === 60),
    '用户那个图层必须还在'
  );
});

test('别的任务写的图层不算"自己人"，同样不许动', async () => {
  // 两条任务用同一个默认图层名是常态。各是各的，谁都不许动谁。
  doc.layers.push(ownedLayer(70, 'AI 结果', 'job_OTHER', 'asset_x'));
  const res = await bridge.writeback(wbOpts());
  assert.equal(res.ok, true, res.detail);
  assert.deepEqual(deleted, [], '不同 jobId 就不是同一次逻辑写回');
});

test('置入失败时，上一次的图层原封不动', async () => {
  /*
   * 顺序是"先放新的、确认放成了、再删旧的"。
   *
   * 反过来（先删后放）的话，只要置入那一步失败，用户就同时失去了
   * 旧结果和新结果 —— 而他什么都没做错，只是 Photoshop 那一刻不高兴。
   * "操作失败还顺手毁掉已有成果"是最不能接受的一类。
   */
  doc.layers.push(ownedLayer(80, 'AI 结果', PROV.jobId, 'asset_0'));
  const before = doc.layers.length;

  // 让 placeEvent 什么都不产生 —— 桥会因为拿不到图层而失败
  const photoshop = globalThis.require('photoshop');
  const realBatch = photoshop.action.batchPlay;
  photoshop.action.batchPlay = async (cmds) => {
    if (cmds?.[0]?._obj === 'placeEvent') return [{}]; // 不设 activeLayers
    return realBatch(cmds);
  };
  try {
    const res = await bridge.writeback(wbOpts());
    assert.equal(res.ok, false, '置入失败就该报失败');
    assert.deepEqual(deleted, [], '失败时绝不能删掉上一次的结果');
    assert.equal(doc.layers.length, before, '图层数量不该变');
  } finally {
    photoshop.action.batchPlay = realBatch;
  }
});

test('反复写回同一条任务：每次只留一个，且删的都是自己人', async () => {
  doc.layers.push(layer(90, 'AI 结果')); // 用户的，全程不该被碰
  for (let i = 0; i < 3; i++) {
    const res = await bridge.writeback(wbOpts({ provenance: { ...PROV, assetId: `asset_${i}` } }));
    assert.equal(res.ok, true, res.detail);
  }
  // 第一次没有前任可删，后两次各删一个
  assert.equal(deleted.length, 2, `应该只删掉两次前任，实际 ${deleted.length}`);
  assert.ok(
    deleted.every((n) => n.includes('psai:job_1/')),
    `删的都必须是自己人：${deleted.join(' | ')}`
  );
  assert.ok(
    doc.layers.some((l) => l.id === 90),
    '用户那个同名图层从头到尾都该在'
  );
});

test('出处标记读得回来，也认得出不是自己写的', () => {
  // 三样都在标记里：任务、哪一张结果、哪一次写回
  assert.deepEqual(bridge.readProvenance('AI 结果 [psai:job_9/asset_3@1f2e3d4c]'), {
    jobId: 'job_9',
    assetId: 'asset_3',
    attemptId: '1f2e3d4c'
  });

  /*
   * `@attempt` 是后加的一段，旧版本写进去的图层没有它。
   * 把那些判成"不是我们的"，「再次写回」就会从替换变成叠加 ——
   * 一次升级给所有人的文档多一个图层。
   */
  assert.deepEqual(bridge.readProvenance('AI 结果 [psai:job_9/asset_3]'), {
    jobId: 'job_9',
    assetId: 'asset_3',
    attemptId: null
  });

  // 用户随手起的名字，一律不认
  for (const n of [
    'AI 结果',
    'psai:job_9/asset_3',
    '[psai:]',
    '[psai:onlyjob]',
    '[psai:job/@abc]', // 有 @ 但没有 assetId
    'x [psai:a/b] 后面还有字'
  ]) {
    assert.equal(bridge.readProvenance(n), null, `不该把「${n}」当成我们写的`);
  }
});

test('落进文档的图层名里，三样出处都在', async () => {
  /*
   * 出现两个同 jobId 的图层时，光看 jobId 和 assetId 分不出
   * "用户复制了一份"和"两次写回各放了一张"—— 而这两种情况
   * 该怎么处理完全不同。带上 attemptId 至少让这件事事后看得出来：
   * 图层面板里、诊断包里都看得到。
   */
  const res = await bridge.writeback(wbOpts());
  assert.equal(res.ok, true, res.detail);

  const placed = doc.layers.find((l) => bridge.readProvenance(l.name)?.jobId === PROV.jobId);
  assert.ok(placed, '应该有一个带出处标记的新图层');

  const prov = bridge.readProvenance(placed.name);
  assert.equal(prov.jobId, PROV.jobId);
  assert.equal(prov.assetId, PROV.assetId);
  assert.equal(prov.attemptId, PROV.attemptId.slice(0, 8), '这一次写回的编号也要在里面');

  // 图层名是用户天天看的东西，不能长到没法看
  assert.ok(placed.name.length < 90, `图层名太长了：「${placed.name}」`);
});

test('标记写不全（图层名被截断）时判失败，不在残缺的标记上做决策', async () => {
  /*
   * Photoshop 对图层名有长度上限。只核一两样的话，一个被截断的名字
   * 可能刚好保住前面那截、丢掉后面那截，而我们会当成写成功了 ——
   * 然后在一个其实认不全的标记上做替换决策。
   */
  const photoshop = globalThis.require('photoshop');
  const realBatch = photoshop.action.batchPlay;
  photoshop.action.batchPlay = async (cmds) => {
    if (cmds?.[0]?._obj === 'placeEvent') {
      const placed = layer(nextLayerId++, '（刚置入）');
      let held = '（刚置入）';
      Object.defineProperty(placed, 'name', {
        get: () => held,
        set: (v) => {
          held = String(v).slice(0, 30); // 模拟被截断
        }
      });
      doc.layers.push(placed);
      doc.activeLayers = [placed];
      return [{}];
    }
    return realBatch(cmds);
  };
  try {
    const res = await bridge.writeback(wbOpts());
    assert.equal(res.ok, false, '标记没写全就该判失败');
    assert.match(res.detail, /出处标记/);
  } finally {
    photoshop.action.batchPlay = realBatch;
  }
});

/* ==================== 写回方式与原位校验 ==================== */

test('功能不允许的写回方式，在动文档之前就被挡下', async () => {
  const res = await bridge.writeback(
    wbOpts({ mode: 'inPlaceSelection', allowedModes: ['smartObject', 'pixelLayer'] })
  );
  assert.equal(res.ok, false);
  assert.match(res.detail, /不支持/);
  assert.deepEqual(deleted, [], '被挡下时不该动文档');
  assert.deepEqual(batchCalls, [], '一条 batchPlay 都不该发出去');
});

test('原位写回没有冻结选区：动文档之前就拒绝', async () => {
  /*
   * 老代码把这条检查放在置入之后：图已经进了文档，才发现没有选区可对齐，
   * 于是抛错 —— 而那张图还留在用户的文档里，位置是随便放的。
   * 用户看到的是"写回失败"外加一个凭空出现、还放错地方的图层。
   */
  const res = await bridge.writeback(wbOpts({ mode: 'inPlaceSelection', target: target({ selectionBounds: null }) }));
  assert.equal(res.ok, false);
  assert.match(res.detail, /没有记录选区/);
  assert.match(res.detail, /智能对象|像素图层/, '要给出可行的替代方案');
  assert.deepEqual(batchCalls, [], '一条 batchPlay 都不该发出去');
});

test('原位写回落点不对时判失败，绝不汇报成功', async () => {
  /*
   * scale / translate 可能悄悄失败或者只做了一半（图层被锁、变换被限制…），
   * 而它们不抛错。不核对的话我们会汇报"已写回选区原位"，
   * 而那张图实际歪在别的地方 —— 报告成功却明显放错位置，
   * 比直接说失败糟糕得多。
   */
  const photoshop = globalThis.require('photoshop');
  const realBatch = photoshop.action.batchPlay;
  photoshop.action.batchPlay = async (cmds) => {
    if (cmds?.[0]?._obj === 'placeEvent') {
      // 放进去了，但位置完全不对
      const placed = layer(910, '（刚置入）', { bounds: { left: 500, top: 500, right: 600, bottom: 600 } });
      placed.scale = async () => {};
      placed.translate = async () => {};
      doc.layers.push(placed);
      doc.activeLayers = [placed];
      return [{}];
    }
    return realBatch(cmds);
  };
  try {
    const res = await bridge.writeback(wbOpts({ mode: 'inPlaceSelection' }));
    assert.equal(res.ok, false, '落点不对就必须报失败');
    assert.match(res.detail, /没有落在选区上/);
  } finally {
    photoshop.action.batchPlay = realBatch;
  }
});

test('读不到落点边界时也判失败，不猜"大概放对了"', async () => {
  const photoshop = globalThis.require('photoshop');
  const realBatch = photoshop.action.batchPlay;
  photoshop.action.batchPlay = async (cmds) => {
    if (cmds?.[0]?._obj === 'placeEvent') {
      const placed = layer(920, '（刚置入）'); // 没有 bounds
      placed.scale = async () => {};
      placed.translate = async () => {};
      doc.layers.push(placed);
      doc.activeLayers = [placed];
      return [{}];
    }
    return realBatch(cmds);
  };
  try {
    const res = await bridge.writeback(wbOpts({ mode: 'inPlaceSelection' }));
    assert.equal(res.ok, false);
    assert.match(res.detail, /读不到图层边界/);
  } finally {
    photoshop.action.batchPlay = realBatch;
  }
});

test('assetOnly 不依赖 Photoshop：桥不可用时照样成功', async () => {
  /*
   * assetOnly 压根不碰文档 —— 结果落资产库就完事了。
   * 把它挡在"Photoshop 不可用"后面的话，浏览器预览、
   * Photoshop 崩过一次之后，一个本来必定成功的操作会报失败。
   */
  globalThis.require = () => {
    throw new Error('不在 Photoshop 里');
  };
  bridge.initBridge();
  assert.equal(bridge.isAvailable(), false, '前提：桥应该是不可用的');

  const res = await bridge.writeback(wbOpts({ mode: 'assetOnly' }));
  assert.equal(res.ok, true, `assetOnly 不该受 Photoshop 可用性影响：${res.detail}`);
});

/* ==================== 捕获：嵌套组与空图 ==================== */

test('捕获嵌套图层时，祖先组也要一并打开', async () => {
  /*
   * 图层显不显示 = 自己 visible && 每一层祖先组都 visible。
   * 只把图层本身设成 visible 的话，藏在收起的组里的图层照样不显示 ——
   * 而我们导出的是"看得见的东西"，结果是一张全透明的图一路传到模型那里，
   * 用户拿回一张跟输入毫无关系的结果，整条链路上没有一处报错。
   */
  let snapshotDoc = null;
  doc.activeLayers = [{ id: 22, name: '深层图层', kind: 'pixel', visible: false }];
  doc.duplicate = async () => {
    snapshotDoc = makeDoc([
      layer(10, '背景'),
      layer(20, '外组', {
        visible: false,
        children: [layer(21, '内组', { visible: false, children: [layer(22, '深层图层', { visible: false })] })]
      })
    ]);
    return snapshotDoc;
  };

  await bridge.captureActiveLayers();

  const outer = snapshotDoc.layers.find((l) => l.id === 20);
  const inner = outer.layers[0];
  const leaf = inner.layers[0];
  assert.equal(leaf.visible, true, '目标图层本身要打开');
  assert.equal(inner.visible, true, '内层组也要打开，否则它还是看不见');
  assert.equal(outer.visible, true, '外层组同样要打开');
});

test('捕获到空图时当场报错，不把一张全透明的图送去生成', async () => {
  // 零面积 bounds = 图层里没有像素
  doc.activeLayers = [{ id: 10, name: '背景', kind: 'pixel', visible: true }];
  doc.duplicate = async () => makeDoc([layer(10, '背景', { bounds: { left: 0, top: 0, right: 0, bottom: 0 } })]);

  const e = await bridge.captureActiveLayers().then(
    () => null,
    (err) => err
  );
  assert.ok(e, '空图应该报错');
  assert.match(e.message, /空图|画布外|空白/, `理由要说清可能是哪儿出的问题：${e.message}`);
});

test('纯黑图层不算空 —— 判据看的是有没有像素，不是像素什么颜色', async () => {
  /*
   * 一开始用的判据是文档直方图，纯黑图层所有像素都落在 0 号桶，
   * 会被判成"空的"而拦下来 —— 而阴影层、蒙版底都是纯黑的常见用法。
   * 改用 bounds 之后不存在这个误伤，这条用例把它钉住。
   */
  doc.activeLayers = [{ id: 10, name: '纯黑', kind: 'pixel', visible: true }];
  doc.duplicate = async () => makeDoc([layer(10, '纯黑', { bounds: { left: 0, top: 0, right: 64, bottom: 64 } })]);
  const snap = await bridge.captureActiveLayers();
  assert.ok(snap, '有像素就不该被拦，哪怕它们全是黑的');
});

test('读不到 bounds 时放行，不拿一次读取失败去拦用户', async () => {
  doc.activeLayers = [{ id: 10, name: '背景', kind: 'pixel', visible: true }];
  doc.duplicate = async () => makeDoc([layer(10, '背景')]); // 没有 bounds
  const snap = await bridge.captureActiveLayers();
  assert.ok(snap, '读不到 bounds 不该让捕获失败');
});

/* ==================== 快照带上文档身份 ==================== */

test('快照记下它取自哪个文档', async () => {
  doc.activeLayers = [{ id: 10, name: '背景', kind: 'pixel', visible: true }];
  const snap = await bridge.captureActiveLayers();
  assert.equal(snap.context.documentId, 1);
  assert.equal(snap.context.documentName, 'a.psd');
});

test('取不到 imaging 时，选区快照如实不带遮罩', async () => {
  // 老一点的 UXP 没有 imaging。这时候选区退化成外接矩形，
  // 调用方要据此告诉用户"羽化与不规则形状不会保留"，而不是假装有遮罩。
  doc.selection = { bounds: { left: 10, top: 10, right: 100, bottom: 100 } };
  const snap = await bridge.captureSelection();
  assert.equal(snap.maskGray, null, '没有 imaging 就不该编一个遮罩出来');
  assert.deepEqual(snap.selectionBounds, { left: 10, top: 10, right: 100, bottom: 100 });
});

/* ==================== 选区遮罩：读取的三种结局 ==================== */

/**
 * 装一个可控的 imaging.getSelection。
 *
 * @param impl 收到 {documentID, sourceBounds, componentSize, colorSpace} 之后要做什么
 */
function installImaging(impl) {
  const photoshop = globalThis.require('photoshop');
  photoshop.imaging =
    impl === null
      ? undefined
      : {
          getSelection: async (o) => {
            const res = await impl(o);
            /*
             * 真接口会回报它**实际**取的那一块。替身默认照抄请求
             * （最常见的情况），用例想模拟"挪了位置"或"老版本不给这个字段"
             * 时可以显式覆盖。
             *
             * 默认不填的话，happy path 就绕过了那道核对 ——
             * 于是"没有核对返回的窗口"这个缺陷永远照不出来。
             */
            if (res && res.sourceBounds === null) res.sourceBounds = o?.sourceBounds ?? null;
            if (res && res.sourceBounds === 'omit') delete res.sourceBounds;
            return res;
          }
        };
  const init = bridge.initBridge();
  assert.equal(init.ok, true);
}

/**
 * 造一份 imageData —— 尽量贴着 UXP 的真实契约，而不是我们希望的样子。
 *
 * 替身比真货宽松的话，测试就测了个寂寞。真接口有这么几件事是必须模出来的：
 *
 *  · componentSize 决定 getData 的**返回类型**：8 位给 Uint8Array，
 *    16 位给 Uint16Array，32 位给 Float32Array（值域 0–1）。
 *    只给 Uint8Array 的替身，永远照不出"位深换算写错了"这一类问题。
 *  · 16 位默认是 Photoshop 的**缩减量程** 0–32768；要 0–65535 必须
 *    在 getData 里显式要 `fullRange: true`。替身照这个规矩来 ——
 *    不然"忘了要 fullRange"这个错（每个值小一半）测不出来。
 *  · colorSpace / pixelFormat 对选区来说都是灰度。
 *  · getData 接受 {chunky, fullRange}；chunky 才是交错排列，跨步取值的前提。
 *  · 返回值里带 sourceBounds：接口**实际**取的那一块，未必等于请求的那一块。
 *  · dispose 必须被调用。
 *
 * @param gray  Photoshop 极性的选区灰度（255 = 完全选中），值域固定 0–255
 * @param opts.componentSize 8 / 16 / 32 —— gray 会被换算到对应值域
 * @param opts.rawValues 直接给每个像素的**原始值**（已经是目标值域），
 *   绕过 gray 的换算。用来喂真实的 16/32 位数据 ——
 *   把 8 位放大上去会掩盖问题：255→65535 正好是乘 257，
 *   而 257 ≡ 1 (mod 256)，于是"按 256 取模截断"这个 bug
 *   在放大来的数据上恰好还原出正确答案，一条都测不出来。
 */
function imageData(gray, w, h, components = 1, opts = {}) {
  const size = opts.componentSize ?? 8;
  const n = w * h * components;
  const Arr = size === 16 ? Uint16Array : size === 32 ? Float32Array : Uint8Array;

  /*
   * 16 位有两个量程：默认的缩减量程 0–32768，和要了 fullRange 之后的
   * 0–65535。替身**按调用方要没要 fullRange 来决定给哪一种**，
   * 真接口就是这么做的 —— 只给一种的话，"忘了要 fullRange 却按 65535 换算"
   * 这个错（每个值小一半）在测试里根本看不出来。
   */
  function build(fullRange) {
    const raw = new Arr(n);
    const top = size === 16 ? (fullRange ? 65535 : 32768) : 255;
    const conv = (v) => (size === 16 ? Math.round((v / 255) * top) : size === 32 ? v / 255 : v);
    for (let i = 0; i < w * h; i++) {
      const v = opts.rawValues ? opts.rawValues[i] : conv(gray[i]);
      for (let c = 0; c < components; c++) raw[i * components + c] = v;
    }
    return raw;
  }

  let disposed = false;
  const data = {
    width: w,
    height: h,
    components,
    componentSize: size,
    colorSpace: opts.colorSpace ?? 'Grayscale',
    pixelFormat: opts.pixelFormat ?? 'Grayscale',
    /** 记下最后一次 getData 的参数，用例要断言我们确实要了 fullRange */
    lastGetDataOpts: null,
    getData: async (o) => {
      data.lastGetDataOpts = o ?? null;
      // 真接口默认就是 chunky；平面排布要另说，我们的取值逻辑不认那种
      if (o && o.chunky === false) throw new Error('替身只支持 chunky');
      return build(!!(o && o.fullRange));
    },
    dispose: () => {
      disposed = true;
    },
    get disposed() {
      return disposed;
    }
  };
  for (const [k, v] of Object.entries(opts.override ?? {})) data[k] = v;
  // sourceBounds 默认就是请求的那一块；用例可以覆盖成"挪过位置"的
  return { imageData: data, sourceBounds: opts.sourceBounds ?? null };
}

function selectionDoc(bounds = { left: 10, top: 20, right: 42, bottom: 44 }) {
  doc.selection = { bounds };
  // 截图尺寸要和 bounds 对得上 —— 生产路径就是按同一个 bounds 裁的
  const w = bounds.right - bounds.left;
  const h = bounds.bottom - bounds.top;
  doc.duplicate = async () => makeDoc([layer(10, '背景', { bounds: { left: 0, top: 0, right: w, bottom: h } })], {
    width: w,
    height: h
  });
  return { w, h, bounds };
}

test('读到遮罩：尺寸、字节布局、极性都按约定来', async () => {
  const { w, h, bounds } = selectionDoc();
  let sawBounds = null;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = i % 2 === 0 ? 255 : 0; // 棋盘，好验布局

  installImaging(async (opts) => {
    sawBounds = opts.sourceBounds;
    return imageData(gray, w, h, 1);
  });

  const snap = await bridge.captureSelection();
  assert.ok(snap.maskGray, `应该拿到遮罩：${snap.maskUnavailable}`);
  assert.equal(snap.maskWidth, w, '遮罩宽度要和截图一致');
  assert.equal(snap.maskHeight, h);
  assert.equal(snap.maskGray.length, w * h, '单通道时长度就是像素数');
  // 用的是**同一个** bounds：画面按它裁、遮罩按它读
  assert.deepEqual(sawBounds, bounds, 'getSelection 要用截图那个 bounds');
  // 极性：这里仍是 Photoshop 侧的原始灰度（255 = 选中），反转在 Helper 合成时做
  assert.equal(snap.maskGray[0], 255);
  assert.equal(snap.maskGray[1], 0);
});

test('多通道交错返回时，按步长取第 0 个通道', async () => {
  // 某些版本按 RGBA 交错给，四个通道是同一个值。
  // 假设"一定是单通道"的话，取出来的会是每隔四个像素的采样 —— 遮罩整个乱掉。
  const { w, h } = selectionDoc();
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = i % 3 === 0 ? 255 : 64;

  installImaging(async () => imageData(gray, w, h, 4));

  const snap = await bridge.captureSelection();
  assert.ok(snap.maskGray, snap.maskUnavailable);
  assert.equal(snap.maskGray.length, w * h);
  for (let i = 0; i < w * h; i++) {
    assert.equal(snap.maskGray[i], gray[i], `第 ${i} 个像素取错了通道`);
  }
});

test('羽化与不规则选区原样带回，不做任何简化', async () => {
  const { w, h } = selectionDoc();
  const gray = new Uint8Array(w * h);
  // 一个带渐变边的斜向形状：既不规则、又有中间值
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = x + y;
      gray[y * w + x] = t < 10 ? 255 : t < 20 ? Math.round(255 * (1 - (t - 10) / 10)) : 0;
    }
  }
  installImaging(async () => imageData(gray, w, h, 1));

  const snap = await bridge.captureSelection();
  assert.ok(snap.maskGray, snap.maskUnavailable);
  for (let i = 0; i < w * h; i++) assert.equal(snap.maskGray[i], gray[i], `第 ${i} 个像素被改动了`);
  assert.ok(
    [...snap.maskGray].some((v) => v > 0 && v < 255),
    '羽化的中间值必须留下来'
  );
});

test('读完之后释放 imageData，不泄漏', async () => {
  const { w, h } = selectionDoc();
  let handle = null;
  installImaging(async () => {
    const r = imageData(new Uint8Array(w * h).fill(255), w, h, 1);
    handle = r.imageData;
    return r;
  });
  await bridge.captureSelection();
  assert.equal(handle.disposed, true, 'imageData 必须被释放');
});

test('接口在但报错：如实说是"读取失败"，不冒充老版本', async () => {
  /*
   * 第一版把所有异常都归成"返回 null"，上层一律提示
   * "这个 Photoshop 版本取不到选区遮罩"。于是权限问题、并发冲突、
   * 选区被别的操作改掉 —— 全都被说成"你的 Photoshop 太老"，
   * 用户永远不会去查真正的原因，而羽化和不规则形状长期悄悄失效。
   */
  const { w, h } = selectionDoc();
  void w;
  void h;
  installImaging(async () => {
    throw new Error('selection is locked by another operation');
  });

  const snap = await bridge.captureSelection();
  assert.equal(snap.maskGray, null, '读失败就不该有遮罩');
  assert.match(snap.maskUnavailable, /读取选区遮罩失败/, '要说清是失败，不是版本问题');
  assert.match(snap.maskUnavailable, /locked by another operation/, '要带上原始报错');
});

test('数据长度不够：判为失败，绝不拿半截数据当遮罩', async () => {
  const { w, h } = selectionDoc();
  installImaging(async () => ({
    imageData: {
      width: w,
      height: h,
      components: 1,
      getData: async () => new Uint8Array(10), // 远远不够
      dispose: () => {}
    }
  }));

  const snap = await bridge.captureSelection();
  assert.equal(snap.maskGray, null);
  assert.match(snap.maskUnavailable, /数据长度/);
});

test('返回的窗口和请求的不一致：判为失败，不缩放对齐也不静默丢弃', async () => {
  /*
   * 画面和遮罩用的是同一个 bounds。对不上就说明 Photoshop 给的窗口
   * 和我们想的不一样 —— 硬缩放对齐是最坏的选择：遮罩整体偏几个像素之后，
   * "改错了地方"比"没有遮罩"难查得多。
   */
  const { w, h } = selectionDoc();
  installImaging(async () => imageData(new Uint8Array(8 * 8).fill(255), 8, 8, 1));

  const snap = await bridge.captureSelection();
  assert.equal(snap.maskGray, null);
  assert.match(snap.maskUnavailable, /不一致/);
  assert.match(snap.maskUnavailable, /8×8/, '要说清实际拿到的是多大');
  assert.match(snap.maskUnavailable, new RegExp(`${w}×${h}`), '也要说清我们要的是多大');
});

test('没有 imaging 接口：这一种才叫"版本问题"', async () => {
  selectionDoc();
  installImaging(null);
  const snap = await bridge.captureSelection();
  assert.equal(snap.maskGray, null);
  assert.match(snap.maskUnavailable, /版本/);
  assert.ok(!/失败/.test(snap.maskUnavailable), '环境限制不该说成失败');
});

/* ==================== 置入身份 / 回滚 / 出处严格性 ==================== */

/** 让 placeEvent 变成一次"什么都没做"的空转 —— 但仍然报成功。 */
function makePlaceNoop() {
  const photoshop = globalThis.require('photoshop');
  const realBatch = photoshop.action.batchPlay;
  photoshop.action.batchPlay = async (cmds) => {
    if (cmds?.[0]?._obj === 'placeEvent' || cmds?.[0]?._obj === 'paste') {
      // 什么都不建，activeLayers 保持原样
      return [{}];
    }
    return realBatch(cmds);
  };
  return () => {
    photoshop.action.batchPlay = realBatch;
  };
}

test('placeEvent 空转时，绝不把用户当前选中的图层当成结果', async () => {
  /*
   * 这是最危险的一条。placeEvent / paste 有可能什么都没做就返回
   * （路径不对、剪贴板空了、命令被别的东西吞了），而 Photoshop 不报错。
   * 那时候 activeLayers[0] 是**用户原本选中的那个图层** ——
   * 拿它当"刚置入的结果"往下走，我们就会给它改名（盖上出处标记）、
   * 缩放、位移。用户一个好好的图层被就地改掉，而我们汇报"写回成功"。
   */
  const victim = layer(600, '用户的重要图层');
  doc.layers.push(victim);
  doc.activeLayers = [victim];
  const nameBefore = victim.name;

  const restore = makePlaceNoop();
  try {
    const res = await bridge.writeback(wbOpts());
    assert.equal(res.ok, false, '空转必须被识破');
    assert.match(res.detail, /没有新建图层/);
    assert.equal(victim.name, nameBefore, '用户的图层名一个字都不该变');
    assert.deepEqual(deleted, [], '更不该删任何东西');
  } finally {
    restore();
  }
});

test('像素图层路径同样要证明是新建的', async () => {
  const victim = layer(610, '用户的图层');
  doc.layers.push(victim);
  doc.activeLayers = [victim];

  const restore = makePlaceNoop();
  try {
    const res = await bridge.writeback(wbOpts({ mode: 'pixelLayer' }));
    assert.equal(res.ok, false);
    assert.match(res.detail, /没有新建图层/);
    assert.equal(victim.name, '用户的图层');
  } finally {
    restore();
  }
});

/** 让置入之后的某一步失败。 */
function breakAfterPlace(what) {
  const photoshop = globalThis.require('photoshop');
  const realBatch = photoshop.action.batchPlay;
  photoshop.action.batchPlay = async (cmds) => {
    if (cmds?.[0]?._obj === 'placeEvent') {
      const placed = layer(nextLayerId++, '（刚置入）', { bounds: { left: 0, top: 0, right: 10, bottom: 10 } });
      if (what === 'scale') placed.scale = async () => Promise.reject(new Error('缩放被拒绝'));
      if (what === 'translate') placed.translate = async () => Promise.reject(new Error('位移被拒绝'));
      if (what === 'stamp') {
        Object.defineProperty(placed, 'name', {
          get: () => '（刚置入）',
          set: () => {
            throw new Error('图层名被锁定');
          }
        });
      }
      if (what === 'undeletable') placed.delete = async () => Promise.reject(new Error('删不掉'));
      doc.layers.push(placed);
      doc.activeLayers = [placed];
      return [{}];
    }
    return realBatch(cmds);
  };
  return () => {
    photoshop.action.batchPlay = realBatch;
  };
}

for (const step of ['scale', 'translate']) {
  test(`原位写回时 ${step} 失败：撤掉新图层，前任原封不动`, async () => {
    const prev = ownedLayer(620, 'AI 结果', PROV.jobId, 'asset_0');
    doc.layers.push(prev);
    const before = doc.layers.length;

    const restore = breakAfterPlace(step);
    try {
      const res = await bridge.writeback(wbOpts({ mode: 'inPlaceSelection' }));
      assert.equal(res.ok, false, `${step} 失败就该报失败`);
      assert.equal(doc.layers.length, before, '刚置入的那个必须被撤掉，图层数回到动手之前');
      assert.ok(
        doc.layers.some((l) => l.id === 620),
        '前任必须原封不动'
      );
      assert.ok(!deleted.some((n) => n.includes('asset_0')), '绝不能删前任');
    } finally {
      restore();
    }
  });
}

test('出处标记盖不上时判失败，并撤掉新图层', async () => {
  /*
   * 盖不上就必须失败：没有标记的图层，下一次写回认不出它是自己人，
   * 于是会在用户的文档里越堆越多；而如果我们此时还汇报成功，
   * 用户更没有理由去检查。
   */
  const before = doc.layers.length;
  const restore = breakAfterPlace('stamp');
  try {
    const res = await bridge.writeback(wbOpts());
    assert.equal(res.ok, false, '标记盖不上就该失败');
    assert.match(res.detail, /出处标记/);
    assert.equal(doc.layers.length, before, '新图层要被撤掉');
  } finally {
    restore();
  }
});

test('撤不掉新图层时，报的是"写了一半"而不是"失败了"', async () => {
  /*
   * "失败了"的含义是文档没被动过、放心重试。而这里文档确实动了、
   * 还多出来一个图层 —— 用同一个说法的话，用户会直接重试，然后再多一个。
   */
  const restore = breakAfterPlace('stamp');
  const photoshop = globalThis.require('photoshop');
  const realBatch = photoshop.action.batchPlay;
  photoshop.action.batchPlay = async (cmds) => {
    if (cmds?.[0]?._obj === 'placeEvent') {
      const placed = layer(nextLayerId++, '（刚置入）');
      Object.defineProperty(placed, 'name', {
        get: () => '（刚置入）',
        set: () => {
          throw new Error('图层名被锁定');
        }
      });
      placed.delete = async () => {
        throw new Error('删不掉');
      };
      doc.layers.push(placed);
      doc.activeLayers = [placed];
      return [{}];
    }
    return realBatch(cmds);
  };
  try {
    const res = await bridge.writeback(wbOpts());
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITEBACK_PARTIAL', '要用专门的码，不能和"文档没动"混为一谈');
    assert.match(res.detail, /手动检查/);
  } finally {
    photoshop.action.batchPlay = realBatch;
    restore();
  }
});

test('同一条任务出现多个带标记的图层时，一个都不删', async () => {
  /*
   * 用户复制过我们的图层，或者手工改过标记 —— 这时候情况和我们的模型
   * 对不上，删哪一个都可能是错的。多留一个图层是小事，
   * 删错一个用户的东西不是。
   */
  doc.layers.push(ownedLayer(630, 'AI 结果', PROV.jobId, 'asset_a'));
  doc.layers.push(ownedLayer(631, 'AI 结果 拷贝', PROV.jobId, 'asset_a'));

  const res = await bridge.writeback(wbOpts());
  assert.equal(res.ok, true, res.detail);
  assert.deepEqual(deleted, [], '拿不准就一个都别动');
  assert.ok(doc.layers.some((l) => l.id === 630) && doc.layers.some((l) => l.id === 631), '两个都该还在');
});

test('用户改过我们的图层名（标记没了）之后，它就成了用户的东西', async () => {
  // 标记是唯一的凭据。用户把它删掉，等于收回了授权 —— 我们不该再动它。
  doc.layers.push(layer(640, 'AI 结果（我改过的）'));
  const res = await bridge.writeback(wbOpts());
  assert.equal(res.ok, true, res.detail);
  assert.deepEqual(deleted, [], '没有标记就不是我们的');
  assert.ok(doc.layers.some((l) => l.id === 640));
});

/* ==================== 选区数据契约：位深、通道、色彩空间 ==================== */

/*
 * 这一组守的都是**不会报错、只会悄悄产出错误遮罩**的情况。
 *
 * 遮罩错了模型照样跑，照样出图，照样收费 —— 只是改错了地方。
 * 用户看到的是一张"模型没听懂我"的图，不会想到是遮罩读错了。
 * 所以这里的原则是：读不懂就如实说读不到（界面会退回外接矩形并明说），
 * 绝不猜。
 */

test('16 位文档：按值域换算，不是按 256 取模截断', async () => {
  /*
   * 老代码是 `gray[i] = raw[i * comps]`，而 gray 是 Uint8Array ——
   * 赋值按 256 取模**截断**，不是钳制。于是 16 位文档上
   * 0x0100（几乎没选中）变成 0，0x8000（半选）也变成 0，
   * 整张遮罩变成一片对不上任何东西的噪声，而且一声不吭。
   *
   * 喂的必须是**真的 16 位值**。拿 8 位放大上去测不出问题：
   * 255→65535 正好是乘 257，而 257 ≡ 1 (mod 256)，
   * 截断之后恰好还原出正确答案 —— 一条都红不了。
   */
  const { w, h } = selectionDoc();
  const raw16 = [];
  const want = [];
  for (let i = 0; i < w * h; i++) {
    // 刻意避开 257 的整数倍
    const v = (i * 1013 + 7) % 65536;
    raw16.push(v);
    want.push(Math.round((v / 65535) * 255));
  }

  installImaging(async () => imageData(null, w, h, 1, { componentSize: 16, rawValues: raw16 }));

  const snap = await bridge.captureSelection();
  assert.ok(snap.maskGray, `16 位应该读得出来：${snap.maskUnavailable}`);
  for (let i = 0; i < w * h; i++) {
    assert.equal(snap.maskGray[i], want[i], `第 ${i} 个像素（原始值 ${raw16[i]}）换算错了`);
  }
});

test('32 位文档：0–1 浮点按值域换算，不是直接截断', async () => {
  // 直接截断的话除了 1.0 之外全变成 0 —— 一张几乎全黑的"遮罩"。
  const { w, h } = selectionDoc();
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = (i * 7) % 256;

  installImaging(async () => imageData(gray, w, h, 1, { componentSize: 32 }));

  const snap = await bridge.captureSelection();
  assert.ok(snap.maskGray, `32 位应该读得出来：${snap.maskUnavailable}`);
  for (let i = 0; i < w * h; i++) {
    assert.ok(Math.abs(snap.maskGray[i] - gray[i]) <= 1, `第 ${i} 个像素换算错了`);
  }
  assert.ok(
    [...snap.maskGray].some((v) => v > 0 && v < 255),
    '中间值必须活下来，否则等于没换算'
  );
});

test('位深和数组类型对不上：判为失败，不按任何一种猜', async () => {
  // 说是 16 位却给了 Uint8Array —— 说明我们理解错了这份数据的排布。
  // 两种解释都可能是错的，那就一种都不能选。
  const { w, h } = selectionDoc();
  installImaging(async () =>
    imageData(new Uint8Array(w * h).fill(200), w, h, 1, { override: { componentSize: 16 } })
  );

  const snap = await bridge.captureSelection();
  assert.equal(snap.maskGray, null, '对不上就不该给出遮罩');
  assert.match(snap.maskUnavailable, /位深/);
});

test('没见过的位深：如实说不支持', async () => {
  const { w, h } = selectionDoc();
  installImaging(async () => imageData(new Uint8Array(w * h).fill(255), w, h, 1, { override: { componentSize: 12 } }));

  const snap = await bridge.captureSelection();
  assert.equal(snap.maskGray, null);
  assert.match(snap.maskUnavailable, /位深/);
});

test('通道数缺失或不合法：判为失败，不默认成 1', async () => {
  /*
   * 老代码写的是 `imageData.components || 1`。0 或 undefined 会被悄悄
   * 改成 1，然后按单通道跨步去读一份其实是多通道的数据 ——
   * 读出来是一张错位的噪声图，而它长得**很像**一张有内容的遮罩，
   * 不会被任何"有没有可编辑区"的体检拦下来。
   */
  const { w, h } = selectionDoc();
  for (const bad of [0, undefined, -1, 9, 1.5]) {
    installImaging(async () =>
      imageData(new Uint8Array(w * h).fill(255), w, h, 4, { override: { components: bad } })
    );
    const snap = await bridge.captureSelection();
    assert.equal(snap.maskGray, null, `components=${bad} 不该被接受`);
    assert.match(snap.maskUnavailable, /通道数/);
  }
});

test('色彩空间不是灰度：判为失败 —— 第 0 通道是红色，不是选区强度', async () => {
  const { w, h } = selectionDoc();
  installImaging(async () => imageData(new Uint8Array(w * h).fill(255), w, h, 3, { colorSpace: 'RGB' }));

  const snap = await bridge.captureSelection();
  assert.equal(snap.maskGray, null);
  assert.match(snap.maskUnavailable, /灰度/);
});

test('尺寸不合法（0 / 非整数）：判为失败', async () => {
  const { w, h } = selectionDoc();
  for (const override of [{ width: 0 }, { height: 0 }, { width: 1.5 }, { width: -4 }]) {
    installImaging(async () => imageData(new Uint8Array(w * h).fill(255), w, h, 1, { override }));
    const snap = await bridge.captureSelection();
    assert.equal(snap.maskGray, null, `${JSON.stringify(override)} 不该被接受`);
    assert.ok(snap.maskUnavailable, '要给出原因');
  }
});

test('明确要 8 位灰度，不看文档位深的脸色', async () => {
  const { w, h, bounds } = selectionDoc();
  let sawOpts = null;
  installImaging(async (opts) => {
    sawOpts = opts;
    return imageData(new Uint8Array(w * h).fill(255), w, h, 1);
  });
  await bridge.captureSelection();
  assert.equal(sawOpts.componentSize, 8, '先礼后兵：能要就要 8 位');
  assert.match(String(sawOpts.colorSpace), /gray/i);
  assert.deepEqual(sawOpts.sourceBounds, bounds);
});

test('按 chunky 取数据 —— 跨步取值的前提', async () => {
  // 平面排布（RRRR…GGGG）下按 i*comps 跨步取到的是一片红色分量，
  // 而不是每个像素的第 0 通道。必须明确要交错排布。
  const { w, h } = selectionDoc();
  let sawChunky;
  installImaging(async () => {
    const r = imageData(new Uint8Array(w * h).fill(128), w, h, 4);
    const real = r.imageData.getData;
    r.imageData.getData = async (o) => {
      sawChunky = o?.chunky;
      return real(o);
    };
    return r;
  });
  await bridge.captureSelection();
  assert.equal(sawChunky, true, '必须显式要 chunky，别让接口的默认值替我们做主');
});

test('getData 返回空：判为失败，不当成"全不选中"', async () => {
  // 一张全 0 的遮罩在极性反转之后是"整张都可编辑"—— 那是合法值，
  // 会被体检放行，然后模型把整张图重画一遍。
  const { w, h } = selectionDoc();
  installImaging(async () => imageData(new Uint8Array(w * h).fill(255), w, h, 1, { override: { getData: async () => null } }));

  const snap = await bridge.captureSelection();
  assert.equal(snap.maskGray, null);
  assert.match(snap.maskUnavailable, /没有返回像素数据/);
});

/* ==================== 选中一个组：要拿到这个组画出来的样子 ==================== */

/** 捕获时导出的那份副本 —— 用来看到底哪些图层留在了可见状态。 */
function captureCopy() {
  let copy = null;
  doc.duplicate = async () => {
    copy = makeDoc(JSON.parse(JSON.stringify(doc.layers)));
    copy.mergeVisibleLayers = async () => {};
    return copy;
  };
  return () => copy;
}

function visibleIds(container, into = []) {
  for (const l of container.layers ?? []) {
    if (l.visible) into.push(l.id);
    if (l.layers?.length) visibleIds(l, into);
  }
  return into;
}

test('选中一个组：组里原本可见的图层要跟着一起出现', async () => {
  /*
   * 捕获会先把所有图层藏起来，再单独打开目标。
   * 目标是**组**的时候，只把组自己打开是没用的 ——
   * 它里面的图层刚刚被一起藏掉了，合并出来是一张全透明的图。
   * 那张空图会一路传到模型那里，用户拿回一张跟他的图毫无关系的结果，
   * 而整条链路上不会有任何一处报错。
   */
  const grp = layer(200, '一个组', {
    children: [layer(201, '子图层 A'), layer(202, '子图层 B')]
  });
  doc.layers.push(grp);
  doc.activeLayers = [grp];
  const getCopy = captureCopy();

  await bridge.captureActiveLayers();

  const vis = visibleIds(getCopy());
  assert.ok(vis.includes(200), '组本身要可见');
  assert.ok(vis.includes(201) && vis.includes(202), '组里的图层必须跟着可见，否则导出的是一张空图');
  assert.ok(!vis.includes(10), '组以外的东西不该被打开');
});

test('组里被用户关掉的图层，保持关着 —— 不替他打开', async () => {
  // 他是特意关掉的。捕获时替他打开，等于把一个他不想要的元素塞进结果里。
  const grp = layer(210, '一个组', {
    children: [layer(211, '要的'), layer(212, '他关掉的', { visible: false })]
  });
  doc.layers.push(grp);
  doc.activeLayers = [grp];
  const getCopy = captureCopy();

  await bridge.captureActiveLayers();

  const vis = visibleIds(getCopy());
  assert.ok(vis.includes(211), '原本开着的要还原');
  assert.ok(!vis.includes(212), '原本关着的必须保持关着');
});

test('嵌套组也要一层层还原到原样', async () => {
  const grp = layer(220, '外组', {
    children: [
      layer(221, '内组', { children: [layer(222, '深层要的'), layer(223, '深层关掉的', { visible: false })] }),
      layer(224, '外层关掉的组', { visible: false, children: [layer(225, '里面的')] })
    ]
  });
  doc.layers.push(grp);
  doc.activeLayers = [grp];
  const getCopy = captureCopy();

  await bridge.captureActiveLayers();

  const vis = visibleIds(getCopy());
  assert.ok(vis.includes(221) && vis.includes(222), '内层原本可见的要还原');
  assert.ok(!vis.includes(223), '深层关掉的保持关着');
  assert.ok(!vis.includes(224), '外层关掉的组保持关着');
});

/* ==================== 文档编号会被回收：认身份，不认号码 ==================== */

test('号码还在但换了一份文档：拒绝写回，绝不写进不相干的文档', async () => {
  /*
   * Photoshop 的文档 id 在文档关掉之后会被回收，后面新开的文档
   * 拿到同一个号是完全可能的。只看 id 的话，我们会把一张 AI 结果
   * 放进一份毫无关系的文档里 —— 用户可能正在改另一个客户的稿子，
   * 而这次写回还会回报"成功"。
   */
  doc.name = '别人的稿子.psd'; // 1 号现在是另一份文档

  const check = bridge.validateWritebackTarget(target(), 'smartObject');
  assert.equal(check.ok, false, '身份对不上就必须拒绝');
  assert.match(check.message, /别人的稿子\.psd/, '要说清现在这个号是谁');
  assert.match(check.message, /a\.psd/, '也要说清我们要找的是谁');

  const res = await bridge.writeback(wbOpts());
  assert.equal(res.ok, false, '写回同样要被拦住');
  assert.deepEqual(deleted, [], '一个图层都不该动');
});

test('存过盘的文档按路径认，路径变了就不认', async () => {
  // 路径是最硬的凭据。文件名一样但路径不同，是两份不同的文件。
  doc.path = { nativePath: 'D:/客户B/a.psd' };
  const check = bridge.validateWritebackTarget(target({ documentPath: 'D:/客户A/a.psd' }), 'smartObject');
  assert.equal(check.ok, false, '同名不同路径不是同一份文档');
});

test('路径对得上就照常放行', async () => {
  doc.path = { nativePath: 'D:/客户A/a.psd' };
  const check = bridge.validateWritebackTarget(target({ documentPath: 'D:/客户A/a.psd' }), 'smartObject');
  assert.equal(check.ok, true, check.message);
});

test('没存过盘的文档退回比文件名 —— 不能因为没路径就一律拒绝', async () => {
  // 新建还没保存的文档没有路径。这是很常见的情况，不该被挡住。
  doc.path = '';
  const check = bridge.validateWritebackTarget(target({ documentPath: '' }), 'smartObject');
  assert.equal(check.ok, true, check.message);
});

test('校验通过之后文档才被掉包：动手前那一刻还要再认一次', async () => {
  /*
   * 校验和真正落笔之间隔着排队、取字节、写临时文件。
   * 这段时间用户完全可能把源文档关掉，而那个编号会被下一份新建文档接手。
   */
  const check = bridge.validateWritebackTarget(target(), 'smartObject');
  assert.equal(check.ok, true, '前提：这一刻是对得上的');

  doc.name = '刚新建的未命名.psd'; // 之后被掉包

  const res = await bridge.writeback(wbOpts());
  assert.equal(res.ok, false, '动手之前必须重认一次');
  assert.match(res.detail, /刚新建的未命名\.psd/);
});

/* ==================== 接口实际取的是哪一块 / 16 位量程 ==================== */

test('返回的窗口尺寸一样但位置挪了：判为失败', async () => {
  /*
   * 这是最阴的一种：尺寸对得上，所有按尺寸做的检查全都通过，
   * 而遮罩描述的是**另一块像素**。合成之后遮罩整体偏移几个像素，
   * 模型在紧挨着选区的地方动手 —— 不报错、不明显，
   * 用户只会觉得"模型没对准"。
   *
   * 所以必须核 sourceBounds 本身，不能只核宽高。
   */
  const { w, h, bounds } = selectionDoc();
  const shifted = {
    left: bounds.left + 3,
    top: bounds.top + 3,
    right: bounds.right + 3,
    bottom: bounds.bottom + 3
  };
  installImaging(async () =>
    imageData(new Uint8Array(w * h).fill(255), w, h, 1, { sourceBounds: shifted })
  );

  const snap = await bridge.captureSelection();
  assert.equal(snap.maskGray, null, '窗口挪了就不该给出遮罩');
  assert.match(snap.maskUnavailable, /实际取的是/);
  assert.match(snap.maskUnavailable, new RegExp(`${shifted.left},${shifted.top}`), '要说清它实际取的是哪一块');
  assert.match(snap.maskUnavailable, new RegExp(`${bounds.left},${bounds.top}`), '也要说清我们要的是哪一块');
});

test('返回的窗口不合法（不是四个整数）：判为失败', async () => {
  const { w, h } = selectionDoc();
  for (const bad of [{ left: 0, top: 0, right: 0, bottom: 0 }, { left: 1.5, top: 0, right: 9, bottom: 9 }, 'nope']) {
    installImaging(async () => imageData(new Uint8Array(w * h).fill(255), w, h, 1, { sourceBounds: bad }));
    const snap = await bridge.captureSelection();
    assert.equal(snap.maskGray, null, `${JSON.stringify(bad)} 不该被接受`);
    assert.match(snap.maskUnavailable, /sourceBounds/);
  }
});

test('老版本不返回 sourceBounds：退回按尺寸核对，不因此判失败', async () => {
  // 这个字段是后加的。没有它就只能核尺寸 —— 挡得住尺寸不符，
  // 挡不住同样大小、位置不同的窗口。如实降级，别假装核过了，
  // 也别把一个本来能用的老版本判成失败。
  const { w, h } = selectionDoc();
  installImaging(async () => imageData(new Uint8Array(w * h).fill(200), w, h, 1, { sourceBounds: 'omit' }));

  const snap = await bridge.captureSelection();
  assert.ok(snap.maskGray, `不该因为缺这个字段就失败：${snap.maskUnavailable}`);
  assert.equal(snap.maskGray[0], 200);
});

test('16 位：必须显式要 fullRange，并按 0–65535 换算', async () => {
  /*
   * Photoshop 的 16 位默认走**缩减量程** 0–32768，不是 0–65535 ——
   * 这是它的历史约定。不要 fullRange 却按 65535 换算的话，
   * 每个值都小一半：一张"完全选中"的遮罩被读成"半选"，
   * 下游只做一半的活，而这既不报错也不容易看出来。
   */
  const { w, h } = selectionDoc();
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = (i * 37) % 256;

  let data = null;
  installImaging(async () => {
    const r = imageData(gray, w, h, 1, { componentSize: 16 });
    data = r.imageData;
    return r;
  });

  const snap = await bridge.captureSelection();
  assert.ok(snap.maskGray, `16 位应该读得出来：${snap.maskUnavailable}`);
  assert.equal(data.lastGetDataOpts?.fullRange, true, '必须显式要 fullRange，否则拿到的是 0–32768');
  assert.equal(data.lastGetDataOpts?.chunky, true, 'chunky 也要显式要');

  for (let i = 0; i < w * h; i++) {
    assert.ok(
      Math.abs(snap.maskGray[i] - gray[i]) <= 1,
      `第 ${i} 个像素换算错了：期望 ≈${gray[i]}，实际 ${snap.maskGray[i]}`
    );
  }
  // 关键：满量程的 255 必须还是 255。忘了要 fullRange 的话这里会是 ~128。
  const maxIn = Math.max(...gray);
  const maxOut = Math.max(...snap.maskGray);
  assert.ok(Math.abs(maxOut - maxIn) <= 1, `最亮的那个点被读小了：期望 ≈${maxIn}，实际 ${maxOut}`);
});

test('16 位：全选的遮罩读回来还是全选，不是半选', async () => {
  // 单独立一条，因为这正是"忘了要 fullRange"最直接的后果，
  // 而它在界面上表现为"模型改得不够狠"，没人会想到是读数错了。
  const { w, h } = selectionDoc();
  installImaging(async () => imageData(new Uint8Array(w * h).fill(255), w, h, 1, { componentSize: 16 }));

  const snap = await bridge.captureSelection();
  assert.ok(snap.maskGray, snap.maskUnavailable);
  for (let i = 0; i < w * h; i++) {
    assert.equal(snap.maskGray[i], 255, `第 ${i} 个像素应该是完全选中，实际 ${snap.maskGray[i]}`);
  }
});

test('pixelFormat 不是灰度：判为失败', async () => {
  // colorSpace 和 pixelFormat 哪个说了"不是灰度"都算数。
  const { w, h } = selectionDoc();
  installImaging(async () =>
    imageData(new Uint8Array(w * h).fill(255), w, h, 3, { colorSpace: 'Grayscale', pixelFormat: 'RGB' })
  );

  const snap = await bridge.captureSelection();
  assert.equal(snap.maskGray, null);
  assert.match(snap.maskUnavailable, /像素格式/);
});

test('32 位出界的值饱和到 0–255，不绕回去', async () => {
  /*
   * 32 位是 Float32，值域名义上是 0–1，但浮点运算完全可能给出
   * 1.0000001 或者 -0.0000001 这种。绕回去（按 256 取模）会让
   * "全选"变成"全不选"—— 最坏的方向：模型什么都不做，用户等一场空。
   * 饱和至少是保守的、可解释的。
   *
   * 16 位不在这里测：Uint16Array physically 装不下 >65535，
   * 真接口也给不出来，硬造只会测到替身自己的截断。
   */
  const { w, h } = selectionDoc();
  const vals = new Array(w * h).fill(0);
  vals[0] = 1.0000002;
  vals[1] = -0.0000002;
  installImaging(async () => imageData(null, w, h, 1, { componentSize: 32, rawValues: vals }));

  const snap = await bridge.captureSelection();
  assert.ok(snap.maskGray, snap.maskUnavailable);
  assert.equal(snap.maskGray[0], 255, '略大于 1 应该饱和到 255，不是绕回 0');
  assert.equal(snap.maskGray[1], 0, '略小于 0 应该饱和到 0');
});

/* ==================== 置入产物的归属：以图层集合之差为准 ==================== */

test('图层建出来了但没被设为当前：照样认得出来，不留孤儿', async () => {
  /*
   * 只看 activeLayers[0] 的话，这里会判"没有新建图层"然后报失败 ——
   * 而那个图层就留在用户文档里，谁也不知道它是哪来的。
   *
   * "报失败"的含义是文档没被动过、放心重试。留一个没人认领的图层
   * 会让用户重试一次多一个，而且他完全看不出为什么。
   */
  const before = doc.layers.length;
  const photoshop = globalThis.require('photoshop');
  const realBatch = photoshop.action.batchPlay;
  photoshop.action.batchPlay = async (cmds) => {
    if (cmds?.[0]?._obj === 'placeEvent') {
      const placed = layer(nextLayerId++, '（刚置入）');
      doc.layers.push(placed);
      // 关键：**不**设 activeLayers —— 当前图层还是原来那个
      doc.activeLayers = [doc.layers[0]];
      return [{}];
    }
    return realBatch(cmds);
  };
  try {
    const res = await bridge.writeback(wbOpts());
    assert.equal(res.ok, true, `建出来了就该认出来：${res.detail}`);
    assert.equal(doc.layers.length, before + 1, '正好多一个图层');

    const placed = doc.layers.find((l) => bridge.readProvenance(l.name)?.jobId === PROV.jobId);
    assert.ok(placed, '那个新图层应该被盖上出处标记');
  } finally {
    photoshop.action.batchPlay = realBatch;
  }
});

test('置入产生了多个新图层且当前图层是其中之一：留当前的，其余撤掉', async () => {
  const before = doc.layers.length;
  const photoshop = globalThis.require('photoshop');
  const realBatch = photoshop.action.batchPlay;
  photoshop.action.batchPlay = async (cmds) => {
    if (cmds?.[0]?._obj === 'placeEvent') {
      const extra = layer(nextLayerId++, '（副产物）');
      const placed = layer(nextLayerId++, '（刚置入）');
      doc.layers.push(extra, placed);
      doc.activeLayers = [placed];
      return [{}];
    }
    return realBatch(cmds);
  };
  try {
    const res = await bridge.writeback(wbOpts());
    assert.equal(res.ok, true, res.detail);
    assert.equal(doc.layers.length, before + 1, '副产物必须被撤掉，只留结果那一个');
    assert.ok(!doc.layers.some((l) => l.name.includes('副产物')), '副产物不该留在文档里');
  } finally {
    photoshop.action.batchPlay = realBatch;
  }
});

test('多个新图层且一个都不是当前图层：全部撤掉再报失败，绝不留孤儿', async () => {
  /*
   * 认不出该用哪一个的时候，唯一可接受的做法是把文档还原 ——
   * 报一个"失败"却留下两个来路不明的图层是最坏的组合。
   */
  const before = doc.layers.length;
  const photoshop = globalThis.require('photoshop');
  const realBatch = photoshop.action.batchPlay;
  photoshop.action.batchPlay = async (cmds) => {
    if (cmds?.[0]?._obj === 'placeEvent') {
      doc.layers.push(layer(nextLayerId++, '（来路不明 A）'), layer(nextLayerId++, '（来路不明 B）'));
      doc.activeLayers = [doc.layers[0]]; // 当前图层是个老图层
      return [{}];
    }
    return realBatch(cmds);
  };
  try {
    const res = await bridge.writeback(wbOpts());
    assert.equal(res.ok, false, '认不出归属就该失败');
    assert.equal(doc.layers.length, before, '失败时文档必须回到动手之前');
    assert.match(res.detail, /已全部撤销/);
  } finally {
    photoshop.action.batchPlay = realBatch;
  }
});

test('撤不掉那些来路不明的图层时，报的是"写了一半"', async () => {
  const photoshop = globalThis.require('photoshop');
  const realBatch = photoshop.action.batchPlay;
  photoshop.action.batchPlay = async (cmds) => {
    if (cmds?.[0]?._obj === 'placeEvent') {
      const a = layer(nextLayerId++, '（删不掉 A）');
      const b = layer(nextLayerId++, '（删不掉 B）');
      a.delete = undefined;
      b.delete = undefined;
      doc.layers.push(a, b);
      doc.activeLayers = [doc.layers[0]];
      return [{}];
    }
    return realBatch(cmds);
  };
  try {
    const res = await bridge.writeback(wbOpts());
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRITEBACK_PARTIAL', '文档确实被动过了，不能和"没动过"混为一谈');
    assert.match(res.detail, /手动检查/);
  } finally {
    photoshop.action.batchPlay = realBatch;
  }
});

test('嵌套组里新建的图层也算数（集合之差是全文档的）', async () => {
  const grp = layer(700, '一个组', { children: [] });
  doc.layers.push(grp);
  const before = doc.layers.length;

  const photoshop = globalThis.require('photoshop');
  const realBatch = photoshop.action.batchPlay;
  photoshop.action.batchPlay = async (cmds) => {
    if (cmds?.[0]?._obj === 'placeEvent') {
      // 放进组里，而且不设为当前图层
      grp.layers.push(layer(nextLayerId++, '（组里刚置入）'));
      doc.activeLayers = [doc.layers[0]];
      return [{}];
    }
    return realBatch(cmds);
  };
  try {
    const res = await bridge.writeback(wbOpts());
    assert.equal(res.ok, true, `组里新建的也该认出来：${res.detail}`);
    assert.equal(doc.layers.length, before, '顶层数量不变');
    assert.equal(grp.layers.length, 1, '新图层在组里');
    assert.ok(bridge.readProvenance(grp.layers[0].name), '组里那个应该被盖上出处标记');
  } finally {
    photoshop.action.batchPlay = realBatch;
  }
});
