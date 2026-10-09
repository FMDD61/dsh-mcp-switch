# 支撑数据

全部数字来自 2026-10-01 至 2026-10-04 在一台远程实验机（Debian 13 原生，
dsh 0.2.0-rc.2，provider = commandcode-ai 直连）的实测。
原始会话记录保存在本地（未随包发布）。

## 费率常量（本机网关实测）

| 常量 | 值 | 来源 |
|---|---|---|
| 冷请求 schema 字节费率 | **0.261 tok/B** | (13,461−5,434) / 30,812 |
| 携带（缓存）费率 | **0.1995 tok/B** | 13,568 / 67,997 |

**关键读数**：同一份 67,997 字节的提示词，冷请求 13,461 tok、热请求（13,568 cacheRead）——
两者几乎相同。**`cacheReadTokens` 被计入 `totalTokens`，在 total 里没有折扣。**
所以真正的问题不是"首次展示 schema 要多少钱"，而是"**每轮都要重发它**"。

注意：早期一度把热请求读成 0.02 tok/B，那是把 `cacheReadTokens` 误当成不计费量导致的，已更正。

## 一、原生 MCP 的成本（同机同 profile 对照）

| 组 | 配置 | 工具数 | schema 字节 | inputTokens | cacheRead |
|---|---|---|---|---|---|
| A0 | headless，无 MCP | 24 | 18,491 | **5,434** | — |
| A1 | headless，context7 + chrome-devtools 原生注册 | 59 | 49,303 | **13,461** | 384 |
| A2 | 同 A1 的第二次请求 | 59 | 49,303 | **289** | **13,568** |

A1 − A0 = **8,027 tok**，对应 schema 差 30,812 字节。

## 二、四种表示方案的字节与 token

（真实 `tools/list` 逐字复算；两台服务器：context7 2 工具、chrome-devtools 30 工具）

| 方案 | context7 | chrome-devtools | 合计 | tok/轮 | 20 轮 |
|---|---|---|---|---|---|
| **A 全量 schema** | 4,581 B | 24,528 B | **29,109 B** | **5,807** | **117,935** |
| **B 仅工具名** | 28 B | 389 B | **417 B** | **83** | **1,689** |
| C 名 + 60 字描述 | 148 B | 2,017 B | 2,165 B | 432 | 8,771 |
| D 纯中间层（4 个代理工具） | — | — | 2,613 B | 521 | 10,587 |

**B 相对 A 省 98.6%；相对 D 省 84%。**

### 中间层工具自身的字节（实测请求头）

```
ws_mcp_call     775 B
ws_mcp_list     649 B
ws_mcp_detail   601 B
ws_mcp_search   588 B
             ─────────
  合计        2,613 B   （wingsky 的四个工具）

read_mcp_resource            353 B
list_mcp_resource_templates  343 B
list_mcp_resources           317 B
                          ─────────
  合计                       1,013 B   （官方 dsh-mcp-resources 的三个工具）
```

## 三、单工具 detail 的真实大小（46 个工具 × 3 台服务器）

按 wingsky `renderDetailOutput` 逐字复算（`Server/Tool/Description/Input schema` + 2 空格缩进展开）。

| 统计量 | 字符 | tok |
|---|---|---|
| 最小 | 242 | **48** |
| 中位 | 842 | **168** |
| 均值 | 970 | **194** |
| p90 | 2,052 | **409** |
| 最大 | 2,959 | **590** |

最贵的五个：

| 工具 | 字符 | tok | 描述 | schema |
|---|---|---|---|---|
| context7/resolve-library-id | 2,959 | 590 | 2,006 | 883 |
| chrome-devtools/list_console_messages | 2,052 | 409 | 72 | **1,900** |
| chrome-devtools/emulate | 2,046 | 408 | 45 | **1,935** |
| context7/query-docs | 1,780 | 355 | 429 | 1,289 |
| chrome-devtools/list_network_requests | 1,708 | 341 | 77 | **1,551** |

