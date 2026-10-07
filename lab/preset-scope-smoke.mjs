/**
 * 预设作用域：本插件的三个工具该在哪些预设里被摘掉。
 *
 *   node lab/preset-scope-smoke.mjs
 *
 * ## 为什么是这个机制，而不是「把插件行搬进预设」
 *
 * 用户实测报的 bug：**极简模式下三个 mcp 工具没有被摘除**。原因是启用时把插件行
 * 挂成了**全局**，而全局层的工具会被极简预设继承。
 *
 * 直觉上的修法是把插件行搬进目标预设（design §5 原本的处方）。但那是错的，实测：
 *
 *   · 预设里的行**每个预设各起一份实例** —— 挂进 standard + ptc 之后，
 *     一个 fake-mcp-server 变成两个子进程；
 *   · 两份实例都会去注册同一个 \`/mcp-switch\` web 路由（谁生效不确定）；
 *   · 两份实例各持一份会话开关内存缓存，互相看不见对方的写入。
 *
 * 本插件的架构前提是「连接随 dsh 本体起一份，会话只决定接入哪些服务器」，
 * 多份实例会把这个前提打掉。所以改成：**插件仍然只有一份**，只在被排除的预设的
 * agent 作用域里用 \`ctx.tools.restrict\` 摘掉这三个工具的可见性。
 *
 * 本套件测的就是后者的规则：什么时候摘、什么时候不摘、什么时候解除。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'mcp-switch-preset-'));
process.env.DSH_HOME = HOME;

const { apply } = await import('../lib/index.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)));
};
const truthy = (label, value) => check(label, Boolean(value), true);

const TOOL_NAMES = ['mcp_servers', 'mcp_detail', 'mcp_call'];

/** 记下所有 emit 出来的事件处理器。 */
function makeHost() {
  const handlers = new Map();
  const warnings = [];
  const registered = new Map();
  const ctx = {
    logger: { info: () => {}, warn: (m) => warnings.push(String(m)), error: (m) => warnings.push(String(m)) },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    emit: () => {},
    get: () => undefined,
    inject: () => () => {},
    tools: { register: (def) => { registered.set(def.name, def); return () => registered.delete(def.name); } },
  };
  const fire = (event, payload) => {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  };
  return { ctx, fire, warnings, registered };
}

/**
 * 造一个 agent。\`restrictCalls\` 记录它作用域里被施加的限制。
 * @param id - session id
 * @param preset - header.agentPreset
 * @param options.withTools - false 时不给作用域 tools 服务（模拟拿不到）
 */
function makeAgent(id, preset, options = {}) {
  const restrictCalls = [];
  const lifts = [];
  const agent = {
    session: { header: { id, agentPreset: preset } },
  };
  if (options.withTools !== false) {
    agent.ctx = {
      tools: {
        restrict: (filter) => {
          restrictCalls.push(filter);
          const lift = () => lifts.push('lifted');
          lifts.push(lift);
          return lift;
        },
      },
    };
  } else {
    agent.ctx = {};
  }
  return { agent, restrictCalls, lifts };
}

// ───────────────────────── 1. 默认规则 ─────────────────────────
console.log('1. 默认规则：minimal 摘掉，其余不动');
{
  const host = makeHost();
  apply(host.ctx, { servers: [] });

  const std = makeAgent('s-std', 'standard');
  host.fire('agent/created', { agent: std.agent });
  check('standard 不被摘', std.restrictCalls, []);

  const ptc = makeAgent('s-ptc', 'ptc');
  host.fire('agent/created', { agent: ptc.agent });
  check('ptc 不被摘', ptc.restrictCalls, []);

  const cordis = makeAgent('s-cordis', 'cordis');
  host.fire('agent/created', { agent: cordis.agent });
  check('cordis 不被摘', cordis.restrictCalls, []);

  const minimal = makeAgent('s-min', 'minimal');
  host.fire('agent/created', { agent: minimal.agent });
  check('minimal 被摘一次', minimal.restrictCalls.length, 1);
  check('摘的正是那三个工具', minimal.restrictCalls[0], { deny: TOOL_NAMES });

  // 没有预设的 agent（老会话 header 里没有这个字段）不该被当成 minimal。
  const unnamed = makeAgent('s-none', undefined);
  host.fire('agent/created', { agent: unnamed.agent });
  check('没有预设信息的 agent 不动它', unnamed.restrictCalls, []);

  check('没有产生警告', host.warnings, []);
}

