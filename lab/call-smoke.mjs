/**
 * mcp_call 端到端测试：假 ctx + 真子进程 + 真图片。
 *
 *   node lab/call-smoke.mjs
 *
 * 服务器是 lab/fake-mcp-server.mjs（手写的最小 MCP，stdio JSON-RPC）。
 * 图片是 lab/fixtures/test.png（48x48 真 PNG）—— 附件存储会校验解码后的
 * 媒体类型与内在尺寸，所以假的 base64 过不了这一关。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';

// 开关现在会落盘 —— 指向临时 DSH_HOME，免得污染真实的 ~/.dsh。
// resolveDshHome() 在 apply 时才解析，所以这里设来得及。
const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcp-switch-call-'));
process.env.DSH_HOME = TEST_HOME;

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)));
};
const truthy = (label, value) => check(label, Boolean(value), true);
const throwsWith = async (label, fn, needle) => {
  try {
    await fn();
    check(label, 'did not throw', 'threw');
  } catch (error) {
    check(label, error.message.includes(needle), true);
    if (!error.message.includes(needle)) console.log('         message: ' + error.message);
  }
};

const SERVER_PATH = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));
const SESSION = 'S1';

// ---- 假服务 ----------------------------------------------------------------
const saved = [];
let imageModalities = ['text', 'image'];
const registered = new Map();
const disposers = [];

const fakeCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
  on: () => () => {},
  inject: () => () => {},
  emit: () => {},
  get: (name) => {
    if (name === 'attachments') {
      return {
        async saveImages(inputs) {
          return inputs.map((image) => {
            saved.push({ bytes: image.data.length, mediaType: image.mediaType });
            return { attachmentId: 'att-' + saved.length, mediaType: image.mediaType, bytes: image.data.length, width: 48, height: 48 };
          });
        },
      };
    }
    if (name === 'llm') return { async resolveModelInfo() { return { inputModalities: imageModalities }; } };
    return undefined;
  },
  tools: { register: (def) => { registered.set(def.name, def); return () => registered.delete(def.name); } },
};

const api = apply(fakeCtx, {
  servers: [{ name: 'fake', transport: 'stdio', command: process.execPath, args: [SERVER_PATH] }],
});

const serversTool = registered.get('mcp_servers');
const detailTool = registered.get('mcp_detail');
const callTool = registered.get('mcp_call');

const makeExec = (sessionId) => ({
  agent: {
    session: { header: { id: sessionId }, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) },
    options: {},
  },
  signal: new AbortController().signal,
});
const exec = makeExec(SESSION);

console.log('1. 工具注册与连接');
check('注册了三个工具', [...registered.keys()].sort(), ['mcp_call', 'mcp_detail', 'mcp_servers']);

let listed;
for (let attempt = 0; attempt < 40; attempt += 1) {
  listed = await serversTool.execute({}, exec);
  if (listed.servers[0]?.available === true) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
check('假服务器已连接', listed.servers[0].phase, 'ready');
check('列出三个工具', listed.servers[0].toolCount, 3);

console.log('\n2. 未启用时拒绝（新会话默认全关）');
await throwsWith('未启用 -> 拒绝', () => callTool.execute({ server: 'fake', tool: 'echo', arguments: { text: 'x' } }, exec), 'is not enabled in this session');

console.log('\n3. 启用后正常调用');
await api.switches.set(SESSION, 'fake', true);
const echoed = await callTool.execute({ server: 'fake', tool: 'echo', arguments: { text: 'hi' } }, exec);
check('echo 结果', echoed.content, [{ type: 'text', text: 'echo: hi' }]);
check('render 直接返回 content', callTool.output.render(null, echoed), echoed.content);

console.log('\n4. 图片路径（本设计的关键验收）');
const shot = await callTool.execute({ server: 'fake', tool: 'screenshot' }, exec);
check('两个块', shot.content.length, 2);
check('文本块在前', shot.content[0], { type: 'text', text: 'here is the screenshot' });
check('图片块是附件引用', shot.content[1].type, 'image');
truthy('附件有 id', typeof shot.content[1].attachment?.attachmentId === 'string');
check('附件媒体类型', shot.content[1].attachment.mediaType, 'image/png');
check('附件字节数 = 真实 PNG 大小', shot.content[1].attachment.bytes, 474);
check('附件内在尺寸来自解码', [shot.content[1].attachment.width, shot.content[1].attachment.height], [48, 48]);
check('附件服务被调用一次', saved.length, 1);
check('canonical value 里没有原始 base64', JSON.stringify(shot).includes('iVBORw0KGgo'), false);

console.log('\n5. 模型不支持图片时降级为文本诊断');
imageModalities = ['text'];
const degraded = await callTool.execute({ server: 'fake', tool: 'screenshot' }, exec);
// 降级后图片变成文本块，与相邻文本块合并成一段 —— 语义正确，且信息不丢。
check('降级后合并为一段文本', degraded.content.length, 1);
check('合并后仍是 text', degraded.content[0].type, 'text');
truthy('原文保留', degraded.content[0].text.includes('here is the screenshot'));
truthy('诊断说明原因', degraded.content[0].text.includes('does not declare image input'));
truthy('诊断说明是哪个媒体类型', degraded.content[0].text.includes('image/png'));
truthy('诊断说明原始数据不再保留', degraded.content[0].text.includes('not retained'));
check('降级时不再落盘', saved.length, 1);
imageModalities = ['text', 'image'];

console.log('\n6. 错误契约：isError 抛错且正文保真');
await throwsWith(
  'isError -> 抛错',
  () => callTool.execute({ server: 'fake', tool: 'explode' }, exec),
  'Input validation error: text: Invalid input: expected string, received undefined',
);

console.log('\n7. 其它拒绝路径');
await throwsWith('未知工具', () => callTool.execute({ server: 'fake', tool: 'nope' }, exec), 'has no tool named "nope"');
await throwsWith('未知服务器', () => callTool.execute({ server: 'ghost', tool: 'x' }, exec), 'unknown MCP server "ghost"');
const other = makeExec('S2');
await throwsWith('另一个会话仍是关的', () => callTool.execute({ server: 'fake', tool: 'echo', arguments: { text: 'x' } }, other), 'is not enabled in this session');

console.log('\n8. mcp_detail 与 mcp_call 的 schema 一致');
const detail = await detailTool.execute({ server: 'fake', tool: 'echo' }, exec);
check('detail required', detail.inputSchema.required, ['text']);

for (const dispose of disposers) { try { await dispose(); } catch { /* 忽略 */ } }
delete process.env.DSH_HOME;
rmSync(TEST_HOME, { recursive: true, force: true });
console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exitCode = failures === 0 ? 0 : 1;