注意后三个：**描述只有 45–77 字符，贵全在 schema 上**——"复杂工具"的复杂度来自参数本身。

> 早期一度写过"一次 detail 约 1,000 tok"，那是把**两个工具合计 4,739 字符**当成一个工具的量，
> 高估约 5 倍。以本表为准。

## 四、六台 MCP 服务器的 server 级字段

| 服务器 | native B | tok/轮 | serverInfo 键 | serverInfo.description | instructions | tools | resources | prompts |
|---|---|---|---|---|---|---|---|---|
| **context7** | 4,581 | 914 | name, version, websiteUrl, **description**, icons | **90 ch** | **632 ch (126 tok)** | 2 | 0 | 0 |
| chrome-devtools | 24,528 | 4,893 | name, title, version | — | **0** | 30 | ERR | ERR |
| filesystem | 7,958 | 1,588 | name, version | — | **0** | 14 | ERR | ERR |
| sequential-thinking | 4,033 | 805 | name, version | — | **0** | 1 | ERR | ERR |
| memory | 4,141 | 826 | name, version | — | **0** | 9 | 1 | ERR |

（`ERR` = JSON-RPC -32601 method not found。）

**六台里只有 context7 一台同时提供 server 描述与 instructions。**
`serverInfo.description` 几乎没人填（6 台里 1 台）——**不可依赖**。
`resources` / `prompts` 也不可依赖：4 台直接报 -32601。

## 五、检索次数的预算（不是次数，是预算）

每命中成本（按 `formatSearchHit` = `server/tool: <完整 description>`）：

| 服务器 | 1 命中 | 3 命中 | 5 命中 | 10 命中（上限） |
|---|---|---|---|---|
| context7 | 1,244 ch / 248 tok | 3,732 ch / 745 tok | 6,220 ch / 1,241 tok | 12,440 ch / 2,482 tok |
| chrome-devtools | 142 ch / 28 tok | 426 ch / 85 tok | 710 ch / 142 tok | 1,420 ch / 283 tok |

**每命中成本差 8.8×**，差异全部来自 description 长度。

`ws_mcp_search` 的 `limit` 上限是 **10 且无分页**——30 个工具的服务器需要多次窄查询才能盘点完。

| 服务器 | 每轮省 | 20 轮预算 | 可承受检索次数（3 命中/次） |
|---|---|---|---|
| context7（4.6 KB 原生） | 393 tok | 7,852 tok | **10.5 次** |
| chrome-devtools（24.5 KB 原生） | 4,372 tok | 87,441 tok | **1,029 次** |

**结论：只要原生 schema 超过约 9.4 KB，检索次数在现实范围内不可能把收益吃掉。**

盈亏平衡点（收敛值）：**原生 schema 约 9.4 KB**。低于它，中间层反而更贵。

## 六、前缀稳定性与缓存轨迹

从 314 个本机会话里统计「工具名列表在会话内是否变化」：

| | 会话数 |
|---|---|
| 有 ≥2 次请求 | 100 |
| 工具名列表**全程恒定** | 59 |
| 工具名列表**中途变化** | **41（41%）** |

那 41 个全部是同一类：中途多了一个 `dev_reset_experience`。
**即：一次增删 = 其后所有按字母序的工具整体后移 = 前缀缓存从那一位起全废。**

### 缓存轨迹（真实本地会话，逐轮）

```
turn |  input | cacheRead |  total | cr%
   1 |   2931 |     19328 |  27136 | 71%
   2 |   1632 |     22144 |  24145 | 92%
   5 |   2178 |     30592 |  33143 | 92%
  10 |   1235 |     49280 |  50853 | 97%
  14 |   3719 |     55168 |  59306 | 93%
```

缓存机制有效（命中率从 71% 升到 97%），**但 cacheRead 仍计入 total，单价几乎不打折**。

## 七、PTC 模式实测

