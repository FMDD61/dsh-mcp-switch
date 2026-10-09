/**
 * config.defaults —— 部署声明的**新会话默认**。
 *
 *   node lab/defaults-config-smoke.mjs
 *
 * 存在的理由：headless / CI 这类形态**没有设置页**，而「哪些服务器接入会话」的唯一来源就是
 * 新会话默认。没有这一项，那些形态里没有任何办法声明该意图（2026-10-08 实测：headless 里
 * mcp_call 只能回「not enabled in this session」）。
 *
 * 语义边界（每条都有断言）：
 *   - 声明写了就以它为准，**默认文件被忽略**，并在挂载时告警一次
 *   - 声明没写 → 仍然读默认文件（今天的行为一行没变）
 *   - 会话**自己**的状态文件永远优先于两者（声明只是「默认」这一层的来源）
 *   - 非法声明（不是数组 / 项不是非空字符串）→ 记 warn 后按没声明处理，不拖垮挂载
 *   - 点名了没配置的服务器 → 不拒绝，但吭声
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const HOME = mkdtempSync(join(tmpdir(), 'mcp-switch-cfgdefaults-'));
process.env.DSH_HOME = HOME;

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
const DEFAULTS_DIR = join(HOME, 'dsh-mcp-switch');
const DEFAULTS_FILE = join(DEFAULTS_DIR, 'defaults.json');

/** 直接写一份「设置页写的」默认文件（绕开 store，模拟另一个进程写下的状态）。 */
const writeStoreDefaults = (servers) => {
  mkdirSync(DEFAULTS_DIR, { recursive: true });
  writeFileSync(DEFAULTS_FILE, JSON.stringify({ version: storeMod.DEFAULTS_VERSION, servers }, null, 2));
};
const removeStoreDefaults = () => rmSync(DEFAULTS_FILE, { force: true });

function makeHost() {
  const registered = new Map();
  const warnings = [];
  const disposers = [];
  let route;
  const inner = {
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
    webServer: { register: (r) => { route = r; return () => { route = undefined; }; } },
    connection: { requestRejection: () => undefined },
  };
  const ctx = {
    logger: {
      info: () => {},
      warn: (message) => warnings.push(String(message)),
      error: (message) => warnings.push(String(message)),
    },
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
  return { ctx, registered, warnings, route: () => route, dispose: async () => { for (const d of disposers.reverse()) await d(); } };
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
const execFor = (sessionId) => ({ agent: { session: { header: { id: sessionId } } } });

const SERVERS = [
  { name: 'fake', transport: 'stdio', command: process.execPath, args: [SERVER] },
  { name: 'half', transport: 'stdio' },
];

console.log('1. 声明生效：文件被忽略并告警一次');
writeStoreDefaults(['half']);
{
  const host = makeHost();
  apply(host.ctx, { servers: SERVERS, defaults: ['fake'] });
  const value = await state(host, 'fresh-1');
  check('新会话跟随声明', value.enabled, ['fake']);
  check('来源是 config', value.defaultSource, 'config');
  check('生效默认就是声明', value.defaults, ['fake']);
  check('文件那份仍然读出来给界面用', value.storeDefaults, ['half']);
  truthy('挂载时告警了「设置页写了也不生效」', host.warnings.some((m) => m.includes('the Settings page writes a value that will not take effect')));
  await host.dispose();
}

console.log('2. mcp_servers 暴露来源');
{
  const host = makeHost();
  apply(host.ctx, { servers: SERVERS, defaults: ['fake'] });
  const inventory = await host.registered.get('mcp_servers').execute({}, execFor('s2'));
  check('defaults', inventory.defaults, ['fake']);
  check('defaultsSource', inventory.defaultsSource, 'config');
  check('defaultsOverridden（文件在，但说了不算）', inventory.defaultsOverridden, true);
  // 关键断言：没有状态文件的新会话**直接生效** —— 这正是 headless / CI 要的行为
  // （声明一次，此后每次 run 都带着这些服务器起步）。
  check('新会话直接启用声明里的服务器', inventory.enabledInThisSession, ['fake']);
  await host.dispose();
}

console.log('3. 没写声明：跟随默认文件');
{
  const host = makeHost();
  apply(host.ctx, { servers: SERVERS });
  const value = await state(host, 'fresh-3');
  check('跟随文件', value.enabled, ['half']);
  check('来源是 store', value.defaultSource, 'store');
  await host.dispose();
}
console.log('4. 声明与文件都没有：none + 全关');
removeStoreDefaults();
{
  const host = makeHost();
  apply(host.ctx, { servers: SERVERS });
  const value = await state(host, 'fresh-4');
  check('全关', value.enabled, []);
  check('来源是 none', value.defaultSource, 'none');
  await host.dispose();
}

console.log('5. 非法声明：warn 后按没声明处理');
{
  const host = makeHost();
  apply(host.ctx, { servers: SERVERS, defaults: 'fake' });
  const inventory = await host.registered.get('mcp_servers').execute({}, execFor('s5'));
  check('不是数组 -> 来源 none', inventory.defaultsSource, 'none');
  check('默认退化为空', inventory.defaults, []);
  truthy('告警可读', host.warnings.some((m) => m.includes('config.defaults must be an array of server names')));
  await host.dispose();
}
{
  const host = makeHost();
  apply(host.ctx, { servers: SERVERS, defaults: ['fake', 'fake', 42, ''] });
  const inventory = await host.registered.get('mcp_servers').execute({}, execFor('s5b'));
  check('坏项丢掉、好项留下并去重', inventory.defaults, ['fake']);
  truthy('坏项告警', host.warnings.some((m) => m.includes('must be non-empty strings')));
  await host.dispose();
}

console.log('6. 点名未配置的服务器：不拒绝，但吭声');
{
  const host = makeHost();
  apply(host.ctx, { servers: SERVERS, defaults: ['ghost'] });
  const inventory = await host.registered.get('mcp_servers').execute({}, execFor('s6'));
  check('仍然如实上报', inventory.defaults, ['ghost']);
  check('来源仍是 config', inventory.defaultsSource, 'config');
  truthy('告警点名了这台', host.warnings.some((m) => m.includes('"ghost"') && m.includes('not a configured server')));
  await host.dispose();
}

console.log('7. 会话自己的状态优先于声明');
{
  const host = makeHost();
  apply(host.ctx, { servers: SERVERS, defaults: ['fake'] });
  await call(host, 'toggle', { sessionId: 'own-1', server: 'fake', enabled: false });
  const value = await state(host, 'own-1');
  check('会话自己关掉后为空', value.enabled, []);
  check('不再标记来自默认', value.fromDefault, false);
  const fresh = await state(host, 'fresh-7');
  check('别的会话仍跟随声明', fresh.enabled, ['fake']);
  check('状态文件确实落盘', JSON.parse(readFileSync(join(DEFAULTS_DIR, 'sessions', 'own-1.json'), 'utf8')).servers, []);
  await host.dispose();
}

rmSync(HOME, { recursive: true, force: true });
console.log('');
if (failures === 0) console.log('ALL PASS');
else { console.log(failures + ' FAILED'); process.exitCode = 1; }
