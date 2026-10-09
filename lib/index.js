/**
 * dsh-mcp-switch — 宿主层。
 *
 * 设计见 docs/design.md；实测依据见 docs/measurements.md；实现进度见 docs/implementation.md。
 *
 * 五条硬约束（违反任何一条，设计即失效）：
 *   1. 工具表在会话内逐字节不变 —— 开关与连接态只改运行时返回值，不改任何声明。
 *   2. 本插件的行必须挂【预设作用域】，且 bundle patch 里声明为 disabled: true。
 *   3. MCP 的 isError 必须抛成工具错误，不要返回 { ok: false }。
 *   4. 工具注册必须发生在 apply 的【同步】阶段（跨 await 注册，模型看不到）。
 *   5. 一个 MCP 连不上**不能**拖垮 dsh 启动 —— 与官方客户端的
 *      failOnStartupError 是有意分歧，见 docs/design.md。
 *
 * 三个概念分开存，不要互相污染：
 *   配置态 —— 用户声明了哪些服务器（本文件，挂载时固定）
 *   连接态 —— 每台此刻能不能用（lib/registry.js）
 *   开关态 —— 用户想让哪些接入本会话（本文件 SessionSwitches）
 *
 * 另有**新会话默认**：它不是第四个概念，是开关态的**初始值** —— 只在某个会话
 * 自己没有状态文件时生效。一旦用户在该会话动过开关，那份文件就固定下来，
 * 之后改默认不会再影响它（见 lib/store.js 的 DefaultsStore）。
 */

import { normalizeServer, startConnection } from './connection.js';
import { ServerRegistry } from './registry.js';
import { extractText, projectMcpContent } from './projection.js';
import { DefaultsStore, SessionStore } from './store.js';
import { registerChannel } from './channel.js';

export const name = 'dsh-mcp-switch';

/** 官方 dsh 服务的软依赖。 */
export const inject = ['tools'];

const LOOSE = { type: 'object', properties: {}, additionalProperties: true };

/** 本插件注册的三个工具。`tools.restrict` 只能点名已知的全局工具，所以要与注册处保持一致。 */
const TOOL_NAMES = ['mcp_servers', 'mcp_detail', 'mcp_call'];

/**
 * 默认**不暴露**本插件工具的 agent 预设。
 *
 * 为什么不是「把插件行搬进预设」（design §5 原本的处方）：
 * 预设里的行会在**每个预设各起一份实例**（实测 2026-10-06：把本插件同时挂进
 * preset-standard 与 preset-ptc，`fake-mcp-server` 子进程从 1 个变成 2 个，
 * 且两份实例都会去注册同一个 `/mcp-switch` web 路由、各自持有一份会话开关缓存）。
 * 本插件的架构前提恰恰是「连接随 dsh 本体起一份，会话只决定接入哪些服务器」——
 * 多份实例会把这个前提打掉，还会让两份缓存互相看不见对方的写入。
 *
 * 所以改成：插件**仍然全局挂载一份**，只在被排除的预设的 agent 作用域里，
 * 用 `ctx.tools.restrict` 把这三个工具从**该作用域的可见性**里摘掉。
 * 工具的字节因此也不进那个预设的请求（可见性解析在呈现之前）。
 */
const DEFAULT_EXCLUDED_PRESETS = ['minimal'];

function textOutput() {
  return {
    schema: LOOSE,
    render: (_args, value) => {
      let text;
      if (typeof value === 'string') text = value;
      else if (value && typeof value.message === 'string') text = value.message;
      else text = JSON.stringify(value, null, 2);
      return [{ type: 'text', text }];
    },
  };
}

/**
 * `config.defaults` —— 部署声明的**新会话默认**（design.md §2.13）。
 *
 * 与 `config.servers`（声明存在哪些服务器）不同，这一项声明的是**新会话默认接入哪些**。
 * 它是 headless / CI 这类没有设置页的形态唯一能表达该意图的地方。
 *
 * 三种输入：
 *   - `undefined`：没有声明 —— 仍然读新会话默认文件（即今天的行为）
 *   - 数组：声明生效，默认文件被忽略（挂载时告警一次）
 *   - 其它：非法，记一条 warn 后按"没有声明"处理（硬约束第 5 条：不拖垮挂载）
 *
 * @returns 归一化后的名字数组（已排序去重），或 `undefined` 表示没有声明
 */
function parseConfiguredDefaults(raw, warn) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    warn(`config.defaults must be an array of server names; got ${typeof raw} — ignoring it`);
    return undefined;
  }
  const names = new Set();
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry === '') {
      warn(`config.defaults entries must be non-empty strings; ignoring ${JSON.stringify(entry)}`);
      continue;
    }
    names.add(entry);
  }
  return [...names].sort();
}

/**
 * 首呼竞态兜底：等一台还在 connecting 的服务器落定多久（`config.readyWaitMs` 可覆盖）。
 *
 * 30 s 的依据是实测：npx 冷启到 ready 约 20 s（见 docs/measurements.md）。
 */
const DEFAULT_READY_WAIT_MS = 30_000;

/**
 * 服务器正处于 `connecting` 时，等它离开这个相位（或超时 / 被中止）。
 *
 * 为什么需要它（2026-10-08 headless 实测）：一次性 run 里模型第一次调用常常早于 MCP
 * 子进程就绪，于是 `mcp_detail` 拿到空目录回 `NO_TOOLS_KNOWN`、`mcp_call` 回"稍后再试" ——
 * 而 headless 没有第二次机会。等待**有界**（`readyWaitMs`）、可被 `exec.signal` 中止，
 * 失败相位不等待（调用方在此之前已经挡掉）。
 *
 * 订阅**先于**读相位：订阅前的那一小段窗口里服务器可能已经 ready，顺序反了会白等到超时。
 *
 * @returns `{ phase, waitedMs, timedOut, aborted }`
 */