### 7.1 生成的 SDK 声明（system prompt 原文）

```typescript
  /** Invoke one tool on the chrome-devtools MCP server by its bare name. */
  chrome_call: {
    /** Bare remote tool name, without the mcp__chrome__ prefix. */
    tool: string;
    arguments?: Record<string, JsonValue>;
  } & Record<string, JsonValue>;
```

- 声明为空 schema 的参数在 TS 侧落成 **`Record<string, JsonValue>`**，可用。
- **注意它变成了可选（`?`）**。
- 工具表：`tools=1`（只有 `run_code`），`mcpNames=0`。

### 7.2 错误投递语义（三个确定性工具的实验）

| 调用 | 抛还是返回 | 程序内收到 | `run_code` 的 `isError` |
|---|---|---|---|
| 恒成功 | 返回 | `{ ok: true }` | `false` |
| 恒抛 `Error` | **抛**（rejected promise） | `ToolCallError { name, message, toolName }` | `false`（程序 catch 住了） |
| 恒返回 `{ok:false}` | 返回 | `{ ok: false, error }` | `false` |
| 恒抛，**未捕获** | 抛到顶层 | `Error: code run failed (exception): ToolCallError: <message>` **+ 11 行堆栈** | **`true`** |

## 八、四臂对照实验（工具名无 description、无 schema）

| 臂 | mcp_detail | 报错内联 | 首次调用参数 | 结果 | detail 调用 | blind 调用 | reasoning 字符 | totalTokens | 耗时 |
|---|---|---|---|---|---|---|---|---|---|
| A | 有 | 无 | `{query:...}` | 校验失败→纠正 | 2（**均在失败后**） | 4 | 1,628 | 10,632 | 39s |
| B | 无 | 无 | `{query:...}` | 校验失败→纠正 | 0 | 6 | 1,224 | 10,208 | 39s |
| C | 无 | 有 | `{query:...}` | 校验失败→纠正 | 0 | 7 | 2,088 | 11,285 | 45s |
| D | 有 | 有 | `{query:...}` | 校验失败→纠正 | 2（均在失败后） | 4 | 688 | 10,146 | 32s |

- **四臂全部盲调，没有一次先取 detail。**
- **四臂全部只错一次就纠正**，包括既无 detail 也无内联的 B 臂。
- **`results carrying inlined schema = 0`**（内联分支从未触发）。

## 九、提示词是支配变量（最强的单条对照）

同一台坏环境（没有 Chrome）、同一组工具，只换提示词：

| 路径 | 工具面 | 提示词 | 耗时 | reasoning 字符 | totalTokens |
|---|---|---|---|---|---|
| 原生 | 57（**30 个 mcp 名带完整 schema**） | **许可型** | **20s** | **142** | 12,857 |
| 原生 | 同上 | **强制型** | **317s** | **56,258** | **68,190** |
| 空壳 | 27（2 个 mcp 名无 schema） | 强制型 | 294s / >420s | 53,309 / 75,364 | 51,132 / 86,544 |
| PTC + 空壳 | 1（只有 `run_code`） | 许可型 | **15s** | **251** | **8,306** |

**耗时差 15.9×，reasoning 差 396×。**

- 同一条原生路径，只换提示词 ⇒ 15.9× 差异。
- 同一个强制提示词，原生路径也照样打转（56,258 字符 vs 空壳 53,309–75,364）。

> **提示词是支配变量，工具面形态是次要变量。**

### chrome-devtools-mcp 在没装 Chrome 时的原生报错

```json
{ "content": [ { "type": "text",
    "text": "Could not find Google Chrome executable for channel 'stable' at:\n - /opt/google/chrome/chrome." } ],
  "isError": true }
```

原生路径的 `tool/result` 记录（注意 `isError: true` 与 `Error: ` 前缀）：

