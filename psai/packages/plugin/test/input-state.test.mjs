/**
 * 输入图的身份与陈旧状态。
 *
 * 这一组守的是"界面上显示的东西，就是提交上去的东西"。
 * 两条都属于同一类问题：不会报错、不会有任何提示，
 * 用户只会看到自己的文档里凭空多了一张不相干的图，
 * 或者一次他以为没选图的提交居然跑起来了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { documentMismatch } = await import('../src/ui/input-guards.ts');

/** 造一张已选好的输入图。sourceDocumentId 为 null 表示上传/粘贴来的。 */
function img(over = {}) {
  return {
    assetId: 'a1',
    width: 64,
    height: 64,
    bytes: 100,
    source: 'layer',
    selectionBounds: null,
    previewSrc: '',
    sourceDocumentId: 1,
    sourceDocumentName: 'A.psd',
    ...over
  };
}

const docA = { documentId: 1, documentName: 'A.psd' };
const docB = { documentId: 2, documentName: 'B.psd' };

test('同一个文档：放行', () => {
  assert.equal(documentMismatch([img()], docA), null);
});

test('从 A 取图却在 B 上提交：拦下来，并说清楚是哪两个文档', () => {
  /*
   * 完全不需要用户做错什么：从 A 取了图，中间切到 B 看一眼，
   * 回来点「开始处理」—— 输入是 A 的内容，而写回目标被冻结成当前的 B。
   * 结果 A 的图被贴进 B 的文档，两边都不报错。
   */
  const r = documentMismatch([img()], docB);
  assert.ok(r, '必须拦下来');
  assert.match(r.detail, /A\.psd/, '要指出图取自哪个文档');
  assert.match(r.detail, /B\.psd/, '也要指出现在打开的是哪个');
  assert.match(r.detail, /切回|移除/, '要给出可执行的下一步');
});

test('多张图里只要有一张对不上，就拦', () => {
  const r = documentMismatch([img(), img({ assetId: 'a2', sourceDocumentId: 2, sourceDocumentName: 'B.psd' })], docA);
  assert.ok(r, '有一张不属于当前文档就该拦');
});

test('上传/粘贴来的图不属于任何文档，写回哪里都行', () => {
  const uploaded = img({ source: 'upload', sourceDocumentId: null, sourceDocumentName: null });
  assert.equal(documentMismatch([uploaded], docA), null);
  assert.equal(documentMismatch([uploaded], docB), null);
  // 连一个文档都没打开时也不该拦 —— 这种图本来就不需要文档
  assert.equal(documentMismatch([uploaded], null), null);
});

test('图取自 Photoshop 但现在没有打开的文档：拦，并说清原因', () => {
  const r = documentMismatch([img()], null);
  assert.ok(r, '没有可写回的文档就该拦');
  assert.match(r.title, /没有打开的文档/);
  assert.match(r.detail, /打开原文档/);
});

test('一张图都没有：放行（该拦的是"缺必需输入"，不是这里）', () => {
  // 职责要分清：这个函数只回答"文档对不对得上"。
  // 把"没选图"也算进来的话，两种完全不同的问题会给出同一句提示。
  assert.equal(documentMismatch([], docA), null);
  assert.equal(documentMismatch([], null), null);
});

/* ==================== 陈旧的输入状态 ==================== */

test('切走再切回来时，输入框和提交内容必须是同一份', async () => {
  /*
   * 这条守的是一种看不见的残留。
   *
   * 每次渲染都会新建一个空的输入框（handle 自己的 images 是 []），
   * 而 currentImages 那份如果用 `??=` 保留旧值，两者就分家了：
   * 界面上空空如也，提交时却带上了上一次那几张图 ——
   * 而且很可能取自一个已经关掉或者改过的文档。
   *
   * 这里直接对着源码断言：`??=` 一旦回来，这条就红。
   * 渲染路径要真跑一遍得把整个 UXP DOM 都搭起来，
   * 而这条规则本身就是一行代码的事，钉住那一行更直接、也更不容易失效。
   */
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../src/ui/page-generate.ts', import.meta.url)), 'utf8');

  assert.ok(
    /currentImages\[key\] = \[\];/.test(src),
    '新建输入框之后必须把 currentImages[key] 清空，让界面和提交内容一致'
  );
  assert.ok(
    !/currentImages\[key\] \?\?= \[\];/.test(src),
    '不能用 ??= 保留旧值 —— 那会留下用户看不见、却会被提交的图'
  );
});

/* ==================== 文档编号会被回收 ==================== */

/*
 * 光比 documentId 是不够的。Photoshop 的文档 id 在文档关掉之后会被回收：
 * 用户关掉 A、新建一份 B，B 完全可能拿到 A 的旧编号。
 * 那时候只比 id 的检查会**放行** —— 然后 A 的内容被贴进 B 的文档，
 * 而 B 可能是另一个客户的稿子，两边都不报错。
 */

