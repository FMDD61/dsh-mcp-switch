/**
 * 运行期工具列表变化（MCP 的 tools/list_changed）。
 *
 *   node lab/catalog-smoke.mjs
 *
 * 这是审查 L4：服务器按运行期状态条件性暴露工具时（认证完成、上游能力打开……）
 * 会发这条协议通知，**不一定是"服务器更新了"**。
 *
 * 本插件此前完全不处理它 —— 目录在连接时冻结，新工具既不可见也不可调。
 *
 * **关键断言是最后一条**：刷新目录**不得改动工具表**。MCP 目录在本层内存里，
 * 三个工具的声明是常量，所以这条路径的前缀成本是零 —— 这正是我们设计掉的问题。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = mkdtempSync(join(tmpdir(), 'mcp-switch-catalog-'));
process.env.DSH_HOME = HOME;

const { apply } = await import('../lib/index.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)));
};
const truthy = (label, value) => check(label, Boolean(value), true);

const SERVER = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));

const registered = new Map();
const disposers = [];
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
  on: () => () => {},
  inject: () => () => {},
  emit: () => {},
  get: () => undefined,
  tools: { register: (def) => { registered.set(def.name, def); return () => registered.delete(def.name); } },
};

const api = apply(ctx, {
  servers: [{
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,
    args: [SERVER, '--list-changed'],
  }],
});

/** 模型看到的工具声明，逐字节。 */
const declarations = () => [...registered.values()]
  .map((def) => ({ name: def.name, description: def.description, parameters: def.parameters }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

const before = declarations();
const serversTool = registered.get('mcp_servers');
const detailTool = registered.get('mcp_detail');
const callTool = registered.get('mcp_call');
const exec = { agent: { session: { header: { id: 'S1' } } }, signal: new AbortController().signal };

const listed = async () => (await serversTool.execute({}, exec)).servers[0];

console.log('1. 连接建立，初始目录 3 个工具');
let current;
for (let i = 0; i < 60; i += 1) {
  current = await listed();
  if (current?.available === true) break;
  await new Promise((r) => setTimeout(r, 200));
}
check('已连接', current.available, true);
check('初始工具数', current.toolCount, 3);

const early = await detailTool.execute({ server: 'fake', tool: 'late-arrival' }, exec);
check('晚到的工具此刻还查不到', early.reason, 'UNKNOWN_TOOL');
truthy('并列出已知工具', early.knownTools.includes('echo'));

console.log('\n2. 服务器发出 tools/list_changed 之后');
let refreshed;
for (let i = 0; i < 40; i += 1) {
  refreshed = await listed();
  if (refreshed.toolCount === 4) break;
  await new Promise((r) => setTimeout(r, 200));
}
check('目录已刷新到 4 个工具', refreshed.toolCount, 4);

const late = await detailTool.execute({ server: 'fake', tool: 'late-arrival' }, exec);
check('新工具现在查得到 schema', late.found, true);

console.log('\n3. 新工具可调用');
await api.switches.set('S1', 'fake', true);
const called = await callTool.execute({ server: 'fake', tool: 'late-arrival' }, exec);
check('调用成功', called.content, [{ type: 'text', text: 'the late tool ran' }]);

console.log('\n4. 关键：刷新目录没有改动工具表');
check('工具声明逐字节不变', declarations(), before);

for (const d of [...disposers].reverse()) { try { await d(); } catch { /* 忽略 */ } }
delete process.env.DSH_HOME;
rmSync(HOME, { recursive: true, force: true });
console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exitCode = failures === 0 ? 0 : 1;