// ───────────────────────── 2. 幂等 ─────────────────────────
console.log('\n2. 幂等：同一个 agent 反复触发只摘一次');
{
  const host = makeHost();
  apply(host.ctx, { servers: [] });
  const minimal = makeAgent('s-min', 'minimal');
  host.fire('agent/created', { agent: minimal.agent });
  host.fire('agent/created', { agent: minimal.agent });
  host.fire('agent-preset/selected', 's-min');
  check('仍然只摘一次', minimal.restrictCalls.length, 1);
}

// ───────────────────────── 3. 首轮之前改选预设 ─────────────────────────
console.log('\n3. 首轮之前改选预设：要跟着变，两个方向都要');
{
  const host = makeHost();
  apply(host.ctx, { servers: [] });

  // standard -> minimal：补摘
  const a = makeAgent('s-a', 'standard');
  host.fire('agent/created', { agent: a.agent });
  check('初始不摘', a.restrictCalls.length, 0);
  a.agent.session.header.agentPreset = 'minimal';
  host.fire('agent-preset/selected', 's-a');
  check('改选 minimal 后摘掉', a.restrictCalls.length, 1);

  // minimal -> standard：解除
  const b = makeAgent('s-b', 'minimal');
  host.fire('agent/created', { agent: b.agent });
  check('初始摘掉', b.restrictCalls.length, 1);
  b.agent.session.header.agentPreset = 'standard';
  host.fire('agent-preset/selected', 's-b');
  check('改选 standard 后解除一次', b.lifts.filter((x) => x === 'lifted').length, 1);

  // 改选事件里 session 不认识就安静跳过，不要抛
  host.fire('agent-preset/selected', 'never-seen');
  truthy('未知 session 的改选事件不抛', true);
}

// ───────────────────────── 4. agent 销毁 ─────────────────────────
console.log('\n4. agent 销毁：解除限制并清掉痕迹');
{
  const host = makeHost();
  apply(host.ctx, { servers: [] });
  const minimal = makeAgent('s-min', 'minimal');
  host.fire('agent/created', { agent: minimal.agent });
  check('先摘掉', minimal.restrictCalls.length, 1);

  host.fire('agent/disposed', { agent: minimal.agent });
  check('销毁时解除一次', minimal.lifts.filter((x) => x === 'lifted').length, 1);

  // 销毁之后再收到改选事件，不该再动手（痕迹已清）
  host.fire('agent-preset/selected', 's-min');
  check('销毁后不再响应改选', minimal.restrictCalls.length, 1);
}

// ───────────────────────── 5. 拿不到作用域 tools 时 ─────────────────────────
console.log('\n5. 拿不到作用域 tools：记警告，不要抛、不要拖垮挂载');
{
  const host = makeHost();
  apply(host.ctx, { servers: [] });
  const minimal = makeAgent('s-min', 'minimal', { withTools: false });
  host.fire('agent/created', { agent: minimal.agent });
  // 用 **error** 级：这里失败 = 极简模式会重新看到三个工具（就是用户报过的那个 bug 的形状），
  // 静默的 warn 会被淹掉。
  check('产生了可读的错误记录', host.warnings.length, 1);
  truthy('记录里点名了预设', host.warnings[0].includes('minimal'));
  truthy('并且明说隔离没生效', host.warnings[0].includes('preset isolation is NOT in effect'));
}

// ───────────────────────── 6. 可配置 ─────────────────────────
console.log('\n6. excludePresets 可配置');
{
  const host = makeHost();
  apply(host.ctx, { servers: [], excludePresets: ['ptc'] });

  const minimal = makeAgent('s-min', 'minimal');
  host.fire('agent/created', { agent: minimal.agent });
  check('配置覆盖后 minimal 不摘', minimal.restrictCalls, []);

  const ptc = makeAgent('s-ptc', 'ptc');
  host.fire('agent/created', { agent: ptc.agent });
  check('配置里点名的 ptc 被摘', ptc.restrictCalls.length, 1);

  // 空数组 = 一个都不排除（显式全开）
  const host2 = makeHost();
  apply(host2.ctx, { servers: [], excludePresets: [] });
  const m2 = makeAgent('s-min', 'minimal');
  host2.fire('agent/created', { agent: m2.agent });
  check('空数组表示一个都不排除', m2.restrictCalls, []);
}

rmSync(HOME, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED');
process.exit(failures === 0 ? 0 : 1);
