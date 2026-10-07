/**
 * 手动重连（design §2.8 的冻结出口、§2.2 的 A 方案）。
 *
 *   node lab/retry-smoke.mjs
 *
 * 存在的场景很窄：**远程 MCP 遇到网络问题，恢复后要能接回来**。
 * 本地 stdio 掉线不该靠它 —— 子进程死了重连也白搭，那是用户的事。
 *
 * 真杀子进程树，再重连，断言 registry 真的翻回 ready。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ServerRegistry } from '../lib/registry.js';
import { startConnection, normalizeServer } from '../lib/connection.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)));
};
const truthy = (label, value) => check(label, Boolean(value), true);

/** 找出 rootPid 的全部后代。 */
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

const SERVER = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));
const server = normalizeServer({ name: 'fake', transport: 'stdio', command: process.execPath, args: [SERVER] });
const reg = new ServerRegistry();
reg.declare(server);

const conn = startConnection({ logger: { info: () => {}, warn: () => {} } }, server, {
  onState: (change) => {
    if (change.phase === 'ready') reg.ready('fake', { toolCount: change.toolCount });
    else if (change.phase === 'failed') reg.failed('fake', { message: change.message, source: change.source });
    else if (change.phase === 'closed') reg.closed('fake');
    else if (change.phase === 'connecting') reg.connecting('fake');
  },
});

console.log('1. 先正常连上');
check('ready', (await conn.ready).ok, true);
check('registry ready', reg.get('fake').phase, 'ready');

console.log('\n2. 杀掉子进程 -> failed');
for (const pid of descendants(process.pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
await new Promise((r) => setTimeout(r, 1500));
check('registry failed', reg.get('fake').phase, 'failed');
check('错误来源是 transport', reg.get('fake').error?.source, 'transport');
check('失败时开关冻结', reg.isSwitchEditable('fake'), false);

console.log('\n3. 手动重连 -> 回到 ready（这就是"接回来"）');
const outcome = await conn.reconnect({ force: true });
check('重连成功', outcome.ok, true);
check('registry 回到 ready', reg.get('fake').phase, 'ready');
check('恢复后开关解冻', reg.isSwitchEditable('fake'), true);
truthy('工具目录也回来了', (await conn.tools()).length === 3);
const echoed = await conn.callTool('echo', { text: 'after retry' });
check('重连后能真的调用', echoed.isError === true ? 'isError' : echoed.content[0].text, 'echo: after retry');

console.log('\n4. 冷却：非 force 的重连被拒');
const cooled = await conn.reconnect();
check('冷却期内被拒', cooled.ok, false);
truthy('说明还剩多久', String(cooled.error?.message).includes('cooldown'));
const forced = await conn.reconnect({ force: true });
check('force 可以绕过冷却', forced.ok, true);

console.log('\n5. single-flight：并发重连复用同一个 promise');
const [a, b] = await Promise.all([conn.reconnect({ force: true }), conn.reconnect({ force: true })]);
check('两个都成功', [a.ok, b.ok], [true, true]);
check('仍然是 ready', reg.get('fake').phase, 'ready');

console.log('\n6. 关闭后不允许重连');
await conn.dispose();
check('dispose -> closed', reg.get('fake').phase, 'closed');
const afterClose = await conn.reconnect({ force: true });
check('closed 后重连被拒', afterClose.ok, false);
truthy('原因可读', String(afterClose.error?.message).includes('closed'));

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exitCode = failures === 0 ? 0 : 1;
