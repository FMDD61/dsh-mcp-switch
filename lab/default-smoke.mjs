/**
 * 新会话默认：存储、解析链、成本估算。
 *
 *   node lab/default-smoke.mjs
 *
 * 这一层最容易搞错的不是读文件，是**语义边界**：
 *
 *   - 默认只是「会话自己没有状态文件时」的初始值；
 *   - 动过一次开关，那个会话就有自己的文件，从此不再跟随默认；
 *   - 默认**不受冻结规则约束**（它讲的是将来的会话，与此刻连没连上无关）；
 *   - 默认文件读不出来时**不拒绝写入** —— 与会话状态相反，因为写入的目标是会话文件，
 *     碰不到默认文件本身，没有可丢的数据。反过来若也拒绝，一台坏文件会让每个新会话都开不了开关。
 *
 * 前三条与第四条各自都有断言。
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const HOME = mkdtempSync(join(tmpdir(), 'mcp-switch-default-'));
process.env.DSH_HOME = HOME;

const measure = await import('../lib/measure.js');
const storeMod = await import('../lib/store.js');
const { apply } = await import('../lib/index.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)));
};
const truthy = (label, value) => check(label, Boolean(value), true);

const SERVER = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));
const DEFAULTS_FILE = join(HOME, 'dsh-mcp-switch', 'defaults.json');

// ───────────────────────── 1. declarationBytes 的口径 ─────────────────────────
console.log('1. declarationBytes 的口径');
{
  check('空输入为 0', measure.declarationBytes([]), 0);
  check('非数组为 0', measure.declarationBytes(undefined), 0);

  const tools = [{ name: 'a', description: 'b', inputSchema: { type: 'object' } }];
  const expected = Buffer.byteLength(JSON.stringify([{ name: 'a', description: 'b', parameters: { type: 'object' } }]), 'utf8');
  check('形状是 name+description+parameters', measure.declarationBytes(tools), expected);

  // 不进请求工具表的字段必须被丢掉（否则界面的数与文档口径对不上）。
  const noisy = [{ name: 'a', description: 'b', inputSchema: { type: 'object' }, title: 'T', annotations: { x: 1 }, icons: [{ src: 'y' }] }];
  check('忽略 title/annotations/icons', measure.declarationBytes(noisy), expected);

  // 中文描述必须按字节算，不能按字符数。
  const cn = [{ name: 'a', description: '中文描述', inputSchema: {} }];
  const cnBytes = measure.declarationBytes(cn);
  check('按 UTF-8 计（中文 4 字 = 12 字节）', cnBytes - measure.declarationBytes([{ name: 'a', description: 'xxxx', inputSchema: {} }]), 12 - 4);

  truthy('不导出 token 折算', measure.estimateTokens === undefined);
}

// ───────────────────────── 2. DefaultsStore 单元 ─────────────────────────
console.log('\n2. DefaultsStore 单元');
{
  const home = mkdtempSync(join(tmpdir(), 'mcp-switch-defaults-unit-'));
  const store = new storeMod.DefaultsStore({ home });

  check('文件不存在 -> 空且可确认', await store.load(), { servers: [], readable: true });
  await store.save(['b', 'a', 'a']);
  check('落盘后排序去重', (await store.load()).servers, ['a', 'b']);
  check('文件权限 0600', statSync(store.path()).mode & 0o777, 0o600);

  writeFileSync(store.path(), 'not json at all');
  check('损坏 -> readable:false 且退化为空', await store.load(), { servers: [], readable: false });

  writeFileSync(store.path(), JSON.stringify({ version: 999, servers: ['x'] }));
  check('版本不认识 -> readable:false', await store.load(), { servers: [], readable: false });

  writeFileSync(store.path(), JSON.stringify({ version: storeMod.DEFAULTS_VERSION, servers: ['ok', 42, '', 'ok'] }));
  check('非字符串项被滤掉', (await store.load()).servers, ['ok']);
  rmSync(home, { recursive: true, force: true });
}

// ───────────────────────── 3. 假宿主 ─────────────────────────
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
  return { ctx, route: () => route, registered };
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

async function waitReady(host) {
  for (let i = 0; i < 100; i += 1) {
    const value = await state(host, 'probe');
    if (value.servers.some((s) => s.name === 'fake' && s.phase === 'ready')) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the fake server never became ready');
}

const CONFIG = {
  servers: [
    { name: 'fake', transport: 'stdio', command: process.execPath, args: [SERVER] },
    { name: 'half', transport: 'stdio' },
  ],
};

// ───────────────────────── 4. 解析链 ─────────────────────────
console.log('\n4. 解析链：自己 -> 继承 -> 默认');
{
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const first = await waitReady(host);

  // 出荷值：全关。
  check('出荷默认全关', first.defaults, []);
  check('新会话跟随默认（空）', first.enabled, []);
  check('新会话标记来自默认', first.fromDefault, true);
  check('默认全关时成本为 0', first.defaultBytes, 0);
  check('读不出默认值时为 false（此处正常）', first.defaultReadable, true);

  // 打开一台默认。
  const set = await call(host, 'default', { server: 'fake', enabled: true });
  check('改默认成功', set.value.defaults, ['fake']);
  check('默认文件已落盘', JSON.parse(readFileSync(DEFAULTS_FILE, 'utf8')).servers, ['fake']);

  const after = await state(host, 'fresh-1');
  check('未碰过的新会话跟随新默认', after.enabled, ['fake']);
  check('成本行有了字节数', after.defaultBytes > 0, true);
  check('已连上的默认不计入未测', after.defaultUnmeasured, 0);

  // 这台服务器还没连上 -> 体量未知，要如实计数。
  await call(host, 'default', { server: 'half', enabled: true });
  const withHalf = await state(host, 'fresh-1');
  check('默认里的未连接服务器被计数', withHalf.defaultUnmeasured, 1);
  check('默认集合含两台', withHalf.defaults, ['fake', 'half']);

  // 冻结规则**不**适用于默认：half 是配置错误、开关被冻结，但默认仍可改。
  const halfRow = withHalf.servers.find((s) => s.name === 'half');
  check('half 的会话开关被冻结', halfRow.switchEditable, false);
  const unfreeze = await call(host, 'default', { server: 'half', enabled: false });
  check('冻结不影响改默认', unfreeze.ok, true);

  // 用户在一个会话里动过开关 -> 从此固化，不再跟随默认。
  const toggled = await call(host, 'toggle', { sessionId: 'touched', server: 'fake', enabled: true });
  check('会话内打开成功', toggled.value.enabled, ['fake']);
  await call(host, 'toggle', { sessionId: 'touched', server: 'fake', enabled: false });
  const touched = await state(host, 'touched');
  check('本会话关掉后为空', touched.enabled, []);
  check('不再是「来自默认」', touched.fromDefault, false);

  await call(host, 'default', { server: 'fake', enabled: false });
  const touchedAfter = await state(host, 'touched');
  check('改默认不影响动过开关的会话', touchedAfter.enabled, []);
  check('未碰过的会话跟随改动', (await state(host, 'fresh-2')).enabled, []);

  // 未知名字要被拒绝，别把垃圾写进默认文件。
  const bogus = await call(host, 'default', { server: 'nope', enabled: true });
  check('未知服务器被拒', bogus.ok, false);
  truthy('拒绝理由可读', bogus.error.message.includes('unknown MCP server'));
  const missing = await call(host, 'default', { enabled: true });
  check('缺服务器名被拒', missing.ok, false);
}

// ───────────────────────── 5. 默认文件损坏时不拒绝写入 ─────────────────────────
console.log('\n5. 默认文件损坏：退化为全关，但会话开关仍然可用');
{
  const home2 = mkdtempSync(join(tmpdir(), 'mcp-switch-default-broken-'));
  mkdirSync(join(home2, 'dsh-mcp-switch'), { recursive: true });
  writeFileSync(join(home2, 'dsh-mcp-switch', 'defaults.json'), '{ this is not json');
  process.env.DSH_HOME = home2;

  const host = makeHost();
  apply(host.ctx, CONFIG);
  const value = await waitReady(host);

  check('退化为全关', value.enabled, []);
  check('并如实上报读不出来', value.defaultReadable, false);
  const toggled = await call(host, 'toggle', { sessionId: 's1', server: 'fake', enabled: true });
  check('损坏的默认文件不阻塞会话开关', toggled.value.enabled, ['fake']);
  check('损坏时仍可改默认（写入目标是默认文件本身）', (await call(host, 'default', { server: 'fake', enabled: true })).ok, true);
  check('改完就恢复正常', (await state(host, 's2')).defaultReadable, true);

  rmSync(home2, { recursive: true, force: true });
}

rmSync(HOME, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED');
process.exit(failures === 0 ? 0 : 1);
