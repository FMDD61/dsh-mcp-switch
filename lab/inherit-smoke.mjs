/**
 * 子代理开关继承测试（含嵌套委派）。
 *
 *   node lab/inherit-smoke.mjs
 *
 * 背景（design.md §2.9）：子代理有**独立的 session id**，所以"按会话存开关"默认会让
 * 子代理全关 —— 父会话开了服务器，子代理里 mcp_call 仍被拒。委派因此静默丢能力。
 *
 * 规则：**自己有状态文件就用自己文件，否则沿 parentSession 上溯**，取其开关。
 *
 * 嵌套是重点：一次 tool 调用的 exec 只带**直接**父会话，所以三层以上必须靠
 * `agent/created` 收集的血缘表逐跳补全 —— 这里用真实事件形状验证那条链。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = mkdtempSync(join(tmpdir(), 'mcp-switch-inherit-'));
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
const handlers = new Map();
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
  on: (type, fn) => { handlers.set(type, fn); return () => handlers.delete(type); },
  // 假 sessions 服务：给"活跃但没被 agent/created 覆盖"的中间层提供持久 header。
  // 这是审查 S1 指出的第二个血缘来源。
  inject: (deps, cb) => {
    if (deps.includes('sessions')) {
      cb({ sessions: { get: (id) => (id === 'COLD-CHILD' ? { header: { id, parentSession: 'ROOT' } } : undefined) } });
    }
    return () => {};
  },
  emit: () => {},
  get: () => undefined,
  tools: { register: (def) => { registered.set(def.name, def); return () => registered.delete(def.name); } },
};

const api = apply(ctx, {
  servers: [
    { name: 'fake', transport: 'stdio', command: process.execPath, args: [SERVER] },
  ],
});

// 等连接就绪 —— connecting 相位下 mcp_call 会拒绝，那是另一条分支。
{
  const serversTool = registered.get('mcp_servers');
  const probe = { agent: { session: { header: { id: 'ROOT' } } }, signal: new AbortController().signal };
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    const listed = await serversTool.execute({}, probe);
    if (listed.servers[0]?.available === true) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('fake server never became ready');
}

console.log('1. 血缘边收集');
const created = handlers.get('agent/created');
truthy('挂了 agent/created 监听', typeof created === 'function');

// ROOT -> CHILD -> GRAND，中间层从不调用我们的工具。
created({ agent: { session: { header: { id: 'CHILD', parentSession: 'ROOT' } } } });
created({ agent: { session: { header: { id: 'GRAND', parentSession: 'CHILD' } } } });
created({ agent: { session: { header: { id: 'SIBLING', parentSession: 'ROOT' } } } });
check('根会话没有父', await api.switches.serversFor('ROOT'), []);

console.log('\n2. 逐层继承');
await api.switches.set('ROOT', 'fake', true);
check('根会话自己开着', await api.switches.serversFor('ROOT'), ['fake']);
check('一层子会话继承', await api.switches.serversFor({ id: 'CHILD', parentSession: 'ROOT' }), ['fake']);
check('两层孙会话也继承（嵌套）', await api.switches.serversFor({ id: 'GRAND', parentSession: 'CHILD' }), ['fake']);

const resolved = await api.switches.resolutionFor({ id: 'GRAND', parentSession: 'CHILD' });
check('来源指向根会话', resolved.source, 'ROOT');
truthy('标记为继承', resolved.inherited);

console.log('\n3. 中间层手动覆盖（用户可手动开关）');
await api.switches.set({ id: 'CHILD', parentSession: 'ROOT' }, 'fake', false);
check('覆盖后中间层自己为空', await api.switches.serversFor({ id: 'CHILD', parentSession: 'ROOT' }), []);
check('覆盖向下传播到孙会话', await api.switches.serversFor({ id: 'GRAND', parentSession: 'CHILD' }), []);
check('覆盖不反向影响根', await api.switches.serversFor('ROOT'), ['fake']);
check('兄弟分支不受影响', await api.switches.serversFor({ id: 'SIBLING', parentSession: 'ROOT' }), ['fake']);

console.log('\n4. 根变化只影响未被覆盖的分支');
// 审查 S1：中间层**没有**经过 agent/created（插件重载、或事件早于挂载的形状）。
// 这条走"活跃会话的持久 header"这条回退路径。
check('未经 agent/created 的中间层仍能上溯（S1 回归）', await api.switches.serversFor({ id: 'COLD-GRAND', parentSession: 'COLD-CHILD' }), ['fake']);

await api.switches.set('ROOT', 'fake', false);
check('未被覆盖的分支跟随根', await api.switches.serversFor({ id: 'SIBLING', parentSession: 'ROOT' }), []);
check('已覆盖的分支仍是自己的值', await api.switches.serversFor({ id: 'CHILD', parentSession: 'ROOT' }), []);

console.log('\n5. 边界：断链与环路都安全退化');
check('父会话未知时退化为空', await api.switches.serversFor({ id: 'ORPHAN', parentSession: 'DOES-NOT-EXIST' }), []);
// 人为造环：A 的父是 B，B 的父是 A。血缘表由事件填，这里直接喂成环。
created({ agent: { session: { header: { id: 'LOOP-A', parentSession: 'LOOP-B' } } } });
created({ agent: { session: { header: { id: 'LOOP-B', parentSession: 'LOOP-A' } } } });
check('环路不会转死，安全返回空', await api.switches.serversFor({ id: 'LOOP-A', parentSession: 'LOOP-B' }), []);

console.log('\n6. 工具侧也走同一条继承链（不是只有 serversFor）');
await api.switches.set('ROOT', 'fake', true);
// 第 3 节把 CHILD 覆盖成空了，这里把它改回来，让孙会话重新有东西可继承。
await api.switches.set({ id: 'CHILD', parentSession: 'ROOT' }, 'fake', true);
check('恢复后孙会话又可继承', await api.switches.serversFor({ id: 'GRAND', parentSession: 'CHILD' }), ['fake']);
const call = registered.get('mcp_call');
const execOf = (id, parent) => ({
  agent: { session: { header: parent === undefined ? { id } : { id, parentSession: parent } } },
  signal: new AbortController().signal,
});
const grandchildCall = await call.execute({ server: 'fake', tool: 'echo', arguments: { text: 'from grandchild' } }, execOf('GRAND', 'CHILD'));
check('孙会话能直接调用（继承生效）', grandchildCall.content, [{ type: 'text', text: 'echo: from grandchild' }]);
const orphan = await (async () => {
  try { await call.execute({ server: 'fake', tool: 'echo', arguments: { text: 'x' } }, execOf('ORPHAN2', 'NOPE')); return 'allowed'; }
  catch (error) { return error.message.includes('not enabled') ? 'refused' : 'other'; }
})();
check('无血缘的孤儿会话仍被拒', orphan, 'refused');

for (const d of [...disposers].reverse()) { try { await d(); } catch { /* 忽略 */ } }
delete process.env.DSH_HOME;
rmSync(HOME, { recursive: true, force: true });
console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exitCode = failures === 0 ? 0 : 1;
