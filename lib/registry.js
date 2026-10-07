/**
 * dsh-mcp-switch — 连接态登记处。
 *
 * 这是**连接态的唯一来源**。它与另外两个概念刻意分开存：
 *
 *   - 配置态：用户声明了哪些服务器（挂载时固定，见 lib/index.js）
 *   - 开关态：用户想让哪些服务器接入本会话（按 session 存，见 lib/index.js）
 *   - 连接态：每台服务器此刻能不能用（就是本模块）
 *
 * 三条语义约定，都是设计讨论里定死的，改动前先读 docs/design.md：
 *
 *   1. `ready` 的含义是【连接已建立】，**不是**"服务可用"。
 *      凭据失效 / 配额耗尽 / 上游故障时连接完全正常 —— 那类问题走【调用错误】
 *      通道（mcp_call 的报错），不进状态机。
 *
 *   2. 只有 **connect 失败**与 **stdio 传输关闭**会写入 failed。
 *      单次工具调用失败**不改状态** —— 否则一个慢工具会把整台服务器标红。
 *      （streamable-http 的传输关闭同样不改状态：HTTP 侧连接关闭可能只是
 *      SSE 流正常结束，不代表服务器不可用。这一点待实测。）
 *
 *   3. 本阶段 failed 是**终态**：进入后本次 dsh 运行内不会恢复。
 *      之所以尚可接受，是因为本阶段还没有开关 UI，"冻结"暂时没有受害者；
 *      引入 retry / 进程停用时必须同时给出出口（见 docs/open-questions.md）。
 */

/**
 * 相位集合。
 *
 *   connecting —— 正在连（或已排队连接）
 *   ready      —— 连接已建立
 *   failed     —— 异常：连不上、配置非法、stdio 子进程退出
 *   stopped    —— 宿主在运行，但该服务器被主动停用【本阶段不实现，占位】
 *   closed     —— 宿主关闭 / 插件卸载
 */
export const PHASES = Object.freeze(['connecting', 'ready', 'failed', 'stopped', 'closed']);

/** 错误来源。消费者靠它区分"连不上"和"连上了但被拒"。 */
export const ERROR_SOURCES = Object.freeze(['config', 'connect', 'transport']);

/** URL 里的 userinfo（`scheme://user:pass@host`）。 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;

/**
 * 抹掉文本里的 URL 凭据。
 *
 * 为什么需要：SDK 的连接失败原文会把**完整 URL** 带回来
 * （实测 "Request cannot be constructed from a URL that includes credentials: https://alice:s3cr3t@host/mcp"），
 * 而这条 message 会进 registry、进 mcp_servers 的返回值、进 mcp_call 的报错、进会话日志、
 * 最后随请求发给 provider —— 持久留存。
 *
 * 抹除放在 registry 这个**唯一的写入口**，而不是各个错误源，避免漏掉新的来源。
 *
 * @param text - 待处理文本
 * @returns 凭据部分的密码被替换成 *** 的文本
 */
export function scrubCredentials(text) {
  return String(text).replace(URL_USERINFO, '$1***@');
}

/** 这些相位下会话开关被冻结（既不能开，也不能关）。 */
const FROZEN_PHASES = Object.freeze(['failed', 'stopped', 'closed']);

/** 复制一份记录。config 的字段都是标量（见 describeConfig），所以浅拷贝即足够。 */
function copy(record) {
  return {
    name: record.name,
    phase: record.phase,
    since: record.since,
    config: { ...record.config },
    ...(record.error === undefined ? {} : { error: { ...record.error } }),
    ...(record.toolCount === undefined ? {} : { toolCount: record.toolCount }),
    // 这里是一份**白名单**：新增字段必须同步加进来，否则 #write 写进了 record、
    // 而 snapshot() 永远看不到它（实测踩过：设置页的成本行一直显示 0）。
    ...(record.declarationBytes === undefined ? {} : { declarationBytes: record.declarationBytes }),
    ...(record.attempts === 0 ? {} : { attempts: record.attempts }),
  };
}

/**
 * 连接态登记处。
 *
 * 不持有连接、不驱动重连、不做健康检查 —— 它只是一张可读的账。
 */
export class ServerRegistry {
  /** @type {Map<string, object>} */
  #records = new Map();
  /** @type {Set<(change: object) => void>} */
  #listeners = new Set();

