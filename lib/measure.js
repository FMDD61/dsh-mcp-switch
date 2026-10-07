/**
 * dsh-mcp-switch — 工具声明的体量。
 *
 * 只有一个用途：设置页那行「把新会话默认打开，每个新会话要多背多少字节」。
 *
 * ## 怎么算（这是唯一的定义，没有第二套口径）
 *
 *   declarationBytes = byteLength(JSON.stringify(tools.map(t => ({
 *     name: t.name,
 *     description: t.description ?? '',
 *     parameters: t.inputSchema ?? {},
 *   }))), 'utf8')
 *
 * 三个选择及其理由：
 *
 *  1. **形状取 `{name, description, parameters}`** —— 与 docs/measurements.md §2 里
 *     「A 全量 schema（name+description+parameters）」同一个口径，那个口径是从真实
 *     `tools/list` 逐字复算出来的。换一个形状就等于换一套单位，界面上的数就和文档里的
 *     29,109 B 对不上了。
 *  2. **不用原始工具对象** —— MCP 返回的对象还带 `title` / `annotations` / `icons`，
 *     那些不进请求的工具表。实测 context7：原始 `JSON.stringify(tools)` = 4,864 B，
 *     按上面的形状 = 4,588 B，276 B 是噪声。
 *  3. **按 UTF-8 计** —— 描述里有中文时 `String.length` 会少算。
 *
 * ## 校准证据（2026-10-06）
 *
 * 复算脚本 `lab/calibrate-bytes.mjs`，对真实 context7 服务器（2 个工具）：
 *
 *   本函数 **4,588 B** ｜ docs/measurements.md 记录的 **4,581 B**
 *
 * 差 7 B（0.15%），来源是 `@upstash/context7-mcp` 版本漂移（复算时 v4.1.1，
 * 记录当时不是）。**函数复现了文档口径**，这就是它的验收标准。
 *
 * ## 它是什么、不是什么
 *
 * 是**估算**：真实请求里的序列化形态可能差几个字节的空白。
 * 不是账单，不折算 token —— token 数跨模型、跨语种差异很大，把折算值写进界面等于
 * 用一个不成立的换算率冒充事实。界面只报字节。
 */

/**
 * 一批工具声明按上述口径的字节数。
 *
 * @param tools - MCP `tools/list` 返回的原始工具数组
 * @returns UTF-8 字节数；非法或空输入返回 0
 */
export function declarationBytes(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  const shaped = tools.map((tool) => ({
    name: typeof tool?.name === 'string' ? tool.name : '',
    description: typeof tool?.description === 'string' ? tool.description : '',
    parameters: tool?.inputSchema ?? {},
  }));
  return Buffer.byteLength(JSON.stringify(shaped), 'utf8');
}
