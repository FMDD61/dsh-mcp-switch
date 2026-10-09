# dsh-mcp-switch 设计

## 0. 范围

**做**：MCP 服务器的**会话级开关**；工具面的**收敛与按需展开**；开关状态的**持久化**；
面向 web / 桌面 / 后续 TUI 的**管理界面**；四种原生预设 + 自定义预设的**适配**。

**不做**：服务器配置的图形化增删改（可由 `dsh-mcp-connector` / `dsh-plugin-tool-management` 承担，本插件只读）；
任何依赖 provider 特性的能力（`defer_loading` 等）；MCP 进程的生命周期管理（本阶段，见 §2.5）。

**关于连接（2026-10-05 变更）**：早期设计写的是"MCP 连接与协议交官方 `@deepseek-ai/dsh-mcp-client`"。
**该决定已推翻。** 现在是**零 fork 的薄连接层**（`lib/connection.js`）：
不使用也不 fork 官方客户端的任何代码，官方客户端**不挂载**。理由见 §1.4。

---

## 1. 工具面形态（核心）

### 1.1 实际形态：MCP 工具**零注册**

| 层 | 内容 | 谁付钱 |
|---|---|---|
| ① 服务器 `instructions` | **不进系统提示词**（见 §2.6） | — |
| ② MCP 工具名 | **不注册**。只在 `mcp_servers` / `mcp_detail` 的**返回值**里出现 | 只在模型主动盘点时 |
| ③ 参数 schema | 经 `mcp_detail` 按需取回，落在对话历史里 | 只在真正要看时付一次 |
| ④ 本插件自己的工具 | **恒定 3 个**（§1.3） | 每轮，1,637 字节 |

**实测（2026-10-05）**：三个工具合计 **1,637 B**（`mcp_call` 646 / `mcp_detail` 448 / `mcp_servers` 543），
对比原生 32 个 MCP 工具的 **29,109 B** —— **5.6%**，省 94.4%。

这三条是同一件事的三个面：**工具表里没有 MCP 的任何痕迹**，所以增删服务器、开关服务器、
服务器中途改工具列表，**都不改动任何声明**。

### 1.2 为什么参数 schema 可以按需取回

两条实测支撑：

1. **错误文本本身就够用**：参数错误时远端返回的文本**直接点名了正确字段**
   （`libraryName: Invalid input: expected string, received undefined`），
   模型**一次纠正成功**——四臂（含既无 detail 也无内联 schema 的 B 臂）全部成功。
2. **模型不会主动先取 detail**（实测）。所以 `mcp_detail` 是**纠错手段**，不是前置步骤——
   见 §6：不为此加机制性拦截。

> ⚠️ **已废弃的支撑**：早期设计还依赖"description 与 parameters 同时为空时 dsh 接受该注册，
> 模型仍能直呼 `mcp__context7__resolve-library-id`"。**该形态已不存在**——我们现在不注册任何
> `mcp__*` 名（`lib/` 全目录 grep `mcp__` 零命中）。这条实测记录保留在 `measurements.md`，
> 但不再构成本设计的依据。

### 1.3 中间层工具（本插件自己注册的，恒定 3 个）

| 工具 | 作用 | 何时用 |
|---|---|---|
| `mcp_servers` | 列出服务器：名字、状态、工具数 | 需要盘点时 |
| `mcp_detail(server, tool)` | 返回单个工具的完整 inputSchema + description | **纠错手段**，不是前置步骤（§6） |
| `mcp_call(server, tool, arguments)` | 统一调用入口；未启用/不可用/未知都从这里拒绝 | 要真正调用时 |

**关键约束：这三个工具的 `parameters` 里不得出现任何服务器名或工具名。**
服务器名是**运行时的值**，不是 schema 的一部分。这条一破，工具表就随服务器增删而变，前缀立刻失效。

### 1.4 为什么零 fork（2026-10-05 决定）

官方 `@deepseek-ai/dsh-mcp-client` 的形状是"一个插件实例 = 一台服务器，**且把每个工具注册进 `ctx.tools`**"。
我们的形状完全不同：一个实例 = N 台服务器，**不注册任何工具**。

| 它内部的东西 | 能不能拿来用 | 为什么 |
|---|---|---|
| `tools.js`（365 行，占 44%） | **能，但不好用** | 导出了 `createMcpToolDefinition`，前提却是"定义会被注册进 registry"——脱离 registry 要重建 registry 的结果形状才能触发 `projectContent` |
| `connection.js`（302 行重连状态机） | **拿不到** | 不导出；handle 只暴露 `{ready, instructions, resources, dispose}`，**不暴露 `Client`** |
| `transport.js`（37 行） | 能复写 | 非平凡部分只有 `{...scrubbedParentEnv(), ...extra}`，而那是公开导出 |
| 传输观察（`onclose` / `onerror`） | 自己写 | 约 30 行，是 `connection.js` 里唯一必须保留的语义 |

⇒ 与其 fork 一个 835 行的单文件包、并在每次 dsh 更新后 diff，不如**只用它的两个公开依赖**
（`@modelcontextprotocol/client` 与 `scrubbedParentEnv`）自己写薄连接层。

**维护成本是决定性理由**：dsh 处于预览期，而 `connection.js` 正是它的活跃开发区。
我们宁可依赖 MCP 官方 SDK（外部包、有 semver）与 dsh 的三个小工具包，
也不依赖它的内部实现形状。

---

## 2. 状态模型

### 2.1 只存"用户意图"，不存"事实"

| 状态 | 存哪 | 理由 |
|---|---|---|
| **服务器开关**（会话级） | 自己存：`<DSH_HOME>/dsh-mcp-switch/sessions/<sessionId>.json` | 这是**用户意图**，日志里没有权威记录 |
| **"某工具在本会话已用过"** | **不存**——从会话日志投影 | 会话日志已记录每一次 `tool/call`（字段是 `data.name`），是权威事实 |

**为什么不自己存"已用工具"**：一旦自己维护，就要处理和日志不一致的全部情形——
日志被 compaction 裁剪、会话被分支、resume 时的孤儿补全。读日志投影永远与事实一致。

### 2.2 状态粒度

- **按会话**（不是按工作目录，也不是全局）——这是本插件与 wingsky 的核心差异。
- 用 dsh 原生 **session ID** 区分文件。
- 会话删除后对应的状态文件成为孤儿；提供一个"清理孤儿状态"的操作（GUI 里）而非自动删除。

### 2.3 服务器进程生命周期

**所有配置过的 MCP 服务器随 dsh 本体一起连接**（这是成熟设计，不是本插件发明）。
开关**只决定是否把该服务器的工具接入对应会话**，不启动/停止进程。

