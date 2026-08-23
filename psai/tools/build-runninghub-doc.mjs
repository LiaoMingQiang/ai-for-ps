/**
 * 由 packages/shared/src/runninghub.ts 生成 docs/RUNNINGHUB.md。
 *
 * 文档手写就一定会和代码漂移 —— 尤其是节点号这种没人会去核对的东西。
 * 所以清单只有一份事实源，文档是它的投影。
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { RUNNINGHUB_PRESETS, RH_CATEGORY_LABELS, rhPostUrl, findFeature, breadcrumb } = await import(
  pathToFileURL(resolve(root, 'packages/shared/dist/index.js')).href
);

const lines = [];
const p = (s = '') => lines.push(s);

p('# 内置云端工作流预设（RunningHub）');
p();
p('> 本文件由 `npm run docs:rh` 从 `packages/shared/src/runninghub.ts` 生成，请勿手工编辑。');
p();
p('每条预设都对应 runninghub.cn 上一个真实存在、公开可跑的工作流。');
p('节点号与字段名不是猜的 —— 全部来自 `POST /api/openapi/getJsonApiFormat` 返回的真实 API 格式图，逐个核对过。');
p();
p('```bash');
p('npm run verify:rh        # 拿真实 API Key 重新核对每条绑定是否还成立');
p('```');
p();
p('云端作者随时可能改图。改了之后我们的 `nodeInfoList` 会打到不存在的节点上，');
p('而 RunningHub **不会报错**，它只是默默忽略那条覆盖 —— 用户拿到的是一张「参数全没生效」的图。');
p('这是最难被发现的一类失败，所以 `verify:rh` 必须在每次发版前跑。');
p();

/* ---------- 总览 ---------- */
p('## 总览');
p();
p('| 预设 | 能力 | 云端工作流 | 节点数 | 需要遮罩 | 绑定数 |');
p('| --- | --- | --- | ---: | :---: | ---: |');
for (const x of RUNNINGHUB_PRESETS) {
  p(
    `| \`${x.id}\` | ${RH_CATEGORY_LABELS[x.category]} | [${x.workflowId}](${rhPostUrl(x.workflowId)}) ` +
      `| ${x.nodeCount} | ${x.needsMask ? '是' : '—'} | ${x.bindings.length} |`
  );
}
p();

/* ---------- 逐条 ---------- */
p('## 逐条明细');
p();
for (const x of RUNNINGHUB_PRESETS) {
  p(`### ${x.label}`);
  p();
  p(`- **预设 id**：\`${x.id}\``);
  p(`- **能力分类**：${RH_CATEGORY_LABELS[x.category]}`);
  p(`- **云端工作流**：[${x.workflowId}](${rhPostUrl(x.workflowId)})（${x.nodeCount} 个节点）`);
  p(`- **模型栈**：${x.stack}`);
  p(`- **说明**：${x.description}`);
  if (x.needsMask) {
    p(
      '- **需要遮罩**：输入图必须带 alpha 通道，透明处即处理区域。' +
        '不带 alpha 提交会被 Helper 拦下（整张图都会被当成处理区，出来的结果和用户圈的选区毫无关系）。'
    );
  }
  const feats = x.featureIds.map((fid) => {
    const f = findFeature(fid);
    return f ? `${breadcrumb(fid).join(' / ')}（\`${fid}\`）` : `\`${fid}\`（功能不存在！）`;
  });
  p(`- **可绑定到**：${feats.join('、')}`);
  p(`- **出图节点**：${x.outputNodeIds.map((n) => `\`${n}\``).join('、')}`);
  if (x.paramDefaults) {
    const kv = Object.entries(x.paramDefaults)
      .map(([k, v]) => `\`${k}\` = ${JSON.stringify(v)}`)
      .join('、');
    p(
      `- **推荐默认值**：${kv}` +
        '（盖过功能自身的默认值。这些值照常显示在参数面板里，用户随时能改 —— 不是背着他改）'
    );
  }
  p();
  p('| 参数 | 节点 | 字段 | 变换 | 必填 |');
  p('| --- | ---: | --- | --- | :---: |');
  for (const b of x.bindings) {
    const t = b.transform ? `\`${b.transform.type}\`${b.transform.type === 'const' ? ` = ${JSON.stringify(b.transform.value)}` : ''}` : '—';
    const name = b.paramId.startsWith('__') ? `${b.paramId}（内部固定值）` : b.paramId;
    p(`| ${name} | \`${b.nodeId}\` | \`${b.input}\` | ${t} | ${b.required ? '✓' : '—'} |`);
  }
  p();
}

/* ---------- 怎么加一条 ---------- */
p('## 怎么再加一条预设');
p();
p('1. 在 runninghub.cn 上找到工作流，作品页地址就是 `https://www.runninghub.cn/post/<workflowId>`。');
p('2. 拉它的真实节点图：');
p();
p('```bash');
p('curl -s -X POST https://www.runninghub.cn/api/openapi/getJsonApiFormat \\');
p('  -H "Content-Type: application/json" \\');
p('  -d "{\\"apiKey\\":\\"$RUNNINGHUB_API_KEY\\",\\"workflowId\\":\\"<workflowId>\\"}"');
p('```');
p();
p('3. 挑绑定的时候盯住两件事：');
p('   - **提示词必须能顺着连线走到 `CLIPTextEncode`**。经过 `ArgosTranslateTextNode` 这类第三方节点的不要选 ——');
p('     实测它在 RunningHub 上不工作、输出空串，任务照样「成功」，出来的是拿空提示词生成的乱图。');
p('   - **要覆盖的字段必须是标量，不能是连线输入**。已经被连线占用的字段，覆盖会被忽略。');
p('4. 把节点号写进 `RUNNINGHUB_PRESETS`，跑 `npm run verify:rh` 确认全部命中。');
p('5. 跑一次真实出图，**用眼睛看图确认提示词生效了**。这一步不能省 —— 前面所有检查都通过、图也出来了，');
p('   却和提示词毫无关系，这种情况真实发生过。');
p();

const out = resolve(root, 'docs/RUNNINGHUB.md');
writeFileSync(out, lines.join('\n') + '\n', 'utf8');
console.log(`DOCS-OK  docs/RUNNINGHUB.md（${RUNNINGHUB_PRESETS.length} 条预设）`);
