/**
 * 最终探针：GUI 数据通道的可行路径。
 *
 * 结论（实测）：
 *   ❌ ctx.connection.rpc.handle(channel, handler) —— 第三方不可用。
 *      它内部走 owner.webServer.register，而 owner 是 connection 服务自己的 ctx
 *      （inject 只有 credentials），被 cordis 的 inject 守卫挡下。
 *   ✅ 自己注册 web 路由 + 复用 connection.requestRejection() 做围栏与浏览器认证。
 */
import { appendFileSync } from 'node:fs';
const FILE = '/tmp/probe-status.log';
const mark = (m) => { try { appendFileSync(FILE, Date.now() + ' ' + m + '\n'); } catch { /* ignore */ } };

export const name = 'mcp-switch-probe-channel';
export const inject = ['connection'];

export function apply(ctx) {
  ctx.inject(['webServer'], (inner) => {
    inner.effect(() => inner.webServer.register({
      kind: 'prefix',
      path: '/mcp-switch-probe',
      handler: async (req, res) => {
        // 与 /api 同一道围栏：Host/Origin 检查 + 浏览器认证（进程令牌或 cookie）。
        const rejection = inner.connection.requestRejection(req);
        mark('HIT ' + req.method + ' ' + req.url + ' -> rejection=' + String(rejection));
        if (rejection !== undefined) {
          res.writeHead(rejection);
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let payload = null;
        try { payload = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, endpoint: new URL(req.url, 'http://x').pathname, echo: payload, ts: Date.now() }));
      },
    }), 'mcp-switch-probe.route');
    mark('route registered');
  });
}
