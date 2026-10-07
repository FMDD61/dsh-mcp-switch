/**
 * 实验用探针工具 —— 只在本地验证时挂载，不进 npm files。
 *
 * 用途：验证「挂进某个预设 → 只在该预设的会话里可见」这条链路。
 * 与 lib/index.js 分开，是为了让生产入口不含任何实验代码。
 */

export const name = 'dsh-mcp-switch-probe';

export const inject = ['tools'];

const LOOSE = { type: 'object', properties: {}, additionalProperties: true };

const output = {
  schema: LOOSE,
  render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
};

export function apply(ctx, config = {}) {
  const label = config.label ?? 'probe';

  ctx.effect(() => ctx.tools.register({
    name: 'probe_' + label,
    description: 'PRESET VISIBILITY PROBE: ' + label,
    parameters: LOOSE,
    output,
    async execute() {
      return { label, seen: true };
    },
  }), 'dsh-mcp-switch-probe.' + label);

  ctx.logger?.info?.('dsh-mcp-switch-probe mounted: ' + label);
}
