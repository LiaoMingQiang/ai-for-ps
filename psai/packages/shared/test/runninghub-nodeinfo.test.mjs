/**
 * 解析 RunningHub AI 应用的 nodeInfoList。
 *
 * 为什么必须靠粘贴：AI 应用的节点号只存在于平台给每个应用单独生成的
 * API 文档页里，没有公开接口能查。实测过 —— 拿 AI 应用的 ID 去打
 * 工作流接口 /api/openapi/getJsonApiFormat，回的是 380 WORKFLOW_NOT_EXISTS，
 * 工作流接口根本不认识它。
 *
 * 既然只能靠粘贴，就得把粘贴这一步做得足够宽容：用户手上可能是整段 curl、
 * 可能是请求体、也可能只是那个数组。要求他自己摘出数组的话，摘错了
 * 报的错会指向别处，而他并不知道自己摘错了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRhNodeInfo, pickRhImageField } from '../dist/index.js';

// 平台「复制文档」给出的原样内容（AI产品精修3.0，应用 1892509998193545217）
const CURL = `curl --location --request POST 'https://www.runninghub.ai/openapi/v2/run/ai-app/1892509998193545217' \\
--header "Content-Type: application/json" \\
--header "Authorization: Bearer \${RUNNINGHUB_API_KEY}" \\
--data-raw '{
  "nodeInfoList": [
    {
      "nodeId": "525",
      "fieldName": "image",
      "fieldValue": "a6fef8ac4754f00e592e263a5a1fc51bd1aa5719f1eb0374d4e8b0f9e1133c0d.png",
      "description": "Upload product retouching"
    },
    {
      "nodeId": "727",
      "fieldName": "int",
      "fieldValue": "25",
      "description": "Similarity value (recommended range 22-26)"
    }
  ],
  "instanceType": "default",
  "usePersonalQueue": "false"
}'`;

test('整段 curl：把 nodeInfoList 摘出来', () => {
  const fields = parseRhNodeInfo(CURL);
  assert.equal(fields.length, 2);
  assert.deepEqual(fields[0], {
    nodeId: '525',
    fieldName: 'image',
    description: 'Upload product retouching',
    defaultValue: 'a6fef8ac4754f00e592e263a5a1fc51bd1aa5719f1eb0374d4e8b0f9e1133c0d.png'
  });
  assert.equal(fields[1].nodeId, '727');
  assert.equal(fields[1].defaultValue, '25', '示例值要留着当默认值');
});

test('只贴请求体 JSON 也行', () => {
  const body = JSON.stringify({
    nodeInfoList: [{ nodeId: '9', fieldName: 'text', fieldValue: 'hi', description: '提示词' }],
    instanceType: 'default'
  });
  assert.equal(parseRhNodeInfo(body).length, 1);
});

test('只贴那个数组也行', () => {
  const arr = JSON.stringify([{ nodeId: 3, fieldName: 'seed', fieldValue: 7 }]);
  const f = parseRhNodeInfo(arr);
  assert.equal(f[0].nodeId, '3', 'nodeId 是数字时要转成字符串');
  assert.equal(f[0].defaultValue, '7');
});

test('空的 / 认不出的内容要给出能照着做的说明', () => {
  assert.throws(() => parseRhNodeInfo('   '), /请先把.*粘贴/);
  assert.throws(() => parseRhNodeInfo('随便写点什么'), /API 页面.*请求示例/s);
  // 合法 JSON 但里面没有 nodeInfoList —— 同样要报得清楚，不能静默返回空数组
  assert.throws(() => parseRhNodeInfo('{"instanceType":"default"}'), /nodeInfoList/);
});

test('缺字段的条目被跳过，不至于让整次粘贴作废', () => {
  const arr = JSON.stringify([
    { nodeId: '1' }, // 没有 fieldName
    { fieldName: 'image' }, // 没有 nodeId
    { nodeId: '2', fieldName: 'image', fieldValue: 'a.png' }
  ]);
  const f = parseRhNodeInfo(arr);
  assert.equal(f.length, 1);
  assert.equal(f[0].nodeId, '2');
});

test('认出图片位：字段名最硬', () => {
  const f = parseRhNodeInfo(CURL);
  assert.equal(pickRhImageField(f).nodeId, '525');
});

test('字段名不叫 image 时，靠示例值的扩展名认', () => {
  const f = parseRhNodeInfo(
    JSON.stringify([
      { nodeId: '1', fieldName: 'int', fieldValue: '25' },
      { nodeId: '2', fieldName: 'any', fieldValue: 'x.jpg' }
    ])
  );
  assert.equal(pickRhImageField(f).nodeId, '2');
});

test('认不出图片位时返回 null，不许猜第一个', () => {
  /*
   * 猜错的后果是把图塞进一个数值字段。平台照跑不误，然后用作者的示例图
   * 出一张跟用户输入毫无关系的图 —— 那种"看起来成功了"的结果，
   * 比直接报错难查得多，而且用户是花了钱才看到它。
   */
  const f = parseRhNodeInfo(
    JSON.stringify([
      { nodeId: '1', fieldName: 'int', fieldValue: '25' },
      { nodeId: '2', fieldName: 'steps', fieldValue: '20' }
    ])
  );
  assert.equal(pickRhImageField(f), null);
});