```json
{"type":"tool/result","data":{"message":{"role":"tool",
  "content":[{"type":"text","text":"Error: Could not find Google Chrome executable for channel 'stable' at:\n - /opt/google/chrome/chrome."}],
  "isError":true}}}
```

## 十、被证伪的两条设计（附证据）

### 10.1 ❌ 工具描述里写"服务器不可用时报告并停止"

原生路径强制型那一次，模型手里有 30 个 MCP 工具的完整 description 与 parameters，仍然打转 317 秒。
**工具描述与用户的强制指令竞争，用户指令赢。**

### 10.2 ❌ 报错内联 schema

1. 内联分支从未触发（远端把校验失败当正常结果返回，不是抛异常）。
2. 错误文本本身已含字段名，四臂全部一次纠正，**包括无 detail 的 B 臂**。
3. 两条通路并存时模型走 detail（ARM D 轨迹：盲调 → detail → 改对）。
4. 代价：中位 842 字符（168 tok）、最大 2,959 字符（590 tok），且此后每轮携带。

---

## 十一、PTC 子调用事件的下游消费者（读源码，2026-10-04）

### 11.1 事件生产（`dsh-tools/lib/index.js:1331` / `:1354`）

每次 PTC 子调用写两条事件：

```js
// 开始时
agent.session.append('tool/ptc-dispatch-start', { rootCallId, parentCallId, subCallId, name, arguments })

// 结算时（await shapeDispatchLog(...) 之后）
agent.session.append('tool/ptc-dispatch', { ...同前, isError, error?, content: logged })
```

- `tool/ptc-dispatch` **带完整 `content`**，但它先过 `shapeDispatchLog()`，
  即 `ctx.waterfall(scopeTarget(this, dispatch.agent), 'tools/ptc-dispatch-log', dispatch, ...)`。
- **模型实际看到的是这份（可能已被裁剪的）content**——裁剪发生在记录的时候，不是模型读取时。

### 11.2 `dsh-spill-policy` 会给子调用日志加上限（已在本 profile 启用）

```js
ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
  const content = await next();
  return await bound(dispatch.exec, content, dispatch.name, dispatch.subCallId, 'dispatch') ?? content;
}, { prepend: true })
```

- `bound()` 按 **估算 token 数**判断，超过 `config.maxInlineTokens` 就落盘（spill）并在上下文里留一条引用提示。
- **本机 web profile 实测配置：`spill-policy` 已挂载，`maxInlineTokens: 12500`。**
- 即：**PTC 子调用结果 > 12.5k tok 会被自动外置**，模型只看到引用。

### 11.3 ⚠️ `tool-result-pruner` **只认 `tool/result`，看不见 PTC 子调用**

`dsh-compaction-tool-result-pruner/lib/index.js:136-145`：

```js
pruneSession(session) {
  const candidates = [];
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq);
    if (event?.type === 'tool/result') candidates.push({ seq, event });   // ← 只收 tool/result
  }
```

**代码库中没有任何模块对 `tool/ptc-dispatch` 做裁减/替换/截断**（grep 全仓 `ptc-dispatch` × `prune|compact|replace|truncate|shadow`：零命中）。

含义：**PTC 下的大结果靠 spill-policy 在"记录时"限流，而不是靠 compaction 在"事后"剪枝。**
两套机制互补，不是遗漏。

### 11.4 另一处相关：compaction 的 tool-pairing 只按 `tool/result` 计数

`dsh-compaction/lib/index.js`：

```js
function eventDelta(event) {
  switch (event.type) {
    case 'assistant/message': return ...tool-call 块数;
    case 'tool/result': return -1;
    default: return 0;
  }
}
```

PTC 子调用**不产生 `tool/result`**（`ptc-dispatch` 的 delta 是 0），
所以它们**不参与配对平衡**——安全切点只由 `run_code` 那一条 `tool/call` + `tool/result` 决定。

### 11.5 对 Q1 的最终回答

> **`mcp_call` 不需要为"被模型吞掉的失败"额外写显式标记。**

理由：

