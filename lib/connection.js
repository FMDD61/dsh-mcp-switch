/**
 * dsh-mcp-switch — MCP 连接层。
 *
 * 职责边界（刻意收窄）：
 *   - 只管「连上、列工具、调工具、读资源、断开」。
 *   - 不管开关、不管提示词、不管结果投影、不管工具注册。
 *   - 不 fork 官方 @deepseek-ai/dsh-mcp-client 的任何代码；只用它的公开依赖。
 *
 * 三条与官方实现的有意分歧（都是我们的设计带来的，不是疏漏）：
 *
 *   1. 不注册工具。官方客户端把每个 MCP 工具注册进 ctx.tools；我们把目录留在
 *      自己的内存里，模型通过 mcp_detail / mcp_call 按需取用。这样工具表里
 *      永远没有 MCP 工具，服务器增删不影响提示词前缀。
 *
 *   2. 不限制 instructions 字节数。官方在超限时【抛错并断连】（默认 32768）。
 *      我们从不把 instructions 放进系统提示词，所以没有理由为此拒绝连接 ——
 *      一个话多的服务器不该连不上。instructions() 原样返回，由消费者自行限长。
 *
 *   3. 无【自动】重连，但有【手动】重连。掉线后 state() 变 'failed' 并停在那里；
 *      上层可以调 reconnect() 重试一次（single-flight + cooldown）。
 *      自动退避循环仍不塞进这一层。
 *
 * 结果校验发生在这一层：callTool 返回的是经 specTypeSchemas 校验过的
 * CallToolResult。isError 语义的解释权归上层（见 lib/index.js 文件头第 3 条）。
 *
 * 状态：本层通过 options.onState 向外发相位变化，但**不认识** registry ——
 * 账怎么记由调用方决定。三条语义约定见 lib/registry.js 文件头。
 */

import { Client, StreamableHTTPClientTransport, specTypeSchemas } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess';
import { declarationBytes } from './measure.js';
import { readFileSync } from 'node:fs';

/** 包版本。硬编码会随发布过期（审查 L4），所以从 package.json 读，读不到再退。 */
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** 报给 MCP 服务器看的客户端身份。 */
const CLIENT_INFO = { name: 'dsh-mcp-switch', version: PACKAGE_VERSION };

/**
 * 把一个可能被包装过的连接错误展开成可读文本：最外层 + cause 链（最多四级）。
 *
 * `fetch failed` 本身不含任何可行动信息；真正的 code（ECONNREFUSED / ENOTFOUND /
 * CERT_HAS_EXPIRED…）在 `error.cause` 上。文本仍会经 registry 的脱敏出口。
 *
 * @param error - 连接阶段抛出的错误
 * @returns 单行描述
 */
export function describeFailure(error) {
  const parts = [error.message];
  let cursor = error.cause;
  for (let depth = 0; cursor !== undefined && cursor !== null && depth < 4; depth += 1) {
    const text = typeof cursor === 'object'
      ? (cursor.code !== undefined ? String(cursor.code) : String(cursor.message ?? cursor))
      : String(cursor);
    if (text !== '' && parts.indexOf(text) < 0) parts.push(text);
    cursor = typeof cursor === 'object' ? cursor.cause : undefined;
  }
  return parts.length === 1 ? parts[0] : parts[0] + ' (' + parts.slice(1).join(' <- ') + ')';
}

/** 单次工具调用 / 资源请求的默认超时。 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

/**
 * 重连冷却。保护的是**将来**的自动重连（模型反复调用时不要反复 spawn 子进程）；
 * 用户在 GUI 上显式点击走 `reconnect({ force: true })`，不受它限制。
 */
const RECONNECT_COOLDOWN_MS = 30_000;

/** 关闭传输时的等待上限；超时只是记一笔，不阻断 dispose。 */
const TRANSPORT_CLOSE_TIMEOUT_MS = 5_000;

/** 官方命名契约要求：serverName 必须匹配 [A-Za-z0-9_-]{1,32}。 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * 子进程环境：宿主擦除过父环境（凭据形状与过期 DSH_* 名字已剔除），再叠加配置里显式给的值。
 *
 * 与官方实现共用同一个擦除定义而不是各自实现 —— 擦除规则只该有一处。
 *
 * @param extra - 配置里为该服务器显式声明的环境变量
 * @returns 交给 MCP SDK spawn 的完整环境
 */