/** 一张取自"已存盘文档 A"的图。 */
function fromSavedA(over = {}) {
  return img({
    sourceDocumentId: 1,
    sourceDocumentName: 'A.psd',
    sourceDocumentPath: 'D:/客户A/A.psd',
    sourceCanvasWidth: 1000,
    sourceCanvasHeight: 800,
    ...over
  });
}

const savedA = { documentId: 1, documentName: 'A.psd', documentPath: 'D:/客户A/A.psd', width: 1000, height: 800 };

test('同一份已存盘文档：路径对得上就放行', () => {
  assert.equal(documentMismatch([fromSavedA()], savedA), null);
});

test('A 关掉后 B 拿到同一个编号：必须拦下来', () => {
  /*
   * 这是这一组的理由。id 一样、名字不一样、路径不一样 ——
   * 只比 id 的话这里会一路放行，把 A 的图贴进 B 的文档。
   */
  const reusedByB = {
    documentId: 1, // 同一个编号
    documentName: 'B.psd',
    documentPath: 'D:/客户B/B.psd',
    width: 1200,
    height: 900
  };
  const r = documentMismatch([fromSavedA()], reusedByB);
  assert.ok(r, '编号被回收时必须拦下来');
  assert.match(r.detail, /已经关掉/, '要说破"那份文档已经关了"，否则用户以为是我们搞错了');
  assert.match(r.detail, /A\.psd/);
  assert.match(r.detail, /B\.psd/);
});

test('编号和名字都一样，但路径不同：仍然拦', () => {
  // 两个客户目录下各有一个 A.psd 太正常了。名字不是凭据。
  const other = { documentId: 1, documentName: 'A.psd', documentPath: 'D:/客户B/A.psd', width: 1000, height: 800 };
  assert.ok(documentMismatch([fromSavedA()], other), '同名不同路径不是同一份');
});

test('取图时没存盘、提交时已另存：认不出来，按不是同一份处理', () => {
  /*
   * 存盘状态变了就没法比了：路径这时候是新出现的，我们没有取图那一刻的
   * 对应值。宁可拦下来让用户确认，也不要赌。
   */
  const unsaved = fromSavedA({ sourceDocumentPath: '' });
  const nowSaved = { documentId: 1, documentName: 'A.psd', documentPath: 'D:/客户A/A.psd', width: 1000, height: 800 };
  assert.ok(documentMismatch([unsaved], nowSaved));
});

test('两边都没存盘：比文件名和画布尺寸', () => {
  const unsaved = fromSavedA({ sourceDocumentPath: '' });
  const same = { documentId: 1, documentName: 'A.psd', documentPath: '', width: 1000, height: 800 };
  assert.equal(documentMismatch([unsaved], same), null, '名字和画布都一样，认成同一份');

  const resized = { documentId: 1, documentName: 'A.psd', documentPath: '', width: 1200, height: 800 };
  assert.ok(documentMismatch([unsaved], resized), '画布尺寸对不上就不是同一份');

  const renamed = { documentId: 1, documentName: '未标题-2', documentPath: '', width: 1000, height: 800 };
  assert.ok(documentMismatch([unsaved], renamed), '名字对不上就不是同一份');
});

/* ==================== 仅存资产库不该被这道检查挡住 ==================== */

test('assetOnly：不写文档，就没有"贴错地方"这回事', () => {
  /*
   * 这道检查查的是"写回目标对不对"，而 assetOnly 根本没有写回目标。
   * 拿它去挡是无中生有 —— 而"没有打开的文档"恰恰是最常落到
   * assetOnly 的情形，那时候用户要的只是把图存进资产库。
   */
  const reusedByB = { documentId: 1, documentName: 'B.psd', documentPath: 'D:/客户B/B.psd', width: 1200, height: 900 };
  assert.equal(documentMismatch([fromSavedA()], reusedByB, 'assetOnly'), null, '编号被回收也不该挡 assetOnly');
  assert.equal(documentMismatch([fromSavedA()], null, 'assetOnly'), null, '连文档都没有也不该挡');
});

test('其余写回方式照旧要查 —— 这道闸门不能一起放开', () => {
  const reusedByB = { documentId: 1, documentName: 'B.psd', documentPath: 'D:/客户B/B.psd', width: 1200, height: 900 };
  for (const mode of ['smartObject', 'pixelLayer', 'inPlaceSelection', undefined]) {
    assert.ok(documentMismatch([fromSavedA()], reusedByB, mode), `${mode} 仍然要拦`);
  }
});

test('没有打开文档时的提示要给出可行的下一步', () => {
  const r = documentMismatch([fromSavedA()], null, 'smartObject');
  assert.ok(r);
  assert.match(r.detail, /仅存资产库/, '要告诉用户还有这条路可以走');
});
