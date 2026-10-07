/**
 * 会话开关持久化测试。
 *
 *   node lab/store-smoke.mjs
 *
 * 三部分：
 *   1. SessionStore 单元 —— 格式、版本、损坏文件、路径穿越、权限、**readable 语义**
 *   2. 通过 apply 的集成 —— 模拟 dsh 重启后恢复会话开关（最初的第 2 条要求）
 *   3. 审查驱动的回归 —— 并发 set 丢更新、读不出来时拒绝覆盖
 *
 * 集成部分靠 DSH_HOME 指向临时目录（resolveDshHome() 在 apply 时才解析），
 * 所以不需要为测试留任何配置后门。
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore, isSafeSessionId, STORE_VERSION } from '../lib/store.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)));
};
const truthy = (label, value) => check(label, Boolean(value), true);
const throwsWith = async (label, fn, needle) => {
  try { await fn(); check(label, 'did not throw', 'threw'); }
  catch (error) { check(label, error.message.includes(needle), true); }
};

// ───────────────────── 1. SessionStore 单元 ─────────────────────
console.log('1. SessionStore 单元');
{
  const home = mkdtempSync(join(tmpdir(), 'mcp-switch-store-'));
  const warnings = [];
  const store = new SessionStore({ home, warn: (m) => warnings.push(m) });

  check('新会话 -> 空集、可读、文件不存在', await store.load('s-new'), { servers: [], readable: true, exists: false });
  check('新会话不产生告警', warnings.length, 0);

  await store.save('s1', ['b', 'a']);
  const file = store.pathFor('s1');
  check('文件落在 sessions/ 下', file.endsWith(join('dsh-mcp-switch', 'sessions', 's1.json')), true);
  check('往返一致', await store.load('s1'), { servers: ['a', 'b'], readable: true, exists: true });

  const raw = JSON.parse(readFileSync(file, 'utf8'));
  check('带版本字段', raw.version, STORE_VERSION);
  check('记录 sessionId', raw.sessionId, 's1');
  check('记录时间戳', typeof raw.updatedAt, 'string');
  check('文件权限 0600', (statSync(file).mode & 0o777).toString(8), '600');
  check('目录权限 0700', (statSync(join(home, 'dsh-mcp-switch', 'sessions')).mode & 0o777).toString(8), '700');
  check('listStored', store.listStored(), ['s1']);

  // 版本不认识 -> 空集但 **readable:false**（不能当成"用户确实全关"）
  await store.save('s2', ['x']);
  const s2 = JSON.parse(readFileSync(store.pathFor('s2'), 'utf8'));
  s2.version = 99;
  writeFileSync(store.pathFor('s2'), JSON.stringify(s2));
  check('版本不认识 -> 空集 + 不可读（文件在）', await store.load('s2'), { servers: [], readable: false, exists: true });
  truthy('并记了告警', warnings.some((m) => m.includes('version')));

  writeFileSync(store.pathFor('s3'), '{ this is not json');
  check('损坏 JSON -> 空集 + 不可读（文件在）', await store.load('s3'), { servers: [], readable: false, exists: true });
  truthy('并记了告警', warnings.some((m) => m.includes('not valid JSON')));

  for (const bad of ['../evil', 'a/b', '', '..', '.hidden']) {
    check('拒绝不安全 id ' + JSON.stringify(bad), isSafeSessionId(bad), false);
  }
  check('穿越 id -> 不可读且不存在', await store.load('../evil'), { servers: [], readable: false, exists: false });
  await throwsWith('拒绝写入穿越 id', () => store.save('../evil', ['x']), 'unsafe session id');

  rmSync(home, { recursive: true, force: true });
}

// ───────────── 2 + 3. 集成：模拟重启 / 审查驱动的回归 ─────────────
console.log('\n2. 通过 apply 的集成（模拟 dsh 重启）');
{
  const home = mkdtempSync(join(tmpdir(), 'mcp-switch-home-'));
  process.env.DSH_HOME = home;

  const SERVER = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));
  const { apply } = await import('../lib/index.js');

  const makeCtx = () => {
    const registered = new Map();
    const disposers = [];
    const handlers = new Map();
    return {
      registered,
      disposers,
      handlers,
      ctx: {
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
        on: () => () => {},
        inject: () => () => {},
        emit: () => {},
        get: () => undefined,
        tools: { register: (def) => { registered.set(def.name, def); return () => registered.delete(def.name); } },
      },
    };
  };
  // 两台真服务器：并发 set 的回归需要两个**都存在**的目标。
  const servers = [
    { name: 'fake', transport: 'stdio', command: process.execPath, args: [SERVER] },
    { name: 'fake2', transport: 'stdio', command: process.execPath, args: [SERVER] },
    { name: 'unreachable', transport: 'stdio', command: '/nonexistent/bin', args: [] },
  ];
  const exec = (id) => ({ agent: { session: { header: { id } } }, signal: new AbortController().signal });

  const ready = async (registered) => {
    const tool = registered.get('mcp_servers');
    for (let i = 0; i < 40; i += 1) {
      const listed = await tool.execute({}, exec('S1'));
      if (listed.servers[0]?.available === true) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('fake server never became ready');
  };
  // cordis 是**反序 + 逐个 await** 执行 disposer（disposables.splice(0).reverse()），
  // 所以测试也照生产顺序来，否则"先断开再退订"从没被真正验过。
  const unmount = async (holder) => {
    for (const d of [...holder.disposers].reverse()) { try { await d(); } catch { /* 忽略 */ } }
  };

  const a = makeCtx();
  const api1 = apply(a.ctx, { servers });
  await ready(a.registered);
  check('起始为空（新会话默认全关）', await api1.switches.serversFor('S1'), []);
  check('DSH_HOME 被尊重', api1.store.pathFor('S1').startsWith(home), true);

  await api1.switches.set('S1', 'fake', true);
  check('开启后立即生效', await api1.switches.serversFor('S1'), ['fake']);
  truthy('状态文件已落盘', readFileSync(api1.store.pathFor('S1'), 'utf8').includes('"fake"'));

  // 审查 S2：并发 set 曾经静默丢更新（两个都返回成功，磁盘只剩后一个）
  const [ra, rb] = await Promise.all([
    api1.switches.set('S1', 'fake', true),
    api1.switches.set('S1', 'fake2', true),
  ]);
  check('并发 set 串行化：后者看到前者的结果', rb, ['fake', 'fake2']);
  check('前者的返回值只含当时已提交的', ra, ['fake']);
  check('内存里两个都在（没有丢更新）', await api1.switches.serversFor('S1'), ['fake', 'fake2']);

  truthy('磁盘里两个也都在', readFileSync(api1.store.pathFor('S1'), 'utf8').includes('fake2'));

  // 审查 T5：上面两次调用在同一微任务里发起，区分不出"真串行"与"读了同一基线"。
  // 这条把两次拆到不同 tick：第一次已经进入 await 之后才发第二次。
  await api1.switches.set('S1', 'fake2', false);
  const first = api1.switches.set('S1', 'fake', true);
  await new Promise((resolve) => setImmediate(resolve));
  const second = api1.switches.set('S1', 'fake2', true);
  await Promise.all([first, second]);
  check('跨 tick 并发也不丢更新', await api1.switches.serversFor('S1'), ['fake', 'fake2']);
  truthy('跨 tick 后磁盘也一致', readFileSync(api1.store.pathFor('S1'), 'utf8').includes('fake2'));
  await api1.switches.set('S1', 'fake2', false);
  await api1.switches.set('S1', 'fake2', false);
  check('未知服务器仍然被拒（冻结守卫）', await (async () => {
    try { await api1.switches.set('S1', 'ghost', true); return 'allowed'; }
    catch (error) { return error.message.includes('frozen') ? 'frozen' : 'other'; }
  })(), 'frozen');

  await unmount(a);

  // --- 模拟重启：全新 ctx、全新 apply，同一个 DSH_HOME ---
  const b = makeCtx();
  const api2 = apply(b.ctx, { servers });
  await ready(b.registered);
  check('重启后恢复 S1 的开关', await api2.switches.serversFor('S1'), ['fake']);
  check('新会话 S2 仍是全关', await api2.switches.serversFor('S2'), []);

  const call = b.registered.get('mcp_call');
  const result = await call.execute({ server: 'fake', tool: 'echo', arguments: { text: 'after restart' } }, exec('S1'));
  check('恢复后可直接调用，无需重新开启', result.content, [{ type: 'text', text: 'echo: after restart' }]);

  // 审查 M1：不可用的服务器必须先报"不可用"，而不是"让用户去开启它"——
  // 它的开关正因为 failed 被冻着，用户做不到（design §7.1 的"模型停不下来"场景）。
  const brokenCall = await (async () => {
    try { await call.execute({ server: 'unreachable', tool: 'x' }, exec('S1')); return ''; }
    catch (error) { return error.message; }
  })();
  truthy('不可用 -> 报 unavailable', brokenCall.includes('currently unavailable'));
  check('不可用 -> 不诱导用户去开启', brokenCall.includes('Ask the user to enable'), false);
  truthy('不可用 -> 明说不要重试', brokenCall.includes('Do not retry'));
  await throwsWith('S2 调用仍被拒', () => call.execute({ server: 'fake', tool: 'echo', arguments: { text: 'x' } }, exec('S2')), 'is not enabled in this session');

  // 审查 L2：状态文件读不出来时，set 必须拒绝，而不是用空集覆盖用户意图
  console.log('\n3. 审查驱动的回归');
  // 审查 L2：**从未成功读过**的会话，若状态文件读不出来，set 必须拒绝 ——
  // 否则会用空集整份覆盖磁盘上原有的用户意图。
  // （注意场景：已成功读入内存缓存的会话，缓存才是权威；这里测的是首读就失败。）
  writeFileSync(api2.store.pathFor('S3'), '{ corrupted');
  await throwsWith('首读失败时拒绝写入', () => api2.switches.set('S3', 'fake', true), 'could not be read');
  check('拒绝后磁盘未被覆盖', readFileSync(api2.store.pathFor('S3'), 'utf8'), '{ corrupted');
  check('读不出来的会话不进缓存（每次重试）', await api2.switches.serversFor('S3'), []);

  await api2.switches.set('S1', 'fake', false);
  check('关闭后生效', await api2.switches.serversFor('S1'), []);

  await unmount(b);
  delete process.env.DSH_HOME;
  rmSync(home, { recursive: true, force: true });
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exitCode = failures === 0 ? 0 : 1;