理由：进程的启停有秒级延迟与失败模式，把它放进"开关"会让 UI 需要加载态与锁；
连接由本插件自己的连接层持有后，开关退化为**纯状态变更**，可在 GUI 上瞬时完成、可乐观更新。

（"进程停用"是**另一个**操作，见 §2.5 的 `stopped` 相位。本阶段不实现。）

### 2.4 三个概念分开存

| 概念 | 含义 | 存哪 | 生命周期 |
|---|---|---|---|
| **配置态** | 用户声明了哪些服务器 | cordis 配置 | 挂载时固定 |
| **连接态** | 每台此刻能不能用 | `lib/registry.js`（内存） | 随连接变化 |
| **开关态** | 用户想让哪些接入本会话 | `sessions/<sessionId>.json` | 跨重启持久 |

三者**不得互相污染**。最典型的错误是把"连不上"当成"关掉了"——那会让用户无法区分
"我没开它"和"它坏了"。

### 2.5 连接态相位

```
connecting → ready → failed
                 ↑        │
                 └────────┘  **手动重连**（reconnect，见 §2.11）
                      ↘ stopped   （主动进程停用；占位，本阶段不实现）
任意相位 → closed                 （宿主关闭 / 插件卸载）
```

**三件事会写入 `failed`：**

1. `connect()` 失败（子进程起不来、握手失败、URL 不通）
2. **stdio 传输关闭**（`client.onclose` —— 子进程死了）
3. **配置非法的条目**——它从未连接过，挂载时直接以 `failed` + `source: 'config'` 登记

**不写入 `failed` 的：**

- **单次工具调用失败**（含超时）。否则一个慢工具会把整台服务器标红。
  这类失败走**调用错误**通道（`mcp_call` 的报错），不进状态机。
- **streamable-http 的传输关闭**。HTTP 侧连接关闭可能只是 SSE 流正常结束，
  不等于服务器不可用。（**待实测**，见 [`open-questions.md`](open-questions.md) Q10。）

### 2.6 `ready` 的语义边界（重要）

> **`ready` 的含义是"连接已建立"，不是"服务可用"。**

凭据失效（如 firecrawl 的 API KEY 过期）、配额耗尽、上游故障时，**连接完全正常**。这类问题：

- **探测不到**——`ping` 只证明传输活着；能真正暴露它的只有一次真实工具调用，
  而那要消耗付费额度，**所以不做主动探测**。
- **基本只能由用户解决**——agent 能解决的事情，正常能启动的 MCP 本来也不会有。
- 因此**不进状态机**，只走调用错误通道。

### 2.7 有意分歧：MCP 失败不得阻止 dsh 启动

官方 `dsh-mcp-client` 有 `failOnStartupError`：初始连接失败会让插件激活失败。
**我们刻意不这样做。**

- `startConnection` 同步返回句柄，`ready` 解析成 `{ok:false}`，错误进 registry。
- 一条坏配置只让它自己那行变红，不影响其它服务器，也不影响 dsh 启动。

代价是：我们**创造出了**"启动即失败、但 dsh 正在运行"这个情形——
所以连接态模型在本设计下比在官方路径下**更必要**，不是更不必要。

### 2.8 开关冻结规则

```
冻结 = phase ∈ {failed, stopped, closed}
```

- `connecting` **不冻结**——否则 dsh 启动的头几秒整个面板都是灰的。
  此时允许预设意图；真失败了会落到"已启用 · 不可用"，由开关态自行表达。
- 冻结是**双向**的：既不能开，也不能关。
- 规则在**状态写入处**强制执行（`SessionSwitches.set`），UI 的禁用只是同一规则的呈现。

⚠️ **本阶段 `failed` 是终态，所以冻结暂时没有出口。** 这是自觉接受的：
本阶段还没有开关 UI，冻结没有受害者。引入 GUI 或进程停用时**必须同时给出出口**
（重试按钮，或进程停用）。见 [`open-questions.md`](open-questions.md) Q9。

> ✅ **2026-10-05 已兑现**：failed 行在 GUI 里出现**重试**按钮，点它走 `reconnect()`（见 §2.11）。
> 冻结不再是无出口的。

### 2.10 ❌ 开关状态**不能**落进会话日志（2026-10-05 实测否决）

GUI 需要一条把服务端状态送到浏览器的通道，正统解是**会话投影**（§8.3 发现四）。
而投影是"对会话事件的纯 fold"，所以开关变更必须**记成一条会话事件**。
`lib/store.js` 的"每会话一个文件"因此退役。

**事件形状：专用事件类型 + `ignorable: true`**，不用 `user/message` + 自定义 source kind
（那是 skill-catalog 的做法，因为它的目录**本来就要进对话**；我们的不要）。

| | 专用类型 + `ignorable` | `user/message` + 自定义 `source.kind` |
|---|---|---|
| 进对话？ | **否** —— surface 类型是闭合集合，未知类型自动非 surface | **是** —— 它就是一条用户消息 |
| 老 dsh 读到 | `ignorable` → **安全跳过** | 要过 source-kind 校验；v2→v3 的闭合白名单会**抛错** |
| 语义 | 正合 `ignorable` 的适用条件（纯信息记录） | 借用了对话通道 |

**dsh 对这套的权威说明**（`known-event-types.d.ts`）：

> *"Downstream (out-of-repo) plugin events are outside this list **by construction**.
> The persisted `SessionEvent.ignorable` marker **is the compatibility mechanism**;
> event-name registration was rejected because it does not classify omission safety."*

以及 `SessionEvent.ignorable` 的写入者规则：

> *"A writer sets `true` only on purely informational records whose loss cannot affect
> reconstruction; defaulting to required means a forgotten marker over-refuses
> (an inconvenience) rather than silently resuming a gutted session."*

**为什么我们算"纯信息"**：丢了这条事件，会话本身仍能完整重建（工具调用与结果都在
`tool/call` / `tool/result` 里）；只是开关状态退回默认全关，用户可以重新开。
反之若标为必需，**老 dsh 会直接拒绝打开整个会话**——那是灾难性的。

#### ⛔ 实测否决（2026-10-05，读 0.2.0-rc.2 实现）

上面的方案**不成立**，两条独立的原因：

**① `append` 根本写不出 `ignorable`。** `Session.append` 的 envelope 是硬编码的：

```js
const event = deepFreeze({ type, seq, time, data: dataSnapshot, ...surfaceMetadataSnapshot });
```

而 `surfaceMetadata` 只可能含 `surfaceOp` / `sourceEventSeqs`（`opts` 也只有这两个）。
签名 `append(type, data, ...opts: T extends SurfaceEventType ? [SurfaceIntent<T>] : [])`
对非 surface 类型**不接受任何 opts**。