export function buildChildEnv(extra) {
  return { ...scrubbedParentEnv(), ...(extra ?? {}) };
}

/**
 * 按配置造一个传输。stdio 会 spawn 子进程，streamable-http 连 URL。
 *
 * @param server - 已归一化的服务器配置
 * @returns 尚未连接、由 Client.connect 接管的传输
 */
export function createTransport(server) {
  if (server.transport === 'stdio') {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: buildChildEnv(server.env),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    });
  }
  return new StreamableHTTPClientTransport(new URL(server.url), {
    ...(Object.keys(server.headers).length === 0 ? {} : { requestInit: { headers: server.headers } }),
  });
}

/**
 * 归一化一条服务器配置，非法即抛。
 *
 * 刻意在这里把错误抛干净：配置错误应该在挂载时暴露，而不是等到第一次调用。
 *
 * @param entry - cordis 配置里的一项
 * @returns 判别式归一化结果
 * @throws {Error} 名字、传输类型或该传输类型必需的字段不合法
 */
export function normalizeServer(entry) {
  if (entry === null || typeof entry !== 'object') throw new TypeError('server entry must be an object');
  const name = entry.name;
  if (typeof name !== 'string' || !SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`invalid server name ${JSON.stringify(name)}: must match [A-Za-z0-9_-]{1,32}`);
  }
  const label = `mcp-switch(${name})`;
  const transport = entry.transport ?? 'stdio';
  const toolCallTimeoutMs = entry.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
  if (!Number.isInteger(toolCallTimeoutMs) || toolCallTimeoutMs <= 0) {
    throw new Error(`${label}: toolCallTimeoutMs must be a positive integer`);
  }
  const note = typeof entry.note === 'string' ? entry.note : undefined;

  // headers / env 必须是 plain object。实测：传字符串或数组会被静默接受，
  // 然后 `Object.keys('X=1')` 得到 `['0','1','2']` 之类，把垃圾 spread 进子进程环境。
  // 配置错误应当在挂载时暴露，而不是变成诡异的运行期行为。
  if (entry.env !== undefined && !isPlainObject(entry.env)) {
    throw new Error(`${label}: env must be a plain object of strings`);
  }
  if (entry.headers !== undefined && !isPlainObject(entry.headers)) {
    throw new Error(`${label}: headers must be a plain object of strings`);
  }

  if (transport === 'stdio') {
    if (typeof entry.command !== 'string' || entry.command === '') {
      throw new Error(`${label}: stdio transport requires a non-empty command`);
    }
    const args = entry.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      throw new Error(`${label}: args must be an array of strings`);
    }
    return {
      name, transport, toolCallTimeoutMs, command: entry.command, args,
      env: entry.env ?? {}, cwd: entry.cwd,
      ...(note === undefined ? {} : { note }),
    };
  }
  if (transport === 'streamable-http') {
    if (typeof entry.url !== 'string' || entry.url === '') {
      throw new Error(`${label}: streamable-http transport requires a non-empty url`);
    }
    // URL 里内嵌凭据必须在配置阶段就拒绝：SDK 的连接失败原文会把完整 URL 带回来，
    // 而那条 message 会进 registry、进模型可见输出、进会话日志（见 registry.scrubCredentials）。
    // 凭据应当放 headers。
    let parsedUrl;
    try {
      parsedUrl = new URL(entry.url);
    } catch {
      throw new Error(`${label}: url is not a valid absolute URL`);
    }
    if (parsedUrl.username !== '' || parsedUrl.password !== '') {
      throw new Error(
        `${label}: url must not embed credentials (user:password@) — the failure text would carry them into model-visible output; put them in headers instead`,
      );
    }
    return {
      name, transport, toolCallTimeoutMs, url: entry.url,
      headers: entry.headers ?? {},
      ...(note === undefined ? {} : { note }),
    };
  }
  throw new Error(`${label}: unknown transport ${JSON.stringify(transport)}`);
}

/** 窄化成一个 plain object（排除数组、null、字符串等）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 给一个 promise 加上限时；超时走 onTimeout 的返回值，不抛。 */
function withTimeout(promise, ms, onTimeout) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * 启动一条到 MCP 服务器的连接。
 *
 * 同步返回句柄，连接在后台进行 —— 调用方用 ready 决定是否等待。
 * 任何失败都不会让进程崩溃：错误进 ready 的结果与 state()。
 *
 * @param ctx - 提供 logger 的 cordis 上下文（可以没有 logger）
 * @param server - normalizeServer 的产物
 * @returns 连接句柄
 */
