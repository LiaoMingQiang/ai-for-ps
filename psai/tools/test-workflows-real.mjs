/**
 * 把 11 份内置工作流逐个提交到**真实 ComfyUI**，确认每个固定功能都真的出得来图。
 *
 * 这是「开箱即用」这句话的凭据：装完插件不导入任何东西，
 * ComfyUI 分支的 11 个功能就应该全部可用。
 *
 * 用法：node tools/test-workflows-real.mjs [comfyUrl]
 * 输出：tools/.artifacts/workflows/<featureId>.png + 汇总表
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { startHelper } = await import(pathToFileURL(resolve(here, '../packages/helper/dist/index.js')).href);
const { fixedComfyFeatures, breadcrumb, featureDefaults } = await import(
  pathToFileURL(resolve(here, '../packages/shared/dist/index.js')).href
);
const { makeStructuredPng, meanAbsDiff, decodePng } = await import(pathToFileURL(resolve(here, 'test-image.mjs')).href);

const COMFY = process.argv[2] ?? 'http://127.0.0.1:8188';
const PORT = 34214;
const OUT_DIR = resolve(here, '.artifacts/workflows');

const rows = [];
const timing = {};
let fail = 0;

async function main() {
  try {
    const r = await fetch(`${COMFY}/system_stats`, { signal: AbortSignal.timeout(5000) });
    const s = await r.json();
    console.log(`ComfyUI ${s.system?.comfyui_version} @ ${COMFY}\n`);
  } catch (e) {
    console.error(`SKIP: 连不上真实 ComfyUI (${COMFY}) — ${e.message}`);
    process.exitCode = 2;
    return;
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'psai-wf-'));
  const helper = await startHelper({ dataDir, port: PORT, ephemeral: true });
  const token = helper.issueToken();

  const api = async (method, path, body) => {
    const headers = { Authorization: `Bearer ${token}` };
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: payload });
    return { status: res.status, json: await res.json() };
  };

  const upload = async (png, name) => {
    const fd = new FormData();
    fd.append('file', new Blob([png], { type: 'image/png' }), name);
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/assets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd
    });
    const j = await res.json();
    if (!j.ok) throw new Error(`上传失败: ${JSON.stringify(j)}`);
    return j.assets[0];
  };

  mkdirSync(OUT_DIR, { recursive: true });

  try {
    await api('PATCH', '/v1/settings', { comfy: { baseUrl: COMFY } });

    /* --- 1. 内置工作流是否全部播种 --- */
    const wfs = (await api('GET', '/v1/workflows')).json.workflows.filter((w) => w.source === 'builtin');
    const features = fixedComfyFeatures();
    console.log(`内置工作流已播种 ${wfs.length} / ${features.length}\n`);
    if (wfs.length !== features.length) {
      console.error('FAIL: 内置工作流数量不符');
      fail++;
    }

    /* --- 2. 依赖预检 --- */
    console.log('=== 依赖预检 ===');
    for (const wf of wfs) {
      const dep = (await api('GET', `/v1/workflows/${wf.id}/dependencies`)).json.report;
      const ok = dep?.ok === true;
      if (!ok) fail++;
      console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${wf.id.padEnd(24)} ` +
          (ok ? '依赖齐全' : `缺节点 ${JSON.stringify(dep?.missingNodes)} 缺模型 ${JSON.stringify(dep?.missingModels)}`)
      );
    }

    /* --- 3. 每个功能真实出图 --- */
    console.log('\n=== 逐个功能真实出图 ===');
    const inputPng = makeStructuredPng(768, 768);
    const bgPng = makeStructuredPng(768, 768);
    const inputAsset = await upload(inputPng, 'subject.png');
    const bgAsset = await upload(bgPng, 'background.png');

    for (const f of features) {
      const label = breadcrumb(f.id).slice(1).join('/');
      const defaults = featureDefaults(f.id);

      // 每个功能都用固定种子 + 较低步数，保证可复现且跑得快
      const params = { ...defaults, seed: { mode: 'fixed', value: 20260822 } };
      if ('steps' in params) params.steps = Math.min(Number(params.steps) || 12, 12);
      if ('resolution' in params) params.resolution = 512;

      const inputs = [{ paramId: 'image', assetId: inputAsset.id, index: 0, source: 'layer' }];
      if (f.params.some((p) => p.id === 'background')) {
        inputs.push({ paramId: 'background', assetId: bgAsset.id, index: 0, source: 'upload' });
      }

      const t0 = Date.now();
      const created = await api('POST', '/v1/jobs', {
        featureId: f.id,
        params,
        inputs,
        target: null,
        writeback: { mode: 'assetOnly' }
      });

      if (!created.json.ok) {
        fail++;
        rows.push({ id: f.id, label, ok: false, detail: `提交被拒: ${JSON.stringify(created.json.error)}` });
        console.log(`  FAIL  ${label.padEnd(22)} 提交被拒 ${created.json.error?.code}: ${created.json.error?.details ?? ''}`);
        continue;
      }

      const jobId = created.json.job.id;
      let job = null;
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        job = (await api('GET', `/v1/jobs/${jobId}`)).json.job;
        if (['succeeded', 'failed', 'lost', 'cancelled'].includes(job?.state)) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);

      if (job?.state !== 'succeeded' || job.results.length === 0) {
        fail++;
        const detail = JSON.stringify(job?.error ?? {}).slice(0, 220);
        rows.push({ id: f.id, label, ok: false, detail: `${job?.state} ${detail}` });
        console.log(`  FAIL  ${label.padEnd(22)} ${job?.state} — ${detail}`);
        continue;
      }

      const res = await fetch(`http://127.0.0.1:${PORT}/v1/assets/${job.results[0].assetId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(join(OUT_DIR, `${f.id}.png`), buf);

      const meta = decodePng(buf);
      let note = `${meta.width}×${meta.height} · ${secs}s`;

      // 无损放大必须是确定性的：同输入同参数跑两次结果必须逐字节一致
      if (f.id === 'comfy.misc.upscale.lossless') {
        const again = await api('POST', '/v1/jobs', {
          featureId: f.id,
          params,
          inputs,
          target: null,
          writeback: { mode: 'assetOnly' }
        });
        let j2 = null;
        const dl2 = Date.now() + 60_000;
        while (Date.now() < dl2) {
          j2 = (await api('GET', `/v1/jobs/${again.json.job.id}`)).json.job;
          if (['succeeded', 'failed'].includes(j2?.state)) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        const same = j2?.results?.[0]?.sha256 === job.results[0].sha256;
        if (!same) {
          fail++;
          note += ' · FAIL 两次结果不一致';
        } else {
          note += ' · 两次结果逐字节一致';
        }
        // 放大倍数应当真的生效
        const expected = decodePng(inputPng).width * 2;
        if (Math.abs(meta.width - expected) > 8) {
          fail++;
          note += ` · FAIL 宽度应为 ${expected}`;
        }
      }

      if (f.id === 'comfy.misc.upscale.general') {
        const expected = decodePng(inputPng).width * 2;
        if (Math.abs(meta.width - expected) > 8) {
          fail++;
          note += ` · FAIL 宽度应为 ${expected}`;
        }
      }

      // 除无损放大外，输出都应当经过模型处理
      if (f.id !== 'comfy.misc.upscale.lossless' && meta.width === decodePng(inputPng).width) {
        const diff = meanAbsDiff(inputPng, buf);
        note += ` · 差异 ${diff.toFixed(1)}`;
      }

      const rowOk = !note.includes('FAIL');
      timing[f.id] = { size: `${meta.width}×${meta.height}`, secs };
      rows.push({ id: f.id, label, ok: rowOk, detail: note });
      console.log(`  ${rowOk ? 'PASS' : 'FAIL'}  ${label.padEnd(22)} ${note}`);
    }
  } finally {
    await helper.stop();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }

  console.log('\n=== 汇总 ===');
  const okCount = rows.filter((r) => r.ok).length;
  console.log(`  ${okCount} / ${rows.length} 个固定功能真实出图成功`);
  console.log(`  产物目录: ${OUT_DIR}`);
  // 实测耗时写盘，供 docs/WORKFLOWS.md 引用
  writeFileSync(resolve(here, '.artifacts/workflows-timing.json'), JSON.stringify(timing, null, 2), 'utf8');
  if (fail > 0) {
    console.log('\n失败项:');
    for (const r of rows.filter((x) => !x.ok)) console.log(`  - ${r.label}: ${r.detail}`);
    process.exitCode = 1;
  }
}

await main();