**② 读路径会拒绝未知类型。** `dsh-session-persistence` 的 `validateStoredEvents`：

```js
if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true)
  throw unsupported(`... contains event type "${event.type}" ... unknown to this harness
    and not marked ignorable; refusing to interpret the log ...`);
```

而 `KNOWN_SESSION_EVENT_TYPES` 是**由 dsh 自己的 `SessionEventMap` 生成的**（
`scripts/gen-persistence-catalog.ts`），注释原话：*"Downstream (out-of-repo) plugin events
are outside this list **by construction**"*。

⇒ **一个进程内插件写的自定义事件类型，会让会话变成"打不开"**。
`ignorable` 是给**外部生产者**（导入/种子路径，见 `adoptSessionEvent` 与 envelope 校验）
准备的，进程内插件够不到。

**③ 唯一可写的已知类型不适合我们。** `user/message` + 自定义 `source.kind`（skill-catalog 的路线）
确实能写，但 `user/message` 是 **surface-eligible**：`surfaceOpOf` 要求它必须带 `surfaceOp`，
于是它**会进对话**。skill-catalog 要的正是这个效果；我们不要（会把开关状态推进模型上下文，
且每次开关都改尾部）。

⇒ **结论：会话投影对开关状态不可用。** 开关状态留在自己的文件里（`lib/store.js`），
浏览器通道走别的路（见 §8.3）。**这条否决让架构变更整个消失**——`store.js` 不动。

### 2.11 手动重连（2026-10-05）

**存在的理由很窄**：远程 MCP 遇到网络问题，恢复后要能接回来。
本地 stdio 掉线不该靠它——子进程死了重连也白搭，那是用户的事。

`connection.reconnect({ force })` 三条约束：

| 约束 | 为什么 |
|---|---|
| **single-flight** | 在途时复用同一个 promise；并发点击不会 spawn 多个子进程 |
| **cooldown 30s**（`force` 可绕过） | 给**将来**的自动重连用；GUI 上显式点击走 `force: true` |
| **每次全新 Client** | MCP SDK 把一个 Protocol 绑死在一个 transport 上，复用会失败 |

相位：`failed --reconnect--> connecting --> ready | failed`。**`failed` 因此不再是终态**，
但也没有自动退避循环——重连只由用户的一次点击驱动。

> ⚠️ **GUI 必须轮询**：连接态是服务端的运行期事实，掉线不会推给浏览器
> （`mcp-switch/state` 事件只在宿主侧发）。不轮询的话用户看不到掉线，
> 也就永远看不到重试入口——而那正是这个功能的前提。面板挂载期间每 5 秒拉一次。

### 2.9 ⚠️ 子代理：已知缺口（本阶段未实现）

**子代理有独立的 session id**（`dsh-subagent-in-process-driver` 用 `sessionId: childId`），
所以"按会话存开关"意味着**子代理默认全关**——父会话开了某台服务器，子代理里 `mcp_call` 仍被拒。
而子代理**能看见**这三个工具（`composeFrom(parent)` 加入同一预设），所以这不是理论问题。

**已定的规则（尚未实现）**：

1. **动态继承**：子会话自己没有状态文件时，沿 `session.header.parentSession` 上溯，
   取第一个有文件的会话的开关。用户意图只存在根会话上，子代理只读。

   **逐跳的父会话有三个来源**（2026-10-05 补齐，见审查 S1）：

   | 来源 | 覆盖 |
   |---|---|
   | 调用方给的 `parentSession` | **第一跳**，来自活的 header，最可靠 |
   | 进程内血缘表（`agent/created` 喂） | 快速路径 |
   | **`ctx.sessions.get(id).header.parentSession`** | 兜底：活跃但没被 `agent/created` 覆盖的中间层 |

   ⚠️ **已知限制**：三者都拿不到**非活跃**（冷）会话的 header——
   那需要读 dsh 的持久化。所以「重启后，一个从未在本进程活跃过的中间层所辖的孙会话」
   仍会继承失败（退化为空集，安全但不正确）。要彻底解决需接 `dsh-session-persistence`。
2. **自己有文件用自己的**：用户可以在某一层手动开关，覆盖继承值。
3. **必须设上限**：`parentSession` 理论上无环，但损坏的文件可能造环；
   用 `delegationDepth`（dsh 默认最大 10 层）或硬上限兜底。
4. **适用范围要显式定**：`parentSession` 的文档语义是"fork 的种子血缘"（`dsh-session` 类型注释），
   而 subagent 也写这个字段。**fork 出来的会话要不要继承种子会话的开关**是单独的决定
   （倾向继承——它是延续，不是新任务）。

未实现前，委派出去的子代理**拿不到 MCP 能力**，且失败不易归因。

---

### 2.12 新会话默认（2026-10-06，用户裁决后实现）

开关态多了一个**初始值**：某个会话自己没有状态文件时用它，一旦用户在该会话动过开关，
那份文件就固化下来，之后改默认不再影响它。**它不是第四个概念**，是开关态的初值。

解析链（`SessionSwitches.#resolve`）：

```
自己的状态文件  →  继承（父会话，三条血缘来源，见 §2.9）  →  新会话默认  →  （出荷为空）
```

落盘在 `<DSH_HOME>/dsh-mcp-switch/defaults.json`，与会话状态同一个目录、同一套原子写与权限。

#### 四条刻意的取舍

| 取舍 | 理由 |
|---|---|
| **读不出来时不拒绝写入**（与会话状态相反） | 会话状态读不出来要拒绝，是因为写入会用空集**整份覆盖**用户意图；默认值读不出来时，写入的目标是会话文件，碰不到默认文件本身，没有可丢的数据。若这里也拒绝，一台损坏的默认文件会让**每个新会话**都开不了开关 —— 把一个小故障放大成不可用 |
| **不受冻结规则约束** | 冻结管的是「本会话此刻能不能用」；默认讲的是**将来的**会话，与此刻连没连上无关（现在失败、下次启动可能就好） |
| **只报字节，不折算 token** | token 数跨模型、跨语种差异很大。折算率一旦写进界面，就是用不成立的换算率冒充事实 |
| **量不出的要说明** | 默认里尚未连接（或连接失败）的服务器没有工具表可量，单独计数并在成本行注明「未计入」，不假装是 0 |

#### 字节口径（唯一一套，不另立）

```js
declarationBytes = byteLength(JSON.stringify(tools.map(t => ({
  name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? {},
}))), 'utf8')
```

与 [measurements.md §2](measurements.md) 的「A 全量 schema（name+description+parameters）」同一口径 ——
那个口径是从真实 `tools/list` 逐字复算的。**换形状就是换单位**，界面上的数会和文档里的 29,109 B 对不上。
实现见 `lib/measure.js`（**没有** token 折算函数，这是刻意的）。

