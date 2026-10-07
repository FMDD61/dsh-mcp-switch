/**
 * 硬约束 1 的验收：**工具表在会话内逐字节不变**。
 *
 *   node lab/invariant-smoke.mjs
 *
 * 这是整个设计的第一前提（前缀缓存永不失效），而审查指出 lab 里此前**零覆盖**。
 * 这里把它变成断言：无论开关怎么变、连接态怎么变、调用发生过多少次，
 * 模型看到的工具声明必须完全一致。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = mkdtempSync(join(tmpdir(), 'mcp-switch-invariant-'));
process.env.DSH_HOME = HOME;

const { apply } = await import('../lib/index.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.log((ok ? '' : '  FAIL ') + label);
    if (!ok) console.log('         got  ' + JSON.stringify(actual) + '\n         want ' + JSON.stringify(expected));
  } else {
    console.log('  ok   ' + label);
  }
};

const SERVER = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));

function makeCtx() {
  const registered = new Map();
  const disposers = [];
  return {
    registered,
    disposers,
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
}

/** 模型实际看到的东西：名字 + description + parameters，逐字节。 */
const declarations = (registered) => [...registered.values()]
  .map((def) => ({ name: def.name, description: def.description, parameters: def.parameters }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

const servers = [
  { name: 'fake', transport: 'stdio', command: process.execPath, args: [SERVER] },
  { name: 'broken', transport: 'stdio' },                                              // 配置非法 -> failed
  { name: 'unreachable', transport: 'stdio', command: '/nonexistent/bin', args: [] },  // 连不上 -> failed
];

const a = makeCtx();
const api = apply(a.ctx, { servers });
const baseline = declarations(a.registered);

console.log('1. 基线');
check('恰好三个工具', baseline.map((d) => d.name), ['mcp_call', 'mcp_detail', 'mcp_servers']);
const baselineText = JSON.stringify(baseline);
check('声明里不含任何服务器名', baselineText.includes('fake') || baselineText.includes('unreachable'), false);

const exec = (id) => ({ agent: { session: { header: { id } } }, signal: new AbortController().signal });

console.log('\n2. 连接态变化（含两台失败）不影响声明');
const serversTool = a.registered.get('mcp_servers');
let listed;
for (let i = 0; i < 40; i += 1) {
  listed = await serversTool.execute({}, exec('S1'));
  if (listed.servers.find((s) => s.name === 'fake')?.available === true) break;
  await new Promise((r) => setTimeout(r, 250));
}
check('确实有一台连上了', listed.servers.find((s) => s.name === 'fake').phase, 'ready');
check('确实有两台失败', listed.unavailable.sort(), ['broken', 'unreachable']);
check('连接期过后声明不变', declarations(a.registered), baseline);

console.log('\n3. 开关变化不影响声明');
await api.switches.set('S1', 'fake', true);
check('开启后声明不变', declarations(a.registered), baseline);
await api.switches.set('S2', 'fake', true);
check('另一个会话开启后声明不变', declarations(a.registered), baseline);
await api.switches.set('S1', 'fake', false);
check('关闭后声明不变', declarations(a.registered), baseline);

console.log('\n4. 真实调用之后仍不变');
await api.switches.set('S1', 'fake', true);
const called = await a.registered.get('mcp_call').execute({ server: 'fake', tool: 'echo', arguments: { text: 'x' } }, exec('S1'));
check('调用确实成功了', called.content, [{ type: 'text', text: 'echo: x' }]);
check('调用后声明不变', declarations(a.registered), baseline);

console.log('\n5. 第二个实例逐字节相同');
const b = makeCtx();
apply(b.ctx, { servers });
check('与第一个实例的声明完全一致', declarations(b.registered), baseline);

// 必须卸载：否则 MCP 子进程会吊住事件循环，脚本永不退出。
// 照生产顺序（cordis 是反序 + 逐个 await）。
for (const holder of [b, a]) {
  for (const dispose of [...holder.disposers].reverse()) {
    try { await dispose(); } catch { /* 忽略 */ }
  }
}

delete process.env.DSH_HOME;
rmSync(HOME, { recursive: true, force: true });
console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exitCode = failures === 0 ? 0 : 1;