export function startConnection(ctx, server, options = {}) {
  const label = `mcp-switch(${server.name})`;
  const timeoutMs = server.toolCallTimeoutMs;
  const log = {
    info: (m) => ctx?.logger?.info?.(m),
    warn: (m) => ctx?.logger?.warn?.(m),
  };
  /** 状态出口。订阅者自己的异常不该影响连接。 */
  const emit = (nextPhase, detail = {}) => {
    try {
      options.onState?.({ phase: nextPhase, ...detail });
    } catch {
      /* 订阅者的问题不是连接的问题 */
    }
  };

  /** @type {'connecting'|'ready'|'failed'|'closed'} */
  let phase = 'connecting';
  let client;
  let catalog = [];
  let capabilities;
  let serverInstructions = '';
  let failure;
  let closing;
  /** 我们自己发起的关闭；onclose 靠它区分"被关"和"断开"。 */
  let disposed = false;
  /** 是否曾经成功连接过；从未成功时失败路径已经写过状态，onclose 不该重复写。 */
  let everConnected = false;
  /** 在途的重连；single-flight —— 并发点击复用同一个 promise。 */
  let reconnectInFlight;
  /** 上次重连尝试的时间戳，用于冷却。 */
  let lastReconnectAt = 0;

  /** 句柄方法共用：连接不可用时给出可诊断的错误，而不是 undefined 行为。 */
  function liveClient() {
    if (client === undefined || phase !== 'ready') {
      throw new Error(`${label}: not connected (state=${phase})${failure === undefined ? '' : `: ${failure.message}`}`);
    }
    return client;
  }

  /**
   * 一次连接尝试。**首次连接与重连都走它。**
   *
   * 每次调用都必须是**全新的 Client**：MCP SDK 把一个 Protocol 绑死在一个
   * transport 上，复用同一个 Client 再 connect 会失败。
   */
  async function attemptConnect() {
    const generation = new Client(CLIENT_INFO, {
      capabilities: {},
      // MCP 的 notifications/tools/list_changed。
      //
      // 服务器按运行期状态条件性暴露工具时（认证完成后、上游能力打开后……）会发这条通知，
      // 不一定是"服务器更新了"。SDK 默认 autoRefresh=true，会把重新拉取的列表直接交给回调。
      //
      // **这条路径的前缀成本是零**：MCP 目录在本层的内存里，不在工具表里 ——
      // 刷新它不会改动任何声明。官方客户端必须先注销再注册工具，那才会改工具表。
      //
      // 处理器只在服务器声明了 tools.listChanged 能力时才会被装上。
      listChanged: {
        // **显式写死，不依赖 SDK 默认值**（审查 S7）：`autoRefresh` 为 false 时回调收到的是
        // `(undefined, undefined)`，我们只会看到「不是数组」然后什么都不做 —— 静默失效。
        // 官方 dsh-mcp-client 也是显式写的（它写 false，因为要自己注销再注册工具；
        // 我们不必：目录在本层内存里，刷新它不改动任何声明）。
        autoRefresh: true,
        debounceMs: 0,
        tools: {
          onChanged: (error, tools) => {
            if (disposed || client !== generation) return;
            if (error !== undefined && error !== null) {
              log.warn(`${label}: tool list refresh failed: ${error.message}`);
              return;
            }
            if (!Array.isArray(tools)) {
              // SDK 没把列表交给我们（autoRefresh 被关掉时就是这样）。**不能静默**：
              // 目录会停在旧值，而「服务器换了工具」这件事没有任何人知道。主动再拉一次。
              log.warn(`${label}: tool list changed but no refreshed list was delivered; re-fetching`);
              void generation.listTools(undefined, { cacheMode: 'refresh' }).then((list) => {
                if (disposed || client !== generation) return;
                if (!Array.isArray(list?.tools)) return;
                catalog = list.tools;
                emit('ready', { toolCount: catalog.length, declarationBytes: declarationBytes(catalog) });
              }).catch((refreshError) => {
                log.warn(`${label}: tool list re-fetch failed: ${refreshError.message}`);
              });
              return;
            }
            catalog = tools;
            log.info(`${label}: server reported a tool list change; catalog is now ${catalog.length} tool(s)`);
            // 相位没变，registry 只会静默更新 toolCount，不会多发通知。
            emit('ready', { toolCount: catalog.length, declarationBytes: declarationBytes(catalog) });
          },
        },
      },
    });
    client = generation;

    // 断连观察必须在 connect 之前挂上 —— 否则握手期间的关闭会被漏掉，
    // 而那正是"服务器崩了我们还停在 ready"的成因。
    generation.onclose = () => {
      if (disposed) return; // 我们自己关的
      if (!everConnected) return; // 从未连上；失败路径已经写过状态
      if (server.transport !== 'stdio') {
        // HTTP 侧连接关闭可能只是 SSE 流正常结束，不足以判定服务器不可用。
        // 这条待实测，见 docs/open-questions.md。
        log.warn(`${label}: transport closed (streamable-http; state unchanged)`);
        return;
      }
      if (phase !== 'ready') return;
      phase = 'failed';
      failure = new Error('the server closed the connection');
      log.warn(`${label}: transport closed by the server`);
      emit('failed', { message: failure.message, source: 'transport' });
    };

    // 传输错误只记录，不改状态：单次请求失败不足以判定整台服务器不可用。
    generation.onerror = (error) => {
      log.warn(`${label}: transport error: ${error instanceof Error ? error.message : String(error)}`);
    };

    try {
      await generation.connect(createTransport(server));
      capabilities = generation.getServerCapabilities();
      // 服务器没声明 tools 能力就是没有工具 —— 与官方实现的判定一致。
      const list = capabilities?.tools === undefined
        ? { tools: [] }
        : await generation.listTools(undefined, { cacheMode: 'refresh' });
      catalog = Array.isArray(list?.tools) ? list.tools : [];
      // 原样保留；不在此处按字节数拒绝（见文件头第 2 条）。
      serverInstructions = generation.getInstructions()?.trimEnd() ?? '';
      // 卸载已经发生：握手成功也不许把相位从 closed 覆写回 ready。
      // dispose 先置 closed、再 await closeTransport（stdio 关闭实测约 2s），
      // 这个窗口内握手成功的话，client === generation 仍成立 —— 失败路径有守卫，
      // 成功路径原先没有，是不对称的。
      if (disposed) {
        await closeTransport();
        return { ok: false, error: failure };
      }
      if (client !== generation) return { ok: false, error: failure };
      phase = 'ready';
      everConnected = true;
      log.info(`${label}: connected, ${catalog.length} tool(s), ${catalog.length === 0 ? 'no' : String(new Set(catalog.map((t) => t.name)).size === catalog.length ? 'unique' : 'DUPLICATE')} names`);
      emit('ready', { toolCount: catalog.length, declarationBytes: declarationBytes(catalog) });
      return { ok: true };
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      // 卸载已经发生：不要再改相位、不要再发事件。
      // 少了这个守卫，dispose 的 await 窗口内落地的连接错误会把已 closed 的连接覆写成 failed，
      // 于是 handle.state() 与 registry 相互矛盾（实测复现）。
      if (disposed) return { ok: false, error: failure };
      if (client === generation) phase = 'failed';
      // `fetch failed` 这类包装错误把真正的诊断藏在 cause 链里（ECONNREFUSED / ENOTFOUND /
      // 证书错误…）。只报最外层等于把「为什么连不上」丢掉，而本插件的错误契约正是让模型与
      // 用户能据此判断**能不能重试**（design §4）。脱敏仍由 registry 的 scrubCredentials 兜底。
      const detail = describeFailure(failure);
      log.warn(`${label}: connection failed: ${detail}`);
      emit('failed', { message: detail, source: 'connect' });
      await closeTransport();
      return { ok: false, error: failure };
    }
  }

  /** 关传输；永不抛。返回是否确认关闭。 */
  async function closeTransport() {
    const generation = client;
    if (generation === undefined) return true;
    try {
      await withTimeout(generation.close(), TRANSPORT_CLOSE_TIMEOUT_MS, () => 'timeout');
      return true;
    } catch (error) {
      log.warn(`${label}: transport close reported ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  const ready = attemptConnect();

  return {
    name: server.name,
    config: server,
    /** 当前连接相位。 */
    state: () => phase,
    /** 首次连接的结果；句柄创建后立即可用。 */
    ready,

    /**
     * 重新连接一次。
     *
     * 三条约束：
     *   - **single-flight**：在途时复用同一个 promise，并发点击不会 spawn 多个进程。
     *   - **cooldown**：非 `force` 的调用 30 秒内只试一次（给将来的自动重连用）。
     *   - **全新 Client**：SDK 把 Protocol 绑死在一个 transport 上，复用会失败。
     *
     * @param options.force - 跳过冷却（GUI 上的显式点击走这条）
     * @returns `{ok:true}` 或 `{ok:false, error}`，不抛
     */
    async reconnect(options = {}) {
      if (disposed) return { ok: false, error: new Error('the connection is closed') };
      if (reconnectInFlight !== undefined) return await reconnectInFlight;
      const since = Date.now() - lastReconnectAt;
      if (options.force !== true && since < RECONNECT_COOLDOWN_MS) {
        return {
          ok: false,
          error: new Error(`retry is on cooldown for another ${Math.ceil((RECONNECT_COOLDOWN_MS - since) / 1000)}s`),
        };
      }
      lastReconnectAt = Date.now();
      reconnectInFlight = (async () => {
        try {
          // 先把上一代关干净：不关就会漏一个子进程，而且旧 transport 还占着。
          await closeTransport();
          client = undefined;
          failure = undefined;
          phase = 'connecting';
          emit('connecting');
          return await attemptConnect();
        } finally {
          reconnectInFlight = undefined;
        }
      })();
      return await reconnectInFlight;
    },

    /** 服务器 instructions 原文（可能为空串）。由消费者自行限长。 */
    instructions: () => serverInstructions,

    /** 服务器声明的能力（连接成功前为 undefined）。 */
    capabilities: () => capabilities,

    /**
     * 上次列工具的结果。默认走缓存，避免每次 mcp_detail 都打一次网络往返。
     *
     * @param options.refresh - 重新向服务器拉取
     * @returns 工具定义数组（服务器的原始形状，未改名）
     */
    async tools(options = {}) {
      if (options.refresh === true) {
        const live = liveClient();
        if (capabilities?.tools === undefined) return catalog;
        const list = await live.listTools(undefined, { cacheMode: 'refresh' });
        catalog = Array.isArray(list?.tools) ? list.tools : [];
      }
      return catalog;
    },

    /**
     * 调一次工具。结果经协议 schema 校验后原样返回 —— isError 的解释权在上层。
     *
     * @param rawName - 服务器自己的工具名（不是 mcp__ 公开名）
     * @param args - 已解析的参数对象
     * @param options.signal - 取消信号
     * @param options.timeoutMs - 覆盖默认超时
     * @returns 校验过的 CallToolResult
     */
    async callTool(rawName, args, options = {}) {
      const live = liveClient();
      const definition = catalog.find((tool) => tool.name === rawName);
      const raw = await live.callTool(
        { name: rawName, arguments: args ?? {} },
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          timeout: options.timeoutMs ?? timeoutMs,
          ...(definition === undefined ? {} : { toolDefinition: definition }),
        },
      );
      const parsed = specTypeSchemas.CallToolResult['~standard'].validate(raw);
      if (parsed.issues !== undefined) {
        throw new Error(
          `${label}: tool "${rawName}" returned an invalid MCP result: ` +
          parsed.issues.map((issue) => issue.message).join('; '),
        );
      }
      return parsed.value;
    },

    /** 三个资源方法，直接对应 MCP 的 resources/* 请求。 */
    resources: {
      async list(cursor, options = {}) {
        return await liveClient().listResources(
          cursor === undefined ? undefined : { cursor },
          { ...(options.signal === undefined ? {} : { signal: options.signal }), timeout: options.timeoutMs ?? timeoutMs },
        );
      },
      async templates(cursor, options = {}) {
        return await liveClient().listResourceTemplates(
          cursor === undefined ? undefined : { cursor },
          { ...(options.signal === undefined ? {} : { signal: options.signal }), timeout: options.timeoutMs ?? timeoutMs },
        );
      },
      async read(uri, options = {}) {
        return await liveClient().readResource(
          { uri },
          { ...(options.signal === undefined ? {} : { signal: options.signal }), timeout: options.timeoutMs ?? timeoutMs },
        );
      },
    },

    /** 断开。幂等；永不抛。 */
    async dispose() {
      closing ??= (async () => {
        disposed = true; // 必须早于 closeTransport：onclose 要能认出这是我们自己关的
        phase = 'closed';
        serverInstructions = '';
        catalog = [];
        const confirmed = await closeTransport();
        client = undefined;
        if (!confirmed) log.warn(`${label}: transport closure could not be confirmed`);
        emit('closed');
      })();
      return await closing;
    },
  };
}