校准：同一台 context7（2 个工具），本函数 4,588 B，文档记录 4,581 B，差 0.15%，
来自 `@upstash/context7-mcp` 版本漂移。复算脚本 `lab/calibrate-bytes.mjs`。

### 2.13 非 web 形态的开关控制面（2026-10-08 裁决，2026-10-09 实现）

web / 桌面之外，dsh 0.2.0-rc.2 还出厂三类形态：`headless`（一次性 CLI）、`acp`（编辑器接入）、
`sdk` / `sdk-minimal`（嵌进别的程序）。**没有 TUI** —— `dsh tui` 只是 launcher help 里的
泛化示例，npm 上也没有对应包。

**已按 0.2.0-rc.2 验证的是 headless**：它的 bundle 自述就是"no Host, HTTP, or browser layer"，
且实测三个工具照常注册（见 measurements §34）。`acp` / `sdk` 同样没有 web 服务器与设置页，
但**本版未验证**，留到下一版（用户裁决：先只做 headless，作为一个版本更新）。

于是缺口很具体：三个工具照常注册、连接照常建立，但「哪些服务器接入本会话」的唯一可写入口是
web 设置页 —— headless 里模型只能得到 `MCP server "x" is not enabled in this session`
（2026-10-08 实测，见 measurements §34）。

#### 采用的方案：`config.defaults`

```yaml
- id: dsh-mcp-switch
  config:
    defaults: [context7]      # 新会话默认接入哪些（部署声明）
    servers: [ ... ]          # 存在哪些服务器
```

- **只作用于「默认」那一层**，解析链其余部分不变：
  `自己的状态文件 → 继承 → config.defaults（写了就用它）→ defaults.json → ∅`。
  会话自己动过开关，仍然以那份文件为准。
- **写了它就压过 `defaults.json`**（设置页写的那份）。这是刻意的：profile 里的是**部署声明**，
  `defaults.json` 是**用户偏好**。代价是两者同时存在时设置页看起来"失灵"，所以插件在挂载时
  **告警一次**，并让 `mcp_servers` 报 `defaultsSource`（`config` / `store` / `none`）与
  `defaultsOverridden` —— 模型和排查的人都能直接看出默认是谁定的。
- **per-run 不需要新接口**：`dsh --patch <file>` 是 launcher 自带能力，写一份两行的 overlay 即可
  只影响一次运行。
- 选它的另一个理由是**维护面**：没有引入任何新的宿主 seam，只用了 cordis 配置这层地基。

#### 被否决的备选（记录在此以免重走）

| 备选 | 否决理由 |
|---|---|
| 环境变量 `DSH_MCP_SWITCH=…` | dsh 专属状态泄漏到通用环境变量上；受限权限的 agent 不便；各平台设置方式不同；**dsh 卸载后残留**；且不可发现（只能靠文档） |
| 独立 CLI 改 `defaults.json` | 在 dsh 之外运行意味着 `dsh-home-paths` / `dsh-atomic-write` 这两个 **peer** 要自带，签名漂移会让 CLI 与插件写出互不兼容的状态；改的是 home 级全局状态，并行 CI 互踩 |
| `cmdlineArgs` 旗标（`--mcp-servers=…`） | 命令行归 **app 插件**所有（上游原话 "an app owns its flag family"）。`parseCmdline` 把 commander 的报错转成 `exit(code)` ——**插件解析出错会带走整个宿主进程**；共存还要 `allowUnknownOption`，并与 app 自己的 `--help` 抢答 |

#### 首呼竞态的兜底：`config.readyWaitMs`

headless 是一次性的：模型第一次调用往往早于 MCP 子进程就绪（npx 冷启实测约 20 s），于是
`mcp_detail` 拿到空目录回 `NO_TOOLS_KNOWN`、`mcp_call` 回"稍后再试" —— 而它没有第二次机会。

- `mcp_call` / `mcp_detail` 遇到目标服务器处于 `connecting` 时**先等**，上限 `readyWaitMs`
  （默认 30 000 ms；`0` = 关闭等待，回到旧行为）。
- 等待**有界、可中止、可短命**：`exec.signal` 中止立即返回；服务器落定（ready **或** failed）
  立即返回；**未启用**的服务器不等（那是另一个轴上的答案）；`mcp_servers` 永不等待 ——
  它是盘点工具，必须即时。
- 超时**不假装"没有工具"**：如实报 `phase: connecting` + `waitedMs` + 一句明说还在连的提示。

宿主侧**不**给这三个工具声明 `timeoutMs`：`dsh-tool-call-timeout-policy` 只对声明了上限的工具
计时，而本插件两端都已经有界（等待 ≤ `readyWaitMs`、MCP 请求 ≤ 该服务器的 `toolCallTimeoutMs`），
再声明一个只会造出第二个互相竞争的期限。
## 3. 前缀稳定性（第一前提）

### 3.1 三层载荷：只有对话消息会变

| 层 | 内容 | 开关会碰它吗 |
|---|---|---|
| ① `tools` 数组 | **恒定的 3 个工具**，不含任何 MCP 痕迹 | **不动** |
| ② system prompt | persona / 环境 / 工具契约。**不含 MCP instructions**（§2.6） | **不动** |
| ③ 对话消息 | detail 结果、调用结果、错误 | 动，但它是**可追加的尾部** |

### 3.2 早期版本依赖的边界条件，现在不存在了

早期设计让服务器 `instructions` 进 system prompt 的 `MCP_SERVERS` 段（order 3100），
于是**"服务器集合在会话内不变"成了前缀稳定的前提**——集合一变，②层就变，
而 3100 的下游是 `TOOLS_SDK`（5000），整份工具契约一起废。

**现在 instructions 不进系统提示词**，那条边界条件随之消失：
提示词里没有任何随服务器集合变化的东西。开关因此可以**在任意时刻翻转**，
连 §2.6 的尾部通知都只是"防模型认知过期"的可选项，不是前缀稳定的必要条件。

### 3.3 与其它生态方案的对比

`dsh-plugin-tool-management` 用 `tools.restrict({ deny })` 隐藏工具，
而 `restrict()` **只作用于调用方 agent 作用域**（预设作用域调用直接报错，已实测），
于是必须逐 agent 挂、逐次重算——其源码里就带着这段说明。

**本插件不需要 `restrict()`**：MCP 工具**根本不注册**，没有东西需要隐藏。
这不是"隐藏得更好"，是**不需要隐藏**。

