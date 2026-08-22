/**
 * 对着**真实 ComfyUI** 跑端到端：Helper → 提交 → 进度 → 出图 → 取消 → 依赖预检。
 *
 * 和桩测试的分工：
 *   - 桩负责稳定复现边界分支（挂队列、故意失败、丢任务）
 *   - 这里负责证明"接的是真接口，真出得来图"
 *
 * 用法：node tools/test-comfy-real.mjs [comfyUrl]
 * ComfyUI 不在线时明确跳过并以非零码退出，不假装通过。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Windows 上绝对路径必须转成 file:// URL，否则 ESM loader 会把盘符当协议
const { startHelper } = await import(pathToFileURL(resolve(here, '../packages/helper/dist/index.js')).href);

const COMFY = process.argv[2] ?? 'http://127.0.0.1:8188';
const PORT = 34213;
const OUT_DIR = resolve(here, '.artifacts');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function section(t) {
  console.log(`\n=== ${t} ===`);
}

async function main() {
  section('前置检查');
  let stats;
  try {
    const r = await fetch(`${COMFY}/system_stats`, { signal: AbortSignal.timeout(5000) });
    stats = await r.json();
  } catch (e) {
    console.error(`\nSKIP: 连不上真实 ComfyUI (${COMFY}) — ${e.message}`);
    console.error('请先启动 ComfyUI 再跑这个脚本。这里不会用桩冒充真实环境。');
    process.exitCode = 2;
    return;
  }
  console.log(`  ComfyUI ${stats.system?.comfyui_version} @ ${COMFY}`);

  const objectInfo = await (await fetch(`${COMFY}/object_info`)).json();
  const ckpts = objectInfo.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
  // 挑一个体积小、出图快的 SD1.5 做冒烟；没有就用列表里第一个
  const ckpt =
    ckpts.find((c) => /v1-5-pruned-emaonly-fp16/.test(c)) ??
    ckpts.find((c) => /v1-5/.test(c)) ??
    ckpts[0];
  if (!ckpt) {
    console.error('SKIP: ComfyUI 里没有任何 checkpoint 模型');
    process.exitCode = 2;
    return;
  }
  console.log(`  使用模型: ${ckpt}`);

  const dataDir = mkdtempSync(join(tmpdir(), 'psai-real-'));
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

  try {
    await api('PATCH', '/v1/settings', { comfy: { baseUrl: COMFY } });

    section('连接与能力发现');
    const test = await api('POST', '/v1/providers/comfyui/test');
    check('测试连接通过', test.json.result?.ok === true, test.json.result?.detail);

    const oi = await api('GET', '/v1/comfy/object-info');
    check('拉到真实采样器列表', (oi.json.samplers?.length ?? 0) > 10, `${oi.json.samplers?.length} 个`);
    check('拉到真实 checkpoint 列表', (oi.json.checkpoints?.length ?? 0) > 0, `${oi.json.checkpoints?.length} 个`);
    check('节点数与真实环境一致', oi.json.nodeCount === Object.keys(objectInfo).length, `${oi.json.nodeCount} 个节点`);

    section('导入工作流并绑定');
    // 用 img2img，和 comfy.wash.portrait「必须有输入图」的定义对齐；
    // 顺带把"上传输入图到 ComfyUI 再注入 LoadImage"这条真实链路一起验了。
    const graph = {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
      2: {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'a red apple on a white table, product photo', clip: ['1', 1] },
        _meta: { title: 'Positive' }
      },
      3: {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'blurry, lowres, watermark', clip: ['1', 1] },
        _meta: { title: 'Negative' }
      },
      4: { class_type: 'LoadImage', inputs: { image: 'example.png' } },
      8: { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['1', 2] } },
      5: {
        class_type: 'KSampler',
        inputs: {
          model: ['1', 0],
          seed: 0,
          steps: 6,
          cfg: 7,
          sampler_name: 'euler',
          scheduler: 'normal',
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['8', 0],
          denoise: 0.6
        }
      },
      6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
      7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'psai_real' } }
    };

    const imported = await api('POST', '/v1/workflows/import', { json: graph, name: '真机冒烟 txt2img' });
    check('导入成功', imported.json.ok === true, JSON.stringify(imported.json.error ?? ''));
    const wf = imported.json.workflow;
    check('识别出输出节点', wf?.outputNodeIds?.includes('7') === true);

    const bound = new Set((wf?.bindings ?? []).map((b) => b.paramId));
    check('自动绑定了提示词/种子/步数/输入图', ['prompt', 'seed', 'steps', 'image'].every((p) => bound.has(p)), [...bound].join(','));

    const dep = await api('GET', `/v1/workflows/${wf.id}/dependencies`);
    check('依赖预检通过（节点与模型都在）', dep.json.report?.ok === true, JSON.stringify(dep.json.report?.missingNodes ?? []));
    check('依赖预检报告的地址就是实际连接的地址', dep.json.report?.checkedAgainst === COMFY, dep.json.report?.checkedAgainst);

    await api('PUT', '/v1/features/comfy.wash.portrait/binding', {
      providerId: 'comfyui',
      workflowId: wf.id,
      enabled: true
    });
    const feats = await api('GET', '/v1/features');
    const f = feats.json.features.find((x) => x.id === 'comfy.wash.portrait');
    check('绑定后功能显示就绪', f?.ready === true, f?.reason ?? '');

    section('真实出图');
    const { makeStructuredPng, meanAbsDiff } = await import(pathToFileURL(resolve(here, 'test-image.mjs')).href);
    // 用有结构的图，不用纯色 —— 纯色进纯色出，管线断了都看不出来
    const inputPng = makeStructuredPng(512, 512);
    const uploadAsset = async () => {
      const fd = new FormData();
      fd.append('file', new Blob([inputPng], { type: 'image/png' }), 'input.png');
      const r = await fetch(`http://127.0.0.1:${PORT}/v1/assets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd
      });
      return (await r.json()).assets[0];
    };
    const inputAsset = await uploadAsset();
    check('输入图上传成功', !!inputAsset?.id, `${inputAsset?.width}×${inputAsset?.height}`);

    const t0 = Date.now();
    const created = await api('POST', '/v1/jobs', {
      featureId: 'comfy.wash.portrait',
      params: {
        prompt: 'a red apple on a white table, product photo, studio lighting',
        seed: { mode: 'fixed', value: 20260822 },
        steps: 6,
        resolution: 512
      },
      inputs: [{ paramId: 'image', assetId: inputAsset.id, index: 0, source: 'layer' }],
      target: null,
      writeback: { mode: 'assetOnly' }
    });
    check('任务创建成功', created.json.ok === true, JSON.stringify(created.json.error ?? ''));
    const jobId = created.json.job?.id;
    if (!jobId) throw new Error(`任务没有创建出来: ${JSON.stringify(created.json.error ?? created.json)}`);

    let job = null;
    let lowDenoiseDiff = 0;
    const sawProgress = [];
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const r = await api('GET', `/v1/jobs/${jobId}`);
      job = r.json.job;
      if (job?.progress?.value != null) sawProgress.push(job.progress.value);
      if (job && ['succeeded', 'failed', 'lost', 'cancelled'].includes(job.state)) break;
      if (job?.results?.length) break;
      await new Promise((s) => setTimeout(s, 250));
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    check('任务成功完成', job?.state === 'succeeded', `state=${job?.state} err=${JSON.stringify(job?.error ?? '')}`);
    check('拿到结果图', (job?.results?.length ?? 0) === 1, `${job?.results?.length} 张 · 耗时 ${elapsed}s`);
    check('结果尺寸正确', job?.results?.[0]?.width === 512 && job?.results?.[0]?.height === 512,
      `${job?.results?.[0]?.width}×${job?.results?.[0]?.height}`);
    check('收到过真实进度回报', sawProgress.length > 0, `${sawProgress.length} 次采样`);
    check('记录了本地 GPU 时长', typeof job?.gpuMs === 'number' && job.gpuMs > 0, `${job?.gpuMs}ms`);
    check('参数被完整解析并落库', job?.resolvedParams?.seed === 20260822, `seed=${job?.resolvedParams?.seed}`);

    if (job?.results?.[0]) {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/assets/${job.results[0].assetId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const buf = Buffer.from(await res.arrayBuffer());
      check('结果字节可下载且是合法 PNG', buf.slice(1, 4).toString('ascii') === 'PNG', `${buf.length} 字节`);

      // 低重绘幅度（0.28）应当保住结构 —— 这正是「洗图」的验收标准之一
      lowDenoiseDiff = meanAbsDiff(inputPng, buf);
      check('低重绘幅度下结构被保住', lowDenoiseDiff < 20, `平均通道差 ${lowDenoiseDiff.toFixed(1)}/255`);
      try {
        rmSync(OUT_DIR, { recursive: true, force: true });
      } catch {
        /* noop */
      }
      const { mkdirSync } = await import('node:fs');
      mkdirSync(OUT_DIR, { recursive: true });
      const outPath = join(OUT_DIR, 'real-comfy-result.png');
      writeFileSync(outPath, buf);
      writeFileSync(join(OUT_DIR, 'real-comfy-input.png'), inputPng);
      console.log(`  产物已保存: ${outPath}`);
    }

    section('重绘幅度真的起作用');
    // 只有把高低两档都跑一遍，才能证明"模型确实在按参数干活"，
    // 而不是把输入原样传回来（那样低幅度那条断言也会通过）。
    const strong = await api('POST', '/v1/jobs', {
      featureId: 'comfy.wash.portrait',
      params: {
        prompt: 'a red apple on a white table, product photo, studio lighting',
        seed: { mode: 'fixed', value: 20260822 },
        steps: 12,
        denoise: 0.9,
        resolution: 512
      },
      inputs: [{ paramId: 'image', assetId: inputAsset.id, index: 0, source: 'layer' }],
      target: null,
      writeback: { mode: 'assetOnly' }
    });
    let strongJob = null;
    const strongDeadline = Date.now() + 180_000;
    while (Date.now() < strongDeadline) {
      const r = await api('GET', `/v1/jobs/${strong.json.job.id}`);
      strongJob = r.json.job;
      if (['succeeded', 'failed', 'lost'].includes(strongJob?.state)) break;
      await new Promise((s) => setTimeout(s, 250));
    }
    check('高重绘幅度任务完成', strongJob?.state === 'succeeded', `state=${strongJob?.state}`);
    if (strongJob?.results?.[0]) {
      const r2 = await fetch(`http://127.0.0.1:${PORT}/v1/assets/${strongJob.results[0].assetId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const strongBuf = Buffer.from(await r2.arrayBuffer());
      writeFileSync(join(OUT_DIR, 'real-comfy-result-denoise090.png'), strongBuf);
      const strongDiff = meanAbsDiff(inputPng, strongBuf);
      check('高重绘幅度下画面被大幅重绘', strongDiff > 25, `平均通道差 ${strongDiff.toFixed(1)}/255`);
      check(
        '重绘幅度参数确实传到了模型（高幅度改动明显大于低幅度）',
        strongDiff > lowDenoiseDiff * 2,
        `${strongDiff.toFixed(1)} vs ${lowDenoiseDiff.toFixed(1)}`
      );
    }

    section('取消（真实 interrupt / 队列删除）');
    const heavy = await api('POST', '/v1/jobs', {
      featureId: 'comfy.wash.portrait',
      params: {
        prompt: 'an intricate detailed landscape',
        seed: { mode: 'random', value: 0 },
        steps: 40,
        resolution: 768
      },
      inputs: [{ paramId: 'image', assetId: inputAsset.id, index: 0, source: 'layer' }],
      target: null,
      writeback: { mode: 'assetOnly' }
    });
    const heavyId = heavy.json.job?.id;
    // 等它真的提交出去
    for (let i = 0; i < 100; i++) {
      const r = await api('GET', `/v1/jobs/${heavyId}`);
      if (r.json.job?.remoteId) break;
      await new Promise((s) => setTimeout(s, 100));
    }
    const cancelled = await api('POST', `/v1/jobs/${heavyId}/cancel`);
    check('取消请求被接受', cancelled.json.ok === true, cancelled.json.reason ?? '');
    const afterCancel = (await api('GET', `/v1/jobs/${heavyId}`)).json.job;
    check('任务进入已取消状态', afterCancel?.state === 'cancelled', `state=${afterCancel?.state}`);
    check('取消的任务没有结果', (afterCancel?.results?.length ?? 0) === 0);

    section('错误如实上报');
    const badGraph = JSON.parse(JSON.stringify(graph));
    badGraph['1'].inputs.ckpt_name = 'this_model_does_not_exist.safetensors';
    const badWf = await api('POST', '/v1/workflows/import', { json: badGraph, name: '真机冒烟 缺模型' });
    await api('PUT', '/v1/features/comfy.wash.scene/binding', {
      providerId: 'comfyui',
      workflowId: badWf.json.workflow.id,
      enabled: true
    });
    const badJob = await api('POST', '/v1/jobs', {
      featureId: 'comfy.wash.scene',
      params: { prompt: 'x', seed: { mode: 'fixed', value: 1 }, steps: 4, resolution: 512 },
      inputs: [{ paramId: 'image', assetId: inputAsset.id, index: 0, source: 'layer' }],
      target: null,
      writeback: { mode: 'assetOnly' }
    });
    // ComfyUI 会在提交时就用节点校验拒掉；也可能进队后失败，两种都接受
    let badState = null;
    if (badJob.json.ok === false) {
      badState = badJob.json.error;
      check('缺模型时提交即被拒绝并带原文', /this_model_does_not_exist/.test(JSON.stringify(badState)),
        badState.code);
    } else {
      const bid = badJob.json.job.id;
      for (let i = 0; i < 200; i++) {
        const r = await api('GET', `/v1/jobs/${bid}`);
        if (['failed', 'lost'].includes(r.json.job?.state)) {
          badState = r.json.job.error;
          break;
        }
        await new Promise((s) => setTimeout(s, 150));
      }
      check('缺模型时任务失败并带原文', badState != null && /this_model_does_not_exist/.test(JSON.stringify(badState)),
        JSON.stringify(badState ?? '').slice(0, 160));
    }

    const depBad = await api('GET', `/v1/workflows/${badWf.json.workflow.id}/dependencies`);
    check('依赖预检能提前发现缺失的模型',
      depBad.json.report?.ok === false &&
        depBad.json.report.missingModels.some((m) => m.name === 'this_model_does_not_exist.safetensors'),
      JSON.stringify(depBad.json.report?.missingModels ?? []));
  } finally {
    await helper.stop();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }

  section('结果');
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  if (fail > 0) {
    console.log('\n失败项:');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

await main();