1. 子调用的 `ptc-dispatch-start` / `ptc-dispatch` **始终被记录**，失败时表现为"有 start 无 dispatch"。
2. 大结果由 `spill-policy` 在记录时按 token 上限外置（本机 12.5k tok），与 `isError` 无关。
3. 唯一"看不见"的是 `tool-result-pruner`——而它的职责本来就只覆盖 `tool/result`。

### 11.6 未验证

- `dsh-experimental-auto-review` 也读 `tool/ptc-dispatch-start`（`:167`）；
  该插件在本 profile 未挂载，**未评估它的行为**。

## 十二、连接层真实往返（2026-10-05）

对象：`lib/connection.js`（自建薄连接层，零 fork）；脚本 `lab/connection-smoke.mjs`。
服务器：context7 v4.1.1，stdio，`npx -y @upstash/context7-mcp@latest`。

### 12.1 往返结果（全部通过）

| 步骤 | 结果 |
|---|---|
| `normalizeServer` | `{name:context7, transport:stdio, timeout:60000}` |
| `ready` | `ok=true state=ready` |
| `tools/list` | 2 个：`resolve-library-id(query,libraryName)`、`query-docs(libraryId,query)` |
| `instructions` | 636 字节（原样保留，未按字节拒绝） |
| `capabilities` | `["prompts","resources","tools"]` |
| `resources/list` | 0 条 |
| `resolve-library-id`（全参数） | `isError=false`，1 个 text 块，`structuredContent` **absent** |
| `query-docs`（真实 libraryId） | `isError=false`，返回真实文档正文 |
| `dispose` | `state=closed`；之后调用抛 `not connected (state=closed)` |
| `dispose` 二次 | 幂等，仍 `closed` |

### 12.2 ⚠️ 三条影响错误契约的真实行为

**(a) `isError: true` 携带的是可操作正文，不是失败摘要。**

缺必填参数时服务器返回：

```json
{ "isError": true, "content": [{ "type": "text",
  "text": "Input validation error: Invalid arguments for tool resolve-library-id: query: Invalid input: expected string, received undefined" }] }
```

正文已经指明了**哪个参数**、**期望什么**。⇒ 早先定的"抛错 + 短分类消息
（`PARAM_ERROR` 等）"若**替换**正文，会销毁模型修复调用所需的信息。
**契约修正：抛错时消息必须是服务器原文；分类只可追加为提示，不得替代。**

**(b) 未知工具名在 SDK 层抛，不是 `isError` 结果。**

```
conn.callTool('no-such-tool', {})  ->  throw: Tool no-such-tool not found
```

⇒ `mcp_call` 必须同时处理两种形状：SDK 抛出（未知名 / 超时 / 连接掉）与
`isError: true` 结果。两者都归一为工具错误，但消息来源不同。

**(c) 声明 `resources` 能力 ≠ 真有资源。**

context7 的 `capabilities` 含 `resources`，但 `resources/list` 返回 0 条。
⇒ 不能靠能力声明推断有没有资源，只能实探；且**不应在连接时**为每台服务器
多打一次往返。资源发现应当**惰性**（首次要资源时再探）。

### 12.3 附带观察（不是我们的问题，但要知道）

- context7 会往 **stdout** 写非协议文本（`Context7 Documentation MCP Server v4.1.1 running on stdio`、
  重定向日志）。stdio 的 stdout 是 JSON-RPC 通道；实测 SDK 容忍**行分隔的非 JSON 文本**。
  官方客户端有同样暴露面，我们不额外处理。
- 服务器 instructions 超过官方 `maxInstructionBytes`(32768) 时官方**抛错断连**；
  我们从不把 instructions 放进提示词，故不设该限制。

## 十三、`mcp_call` 与图片路径（2026-10-05）

对象：`lib/projection.js` + `lib/index.js` 的 `mcp_call`；脚本 `lab/call-smoke.mjs`（27 条断言全过）。