> 顺带记录：曾评估过"用 `restrict()` 隐藏官方客户端注册的工具，再从一个无 agent 的
> 全局视图重新派发"（内部称"路径 D"）。它可行，但会把 MCP 执行降级成无 agent 绑定的派发，
> **图片准入直接失效**（`exec.agent` 缺失时 model route 解析不出来，图片降级为文本诊断）。
> 这是它被否决的主因，实测见 `measurements.md` §12。

---

## 4. 错误契约

### 4.1 三条实测的投递语义

| 情况 | `run_code`（PTC）的结果 | 模型看到 |
|---|---|---|
| 工具成功 | `isError=false` | 返回值 |
| 工具抛错，程序 `try/catch` 住 | `isError=false` | `ToolCallError { name, message, toolName }` |
| 工具抛错，未被捕获 | **`isError=true`** | `Error: code run failed (exception): ToolCallError: <message>` **+ 完整堆栈** |

原生模式下（无 `run_code` 包裹）：失败的 `tool/result` 直接带 `isError: true`，文本前缀 `Error: `。

### 4.2 四条实现要求

1. **MCP 的 `isError` 必须抛成工具错误**，不要返回 `{ ok: false }`。
   原生 `dsh-mcp-client` 就是这么做的（`lib/index.js:236`：`if (result.isError === true) throw new Error(text)`）；
   两条路径语义必须一致，否则 harness 的失败统计、重复工具提醒、compaction 剪枝全部失真。
2. **抛出的错误必须带 `toolName`**（dsh 的 `ToolCallError` 已经如此）。
3. **message 要短、要分类明确，不要让堆栈冒泡**。
   实测：未捕获时错误文本含 11 行 harness 内部路径（`dsh-ptc-runtime-node/lib/process.js:902:22` …），
   既占 token 又暴露实现细节。
4. **不要做"报错内联 schema"**——见 §7。

### 4.3 错误分类字段

```json
{ "isError": true, "kind": "ENV_MISSING", "message": "…" }
```

| kind | 该给模型的信号 |
|---|---|
| `ENV_MISSING` | 不是参数问题，重试无用 |
| `PARAM_ERROR` | 按提示改参数（错误文本通常已含字段名） |
| `TIMEOUT` | 可重试一次 |

成本：一个词。收益：给模型一个**可以停下来的出口**（见 §6）。

> ⚠️ **2026-10-05 定性**：这是**可选的第三层保险**，不是必须项（§6.3），
> 且 §7.2 已用实验证明「错误文本本身就够用」。**默认不做**，不实现分类字段。

### 4.4 结果投影的三条取舍（`lib/projection.js`）

1. **图片在 `execute` 阶段落盘，而不是留给 `render`。**
   dsh 的 `render(args, value)` 是同步的，而 `attachments.saveImages` 是异步的。
   官方客户端的做法是 WeakMap + `projectContent` 回调；我们把已落盘的引用直接放进
   canonical value，`render` 退化成一次数组返回。

2. **canonical value 里不留原始 base64。**
   官方客户端保留（"raw image data remains available to programmatic callers"）。
   我们不留——一张截图就是几百 KB 的 base64，而 PTC 的程序会原样拿到 canonical value。
   需要字节的调用方走附件服务（引用即句柄）。

3. **图片准入失败不抛错，降级为文本诊断。**
   模型不支持图片输入 / 附件服务没挂 / 路由解析不出来——这些都是环境问题，
   不该让一次工具调用失败。MCP 的原始文本仍完整送达（实测见 `measurements.md` §13.2）。

---

## 5. 预设适配

| 预设 | 工具表 | `mcp_call` 可及性 | 适配方式 |
|---|---|---|---|
| 标准 | 原生，含中间层工具 | 直接可调 | **插件行挂在该预设作用域内** |
| cordis | 同上 | 同上 | 同上 |
| **极简** | 原生 | **完全没有** | **插件行不挂进这个预设** |
| **PTC** | **只有 `run_code`** | 经 `await tools.mcp_call(...)` | 实测通过（见下） |

### 5.0 ⚠️ 挂载位置是本设计的**硬要求**（实测 2026-10-04 / 05）

**两次独立实验的共同结论**：

| 挂在哪 | 极简模式的会话里 |
|---|---|
| 某个**别的预设**内（如 preset-standard） | **不可见** ✅ 隔离成立 |
| **极简预设自己**内 | 可见 |
| **profile（全局）层** | **可见** ⚠️ |

实测输出（隔离 DSH_HOME，`agentPreset=minimal`）：

```
tools = 4
   2223 B  bash                  ← 极简预设自己的
    233 B  mcp_switch_probe      ← 【profile 层】可见
    146 B  probe_global          ← 【profile 层】可见
    160 B  probe_minimalinside   ← 【极简预设内】可见
```

**⇒ profile（全局）层的行会被极简预设继承，这是机制事实，没变。**
（极简下依然可见的 `read`/`edit`/`glob`/`web_search` 等，也都是从全局层继承的；
极简预设的 `plugins` 只决定它"额外挂什么"，**不限制它"继承什么"**。）

> ⛔ **但结论在 2026-10-06 被推翻了。** 上面这条事实当时被读成
> 「所以要挂进预设作用域」——**那是错的**，见 §5.3：预设里的行是**每个预设各起一份实例**，
> 对本插件意味着 N 套 MCP 子进程 + 重复注册同一个 web 路由 + 两份互不可见的开关缓存。
> 正确做法是**全局挂载一份**，再用 `ctx.tools.restrict` 在目标 agent 的 scope 里摘掉可见性。

### 5.0.1 ⚠️ 推论：bundle patch 的 `insert` 行必须带 `disabled: true`

实测发现：只要插件出现在 `dsh.profile.bundles` 里，它的 `cordis.patch.yml` 就被应用，
而其中的 `- insert: - id: dsh-mcp-switch` **落在 profile 层**——
结果是插件**在整个进程里全局挂载**，预设作用域里的那一行变成"第二份"。

**采用的解法**（照抄官方 `dsh-tool-skill` 的成熟模式）：patch 里**仍然声明这一行，但带 `disabled: true`**：

```yaml
- insert:
    - id: dsh-mcp-switch
      name: 'dsh-mcp-switch'
      disabled: true
```

于是 profile 层有一个**停用**的声明（用户在配置里看得见、改一个字段即可启用）。

**启用方式在 §5.3 被推翻过一次**：不是「每个目标预设各挂一行」，
而是**在 profile 层启用这一份**，由插件自己按 `config.excludePresets` 决定哪些预设看不到它。

> ⚠️ **本节曾被写成"patch 故意留空数组 `[]`"——那是错的**，而且与小标题自相矛盾。
> 空数组意味着用户在配置里看不到任何痕迹，无从发现这个插件的存在。
> 修正见 [`implementation.md`](implementation.md) 的「对 `cordis.patch.yml` 的修正要求」一节。
### 5.1 PTC 的实测结论（关键）

