/**
 * dsh-mcp-switch — 浏览器通道（服务端）。
 *
 * 给浏览器半包一条读状态、改开关的 HTTP 通道。协议我们自己定，两端都是我们的。
 *
 * ## 为什么不用 `ctx.connection.rpc.handle`
 *
 * 它是框架提供的"通用 RPC 通道"，但对第三方插件**不可用**（实测）：
 * 内部走 `owner.effect(() => owner.webServer.register(route))`，而 `owner = this.ctx`
 * 是 **connection 服务自己的 ctx**（inject 只有 `credentials`），被 cordis 的 inject
 * 守卫挡下 —— `cannot get property "webServer" without inject`。
 *
 * 三种规避都试过且都无效：插件级 inject、在 `ctx.inject(['webServer'], cb)` 里访问、
 * 照 connection 自己的写法。旁证：全仓没有任何包用 `rpc.handle`。
 *
 * ## 采用的路径
 *
 * 自己往 `webServer` 注册一个前缀路由，并**复用 connection 的围栏**：
 * `requestRejection(req)` 同时做 Host/Origin 检查与浏览器认证，与 `/api` 同源同强度。
 * 实测：curl 无凭据 → 401；真实浏览器同源 fetch → 200。
 *
 * `connection` 服务实例上**没有** `applyTrustChecks`（那在 `HostConnectionHandle` 类型上）；
 * 实际可用的是 `requestRejection` / `admit` / `authorizeIndex` / `authenticatedUrl`。
 */

/** 通道前缀。CHANNEL_PATTERN 允许 `[A-Za-z0-9._~-]`。 */
export const CHANNEL_PATH = '/mcp-switch';

/** 请求体上限：只传 sessionId 与开关意图，几 KB 足够。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 读完整请求体并解析 JSON。空体按 `{}` 处理。 */
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * 注册通道。
 *
 * @param ctx - 插件上下文（需能拿到 `connection`）
 * @param handlers.state - `(input) => Promise<object>`，读状态
 * @param handlers.toggle - `(input) => Promise<object>`，改开关
 * @param handlers.retry - `(input) => Promise<object>`，对一台失败的服务器重连一次
 * @param handlers.setDefault - `(input) => Promise<object>`，改「新会话默认」（端点名 `default`，
 *   但 `default` 是保留字，处理器键取 `setDefault`）
 * @param handlers.log - 日志出口
 * @returns 是否注册成功（拿不到 webServer 时为 false，不抛）
 */
export function registerChannel(ctx, handlers) {
  let registered = false;
  // 两个服务都要注入：webServer 用来注册路由，connection 提供围栏。
  // 少任何一个，访问时都会被 cordis 的 inject 守卫抛错 —— 而 web 服务器把
  // 处理器抛出的异常兜底成 **400 空响应**（`handle(req,res).catch(...)`），
  // 日志只进 logger.warn 不进 stdout，所以现象是"路由在但处理器不跑"（实测踩过）。
  ctx.inject(['webServer', 'connection'], (inner) => {
    inner.effect(() => {
      // **必须 return disposer**：`webServer.register` 返回移除该路由的函数，
      // 而重复注册同一个 `(kind, path)` 会抛（"route patterns are a composition-level contract"）。
      // 不 return 的话，HMR / 重新 apply 时旧路由不在 effect 清理里 →
      // 新注册撞车 → 通道静默消失（正是本文件顶注描述的那类现象）。
      const dispose = inner.webServer.register({
        kind: 'prefix',
        path: CHANNEL_PATH,
        handler: async (req, res) => {
          // **整段**包在 try 里。只包住围栏与解析是不够的：`sendJson` 自己也可能抛
          // （连接已断、响应已发），冒到框架就被兜底成**无信息的 400 空响应**，
          // 而日志只进 logger.warn 不进 stdout —— 现象是"路由在但处理器不跑"。
          // 围栏故障与"操作被拒"是两回事：前者是基础设施问题（500 + 明确 code），
          // 后者是预期结果（200 + ok:false，让 UI 拿到原因）。用阶段标记区分。
          let stage = 'fence';
          try {
            // 与 /api 同一道围栏：Host/Origin 检查 + 浏览器认证。
            const rejection = inner.connection.requestRejection(req);
            if (rejection !== undefined) {
              res.writeHead(rejection);
              res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
              return;
            }
            stage = 'dispatch';
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } });
              return;
            }
            const endpoint = new URL(req.url, 'http://localhost').pathname.slice(CHANNEL_PATH.length + 1);
            let input;
            try {
              input = await readJsonBody(req);
            } catch (error) {
              sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: String(error?.message ?? error) } });
              return;
            }
            if (endpoint === 'state') {
              sendJson(res, 200, { ok: true, value: await handlers.state(input) });
              return;
            }
            if (endpoint === 'toggle') {
              sendJson(res, 200, { ok: true, value: await handlers.toggle(input) });
              return;
            }
            if (endpoint === 'retry') {
              sendJson(res, 200, { ok: true, value: await handlers.retry(input) });
              return;
            }
            if (endpoint === 'default') {
              sendJson(res, 200, { ok: true, value: await handlers.setDefault(input) });
              return;
            }
            sendJson(res, 404, { ok: false, error: { code: 'unknown-endpoint', message: `unknown endpoint ${JSON.stringify(endpoint)}` } });
          } catch (error) {
            // 响应已经发出去时只销毁连接，不再尝试写第二次。
            if (res.headersSent === true) { try { res.destroy(); } catch { /* ignore */ } return; }
            const message = String(error?.message ?? error);
            try {
              if (stage === 'fence') {
                sendJson(res, 500, { ok: false, error: { code: 'fence-unavailable', message } });
              } else {
                // 操作失败（冻结、读不出来…）是**预期结果**，200 + ok:false，让 UI 拿到原因。
                sendJson(res, 200, { ok: false, error: { code: 'rejected', message } });
              }
            } catch {
              try { res.destroy(); } catch { /* ignore */ }
            }
          }
        },
      });
      registered = true;
      handlers.log?.(CHANNEL_PATH + ' channel registered');
      return dispose;
    }, 'dsh-mcp-switch.route');
  });
  return registered;
}