**装置**：`lab/fake-mcp-server.mjs` —— **手写的最小 MCP 服务器**（stdio 行分隔 JSON-RPC，
不依赖任何 server 端 SDK；本机也没装 `@modelcontextprotocol/server`）。
三个工具分别覆盖文本、**真图片**、`isError`。
图片是 `lab/fixtures/test.png`（474 B，48×48 真 PNG）—— 附件服务会校验**解码后**的媒体类型
与内在尺寸，所以伪造的 base64 过不了这一关。

### 13.1 图片路径（当初否决「路径 D」的原因，现验收通过）

MCP 返回 `[text, image]` 两块，实测投影结果：

| 断言 | 实测 |
|---|---|
| 块数 | 2（文本在前、图片在后，**不跨图片合并**） |
| 图片块 | `{ type: "image", attachment: … }` |
| 媒体类型 | `image/png` |
| 字节数 | **474**（= 真实 PNG 大小） |
| 内在尺寸 | **48×48**（由附件服务解码得出，不是我们声明的） |
| `attachments.saveImages` 调用次数 | 1 |
| canonical value 里是否残留 base64 | **否** |

### 13.2 降级路径（模型不声明图片输入时）

把假 `llm.resolveModelInfo` 的 `inputModalities` 改成只含文本后重跑：

- **不抛错**，图片块降级为文本诊断；
- 诊断与相邻文本块**合并为一段**（语义正确，信息不丢）：原文、原因
  （`does not declare image input`）、媒体类型（`image/png`）、以及「原始数据不再保留」
  四处都在；
- **不再落盘**（`saveImages` 调用次数仍为 1，没有第二次）。

### 13.3 错误契约在真实服务器上的复核

假服务器返回 `{ isError: true, content: [{ type: "text", text: "Input validation error: …" }] }`，
`mcp_call` 抛出且**正文逐字保真**。与 §12.2(a) 一致：分类字段维持「可选、默认不做」。

### 13.4 四条拒绝路径（互不混淆）

| 情形 | 消息特征 |
|---|---|
| 服务器未在本会话启用 | `is not enabled in this session` + 已启用清单 |
| 已启用但不可用 | `is currently unavailable (phase=…)` + 原文 + 「不要重试」 |
| 未知服务器 | `unknown MCP server "…"` + 已知清单 |
| 工具名不存在 | `has no tool named "…"` + 该服务器工具清单 |

---

*文档版本: 0.2.0*
*更新日期: 2026-10-05*

---

## 33. 字节口径的复算校准（2026-10-06）

§2 的「A 全量 schema」是用真实 `tools/list` 逐字复算的，但当时没把**序列化形状**写死。
要把它变成界面上可随时重算的东西，形状必须先固定，否则界面上的数与这里的 29,109 B 不是同一把尺。

**定下来的形状**：

```js
JSON.stringify(tools.map(t => ({ name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? {} })))
```

理由是它正好等于「会进入请求工具表的那些字段」：`title` / `annotations` / `icons` 不进，
用原始工具对象会多算。实测同一台 context7：

| 形状 | 字节 |
|---|---|
| 原始 `JSON.stringify(tools)` | 4,864 |
| **`name+description+parameters`** | **4,588** |
| 逐工具累加（不套数组） | 4,465 |

与 §2 记录的 **4,581 B** 相差 7 B（0.15%），来源是 `@upstash/context7-mcp` 版本漂移
（复算时 v4.1.1，记录当时不是）。**形状被复现，这就是校准通过的判据。**

复算脚本：`lab/calibrate-bytes.mjs`；实现：`lib/measure.js`。

**该模块刻意不提供 token 折算。** token 数跨模型、跨语种差异很大，
把折算率写进界面等于用一个不成立的换算率冒充事实。界面只报字节。

---

## 34. headless 形态：控制面与首呼竞态（2026-10-08 / 09 实测）