生成的 SDK 声明（system prompt 原文）：

```typescript
  chrome_call: {
    tool: string;
    arguments?: Record<string, JsonValue>;
  } & Record<string, JsonValue>;
```

- 声明为空 schema 的参数在 TS 侧落成 **`Record<string, JsonValue>`**，可用。
- **注意它会变成可选（`?`）**；若要必填，需按 dsh 的 schema 语法显式标 `required`。
- 工具表实测 `tools=1`（只有 `run_code`）。
- 模型自述：中间层工具出现在 `ToolArgsMap` / `ToolOutputMap`，"不是可直接调用的工具"，
  只能作为 `await tools.mcp_call(args)` 到达。

### 5.2 极简模式的处理

**不挂插件行**是最干净的做法：极简预设的作用域里根本没有这些工具，连隐藏都不需要。
**不要**用 `tools.restrict()` 去"隐藏"——那是为别的问题设计的，而且有四个抛错点
（非 scoped context、`{}` 空 filter、保留名 `run_code`、未知名）。

---

### 5.3 ⛔ 修正（2026-10-06 实测）：本插件**不能**搬进预设

§5 的表原先写「标准 / cordis：插件行挂在该预设作用域内」。**那条对本插件不成立。**

#### 触发这次修正的 bug

用户实测：**极简模式下三个 mcp 工具没有被摘除**。直接原因是启用时把插件行挂成了
**全局**（`- id: dsh-mcp-switch / disabled: false`），而 profile 层的工具会被极简预设继承——
这正是 §5.0 那张表里「profile（全局）层 → 可见 ⚠」那一行。

#### 为什么不能靠「搬进预设」修

实测（隔离宿主，只配一台 fake 服务器）：

| 挂法 | `fake-mcp-server` 子进程 |
|---|---|
| 全局一份 | **1** |
| 同时挂进 preset-standard 与 preset-ptc | **2** |

dsh 源码的说法是 *「One agent's instance of a service its preset mounted」*——
预设里的行是**每个预设各起一份实例**。对本插件这意味着：

1. **N 个预设 = N 套 MCP 子进程**（同一台服务器被连 N 次）；
2. N 份实例都会去注册同一个 `/mcp-switch` web 路由 —— 谁生效不确定；
3. N 份实例各持一份会话开关的**内存缓存**，互相看不见对方的写入。

而本插件的架构前提恰恰是「连接随 dsh 本体起一份，会话只决定接入哪些服务器」。
⇒ 多份实例会把这个前提打掉。

> 这也正是本项目那份「按预设收窄」生成脚本顶部那条 ⚠ 说的情况：
> 「会 spawn 长驻子进程的行……会把『每个预设一份』变成『每个预设各一套进程』，
> 搬之前必须先确证进程开销。」——**确证了，结论是不搬。**

#### 采用的方案：全局一份 + 按 scope 摘掉可见性

插件**始终全局挂载一份**；对不该看到它的预设（默认 `minimal`），在该 agent 的
**作用域**里用 `ctx.tools.restrict({ deny: [...] })` 把三个工具从可见性里摘掉。
可见性解析在呈现之前，所以那些预设的请求里也不带这三个工具的字节。

要改排除哪些预设用配置：`config.excludePresets`（默认 `['minimal']`）。

#### ⚠ 踩坑：预设要读**会话投影**，不能读 header

`header.agentPreset` 只在会话**创建时**写入。会话创建之后再改选预设，
header 上的值会停在创建时那一个 —— 实测：一个从标准切到极简的会话，
header 里还是 `standard`，于是按 header 判断就什么都摘不掉。

权威来源是 `agentPreset` **会话投影**（`sessionProjections.stateOf(session, 'agentPreset')`）。
`dsh-agent-preset-registry` 自己也只读投影，注释原话是
*「Reconstruction reads the `agentPreset` Session projection, never the header」*。

## 6. 关于"诱导模型先取 detail"

### 6.1 实测到的模型自发行为

context7 四臂（工具名无 description、无 schema）：

| 臂 | mcp_detail | 报错内联 | 首次动作 | detail 调用次数 | 结果 |
|---|---|---|---|---|---|
| A | 有 | 无 | **盲调** | 2（**全部在失败之后**） | 成功 |
| B | 无 | 无 | **盲调** | 0 | 成功 |
| C | 无 | 有 | **盲调** | 0 | 成功 |
| D | 有 | 有 | **盲调** | 2（全部在失败之后） | 成功 |

**四臂全部直接调 `mcp__context7__*`，没有一次先调 `mcp_detail`。**

> ⚠️ **前提已变**：该实验跑在**早期形态**下——那时模型可以直接直呼 `mcp__context7__*`，
> 所以"要不要先取 schema"是一个真实的选择。**现在 MCP 工具根本不注册**，模型只能走
> `mcp_call(server, tool, arguments)`，而它仍然可以在不知道 schema 的情况下**盲调**
> （名字从 `mcp_servers` 得到）。
>
> 所以结论的**精神**仍然成立——**模型倾向于先试一次而不是先查**——但机制不同，
> 且这条结论**需要在当前形态下重测**（见 [`open-questions.md`](open-questions.md)）。

### 6.2 结论

- `mcp_detail` 是**纠错手段**，不是前置步骤。
- **"先取 detail" 应当作为推荐路径写进工具描述，但不能指望模型服从**——实测它不服从。
- **不要为了强制它而加机制性的拦截**（例如"未用过的工具先只回 schema 不执行"）：
  实测显示一次盲调失败的代价约 209 tok，而一次 detail 的代价中位 168 tok、最大 590 tok，
  两者同量级；加拦截会把"一次往返"变成"固定两次往返"，在健康环境里是净亏。

### 6.3 真正该做的是（可选的第三层保险）

若某个 MCP 工具在极端情况下会反复失败（弱模型 + 复杂 schema），
**在错误分类里标注 `PARAM_ERROR` 并在 message 里附上"可调用 `mcp_detail` 获取完整 schema"的提示**——
一句话，零 schema 字节。这比内联 schema 便宜两个数量级。

---

## 7. 两条被证伪的设计（记录在此以免重走）

### 7.1 ❌ "在工具描述里写明：服务器不可用时报告并停止"

**无效。** 反驳证据：原生路径的强制型提示词那一次，模型手里有 **30 个 MCP 工具的完整 description 与 parameters**，
仍然跑 317 秒 / 56,258 字符 reasoning / 68,190 tokens 去试图安装浏览器。

**工具描述是另一段文本输入，与用户的强制指令竞争，而用户指令赢。**

