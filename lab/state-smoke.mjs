/**
 * 状态层测试：registry 单元行为 + 连接层状态接线 + 【真实断连】+ 宿主层集成。
 *
 *   node lab/state-smoke.mjs
 *
 * 断连那段不是模拟：它杀掉 npx 拉起的整棵 MCP 子进程树，
 * 然后断言 registry 从 ready 翻到 failed。这是 3.3(a) 缺口的验收。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { ServerRegistry, scrubCredentials } from '../lib/registry.js';
import { startConnection, normalizeServer } from '../lib/connection.js';
import { apply } from '../lib/index.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)));
};
const truthy = (label, value) => check(label, Boolean(value), true);

// ───────────────────────── 1. registry 单元行为 ─────────────────────────
console.log('1. registry 单元行为');
{
  const reg = new ServerRegistry();
  const changes = [];
  reg.onChange((c) => changes.push(c.phase + (c.error ? ':' + c.error.source : '')));

  reg.declare({ name: 'a', transport: 'stdio', command: 'x', args: [], toolCallTimeoutMs: 1000 });
  check('declare -> connecting', reg.get('a').phase, 'connecting');
  check('connecting 不冻结', reg.isSwitchEditable('a'), true);
  check('未知服务器不可操作', reg.isSwitchEditable('nope'), false);

  reg.ready('a', { toolCount: 7 });
  check('ready 带 toolCount', reg.get('a').toolCount, 7);
  reg.failed('a', { message: 'boom', source: 'transport' });
  check('failed 冻结', reg.isSwitchEditable('a'), false);
  check('错误原文保留', reg.get('a').error.message, 'boom');
  check('错误来源保留', reg.get('a').error.source, 'transport');
  reg.ready('a', { toolCount: 9 });
  check('恢复 ready 清空 error', reg.get('a').error, undefined);
  check('恢复后解冻', reg.isSwitchEditable('a'), true);
  reg.closed('a');
  check('closed 冻结', reg.isSwitchEditable('a'), false);
  // declare 建立的是初始态、不算变化，所以首个通知是 ready。
  check('通知只在变化时发', changes, ['ready', 'failed:transport', 'ready', 'closed']);

  const snap = reg.get('a');
  snap.phase = 'ready';
  check('快照是副本', reg.get('a').phase, 'closed');

  const reg2 = new ServerRegistry();
  reg2.declareConfigError('bad', 'missing command', { transport: 'stdio' });
  check('配置错误 -> failed/config', reg2.get('bad').error.source, 'config');
  check('配置错误冻结', reg2.isSwitchEditable('bad'), false);
  let threw = false;
  try { reg2.declare({ name: 'bad', transport: 'stdio' }); } catch { threw = true; }
  truthy('重复登记抛错', threw);
}

// 审查 S1：连接失败原文里的 URL 凭据不得进入模型可见输出。
console.log('\n1b. 凭据抹除（S1 回归）');
{
  check('抹除 URL 密码', scrubCredentials('cannot construct https://alice:s3cr3t@host/mcp now'),
        'cannot construct https://***@host/mcp now');
  check('无凭据时不动', scrubCredentials('https://host/mcp ok'), 'https://host/mcp ok');

  const reg = new ServerRegistry();
  reg.declare({ name: 'r', transport: 'stdio', command: 'x', args: [], toolCallTimeoutMs: 1000 });
  reg.failed('r', { message: 'Request cannot be constructed from a URL that includes credentials: https://alice:s3cr3t@127.0.0.1:1/mcp', source: 'connect' });
  const stored = reg.get('r').error.message;
  check('registry 里已无明文密码', stored.includes('s3cr3t'), false);
  truthy('但仍看得出是哪个主机', stored.includes('127.0.0.1:1'));

  // 配置阶段就该拒绝带凭据的 URL —— 纵深防御。
  let rejected = '';
  try { normalizeServer({ name: 'u', transport: 'streamable-http', url: 'https://alice:s3cr3t@host/mcp' }); }
  catch (error) { rejected = error.message; }
  truthy('配置阶段拒绝内嵌凭据的 URL', rejected.includes('must not embed credentials'));
  check('拒绝信息本身不含密码', rejected.includes('s3cr3t'), false);

  // args 不进 registry（可能含 --api-key）。
  const reg3 = new ServerRegistry();
  reg3.declare({ name: 'a', transport: 'stdio', command: 'x', args: ['--api-key', 'sk-deadbeef'], toolCallTimeoutMs: 1000 });
  check('registry 不保留 args', JSON.stringify(reg3.get('a').config).includes('sk-deadbeef'), false);
}

/** 找出 rootPid 的全部后代（/proc/<pid>/stat 的 state 之后第一个字段是 ppid）。 */
function descendants(rootPid) {
  const parentOf = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue;
    try {
      const stat = readFileSync('/proc/' + entry + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parentOf.set(Number(entry), Number(fields[1]));
    } catch { /* 进程已退出 */ }
  }
  const out = [];
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    for (const [child, parent] of parentOf) {
      if (parent === pid) { out.push(child); stack.push(child); }
    }
  }
  return out;
}

const CTX7 = {
  name: 'context7', transport: 'stdio',
  command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'],
};
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ───────────────────── 2. 连接层接线 + 真实断连 ─────────────────────
console.log('\n2. 连接层接线 + 真实断连');
const server = normalizeServer(CTX7);
const reg = new ServerRegistry();
reg.declare(server);
const seen = [];
reg.onChange((c) => seen.push(c.phase));