async function waitWhileConnecting(registry, name, options) {
  const timeoutMs = options.timeoutMs;
  const signal = options.signal;
  const started = Date.now();
  const phaseNow = () => registry.get(name)?.phase ?? 'unknown';
  const settled = (extra) => ({ phase: phaseNow(), waitedMs: Date.now() - started, timedOut: false, aborted: false, ...extra });
  if (phaseNow() !== 'connecting') return settled();
  if (!(timeoutMs > 0)) return settled({ timedOut: true, waitedMs: 0 });

  const outcome = await new Promise((resolve) => {
    let finished = false;
    let unsubscribe = () => {};
    let timer;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      unsubscribe();
      resolve(value);
    };
    const onAbort = () => finish({ timedOut: false, aborted: true });
    // 只认**这台**服务器的落定：别的服务器变更与它无关。
    unsubscribe = registry.onChange((change) => {
      if (change?.name !== name) return;
      if (phaseNow() !== 'connecting') finish({ timedOut: false, aborted: false });
    });
    timer = setTimeout(() => finish({ timedOut: true, aborted: false }), timeoutMs);
    timer.unref?.();
    if (signal?.aborted === true) onAbort();
    else {
      signal?.addEventListener?.('abort', onAbort, { once: true });
      // 订阅之后再读一次相位：订阅之前的窗口里它可能已经落定。
      if (phaseNow() !== 'connecting') finish({ timedOut: false, aborted: false });
    }
  });
  return settled(outcome);
}

/**
 * 会话级开关的状态：内存缓存 + 冻结规则，持久化委托给 lib/store.js。
 *
 * 「某工具是否用过」不在此处维护 —— 它从会话日志投影（见 docs/design.md §2.1）。
 *
 * 新会话默认**全部关闭**：文件不存在就是空集，这是明确契约不是巧合。
 */
class SessionSwitches {
  /** 每会话【自己的】状态（不含继承）。只有成功读到或成功写入过才进这里。 */
  #own = new Map();
  /** 每会话一条写入链：读-改-写跨 await，并发调用必须串行，否则互相覆盖。 */
  #chains = new Map();
  /**
   * 血缘表：子会话 id → 直接父会话 id。
   *
   * **为什么需要它**：一次 tool 调用的 exec 只带**直接**父会话（`header.parentSession`），
   * 而嵌套委派（孙 → 子 → 根）要求逐跳上溯。光靠 exec 只能跳一层，三层以上就断在中间。
   * dsh 的 `agent/created` 事件带完整 header，于是按 agent 逐个记边即可补全整条链。
   */
  #lineage = new Map();
  #registry;
  #store;

  /** 读一个会话持久 header 里的 parentSession（活跃会话）。由 apply 注入。 */
  #headerParent = () => undefined;

  /**
   * 新会话默认的读取口。由 apply 注入（它是异步加载的，所以这里是函数不是值）。
   * 出荷为 `[]` —— 全关仍是默认行为。
   */
  #defaults = async () => [];

  constructor(registry, store, options = {}) {
    this.#registry = registry;
    this.#store = store;
    if (typeof options.headerParent === 'function') this.#headerParent = options.headerParent;
    if (typeof options.defaults === 'function') this.#defaults = options.defaults;
  }

