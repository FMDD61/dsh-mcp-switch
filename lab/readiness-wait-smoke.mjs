/**
 * 首呼竞态兜底：connecting 相位的有界等待。
 *
 *   node lab/readiness-wait-smoke.mjs
 *
 * 背景（2026-10-08 headless 实测）：一次性 run 里模型第一次调用常常早于 MCP 子进程就绪，
 * 于是 mcp_detail 拿到空目录回 NO_TOOLS_KNOWN、mcp_call 回「稍后再试」—— 而 headless 没有
 * 第二次机会（实测：一次 run 里模型三个工具一次调完，全撞在 connecting 上）。
 *
 * 这里验的是**边界**，不是「能等到」：
 *   1. 等待中变 ready → 正常作答（而不是 NO_TOOLS_KNOWN）
 *   2. readyWaitMs: 0 → 回到旧行为（立刻作答，不等）
 *   3. 超时 → 立刻返回，并且**明说还在连**，不假装「没有工具」
 *   4. 等待期间失败 / signal 已中止 → 立刻返回，不白等到超时
 *   5. mcp_call 走同一条等待；但**未启用时不等待**（那是另一个轴上的答案）
 *   6. mcp_servers 不等待 —— 它是盘点工具，本来就该立刻回答
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const HOME = mkdtempSync(join(tmpdir(), 'mcp-switch-wait-'));
process.env.DSH_HOME = HOME;

const { apply } = await import('../lib/index.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)));
};
const truthy = (label, value) => check(label, Boolean(value), true);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SERVER = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));

function makeHost() {
  const registered = new Map();
  const disposers = [];
  let route;
  const inner = {
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
    webServer: { register: (r) => { route = r; return () => { route = undefined; }; } },
    connection: { requestRejection: () => undefined },
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
    on: () => () => {},
    emit: () => {},
    get: () => undefined,
    tools: { register: (def) => { registered.set(def.name, def); return () => registered.delete(def.name); } },
    inject: (deps, callback) => {
      if (Array.isArray(deps) && deps.includes('webServer') && deps.includes('connection')) callback(inner);
      return () => {};
    },
  };
  return {
    ctx,
    registered,
    route: () => route,
    dispose: async () => { for (const d of disposers.reverse()) await d(); },
  };
}

function makeReq(url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = 'POST';
  req.url = url;
  return req;
}

function makeRes() {
  const captured = { status: 0, body: '', sent: false };
  return {
    captured,
    get headersSent() { return captured.sent; },
    writeHead: (status) => { captured.status = status; },
    end: (body) => { captured.body = body === undefined ? '' : String(body); captured.sent = true; },
    destroy: () => {},
  };
}

async function call(host, endpoint, body) {
  const res = makeRes();
  await host.route().handler(makeReq('/mcp-switch/' + endpoint, body), res);
  return JSON.parse(res.captured.body);
}

const state = async (host, sessionId) => (await call(host, 'state', { sessionId })).value;
const execFor = (sessionId, signal) => ({
  agent: { session: { header: { id: sessionId } } },
  ...(signal === undefined ? {} : { signal }),
});
const slowServer = (delayMs) => ({
  name: 'slow',
  transport: 'stdio',
  command: process.execPath,
  args: [SERVER, '--ready-delay-ms', String(delayMs)],
});

// ───────────────── 1. 等待中变 ready：正常作答 ─────────────────
console.log('1. 等待中变 ready：正常作答');
{
  const host = makeHost();
  apply(host.ctx, { readyWaitMs: 10_000, servers: [slowServer(1500)] });
  const started = Date.now();
  const detail = await host.registered.get('mcp_detail').execute({ server: 'slow', tool: 'echo' }, execFor('s1'));
  const elapsed = Date.now() - started;
  check('等到了目录（found:true）', detail.found, true);
  truthy('报告了等待时长', typeof detail.waitedMs === 'number' && detail.waitedMs >= 1000);
  truthy('整体耗时落在合理区间', elapsed >= 1000 && elapsed < 9000);
  await host.dispose();
}

// ───────────────── 2. readyWaitMs: 0 = 关掉等待 ─────────────────
console.log('2. readyWaitMs: 0 回到旧行为');
{
  const host = makeHost();
  apply(host.ctx, { readyWaitMs: 0, servers: [slowServer(1500)] });
  const started = Date.now();
  const detail = await host.registered.get('mcp_detail').execute({ server: 'slow', tool: 'echo' }, execFor('s2'));
  const elapsed = Date.now() - started;
  check('不等待：NO_TOOLS_KNOWN', detail.reason, 'NO_TOOLS_KNOWN');
  check('不等待：相位仍是 connecting', detail.phase, 'connecting');
  truthy('耗时很短', elapsed < 600);
  check('没有 waitedMs 字段（没等过就不报）', detail.waitedMs, undefined);
  await host.dispose();
}

// ───────────────── 3. 超时：立刻返回且明说还在连 ─────────────────
console.log('3. 超时：明说还在连，不假装没有工具');
{
  const host = makeHost();
  apply(host.ctx, { readyWaitMs: 200, servers: [slowServer(3000)] });
  const started = Date.now();
  const detail = await host.registered.get('mcp_detail').execute({ server: 'slow', tool: 'echo' }, execFor('s3'));
  const elapsed = Date.now() - started;
  check('超时后仍报 connecting', detail.phase, 'connecting');
  check('原因仍是 NO_TOOLS_KNOWN', detail.reason, 'NO_TOOLS_KNOWN');
  truthy('等待时长接近上限', detail.waitedMs >= 190 && detail.waitedMs < 1500);
  truthy('提示明说还在连', String(detail.hint).includes('still connecting'));
  truthy('没有等服务器就绪', elapsed < 2500);
  await host.dispose();
}

// ───────────────── 4. 不白等：失败 / 已中止 ─────────────────
console.log('4. 不白等：失败与中止');
{
  const host = makeHost();
  apply(host.ctx, {
    readyWaitMs: 10_000,
    servers: [{ name: 'dead', transport: 'stdio', command: '/nonexistent-dsh-mcp-switch-binary' }],
  });
  const started = Date.now();
  const detail = await host.registered.get('mcp_detail').execute({ server: 'dead', tool: 'x' }, execFor('s4'));
  check('失败相位如实上报', detail.phase, 'failed');
  truthy('带上了失败原因', typeof detail.error === 'string' && detail.error !== '');
  truthy('没有等满超时', Date.now() - started < 5000);
  await host.dispose();
}
{
  const host = makeHost();
  apply(host.ctx, { readyWaitMs: 10_000, servers: [slowServer(3000)] });
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const detail = await host.registered.get('mcp_detail').execute({ server: 'slow', tool: 'echo' }, execFor('s5', controller.signal));
  check('已中止：如实标记 aborted', detail.aborted, true);
  truthy('中止立刻生效', Date.now() - started < 600);
  await host.dispose();
}

// ───────────────── 5. mcp_call：同一条等待，但未启用不等 ─────────────────
console.log('5. mcp_call 走同一条等待');
{
  const host = makeHost();
  apply(host.ctx, { readyWaitMs: 10_000, servers: [slowServer(1200)] });
  await call(host, 'toggle', { sessionId: 'c1', server: 'slow', enabled: true });
  const result = await host.registered.get('mcp_call').execute(
    { server: 'slow', tool: 'echo', arguments: { text: 'hi' } },
    execFor('c1'),
  );
  truthy('等到就绪后调用成功', Array.isArray(result.content) && result.content.length > 0);
  await host.dispose();
}
{
  const host = makeHost();
  apply(host.ctx, { readyWaitMs: 10_000, servers: [slowServer(3000)] });
  const started = Date.now();
  let message = '';
  try {
    await host.registered.get('mcp_call').execute({ server: 'slow', tool: 'echo' }, execFor('c2'));
  } catch (error) { message = String(error.message); }
  truthy('未启用时立刻拒绝', message.includes('not enabled in this session'));
  truthy('未启用时不等待', Date.now() - started < 600);
  await host.dispose();
}

// ───────────────── 6. mcp_servers 不等待 ─────────────────
console.log('6. mcp_servers 是盘点工具，不等待');
{
  const host = makeHost();
  apply(host.ctx, { readyWaitMs: 10_000, servers: [slowServer(3000)] });
  const started = Date.now();
  const inventory = await host.registered.get('mcp_servers').execute({}, execFor('s6'));
  truthy('立刻返回', Date.now() - started < 600);
  check('相位如实为 connecting', inventory.servers[0].phase, 'connecting');
  await host.dispose();
}

rmSync(HOME, { recursive: true, force: true });
console.log('');
if (failures === 0) console.log('ALL PASS');
else { console.log(failures + ' FAILED'); process.exitCode = 1; }