> 模型能否停下，只由 **prompt 的输入者**控制。工具能做的是把失败状态表达得毫无歧义，
> 这样一旦提示词允许停，模型立刻停（实测：许可型 + 原生路径 = 20 秒 / 142 字符 reasoning）；
> 但工具**不能**让一个不允许停的提示词变得可以停。

### 7.2 ❌ "报错时内联该工具的完整 schema"

**冗余，且应当在收益最小的那一类上才有用。** 三条理由：

1. 该分支在本轮实验里**从未被触发**（`results carrying inlined schema = 0`）——
   远端把参数校验失败当**正常工具结果**返回（`isError: true` 的 content）而非抛异常。
2. 更早的实验已证明**错误文本本身就够用**：四臂全部只错一次就纠正，**包括无 detail 的 B 臂**。
3. **两条通路并存时模型走 detail**：ARM D 的轨迹是 `盲调 → mcp_detail → 改对`，不是等报错塞 schema。

代价侧：单工具 schema 实测中位 842 字符（168 tok）、最大 2,959 字符（590 tok），
且该结果**此后每轮作为历史被携带**。

**替代方案**：§4.3 的 `kind` 分类字段——一个词，零 schema 字节。

---

## 8. 界面（web / 桌面，后续 TUI）

### 8.1 承载形态：设置页，用原生组件

用户要求界面**与设置内原生组件风格一致**，且要覆盖 web 与 Electron 桌面壳。
⇒ 放进设置页，用原生组件库渲染。

**实测到的三个 seam（2026-10-05，读 dsh 0.2.0-rc.2 源码）**：

| 能力 | 机制 |
|---|---|
| 浏览器半包格式 | `window.__ModuleLoader__.load({ id, factory })`，导出 `{ apply, inject }`。**纯 JS，不需要构建步骤** |
| 挂载点 | 60 个 slot；设置相关有 `settings.section` / `settings.general.item` / `settings.plugins.tab` / `settings.action` / `settings.header` / `settings.launcher` |
| 原生组件 | `@deepseek-ai/dsh-client-ui-primitives`：**`Switch`**、`StateDot`、`Button`、`Input`、`Pill`、`SegmentedControl`、`Modal`、`Toast`，以及 **`settings-form/`**（`SettingsForm` + `fields`） |

三个形状都对得上：开关用 `Switch`，连接态用 `StateDot`，布局用 `settings-form`。

参考实现：第三方插件 `@linxin666/dsh-client-ui-session-id`（已发布 npm，浏览器半包 22 KB）。
**2026-10-06 补：承载形态定为两处，不是一处 —— 而且切开它的是一条真实的界线。**

设置页槽位（`settings.general.item`）**没有 `sessionId` 属性**：它是全局槽位，
拿不到「当前是哪个会话」。第一版只能照第三方插件的写法，从 `sessions.list` 里推主视图
会话 —— 本来就是脆的。而会话头部操作带（`conversation.session.header.actions`，见 §8.5）
是 `scope: 'session'`，`sessionId` 由宿主直接下发。

⇒ 两处，各归其位：

| 事实 | 归属 | 理由 |
|---|---|---|
| 哪些服务器配好了、连没连上、要不要重连 | 设置页 | **连接是全局的**：服务器随 dsh 本体启动，所有会话共用一条连接，没有会话时也该看得见 |
| 本会话接入了哪几台 | 会话头部操作带 | **挂载是会话的** |

这不是「两个地方各摆一份开关」，而是全局事实与会话事实各自归位。官方
`dsh-client-ui-permission-presets` 就是这个形状：设置里放**新会话的默认**，
composer 里放本次会话的覆盖。

### 8.2 开关交互的三条要求

1. **即时反馈**：本地乐观状态 + 写失败回滚并说明原因（`dsh-plugin-tool-management` 的先例）。
2. **加载可见**：连接中/重连中/失败分级展示，不用"卡住"表达等待。
3. **开关锁死**：一次操作进行中禁用该行，防连点。

### 8.3 数据通道（✅ 已实测跑通，见下方「发现五」）

UI 组件那一半已经清楚，**卡在浏览器怎么拿到服务端状态、怎么回写**。

**发现一：第三方插件目前都是浏览器单边的。**
参考插件的服务端 `apply` 是**空函数**；它只读宿主已有的客户端 store（`ctx.get("sessions")`）。

**发现二：自定义服务端 API 走代码生成管线。**
`typert.remotes.register(contribution)` 要求 `TypertContribution` 携带**生成的**产物：
Zod schema 工厂 + 反射模型（`TypertPackageModel`）+ invocation 描述符。
类型注释原话是 *"Pure generated-artifact and runtime-registry types"*。
dsh 自家的 `@deepseek-ai/dsh-api-*` 由构建产出这些；**第三方手写等于对抗一个未公开的生成契约**，
必然随 dsh 内部演进碎裂——与既定的维护成本原则冲突。

**发现三：有一个现成的命名空间 KV 通道。**
`@deepseek-ai/dsh-api-settings-controller` 的 `SettingsController extends TypertRemoteService`，
暴露 `describe` / `update(ns, patch, expectedRevision)` / `replace` / `mutate`；
服务端 `dsh-settings` 的 `SettingsForms` 有同名方法，并**发出 `settings/document-updated(ns, revision)`**
——服务端能订阅到变更。

**发现五（✅ 实测通过的最终路径）：自己注册 web 路由 + 复用 connection 的围栏。**

实测装置：`lab/probes/probe-channel.mjs` 挂在一个隔离的 DSH_HOME（独立 profile，端口 3099），
先用 curl、再用**真实浏览器**（chrome-devtools）打这个路由。

| 候选 | 结果 |
|---|---|
| ❌ `ctx.connection.rpc.handle(channel, handler)` | **第三方不可用**。它内部走 `owner.effect(() => owner.webServer.register(route))`，而 `owner = this.ctx` 是 **connection 服务自己的 ctx**（`inject` 只有 `credentials`），被 cordis 的 inject 守卫挡下：`cannot get property "webServer" without inject`。在调用方写 `inject = ['connection','webServer']` **也没用**，在 `ctx.inject(['webServer'], cb)` 里访问**也没用**（两条都实测过）。旁证：全仓**没有任何包**用 `rpc.handle`，只有 `dsh-api-gateway` 用 `rpc.intercept`（那个不碰 webServer，所以能跑） |
| ❌ `intercept('/api', matches, handler)` | `/api` 只允许**一个** interceptor，已被 `dsh-api-gateway` 占用 |
| ✅ **自己注册 web 路由 + `connection.requestRejection()`** | **跑通** |

**服务端配方**（实测可用）：