  /**
   * 挂载时登记一台服务器。
   *
   * @param server - normalizeServer 的产物（或被判定为非法的原始条目，见 markConfigError）
   * @returns 本登记处，便于链式
   */
  declare(server) {
    if (this.#records.has(server.name)) {
      throw new Error(`server "${server.name}" is already declared`);
    }
    this.#records.set(server.name, {
      name: server.name,
      phase: 'connecting',
      since: Date.now(),
      attempts: 0,
      config: describeConfig(server),
    });
    return this;
  }

  /**
   * 登记一台**配置非法**的服务器：它进不了连接流程，但必须可见。
   *
   * 刻意不让一条坏配置拖垮整个插件挂载 —— 那正是我们要避免的
   * "一个 MCP 起不来就整个 dsh 起不来"。
   *
   * @param name - 配置里写的名字（可能本身就不合法，调用方需先兜底）
   * @param message - 配置错误原文
   * @param raw - 原始条目，供展示
   */
  declareConfigError(name, message, raw) {
    if (this.#records.has(name)) return this;
    this.#records.set(name, {
      name,
      phase: 'failed',
      since: Date.now(),
      attempts: 0,
      // 与 failed() 走同一条脱敏 —— 只在其中一个写入口脱敏是结构性缺口（审查 L2）。
      error: { message: scrubCredentials(message), source: 'config', at: Date.now() },
      config: { transport: typeof raw?.transport === 'string' ? raw.transport : 'unknown', invalid: true },
    });
    return this;
  }

  /** 连接开始（含之后可能引入的重连）。 */
  connecting(name) {
    return this.#write(name, 'connecting', { clearError: true });
  }

  /**
   * 连接建立。
   *
   * @param name - 服务器名
   * @param detail.toolCount - 首次列工具得到的数量
   * @param detail.declarationBytes - 这批工具声明的体量（`lib/measure.js` 的口径），
   *   仅供设置页估算「把新会话默认打开」的代价，不参与任何判定
   */
  ready(name, detail = {}) {
    return this.#write(name, 'ready', {
      clearError: true,
      patch: { toolCount: detail.toolCount, declarationBytes: detail.declarationBytes },
    });
  }

  /**
   * 进入失败态。
   *
   * @param name - 服务器名
   * @param detail.message - 错误原文（**原样保留**，见 design.md §7.2）
   * @param detail.source - ERROR_SOURCES 之一
   */
  failed(name, detail) {
    const source = ERROR_SOURCES.includes(detail?.source) ? detail.source : 'connect';
    return this.#write(name, 'failed', {
      patch: {
        attempts: (this.#records.get(name)?.attempts ?? 0) + 1,
        error: {
          message: scrubCredentials(detail?.message ?? 'unknown failure'),
          source,
          at: Date.now(),
        },
      },
      // 错误变化本身就是可观察变化：同一相位下换一条错误也要通知。
      force: true,
    });
  }

  /** 宿主关闭该服务器（dsh 退出 / 插件卸载）。 */
  closed(name) {
    return this.#write(name, 'closed', { clearError: true });
  }

  /**
   * 会话开关此刻可否操作。
   *
   * 冻结只针对 failed / stopped / closed。**connecting 不冻结** ——
   * 否则 dsh 启动的头几秒整个面板都是灰的；此时允许预设意图，真失败了
   * 会落到"已启用 · 不可用"，由开关态自行表达。
   *
   * @param name - 服务器名
   * @returns 未登记的服务器一律返回 false（不存在的东西不可操作）
   */
  isSwitchEditable(name) {
    const record = this.#records.get(name);
    if (record === undefined) return false;
    return !FROZEN_PHASES.includes(record.phase);
  }

  /** 单台记录的快照；未登记返回 undefined。 */
  get(name) {
    const record = this.#records.get(name);
    return record === undefined ? undefined : copy(record);
  }

  /** 全部记录的快照，按名字排序。 */
  snapshot() {
    return [...this.#records.values()].map(copy).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** 已登记的名字。 */
  names() {
    return [...this.#records.keys()];
  }

  /**
   * 订阅状态变化。**只在可观察内容真的变了时**触发，不发心跳。
   *
   * 注意：`declare` 建立的是**初始态，不算变化**，因此不会触发订阅者。
   * 正确用法是先 `snapshot()` 取全量、再 `onChange()` 订阅增量。
   *
   * @param listener - 收到一条变化的副本
   * @returns 取消订阅的函数
   */
  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 所有写入的唯一入口：决定"是否算变化"并发通知。 */
  #write(name, phase, options = {}) {
    const record = this.#records.get(name);
    if (record === undefined) return false;
    if (!PHASES.includes(phase)) throw new Error(`unknown phase ${JSON.stringify(phase)}`);
    // closed 是终态：宿主已卸载，迟到的连接错误不该把记录复活。
    if (record.phase === 'closed' && phase !== 'closed') return false;

    const phaseChanged = record.phase !== phase;
    if (phaseChanged) {
      record.phase = phase;
      record.since = Date.now();
    }
    if (options.clearError === true) record.error = undefined;
    if (options.patch !== undefined) Object.assign(record, options.patch);

    if (!phaseChanged && options.force !== true) return false;
    const change = copy(record);
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch {
        // 订阅者自己的问题不该影响状态机的写入。
      }
    }
    return true;
  }
}

/**
 * 从归一化配置里挑出可展示的字段。
 *
 * **刻意不含 `env` 和 `args`。** env 显然会带密钥；args 同样常见
 * （`--api-key sk-…`、`--token=…`），而启发式脱敏总会漏。这两样都不进 registry，
 * 也就不进 mcp-switch/state 事件与将来的 GUI 面板。要看诊断信息请直接读 cordis.yml。
 */
function describeConfig(server) {
  const common = { transport: server.transport, toolCallTimeoutMs: server.toolCallTimeoutMs };
  if (server.transport === 'stdio') return { ...common, command: server.command };
  return { ...common, url: redactUrl(server.url) };
}

/** URL 可能内嵌凭据（https://user:pass@host/），展示前抹掉。 */
function redactUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return '(unparseable url)';
  }
}