  /** 读一个会话【自己】的状态，带缓存。 */
  async #ownState(sessionId) {
    const cached = this.#own.get(sessionId);
    if (cached !== undefined) return { servers: cached, readable: true, exists: true };
    const loaded = await this.#store.load(sessionId);
    // 读不出来时**不缓存**：下一次再试一遍，而不是把"空"当成事实记下来。
    if (loaded.readable && loaded.exists) this.#own.set(sessionId, loaded.servers);
    return loaded;
  }

  /**
   * 忘掉一个会话的所有进程内痕迹。由 `agent/disposed` 调用。
   *
   * 不清理的话：内存随会话数单调增长；更糟的是 session id 被复用（fork/删除）时，
   * 新会话会静默继承上一代的父指针与开关（审查 M4）。
   */
  forget(agent) {
    const id = agent?.session?.header?.id;
    if (typeof id !== 'string' || id === '') return;
    this.#lineage.delete(id);
    this.#own.delete(id);
    this.#chains.delete(id);
  }

  /**
   * 从一个**裸 session id** 造出带血缘的 ref。
   *
   * 通道侧（浏览器请求）没有活的 session header，只能查血缘表。
   * 拿不到父会话时返回 `{id}` —— 上溯会在这一层停下，安全。
   */
  refFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    const parent = this.#lineage.get(sessionId);
    return parent === undefined ? { id: sessionId } : { id: sessionId, parentSession: parent };
  }

  /**
   * 记一条血缘边。由 `agent/created` 对**每个** agent 调用，
   * 这样即使某个中间层从不调用我们的工具，链条也是完整的。
   */
  remember(agent) {
    const header = agent?.session?.header;
    if (header === undefined || typeof header.id !== 'string') return;
    if (typeof header.parentSession === 'string' && header.parentSession !== '') {
      this.#lineage.set(header.id, header.parentSession);
    }
  }

  /**
   * 解析该会话**实际生效**的开关。
   *
   * 规则（design.md §2.9）：**自己有状态文件就用自己文件，否则沿 parentSession 上溯**，
   * 取第一个有文件的祖先。用户意图只存在根会话上，子代理只读。
   *
   * 逐跳来源：第一跳用调用方给的 `ref.parentSession`（来自活的 header，最可靠），
   * 之后每跳查血缘表。少了后者，嵌套委派会在第二跳断掉。
   *
   * `seen` 集合 + 深度上限是防御性的：血缘理论上无环，
   * 但损坏的状态或意外的 header 不该让进程转死。
   */
  async #resolve(ref) {
    const seen = new Set();
    let cursor = ref;
    for (let depth = 0; depth < MAX_INHERIT_DEPTH && cursor !== undefined; depth += 1) {
      if (seen.has(cursor.id)) break; // 环
      seen.add(cursor.id);
      const own = await this.#ownState(cursor.id);
      if (!own.readable) return { servers: [], readable: false, source: cursor.id, inherited: false };
      if (own.exists) {
        // 同样给副本：own.servers 是 #own 缓存里的数组，外泄活引用等于把内部状态交给调用方（审查 S2）。
        return { servers: own.servers.slice(), readable: true, source: cursor.id, inherited: cursor.id !== ref.id };
      }
      // 逐跳取父会话，三个来源按可靠性排序：
      //   1. 调用方给的 `parentSession`（活的 header，最可靠）
      //   2. 进程内血缘表（agent/created 喂的）
      //   3. **活跃会话的持久 header**（`ctx.sessions.get(id).header.parentSession`）
      // 缺了 3 的话，只要中间层没被 agent/created 覆盖到（插件重载、事件早于挂载），
      // 整条链就在第二跳断掉（审查 S1）。
      const parent = cursor.parentSession ?? this.#lineage.get(cursor.id) ?? this.#headerParent(cursor.id);
      cursor = parent === undefined ? undefined : { id: parent };
    }
    // 走到这里 = 整条血缘链上没有任何一个会话有自己的状态文件。
    // 落到**新会话默认**（它本身出荷为全关，所以新装的行为和没有这个特性时一致）。
    return {
      servers: await this.#defaults(),
      readable: true,
      source: undefined,
      inherited: false,
      fromDefault: true,
    };
  }

  /**
   * 该会话实际生效的已启用服务器。
   *
   * @param session - 裸 session id，或 `{ id, parentSession }`（子代理继承需要后者）
   * @returns 已排序的服务器名数组
   */
  async serversFor(session) {
    const ref = normalizeSessionRef(session);
    if (ref === undefined) return [];
    await (this.#chains.get(ref.id) ?? Promise.resolve()); // 等在途写入落定，别读旧值
    return (await this.#resolve(ref)).servers;
  }

  /** 连带说出这个值是从哪个会话继承来的（GUI 与诊断用）。 */
  async resolutionFor(session) {
    const ref = normalizeSessionRef(session);
    if (ref === undefined) return { servers: [], readable: true, source: undefined, inherited: false };
    await (this.#chains.get(ref.id) ?? Promise.resolve());
    return await this.#resolve(ref);
  }

  /**
   * 改一个会话开关。
   *
   * 冻结规则在这里强制执行（而不是在 UI 里）：连接态不是 ready/connecting 时，
   * 该服务器的开关既不能开也不能关。UI 侧的禁用只是同一规则的呈现。
   *
   * @throws {Error} 该服务器的连接态冻结了开关
   */
  /**
   * 改一个会话开关。
   *
   * **按会话串行**：读-改-写跨了 await，两个并发 set（GUI 连点、将来的批量开启）
   * 会各自读到同一个旧值、各自写回，后写的那次把前一次的意图整份覆盖掉，
   * 而且两次都返回"成功"。实测复现过。
   */
  async set(session, server, enabled) {
    const ref = normalizeSessionRef(session);
    if (ref === undefined) throw new Error(`cannot change the switch for "${server}": no session context`);
    const run = (this.#chains.get(ref.id) ?? Promise.resolve()).then(
      () => this.#applySet(ref, server, enabled),
      () => this.#applySet(ref, server, enabled),
    );
    // 链上只保留"已落定"，不让异常沿着链传播给下一个调用者。
    this.#chains.set(ref.id, run.then(() => {}, () => {}));
    return await run;
  }

  /**
   * 串行链内部的入口：先拿**跨进程**写锁，再进实际写入。
   *
   * 进程内已有按会话的串行链，但两个共用同一个 DSH_HOME 的 dsh 进程之间没有 ——
   * 两边各自读到同一份旧值、各自写回，后写的把前一次的选择整份覆盖掉（审查 N7）。
   * 锁必须包住**整段读-改-写**，所以 `#resolve` 也在锁内。
   *
   * **不要**在这里 await 链本身（会死锁）。
   */
  async #applySet(ref, server, enabled) {
    return await this.#store.withLock(ref.id, () => this.#applySetLocked(ref, server, enabled));
  }

  /** 锁内实际的读-改-写。 */
  async #applySetLocked(ref, server, enabled) {
    // 冻结检查放在链内：排队期间连接态可能已经变了。
    if (!this.#registry.isSwitchEditable(server)) {
      const phase = this.#registry.get(server)?.phase ?? 'unknown';
      throw new Error(`server "${server}" switch is frozen while phase=${phase}`);
    }
    // 基线是**实际生效**的值（可能继承自父会话，也可能是新会话默认）。
    // 首次写入会把这份基线**固化**成该会话自己的文件 —— 这就是「用户手动覆盖」的语义：
    // 从这一刻起，改默认不再影响这个会话。
    const resolved = await this.#resolve(ref);
    // 读不出来还写，就是用空集覆盖用户原有的意图。宁可失败。
    if (!resolved.readable) {
      throw new Error(
        `refusing to change the switch for "${server}": the stored state of session "${resolved.source}" ` +
        'could not be read, so writing would overwrite it',
      );
    }
    const next = new Set(resolved.servers);
    if (enabled) next.add(server);
    else next.delete(server);
    // 先写盘、成功后才改内存 —— 反过来会让写失败变成内存与磁盘的静默分叉。
    await this.#store.save(ref.id, next);
    const committed = [...next].sort();
    this.#own.set(ref.id, committed);
    return committed;
  }
}

/** 子代理继承时沿 parentSession 上溯的硬上限（dsh 默认最大委派深度是 10）。 */
const MAX_INHERIT_DEPTH = 32;

/**
 * 把调用方给的东西归一成 `{ id, parentSession? }`。
 *
 * 接受裸字符串（没有血缘信息，无法继承）或带血缘的对象。空 id 一律当"没有会话上下文"。
 */
function normalizeSessionRef(session) {
  if (typeof session === 'string') return session === '' ? undefined : { id: session };
  if (session === null || typeof session !== 'object') return undefined;
  if (typeof session.id !== 'string' || session.id === '') return undefined;
  return {
    id: session.id,
    ...(typeof session.parentSession === 'string' && session.parentSession !== ''
      ? { parentSession: session.parentSession }
      : {}),
  };
}

/**
 * 从一次工具执行里取出会话标识**与血缘**。
 *
 * `parentSession` 是子代理继承的唯一线索 —— dsh 在子会话的 header 里落盘了它
 * （`dsh-subagent` 的 `childSessionMeta`），所以不需要自己维护父子关系。
 */
function sessionRefOf(exec) {
  const header = exec?.agent?.session?.header;
  if (header === undefined) return undefined;
  return normalizeSessionRef({ id: header.id, parentSession: header.parentSession });
}

/**
 * 挂载宿主层。
 *
 * 注册全部发生在 apply 的同步阶段 —— 这是硬要求（见文件头第 4 条）。
 */