```js
ctx.inject(['webServer'], (inner) => {
  // 必须 return disposer —— 不 return 的话 HMR 时旧路由不注销，
  // 而重复注册同一个 (kind, path) 会抛，通道静默消失。
  inner.effect(() => { const dispose = inner.webServer.register({
    kind: 'prefix',
    path: '/mcp-switch',
    handler: async (req, res) => {
      // 与 /api 同一道围栏：Host/Origin 检查 + 浏览器认证。
      const rejection = inner.connection.requestRejection(req);
      if (rejection !== undefined) { res.writeHead(rejection); res.end(...); return; }
      ... 自己的 JSON 协议 ...
    },
  }); return dispose; }, 'dsh-mcp-switch.route');
});
```

**实测结果**：

- `curl` 无浏览器凭据 → **HTTP 401 unauthorized**（围栏生效，不是裸路由）
- 真实浏览器同源 `fetch('/mcp-switch-probe/ping', {method:'POST', …})` → **HTTP 200** + 正确 JSON

⚠️ 注意 `connection` 上**没有** `applyTrustChecks`（那在 `HostConnectionHandle` 类型上，服务实例上没有）。
可用的是 `requestRejection` / `admit` / `authorizeIndex` / `authenticatedUrl`。

**发现四：框架自带"会话级投影"通道——但对本项目【不可用】。**

> ⛔ **2026-10-05 实测否决**：投影是"对会话事件的纯 fold"，而**我们写不出它需要的那种事件**。
> 两条独立原因（详见 §2.10 的实测否决）：`append` 无法设置 `ignorable`；
> 而读路径对未知事件类型直接拒绝重建会话。唯一能写的已知类型 `user/message` 是 surface 的，
> 会进对话——那不是我们要的。
>
> ⇒ 下面这段保留作为**机制记录**（它本身是真实可用的框架能力，只是不适配我们的场景），
> 但**不构成本项目的路线**。

- 服务端：`ctx.sessionProjections.register(definition)`（`@deepseek-ai/dsh-session-projection`）
- 浏览器：`useProjection(key)`（"the fifth framework hook seat"，ui-renderer 绑定）

它的定位原话是：*"the host is the only computation site"*、
*"a domain ships projection support with **zero client code**"*。
即：**它不是自定义 Remote，是框架的扩展点**——不需要 typert 生成，也不需要借设置命名空间。

**但它有精确的适配边界。** `ProjectionDefinition` 是**对会话事件的纯同步 fold**：
`init(header, offset)` → `apply(state, event)`（每个已提交事件驱动一次）→ `wire.view(state)`，
state 必须是纯 JSON、函数必须同步。

| 要送到浏览器的东西 | 投影能否承载 |
|---|---|
| **哪些服务器在本会话启用** | ✅ 可以——前提是开关变更**记成一条会话事件**（skill-catalog 就是这么做的） |
| **连接态相位与错误原文** | ❌ **不能**——那是进程级运行期状态，不是会话事件的函数 |

⇒ 三条可行路线：

| | A. 借设置命名空间做通道 | B. 手写 typert contribution |
|---|---|---|
| 服务端状态 | 移进设置命名空间（每会话一个键） | 保持现状（自己的文件） |
| 浏览器半 | 读设置客户端 store + 调 `update` | 调自定义 Remote |
| 并发 | **revision 控制，白送** | 自己做 |
| 风险 | 把每会话状态塞进全局设置文档，语义略勉强 | 对抗生成契约，随 dsh 更新碎裂 |

**倾向 A**：不对抗任何未公开契约，且 revision 控制顺带解决多写者问题。
代价是 `lib/store.js` 的每会话一文件要让位给设置文档——**这是需要确认的架构变更**。

### 8.5 会话头部操作带（2026-10-06 实测跑通）

用户定的是「顶部那一行，跟子智能体、预设模式、后台任务同一行，下拉展开服务器列表」。

**槽位契约**（读 0.2.0-rc.2 源码 + 真实浏览器双重复核）：

| 项 | 值 |
|---|---|
| 槽位 | `conversation.session.header.actions` |
| 声明 | `kind: 'list'`、`scope: 'session'`（`dsh-client-ui-conversation` 的 `contract/slots.d.ts`） |
| props | **`sessionId` 直接下发**（`InjectParams`：session scope ⇒ `[sessionId]`），外加 `locale` 给的 `t` |
| 前置声明 | 槽位所属包必须写进 `package.json` 的 `dsh.client.inject` —— 对齐 `dsh-client-ui-jobs` / `-subagent` 的写法。漏了不报错，整项静默不渲染 |

同槽位原生条目的 `order`：`subagent-catalog` -30 / `agent-team` -20 / `agent-preset` -10 /
`job-list` 20。本插件取 **30**，落在「后台任务」右边。

**视觉对齐**：原生插件用 CSS Modules，类名由打包器生成；本插件无构建步骤，所以自己注入一段
`<style data-plugin-css=…>`（`data-plugin-css` 正是原生插件的去重标记），样式照
`dsh-client-ui-jobs` 的 `JobListAction` 模块移植，类名前缀换成 `Msw_`。触发器与菜单的几何、
`--dsw-alias-*` 设计令牌、`useDismissOnOutsidePointer` 点外关闭、Escape 关闭、出视口时横向
平移 —— 全部对齐官方实现，不自己发明一套。

**实测（隔离宿主端口 3099 + chrome-devtools 真实浏览器）**：

- 头部那一行渲染为 `7 个子智能体 │ PTC 模式 │ ● MCP 0/3 ⌄`，位置正确
- 展开后三台服务器的相位、工具数、错误文本、重试按钮、开关齐全；失败行的开关禁用并带说明
- 打开 `fake` → 开关变蓝、头部计数变 `MCP 1/3`、服务端真的接入
- **切到另一个会话 → `MCP 0/3`**（证实开关确实是会话级的），切回来仍是 `1/3`
- 关掉 `fake` → 回到 `MCP 0/3`；设置页那一份同步反映同一状态

**踩到并修掉的坑**：第一版菜单行布局塌陷 —— 长错误文本把重试按钮挤成两行（「重」「试」），
开关被裁到菜单外。根因是 flex 项默认 `min-width: auto` 不肯收缩。修法：相位文本 `flex:none`、
错误文本 `flex:0 1 auto; min-width:0` + 省略号、重试按钮 `white-space:nowrap`。
`lab/client-static-smoke.mjs` 现在把「CSS 规则 ↔ 类名映射」的双向一致做成断言，防它回来。

### 8.4 后续 TUI

`@deepseek-harness-tui/dsh-tui` 存在但目前无插件适配 MCP 管理。
本插件的界面层应当与宿主层分离，使 TUI 只实现一个薄接口。

---

## 9. 未决项

见 [`open-questions.md`](open-questions.md)。

---

*文档版本: 0.4.0*
*更新日期: 2026-10-07*
