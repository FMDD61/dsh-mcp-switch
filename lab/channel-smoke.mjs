/**
 * 浏览器通道的单元测试。
 *
 *   node lab/channel-smoke.mjs
 *
 * 审查 T2 指出：通道此前**零自动化断言** —— "无凭据 401" 这条最关键的验收
 * 只靠手工 curl + 浏览器验证过，没有可回归的测试。这份补上。
 *
 * 用假的 webServer / connection / req / res，不需要真宿主。
 */

import { registerChannel, CHANNEL_PATH } from '../lib/channel.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)));
};
const truthy = (label, value) => check(label, Boolean(value), true);

function makeReq(options = {}) {
  const method = options.method === undefined ? 'POST' : options.method;
  const url = options.url === undefined ? CHANNEL_PATH + '/state' : options.url;
  const raw = options.raw === undefined ? JSON.stringify(options.body === undefined ? {} : options.body) : options.raw;
  const req = { method, url };
  req[Symbol.asyncIterator] = async function* () {
    if (raw !== null) yield Buffer.from(raw, 'utf8');
  };
  return req;
}

function makeRes() {
  const state = { status: undefined, body: undefined, headersSent: false, destroyed: false };
  return {
    state,
    writeHead(status) { state.status = status; state.headersSent = true; },
    end(body) { state.body = body; },
    destroy() { state.destroyed = true; },
  };
}

/** 造一个假 ctx：捕获路由与 effect 的返回值。 */
function makeHarness(options = {}) {
  let route;
  let effectResult;
  let injectDeps;
  const inner = {
    // 注册路由的 effect 在 inner 上（M1 改版后的结构），要捕获它的返回值。
    effect(fn) { effectResult = fn(); return () => {}; },
    webServer: {
      register(candidate) { route = candidate; return () => { route = undefined; }; },
    },
    connection: { requestRejection: () => options.rejection },
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => { effectResult = fn(); return effectResult; },
    on: () => () => {},
    emit: () => {},
    get: () => undefined,
    tools: { register: () => () => {} },
    inject: (deps, callback) => { injectDeps = deps; callback(inner); return () => {}; },
  };
  const registered = registerChannel(ctx, options.handlers === undefined ? {
    state: async (input) => ({ echo: input, servers: [] }),
    toggle: async (input) => {
      if (input && input.server === 'frozen') throw new Error('server "frozen" switch is frozen while phase=failed');
      return { enabled: [input.server] };
    },
    retry: async (input) => {
      if (input && input.server === 'broken') throw new Error('MCP server "broken" has no connection to retry (unknown name or invalid configuration)');
      return { phase: 'ready' };
    },
  } : options.handlers);
  return { registered, route: () => route, effectResult: () => effectResult, injectDeps: () => injectDeps };
}

const call = async (route, req) => {
  const res = makeRes();
  await route.handler(req, res);
  return res.state;
};
const parse = (state) => (state.body === undefined ? undefined : JSON.parse(state.body));

console.log('1. 注册与注入');
{
  const h = makeHarness();
  truthy('registerChannel 返回 true', h.registered);
  truthy('路由已注册', h.route() !== undefined);
  check('路径', h.route().path, CHANNEL_PATH);
  check('kind', h.route().kind, 'prefix');
  check('注入了两个服务', h.injectDeps(), ['webServer', 'connection']);
  // 审查 M1：不 return disposer 的话 HMR 时旧路由不注销，重注册会撞车。
  truthy('effect 拿到了 disposer（M1 回归）', typeof h.effectResult() === 'function');
}

console.log('\n2. 围栏（T2 的核心）');
for (const code of [401, 403]) {
  const h = makeHarness({ rejection: code });
  const state = await call(h.route(), makeReq({ body: { sessionId: 'S1' } }));
  check('拒绝码 ' + code + ' 透传', state.status, code);
  check('拒绝时不回 JSON', state.body, code === 401 ? 'unauthorized' : 'forbidden');
}
{
  const h = makeHarness({ rejection: undefined });
  const state = await call(h.route(), makeReq({ body: { sessionId: 'S1' } }));
  check('围栏放行 -> 200', state.status, 200);
}

console.log('\n3. 方法与端点');
{
  const h = makeHarness();
  check('非 POST -> 405', (await call(h.route(), makeReq({ method: 'GET' }))).status, 405);
  check('未知端点 -> 404', (await call(h.route(), makeReq({ url: CHANNEL_PATH + '/nope' }))).status, 404);
  check('坏 JSON -> 400', (await call(h.route(), makeReq({ raw: '{ not json' }))).status, 400);
}

console.log('\n4. 正常路径');
{
  const h = makeHarness();
  const state = await call(h.route(), makeReq({ body: { sessionId: 'S1' } }));
  check('state 回包', parse(state), { ok: true, value: { echo: { sessionId: 'S1' }, servers: [] } });
  const toggled = await call(h.route(), makeReq({ url: CHANNEL_PATH + '/toggle', body: { sessionId: 'S1', server: 'fake' } }));
  check('toggle 回包', parse(toggled), { ok: true, value: { enabled: ['fake'] } });
}

console.log('\n5. 冻结：操作失败走 200 + ok:false（不是 500）');
{
  const h = makeHarness();
  const ok = await call(h.route(), makeReq({ url: CHANNEL_PATH + '/retry', body: { sessionId: 'S1', server: 'fake' } }));
  check('重连成功回 200', ok.status, 200);
  check('带上新相位', parse(ok).value, { phase: 'ready' });
  const bad = await call(h.route(), makeReq({ url: CHANNEL_PATH + '/retry', body: { sessionId: 'S1', server: 'broken' } }));
  check('配置错 -> 仍是 200 + ok:false', bad.status, 200);
  truthy('说明没有可重连的连接', parse(bad).error.message.includes('no connection to retry'));

  const state = await call(h.route(), makeReq({ url: CHANNEL_PATH + '/toggle', body: { sessionId: 'S1', server: 'frozen' } }));
  check('状态码仍是 200', state.status, 200);
  const parsed = parse(state);
  check('ok=false', parsed.ok, false);
  truthy('带出冻结原因', parsed.error.message.includes('frozen while phase=failed'));
}

console.log('\n6. handler 抛错不冒到框架（审查 L6）');
{
  const h = makeHarness({
    handlers: {
      state: async () => { throw new Error('boom from state handler'); },
      toggle: async () => ({ enabled: [] }),
    },
  });
  const state = await call(h.route(), makeReq());
  check('抛错也回 200 + ok:false', state.status, 200);
  truthy('错误可读', parse(state).error.message.includes('boom from state handler'));
}

console.log('\n7. 围栏自身抛错 -> 500 且带原因');
{
  const h = makeHarness({ rejection: undefined });
  const inner = { webServer: { register: (r) => { h.routeHolder = r; return () => {}; } }, connection: { requestRejection: () => { throw new Error('fence exploded'); } } };
  // 重新造一份，让 requestRejection 抛
  let route;
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => fn(), on: () => () => {}, emit: () => {}, get: () => undefined,
    tools: { register: () => () => {} },
    inject: (deps, cb) => { cb({ effect: (fn) => { fn(); return () => {}; }, webServer: { register: (r) => { route = r; return () => {}; } }, connection: { requestRejection: () => { throw new Error('fence exploded'); } } }); return () => {}; },
  };
  registerChannel(ctx, { state: async () => ({}), toggle: async () => ({}) });
  const state = await call({ handler: route.handler }, makeReq());
  check('围栏抛错 -> 500', state.status, 500);
  truthy('原因可读', String(state.body).includes('fence exploded'));
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exitCode = failures === 0 ? 0 : 1;