export function apply(ctx, config = {}) {
  const registry = new ServerRegistry();
  const store = new SessionStore({ warn: (message) => ctx.logger?.warn?.(message) });

  // ---- 0. 新会话默认 --------------------------------------------------------
  // 只是**开关态的初始值**，不是第四个概念：会话自己没有状态文件时才生效。
  // 读不出来时退化为空集继续跑，绝不因为它让插件挂载失败（理由见 lib/store.js）。
  // 部署声明的新会话默认（config.defaults）：写了它，默认文件就被忽略（design.md §2.13）。
  // 没有设置页的形态（headless / CI）只有这一条路能声明"这次跑该接入哪些服务器"。
  const configuredDefaults = parseConfiguredDefaults(config.defaults, (message) =>
    ctx.logger?.warn?.('dsh-mcp-switch: ' + message));

  const defaultsStore = new DefaultsStore({ warn: (message) => ctx.logger?.warn?.(message) });
  let defaultServers = [];
  let defaultsReadable = true;
  /** 磁盘上有没有那份默认文件；决定 defaultsSource 是 'store' 还是 'none'。 */
  let defaultsExists = false;
  // 写入同样要串行：读-改-写跨 await，GUI 连点会互相覆盖（与会话开关同一个道理）。
  let defaultsChain = Promise.resolve();
  const defaultsReady = defaultsStore.load().then((loaded) => {
    defaultServers = loaded.servers;
    defaultsReadable = loaded.readable;
    defaultsExists = loaded.exists === true;
    if (!loaded.readable) {
      ctx.logger?.warn?.('dsh-mcp-switch: the new-session default could not be read; treating it as empty');
    }
    // 两者同时存在 = 设置页写的东西不会生效。这件事必须在**挂载时**说一次，
    // 否则现场表现是"设置页失灵"（design.md §2.13 的已知取舍）。
    if (configuredDefaults !== undefined && defaultsExists) {
      ctx.logger?.warn?.(
        'dsh-mcp-switch: config.defaults is set, so the new-session default file is ignored ' +
        `(${defaultsStore.path()}); the Settings page writes a value that will not take effect`,
      );
    }
  });
  // **必须给副本**：消费者（解析链 → #applySet 的基线固化）会拿它当「这个会话该写什么」的依据。
  // 交活引用的话，用户点「新会话默认」的同一瞬间，另一个正在调 mcp_servers 的会话会读到
  // 半更新的集合、并把它固化进自己的状态文件 —— 静默写错，且此后改默认不再影响它（审查 S1）。
  // 生效值 + **来源**。来源要给模型看见（`mcp_servers.defaultsSource`）：
  // "默认来自 profile 声明还是设置页"正是"改了设置页为什么不生效"的答案。
  const readDefaultsState = async () => {
    await defaultsReady;
    const storeServers = defaultServers.slice();
    if (configuredDefaults !== undefined) {
      return {
        servers: configuredDefaults.slice(),
        source: 'config',
        readable: true,
        storeExists: defaultsExists,
        storeServers,
      };
    }
    return {
      servers: storeServers,
      source: defaultsExists ? 'store' : 'none',
      readable: defaultsReadable,
      storeExists: defaultsExists,
      storeServers,
    };
  };
  const readDefaults = () => readDefaultsState().then((state) => state.servers);
  const writeDefaults = (next) => {
    const run = defaultsChain.then(() => defaultsStore.save(next), () => defaultsStore.save(next));
    defaultsChain = run.then(() => {}, () => {});
    return run.then(() => {
      defaultServers = [...next].sort();
      defaultsReadable = true;
      defaultsExists = true;
      return defaultServers;
    });
  };

  // 血缘的第三来源：活跃会话的持久 header。软注入 —— 服务缺位时退化为 undefined，不抛。
  let headerParent = () => undefined;
  /** 这个 session id 是否是真实存在的会话；拿不到 sessions 服务时放行。见软注入处。 */
  let knownSession = () => true;
  ctx.inject(['sessions'], (sessionCtx) => {
    headerParent = (sessionId) => {
      try { return sessionCtx.sessions.get(sessionId)?.header?.parentSession; } catch { return undefined; }
    };
    /**
     * 这个 session id 是不是一个**真实存在**的会话。
     *
     * 通道只要过了围栏（浏览器认证 + Host/Origin）就进得来，而 toggle 会为一个从未见过的
     * id **凭空建一个状态文件** —— 那正是孤儿文件的来源，而且目前没有清理入口（审查 N5）。
     * UUID 猜不到，但「不要凭一个字符串就在磁盘上落文件」是该有的纪律。
     *
     * 拿不到 sessions 服务时**放行**：这是纵深防御，不是权限模型；让一个软依赖的缺席
     * 把功能整个关掉是过度收紧。
     */
    knownSession = (sessionId) => {
      try { return sessionCtx.sessions.get(sessionId) !== undefined; } catch { return true; }
    };
  });
  const switches = new SessionSwitches(registry, store, {
    headerParent: (id) => headerParent(id),
    defaults: readDefaults,
  });
  /** @type {Map<string, ReturnType<typeof startConnection>>} */
  const connections = new Map();
  /** @type {Map<string, object>} 归一化配置，按名字索引 */
  const normalized = new Map();

  // ---- 1. 配置态：逐条归一化并登记 -----------------------------------------
  // 一条坏配置只让它自己那行变红，不拖垮挂载（硬约束第 5 条）。
  const rawEntries = Array.isArray(config.servers) ? config.servers : [];
  rawEntries.forEach((raw, index) => {
    try {
      const server = normalizeServer(raw);
      if (normalized.has(server.name)) {
        throw new Error(`duplicate server name "${server.name}"`);
      }
      normalized.set(server.name, server);
      registry.declare(server);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallback = typeof raw?.name === 'string' && raw.name !== '' ? raw.name : `#${index}`;
      registry.declareConfigError(fallback, message, raw);
      ctx.logger?.error?.(`dsh-mcp-switch: server entry #${index} rejected: ${message}`);
    }
  });
  // config.defaults 点名了不存在的服务器：**不拒绝**（服务器列表以后可能变，默认文件里也允许
  // 留着暂时没配置的名字），但必须吭声 —— 否则现场表现是"声明了却没生效"且毫无线索。
  for (const declared of configuredDefaults ?? []) {
    if (!normalized.has(declared)) {
      ctx.logger?.warn?.(`dsh-mcp-switch: config.defaults lists "${declared}", which is not a configured server`);
    }
  }

  // ---- 2. 连接态：逐台启动。失败只记账，不抛 ---------------------------------
  for (const server of normalized.values()) {
    const serverName = server.name;
    const handle = startConnection(ctx, server, {
      onState: (change) => {
        if (change.phase === 'ready') {
          // declarationBytes 必须一起转发：设置页那行成本估算靠它，漏了就是永远显示 0。
          registry.ready(serverName, { toolCount: change.toolCount, declarationBytes: change.declarationBytes });
        }
        else if (change.phase === 'failed') {
          registry.failed(serverName, { message: change.message, source: change.source });
        } else if (change.phase === 'closed') registry.closed(serverName);
        // 手动重连时会发 'connecting'（reconnect() 在尝试前先置相位）。
        else if (change.phase === 'connecting') registry.connecting(serverName);
      },
    });
    connections.set(serverName, handle);
  }

  // ---- 2b. 血缘：为嵌套委派的开关继承建链 ------------------------------------
  // 每个 agent 创建时记一条边。少了它，孙会话只能上溯到子会话就断掉。
  // ---- 预设作用域：把三个工具从被排除的预设里摘掉 ------------------------------
  // 见 DEFAULT_EXCLUDED_PRESETS 的顶注：**不**把插件行搬进预设（那会让每个预设各起
  // 一份实例：多一套 MCP 子进程 + 重复注册同一个 web 路由 + 两份互不可见的会话开关缓存），
  // 而是在该 agent 的作用域里做可见性限制。插件始终只有一份。
  // 首呼竞态兜底的等待上限。0 = 关闭等待（回到"connecting 立刻作答"的旧行为）。
  const readyWaitMs = Number.isInteger(config.readyWaitMs) && config.readyWaitMs >= 0
    ? config.readyWaitMs
    : DEFAULT_READY_WAIT_MS;
  if (config.readyWaitMs !== undefined && readyWaitMs !== config.readyWaitMs) {
    ctx.logger?.warn?.(
      `dsh-mcp-switch: config.readyWaitMs must be a non-negative integer; using ${DEFAULT_READY_WAIT_MS}`,
    );
  }

  const excludedPresets = new Set(
    Array.isArray(config.excludePresets)
      ? config.excludePresets.filter((name) => typeof name === 'string' && name !== '')
      : DEFAULT_EXCLUDED_PRESETS,
  );
  /** 活跃 agent，供「首轮之前改选预设」时重新套用；`agent/disposed` 时清掉。 */
  const activeAgents = new Map();
  /** 已施加限制的解除函数，按 session id。 */
  const scopeLifts = new Map();

  /**
   * 读一个 agent **当前生效**的预设。
   *
   * **不能用 `header.agentPreset`**：会话创建之后再改选预设时，header 上的值会停在
   * 创建时的那一个（实测：一个从标准切到极简的会话，header 里还是 standard，
   * 于是这里什么都没摘）。权威来源是 `agentPreset` **会话投影** ——
   * `dsh-agent-preset-registry` 自己也只读投影，注释原话是
   * "Reconstruction reads the agentPreset Session projection, never the header"。
   * 投影服务缺席（软依赖没装上）时退回头部。
   */
  let presetOf = (agent) => agent?.session?.header?.agentPreset;
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    presetOf = (agent) => {
      try {
        const projected = projectionCtx.sessionProjections.stateOf(agent.session, 'agentPreset');
        if (typeof projected === 'string' && projected !== '') return projected;
      } catch { /* 投影没注册，退回头部 */ }
      return agent?.session?.header?.agentPreset;
    };
  });

  function sessionIdOf(agent) {
    const id = agent?.session?.header?.id;
    return typeof id === 'string' && id !== '' ? id : undefined;
  }

  function trackAgent(agent) {
    const id = sessionIdOf(agent);
    if (id !== undefined) activeAgents.set(id, agent);
  }

  function forgetAgent(agent) {
    const id = sessionIdOf(agent);
    if (id === undefined) return;
    activeAgents.delete(id);
    const lift = scopeLifts.get(id);
    if (lift === undefined) return;
    scopeLifts.delete(id);
    // 作用域可能已经随之销毁，解除失败不是问题。
    try { lift(); } catch { /* ignore */ }
  }

  /**
   * 按该 agent 当前的预设决定要不要摘掉本插件的工具。
   * 幂等：只在状态**变化**时动手，所以重复调用是安全的。
   *
   * @param agent - `agent/created` 给出的 agent（必须带作用域 ctx）
   */
  function applyPresetScope(agent) {
    const id = sessionIdOf(agent);
    if (id === undefined) return;
    const preset = presetOf(agent);
    const shouldHide = typeof preset === 'string' && excludedPresets.has(preset);
    const existing = scopeLifts.get(id);
    if (shouldHide === (existing !== undefined)) return; // 状态没变

    if (!shouldHide) {
      scopeLifts.delete(id);
      try { existing(); } catch { /* ignore */ }
      return;
    }

    const scoped = agent?.ctx;
    // 这里失败 = **极简模式会重新看到三个工具**（用户 2026-10-06 报的那个 bug 的形状），
    // 而且是静默的。所以用 error 级，别让它淹在 info 里（审查 S8 / 稳健性清单第 1 条）。
    if (scoped === undefined || typeof scoped.tools?.restrict !== 'function') {
      ctx.logger?.error?.(
        'dsh-mcp-switch: cannot hide tools for preset ' + JSON.stringify(preset) +
        ': no scoped tools service — preset isolation is NOT in effect',
      );
      return;
    }
    try {
      scopeLifts.set(id, scoped.tools.restrict({ deny: TOOL_NAMES }));
    } catch (error) {
      ctx.logger?.error?.(
        'dsh-mcp-switch: cannot hide tools for preset ' + JSON.stringify(preset) + ': ' +
        (error?.message ?? String(error)) + ' — preset isolation is NOT in effect',
      );
    }
  }

  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    switches.remember(agent);
    trackAgent(agent);
    applyPresetScope(agent);
  }), 'dsh-mcp-switch.lineage');
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    switches.forget(agent);
    forgetAgent(agent);
  }), 'dsh-mcp-switch.lineage.dispose');
  // 预设可以在**首轮之前**改选，那时 header 上的值还是旧的，所以这条也要听。
  ctx.effect(() => ctx.on('agent-preset/selected', (sessionId) => {
    const agent = activeAgents.get(sessionId);
    if (agent !== undefined) applyPresetScope(agent);
  }), 'dsh-mcp-switch.preset-scope');

  // ---- 2c. 浏览器通道 -------------------------------------------------------
  // 给浏览器半包一条读状态、改开关的路。围栏复用 connection.requestRejection，
  // 与 /api 同源同强度（实测：无凭据 401、真实浏览器 200）。
  registerChannel(ctx, {
    log: (message) => ctx.logger?.info?.('dsh-mcp-switch: ' + message),
    state: async (input) => {
      const ref = switches.refFor(input?.sessionId);
      const resolved = await switches.resolutionFor(ref);
      const records = registry.snapshot();
      const defaultsState = await readDefaultsState();
      const defaults = defaultsState.servers;
      // 成本估算：新会话默认里那些服务器，会往**每个新会话**塞进多少字节的工具声明。
      // 只报字节 —— 不折算 token：token 数跨模型、跨语种差异很大，折算值会冒充事实。
      // 没连上的服务器量不出来，单独计数，由界面如实说明「未计入」。
      let defaultBytes = 0;
      let defaultUnmeasured = 0;
      for (const name of defaults) {
        const record = records.find((row) => row.name === name);
        if (record !== undefined && typeof record.declarationBytes === 'number') defaultBytes += record.declarationBytes;
        else defaultUnmeasured += 1;
      }
      return {
        sessionId: ref?.id ?? null,
        enabled: resolved.servers,
        // 开关继承自哪个会话（子代理场景）；未继承时为 null。
        inheritedFrom: resolved.inherited ? resolved.source : null,
        // 该会话没有自己的状态文件，值直接来自「新会话默认」。
        fromDefault: resolved.fromDefault === true,
        readable: resolved.readable,
        defaults,
        // 默认从哪来：'config'（profile 声明）| 'store'（设置页）| 'none'。
        // 声明生效时设置页那份也一并给出（`storeDefaults`），界面据此可以提示"当前由配置决定"。
        defaultSource: defaultsState.source,
        storeDefaults: defaultsState.storeServers,
        defaultReadable: defaultsReadable,
        defaultBytes,
        defaultUnmeasured,
        servers: records.map((record) => ({
          name: record.name,
          phase: record.phase,
          available: record.phase === 'ready',
          switchEditable: registry.isSwitchEditable(record.name),
          ...(record.toolCount === undefined ? {} : { toolCount: record.toolCount }),
          ...(record.error === undefined ? {} : { error: record.error.message, errorSource: record.error.source }),
        })),
      };
    },
    toggle: async (input) => {
      const ref = switches.refFor(input?.sessionId);
      const server = typeof input?.server === 'string' ? input.server : '';
      if (server === '') throw new Error('toggle requires a server name');
      // 不给不存在的会话凭空建状态文件（审查 N5）。
      if (ref !== undefined && !knownSession(ref.id)) {
        throw new Error(`refusing to change the switch for unknown session ${JSON.stringify(ref.id)}`);
      }
      // 冻结规则在 SessionSwitches 里强制执行 —— 这里只是把它翻成 ok:false。
      const enabled = await switches.set(ref, server, input?.enabled === true);
      return { enabled };
    },
    // 手动重连。存在的理由很窄：远程 MCP 遇到网络问题，恢复后要能接回来。
    // 本地 stdio 掉线不该靠它 —— 子进程死了重连也白搭，那是用户的事。
    retry: async (input) => {
      const server = typeof input?.server === 'string' ? input.server : '';
      if (server === '') throw new Error('retry requires a server name');
      const handle = connections.get(server);
      // 没有句柄 = 配置非法，从未连接过 —— 重连解决不了它。
      if (handle === undefined) {
        throw new Error(`MCP server "${server}" has no connection to retry (unknown name or invalid configuration)`);
      }
      // **已经 ready 就不重连。** 界面只在 failed 行上给重试按钮，但端点本身是可达的：
      // 对一台好服务器放电会把它无谓地断开再连（审查 N6）。真要强制重连时显式带 force。
      const phase = registry.get(server)?.phase;
      if (phase === 'ready' && input?.force !== true) return { phase, skipped: 'already-ready' };
      // force：用户显式点击，不受自动重连的冷却限制。
      const outcome = await handle.reconnect({ force: true });
      if (outcome.ok !== true) throw outcome.error;
      return { phase: registry.get(server)?.phase ?? 'unknown' };
    },
    // 改「新会话默认」。
    // **刻意不做冻结检查**：这一项说的是**将来的**会话，此刻这台服务器连没连上
    // 与它无关（现在失败、下次启动可能就好）。冻结规则管的是「本会话此刻能不能用」，
    // 两者不是一回事。
    setDefault: async (input) => {
      const server = typeof input?.server === 'string' ? input.server : '';
      if (server === '') throw new Error('default requires a server name');
      if (!registry.names().includes(server)) {
        throw new Error(`unknown MCP server ${JSON.stringify(server)}`);
      }
      // 读-改-写整段持**跨进程**锁（审查 N7），而且**在锁内重新读盘**：
      // 内存里那份可能已经被另一个共用同一个 DSH_HOME 的 dsh 进程改过。
      const committed = await defaultsStore.withLock(async () => {
        const fresh = await defaultsStore.load();
        const next = new Set(fresh.readable ? fresh.servers : []);
        if (input?.enabled === true) next.add(server);
        else next.delete(server);
        return await writeDefaults(next);
      });
      return { defaults: committed };
    },
  });

  // ---- 3. 状态订阅出口：只在变化时发，不发心跳 -------------------------------
  const unsubscribe = registry.onChange((change) => {
    try {
      ctx.emit?.('mcp-switch/state', change);
    } catch {
      /* 没有监听者 / 监听者抛错都不该影响状态写入 */
    }
  });

  // 卸载：先断开（每台会发出 closed 并写进 registry），最后才取消订阅 ——
  // 顺序反了的话，最后一批评相位变化就发不出去。
  // 返回 promise 让 cordis 能等：不等的话宿主可能在连接还活着时就退出了。
  ctx.effect(() => async () => {
    // allSettled 而非 all：一个 dispose 失败不该让其余连接不被断开。
    // finally 保证无论成败都补齐状态并退订 —— 否则监听器泄漏、记录停在非 closed。
    try {
      const settled = await Promise.allSettled(
        [...connections.values()].map((handle) => handle.dispose()),
      );
      for (const outcome of settled) {
        if (outcome.status === 'rejected') {
          ctx.logger?.error?.(`dsh-mcp-switch: dispose failed: ${String(outcome.reason)}`);
        }
      }
    } finally {
      // 没有连接句柄的行（配置非法的）不会自己发 closed，这里补齐，
      // 否则卸载后快照里会剩下几行永远停在 failed 的僵尸记录。
      for (const record of registry.snapshot()) {
        if (record.phase !== 'closed') registry.closed(record.name);
      }
      unsubscribe();
    }
  }, 'dsh-mcp-switch.dispose');

  // ---- 4. mcp_servers：盘点 + 状态 ------------------------------------------
  ctx.effect(() => ctx.tools.register({
    name: 'mcp_servers',
    description:
      'List the MCP servers configured in this deployment, with each one\'s connection phase and whether ' +
      'this session currently has it switched on. Call this when you are unsure which MCP servers exist, ' +
      'or before telling the user a server is unavailable. It does NOT return argument schemas — use ' +
      'mcp_detail for one tool.',
    parameters: {
      type: 'object',
      properties: {
        includeTools: {
          type: 'boolean',
          description: 'Also list each available server\'s tool names. Defaults to false.',
        },
      },
      additionalProperties: true,
    },
    output: textOutput(),
    async execute(args, exec) {
      // 传 ref 而不是裸 id：子代理的开关要沿 parentSession 继承（design.md §2.9）。
      const enabled = await switches.serversFor(sessionRefOf(exec));
      const defaultsState = await readDefaultsState();
      const includeTools = args?.includeTools === true;

      const servers = [];
      for (const record of registry.snapshot()) {
        const tools = includeTools && record.phase === 'ready'
          ? (await connections.get(record.name)?.tools() ?? []).map((tool) => tool.name).sort()
          : undefined;
        servers.push({
          name: record.name,
          phase: record.phase,
          available: record.phase === 'ready',
          sessionEnabled: enabled.includes(record.name),
          switchEditable: registry.isSwitchEditable(record.name),
          ...(record.toolCount === undefined ? {} : { toolCount: record.toolCount }),
          ...(record.error === undefined ? {} : { error: record.error.message, errorSource: record.error.source }),
          ...(tools === undefined ? {} : { tools }),
        });
      }

      return {
        servers,
        total: servers.length,
        available: servers.filter((s) => s.available).length,
        unavailable: servers.filter((s) => !s.available).map((s) => s.name),
        enabledInThisSession: enabled,
        // 新会话默认的**生效值**与**来源**。没有设置页的形态（headless / CI）只能靠
        // config.defaults 声明它，所以"来源"必须让模型看得见（design.md §2.13）。
        defaults: defaultsState.servers,
        defaultsSource: defaultsState.source,
        ...(defaultsState.source === 'config' && defaultsState.storeExists ? { defaultsOverridden: true } : {}),
      };
    },
  }), 'dsh-mcp-switch.servers');

  // ---- 5. mcp_detail：单工具 schema -----------------------------------------
  ctx.effect(() => ctx.tools.register({
    name: 'mcp_detail',
    description:
      'Return the exact argument schema of ONE MCP tool, so you do not have to guess argument names. ' +
      'Call it before the first use of a tool whose schema you have not seen.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server name as reported by mcp_servers.' },
        tool: { type: 'string', description: 'Bare remote tool name, without any prefix.' },
      },
      required: ['server', 'tool'],
    },
    output: textOutput(),
    async execute(args, exec) {
      const server = String(args?.server ?? '');
      const tool = String(args?.tool ?? '');
      const record = registry.get(server);

      if (record === undefined) {
        return {
          found: false,
          reason: 'UNKNOWN_SERVER',
          knownServers: registry.names().sort(),
          hint: 'Call mcp_servers to see what is configured.',
        };
      }

      const handle = connections.get(server);
      if (handle === undefined) {
        // 配置非法：连接从未建立，目录无从谈起。
        return {
          found: false,
          reason: 'SERVER_NOT_CONNECTED',
          server,
          phase: record.phase,
          ...(record.error === undefined ? {} : { error: record.error.message, errorSource: record.error.source }),
          hint: 'This server never connected, so its tool list is unknown.',
        };
      }

      // 首呼竞态兜底：还在 connecting 时先等一会（headless 里模型常常抢在 MCP 子进程就绪之前
      // 调用，而一次性 run 没有第二次机会）。失败相位在上面那个分支已经挡掉，所以不会久等。
      const waited = await waitWhileConnecting(registry, server, { signal: exec?.signal, timeoutMs: readyWaitMs });
      // 等待之后的相位：这期间它可能已经 ready、也可能失败。
      const settledRecord = registry.get(server) ?? record;
      const waitNotes = {
        ...(waited.waitedMs === 0 ? {} : { waitedMs: waited.waitedMs }),
        ...(waited.aborted === true ? { aborted: true } : {}),
      };

      // 缓存读，不打网络：曾 ready 过就还有目录（见 design.md §2.6）。
      const catalog = await handle.tools();
      const found = catalog.find((candidate) => candidate.name === tool);
      if (found === undefined) {
        return {
          found: false,
          reason: catalog.length === 0 ? 'NO_TOOLS_KNOWN' : 'UNKNOWN_TOOL',
          server,
          phase: settledRecord.phase,
          ...waitNotes,
          ...(settledRecord.error === undefined ? {} : { error: settledRecord.error.message, errorSource: settledRecord.error.source }),
          knownTools: catalog.map((candidate) => candidate.name).sort(),
          hint: waited.timedOut
            ? `The server was still connecting after ${waited.waitedMs}ms, so its tool list is not known yet. Try again in a moment.`
            : 'The name must match exactly; call mcp_servers with includeTools=true to list them.',
        };
      }

      return {
        found: true,
        server,
        tool,
        ...waitNotes,
        description: found.description ?? '',
        inputSchema: found.inputSchema,
        ...(found.outputSchema === undefined ? {} : { outputSchema: found.outputSchema }),
        // 曾 ready、之后不可用时仍然给缓存 schema —— schema 不随断连改变，
        // 模型可以据此为恢复后做准备。但必须标注来源（见 design §2.6）。
        // 判据用 `toolCount !== undefined`（= 确实连上过）而不是 `phase !== ready`：
        // 从未 ready 的服务器没有"缓存"可言（审查 L3）。
        ...(record.phase === 'ready' || record.toolCount === undefined ? {} : {
          servedFrom: 'cache',
          serverPhase: record.phase,
          note: 'This server is currently unavailable; the schema comes from its last successful tool listing.',
        }),
      };
    },
  }), 'dsh-mcp-switch.detail');

  // ---- 6. mcp_call：真正的调用 ---------------------------------------------
  ctx.effect(() => ctx.tools.register({
    name: 'mcp_call',
    description:
      'Call one tool on an MCP server and return its result. The server must be enabled in this ' +
      'session; check mcp_servers first if unsure. Get the argument schema from mcp_detail — do not ' +
      'guess argument names.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server name as reported by mcp_servers.' },
        tool: { type: 'string', description: 'Bare remote tool name, without any prefix.' },
        arguments: {
          type: 'object',
          description: 'Arguments object matching the schema from mcp_detail. Omit for tools that take none.',
          additionalProperties: true,
        },
      },
      required: ['server', 'tool'],
    },
    output: {
      schema: LOOSE,
      // canonical value 已经是投影好的 ContentBlock 数组（图片在 execute 阶段落盘），
      // 所以 render 是一次纯同步的数组返回 —— 见 lib/projection.js 文件头第 1 条。
      render: (_args, value) => {
        if (!Array.isArray(value?.content)) return [{ type: 'text', text: String(value) }];
        // 空 content 是**合法**的 MCP 返回（官方 dsh-mcp-client 对同一情形也有兜底）。
        // 直接返回 [] 的话，一次成功的调用在模型看来是一片空白 —— 分不清「成功但没内容」
        // 与「什么都没发生」（审查 S6）。
        if (value.content.length === 0) return [{ type: 'text', text: value.emptyNotice ?? '(the server returned no content)' }];
        return value.content;
      },
    },
    async execute(args, exec) {
      const server = String(args?.server ?? '');
      const tool = String(args?.tool ?? '');

      const record = registry.get(server);
      if (record === undefined) {
        throw new Error(
          `unknown MCP server "${server}"; known servers: ${registry.names().sort().join(', ') || '(none)'}`,
        );
      }

      // 传 ref 而不是裸 id：子代理的开关要沿 parentSession 继承（design.md §2.9）。
      const sessionRef = sessionRefOf(exec);
      const handle = connections.get(server);

      // 顺序要紧：**冻结态必须先于"未启用"报出**。
      // 反过来的话，一台连不上的服务器会对模型说"请用户去开启它"——而它的开关
      // 正因为 phase=failed 被冻着（registry.isSwitchEditable），用户做不到。
      // 那正是 design §7.1 描述的"模型停不下来"的场景。
      const frozen = record.phase === 'failed' || record.phase === 'stopped' || record.phase === 'closed';
      if (frozen || handle === undefined) {
        const detail = record.error === undefined ? '' : `: ${record.error.message}`;
        throw new Error(
          `MCP server "${server}" is currently unavailable (phase=${record.phase})${detail}. ` +
          'Do not retry and do not change arguments — report this to the user.',
        );
      }

      const enabled = await switches.serversFor(sessionRef);
      if (!enabled.includes(server)) {
        throw new Error(
          `MCP server "${server}" is not enabled in this session. Enabled: ${enabled.join(', ') || '(none)'}. ` +
          'Ask the user to enable it, or use a server that is already enabled.',
        );
      }

      // 到这里说明本会话**确实**接入了它，所以「还在连」应当说成「稍后再试」——
      // 否则会一路走到 handle.tools()，撞上一句笼统的 `not connected (state=connecting)`。
      //
      // 首呼竞态兜底（2026-10-08 headless 实测）：模型常常抢在 MCP 子进程就绪之前调用，
      // 而一次性 run 没有第二次机会。等待有界、可被 exec.signal 中止。
      // 顺序：**冻结态 → 未启用 → 等待**；未启用时不等 —— 那是另一个轴上的答案，等它没意义。
      const waited = await waitWhileConnecting(registry, server, { signal: exec?.signal, timeoutMs: readyWaitMs });

      // **必须重读相位**：上面的 await 会等会话写入链、磁盘读与这次等待，期间服务器可能已经断连。
      // 沿用旧快照会把"不可用，别重试"降级成通用的 not connected ——
      // 正是 design §7.1 要防的那件事。
      const current = registry.get(server) ?? record;
      if (current.phase !== 'ready') {
        const detail = current.error === undefined ? '' : `: ${current.error.message}`;
        if (current.phase === 'connecting') {
          throw new Error(
            `MCP server "${server}" is still connecting after ${waited.waitedMs}ms (phase=connecting). ` +
            'Try again in a moment.',
          );
        }
        throw new Error(
          `MCP server "${server}" is currently unavailable (phase=${current.phase})${detail}. ` +
          'Do not retry and do not change arguments — report this to the user.',
        );
      }

      const catalog = await handle.tools();
      if (!catalog.some((candidate) => candidate.name === tool)) {
        throw new Error(
          `MCP server "${server}" has no tool named "${tool}". ` +
          `Known tools: ${catalog.map((candidate) => candidate.name).sort().join(', ') || '(none)'}`, 
        );
      }

      const raw = await handle.callTool(tool, args?.arguments ?? {}, { signal: exec?.signal });

      // MCP 的 isError 必须抛成工具错误（硬约束第 3 条）。
      // 正文原样透传 —— 它就是模型据以纠正的全部信息（design.md §7.2）。
      if (raw.isError === true) {
        const text = extractText(raw.content);
        // 空正文不能抛 new Error("")：模型只会看到 "Error: "，连"失败了"都读不出来。
        throw new Error(text === ''
          ? `MCP tool "${tool}" on server "${server}" reported a failure with no message.`
          : text);
      }

      const content = await projectMcpContent(ctx, exec, raw.content);
      return {
        content,
        ...(raw.structuredContent === undefined ? {} : { structuredContent: raw.structuredContent }),
      };
    },
  }), 'dsh-mcp-switch.call');

  const snapshot = registry.snapshot();
  ctx.logger?.info?.(
    'dsh-mcp-switch mounted: configured=' + snapshot.length +
    ' (' + snapshot.map((r) => r.name + ':' + r.phase).join(', ') + ')' +
    ', tools=mcp_servers,mcp_detail,mcp_call',
  );

  // 程序化接口：供测试与后续 GUI 层使用。cordis 忽略 apply 的返回值。
  return { registry, switches, store, connections };
}