**缺口（0.7.3 + `headless` profile）**：三个工具正常注册、两台服务器 `ready`，但模型得到
`Error: MCP server "context7" is not enabled in this session. Enabled: (none).`
—— 唯一能写「新会话默认」的入口是 web 设置页，headless 没有。

**首呼竞态**：同一次 run 里 `mcp_servers` 返回两台都还在 `connecting`，`mcp_detail` 回
`NO_TOOLS_KNOWN`（空目录），`mcp_call` 回 `still connecting`。冷启到 ready 实测约 20 s
（web 侧同配置：t+0 connecting → t+20s ready，30 + 2 个工具）。

**0.8.0 之后（lab profile + 本地构建，真实一次性 run）**：`mcp_servers` 返回
`"enabledInThisSession": ["context7"]`、`"defaultsSource": "config"`、`"defaults": ["context7"]`；
同一次 run 里 context7 仍显示 `connecting`，而紧随其后的 `mcp_call` **已经打到真实服务器**
并拿回它自己的参数校验错误
（`Invalid arguments for tool resolve-library-id: query: Invalid input: expected string`）——
即等待把调用带过了就绪窗口。若等待未生效，这里会是 `still connecting (phase=connecting)`。

**0.8.0 正式版验收（2026-10-09，npm 安装 + 真实 `headless` profile）**：profile 侧只加了一行
`config.defaults: [context7]`。一次 run 里三步全过：

- `mcp_servers` → `"enabledInThisSession": ["context7"]`、`"defaultsSource": "config"`
  （控制面来自 profile 声明，不是设置页）；
- `mcp_detail`（该服务器当刻仍 `connecting`）→ `found: true` 且 **`waitedMs: 2427`**，
  带回完整 `inputSchema`；0.7.3 时同一位置是 `NO_TOOLS_KNOWN`；
- `mcp_call` → context7 的真实返回（候选库 `/reactjs/react.dev` 等）。

会话状态目录无新增文件（一次性 run 不落状态）。

---

## 35. ACP 基线：客户端声明的 MCP 服务器走哪条路（2026-10-09 实测，dsh 0.2.0-rc.2）

**做法**：`acp` profile（出厂模板）+ 手写 ACP v1 stdio 客户端（`@agentclientprotocol/sdk` 1.4.0 的
`ClientSideConnection` + `ndJsonStream`）：`initialize` → `session/new`（带 `mcpServers` 声明）→
`session/prompt`。

**观测**：

| 观测项 | 结果 |
|---|---|
| `session/new` 带一台 context7 声明 | **阻塞 6 315 ms** 直到服务器起来（stderr 出现 `Context7 … running on stdio`），之后才返回 sessionId |
| 模型看到的工具 | **`mcp__context7__query-docs`、`mcp__context7__resolve-library-id`** —— 原生逐工具路径 |
| 坏声明（npx 符号链接；或 node 配错参数） | `session/new` **照常返回 sessionId**、模型照常运行、**没有任何 `mcp__` 工具**，客户端拿不到错误 |

**结论**：ACP 形态下客户端声明的 MCP 服务器由 `dsh-acp` 自己 mount 成原生 `dsh-mcp-client`
（`agentCtx.plugin(McpClient, config)`，在 Agent 发布之前、`failOnStartupError: true`），
产出**逐工具声明**且**不在本插件的开关管辖内**；ACP 契约不允许私有方法，插件侧没有接入口 ——
即 design.md §2.13 记录的 ACP 缺口。

**pnpm 发布龄门禁（同一批实验的附带实测）**：`minimumReleaseAge` 默认 1440 分钟。
发布 23.7 小时的版本裸 `add` 会被**静默跳过**（退回 24.4 小时前那版），发布 69 小时的正常装上；
空 cache 目录可复现，`--config.minimumReleaseAge=0` 即装到最新 ⇒ **与 packument 缓存无关**
（2026-10-08 曾误判为缓存，用空 cache 复现后排除）。