const conn = startConnection({ logger: silentLogger }, server, {
  onState: (change) => {
    if (change.phase === 'ready') reg.ready('context7', { toolCount: change.toolCount });
    else if (change.phase === 'failed') reg.failed('context7', { message: change.message, source: change.source });
    else if (change.phase === 'closed') reg.closed('context7');
  },
});

const outcome = await conn.ready;
check('连接成功', outcome.ok, true);
check('registry 已 ready', reg.get('context7').phase, 'ready');
check('toolCount 已记录', reg.get('context7').toolCount, 2);
const before = await conn.callTool('resolve-library-id', { libraryName: 'react', query: 'hooks' });
check('断连前调用正常', before.isError === true, false);

const victims = descendants(process.pid);
console.log('   killing MCP subtree: ' + JSON.stringify(victims));
for (const pid of victims) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
await new Promise((resolve) => setTimeout(resolve, 1500));

check('registry 翻到 failed', reg.get('context7').phase, 'failed');
check('错误来源是 transport', reg.get('context7').error?.source, 'transport');
check('failed 冻结开关', reg.isSwitchEditable('context7'), false);
let afterMessage = '';
try { await conn.callTool('resolve-library-id', { libraryName: 'react', query: 'hooks' }); }
catch (error) { afterMessage = error.message; }
truthy('断连后调用抛可诊断错误', afterMessage.includes('not connected') && afterMessage.includes('failed'));
await conn.dispose();
check('dispose -> closed', reg.get('context7').phase, 'closed');
check('相位轨迹', seen, ['ready', 'failed', 'closed']);

// 审查 M2：连接握手期间就卸载 —— 迟到的连接错误不许把已 closed 的连接覆写成 failed，
// 否则 handle.state() 与 registry 会互相矛盾（GUI 会读到相反的状态）。
console.log('\n2b. 握手期间卸载（M2 回归）');
const racing = startConnection({ logger: silentLogger }, normalizeServer(CTX7), {});
const raceSeen = [];
await racing.dispose(); // 不等 ready，立刻卸载
await new Promise((resolve) => setTimeout(resolve, 800));
check('卸载后 state() 是 closed 而不是 failed', racing.state(), 'closed');
check('ready 也如实报告未连上', (await racing.ready).ok, false);

// ───────────────────────── 3. 宿主层集成 ─────────────────────────
console.log('\n3. 宿主层集成（假 ctx，真连接）');
{
  const registered = new Map();
  const disposers = [];
  const events = [];
  const fakeCtx = {
    logger: silentLogger,
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
    on: () => () => {},
    inject: () => () => {},
    emit: (type, payload) => events.push([type, payload.phase]),
    tools: { register: (def) => { registered.set(def.name, def); return () => registered.delete(def.name); } },
  };

  apply(fakeCtx, {
    servers: [
      CTX7,
      { name: 'broken', transport: 'stdio' },                       // 缺 command -> 配置错误
      { name: 'has space', transport: 'stdio', command: 'x' },      // 名字非法
    ],
  });

  check('三个工具都注册了', [...registered.keys()].sort(), ['mcp_call', 'mcp_detail', 'mcp_servers']);

  const serversTool = registered.get('mcp_servers');
  const detailTool = registered.get('mcp_detail');
  const call = (tool, args) => tool.execute(args, {});

  // 等真实连接落地
  let listed;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    listed = await call(serversTool, {});
    if (listed.servers.find((s) => s.name === 'context7')?.available === true) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const byName = Object.fromEntries(listed.servers.map((s) => [s.name, s]));
  check('三台都登记了', listed.total, 3);
  check('context7 可用', byName.context7.available, true);
  check('context7 toolCount', byName.context7.toolCount, 2);
  check('context7 开关可操作', byName.context7.switchEditable, true);
  check('新会话默认全关', listed.enabledInThisSession, []);
  check('缺 command -> failed', byName.broken.phase, 'failed');
  check('缺 command 错误来源', byName.broken.errorSource, 'config');
  check('缺 command 冻结开关', byName.broken.switchEditable, false);
  check('非法名字也可见', byName['has space'].phase, 'failed');
  check('不可用清单', listed.unavailable.sort(), ['broken', 'has space']);

  const withTools = await call(serversTool, { includeTools: true });
  check('includeTools 列出工具名', withTools.servers.find((s) => s.name === 'context7').tools, ['query-docs', 'resolve-library-id']);

  const detail = await call(detailTool, { server: 'context7', tool: 'resolve-library-id' });
  check('mcp_detail 返回 schema', detail.found, true);
  check('schema 有 required', detail.inputSchema.required, ['query', 'libraryName']);
  check('可用服务器不带 cache 标注', detail.servedFrom, undefined);

  check('未知工具', (await call(detailTool, { server: 'context7', tool: 'nope' })).reason, 'UNKNOWN_TOOL');
  check('未知服务器', (await call(detailTool, { server: 'nope', tool: 'x' })).reason, 'UNKNOWN_SERVER');
  check('配置错误服务器取不到 schema', (await call(detailTool, { server: 'broken', tool: 'x' })).reason, 'SERVER_NOT_CONNECTED');

  const stateEvents = events.filter(([type]) => type === 'mcp-switch/state');
  truthy('发出了 mcp-switch/state 事件', stateEvents.length > 0);
  console.log('   events: ' + JSON.stringify(stateEvents.map(([, phase]) => phase)));

  // cordis 是**反序 + 逐个 await** 执行 disposer，测试也照生产顺序来。
  for (const dispose of [...disposers].reverse()) { try { await dispose(); } catch { /* 忽略 */ } }
  const afterDispose = await call(serversTool, {});
  check('卸载后 context7 变 closed', afterDispose.servers.find((s) => s.name === 'context7').phase, 'closed');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exitCode = failures === 0 ? 0 : 1;
