/**
 * dsh-mcp-switch — 会话开关的持久化。
 *
 * 两个文件：
 *
 *   - 每会话意图：`<DSH_HOME>/dsh-mcp-switch/sessions/<sessionId>.json`（`SessionStore`）
 *   - 新会话默认：`<DSH_HOME>/dsh-mcp-switch/defaults.json`（`DefaultsStore`）
 *
 * 只存**用户意图**（哪些服务器在本会话被打开），不存任何事实：
 * 连接态是内存里的 `lib/registry.js`，"某工具是否用过"从会话日志投影。
 * 一旦开始自己存事实，就要处理和事实不一致的全部情形（日志被裁剪、会话被分支、
 * resume 补全），这是设计上明确拒绝的（见 docs/design.md §2.1）。
 *
 * 四条约定：
 *
 *   1. **新会话默认全关。** 文件不存在 = 空集，这是正常路径不是错误。
 *   2. **读不懂就退化为空集并记日志**，绝不抛。一个损坏文件不该让插件挂载失败。
 *   3. **写是原子的**（`@deepseek-ai/dsh-atomic-write`），且权限收紧
 *      （文件 0600、目录 0700）—— 这里记的是用户行为，属于私有数据。
 *   4. **孤儿文件不自动删。** 会话被删掉后它的状态文件会留下；清理是 GUI 的
 *      显式操作（`listStored()` 提供候选），不是后台扫除。
 */

import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

/** 状态文件格式版本。读到不认识的版本时退化为空集，不做猜测性迁移。 */
export const STORE_VERSION = 1;

/** 插件在 DSH_HOME 下的目录名。 */
const STATE_DIR_NAME = 'dsh-mcp-switch';
const SESSIONS_DIR_NAME = 'sessions';

/** session id 只允许这一族字符——它会被直接拼进文件名。 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 新会话默认所在的文件名。**不是** sessions 下的一个会话，是独立的一份。 */
const DEFAULTS_FILE_NAME = 'defaults.json';

/** 默认值文件的格式版本。读到不认识的版本时退化为空集并记日志。 */
export const DEFAULTS_VERSION = 1;

/**
 * 该 session id 能否安全地当文件名用。
 *
 * 挡的是路径穿越（`../`、绝对路径、分隔符）。宁可拒绝并记日志，
 * 也不要让一个意外的 id 把状态写到目录之外。
 *
 * @param sessionId - 来自 `agent.session.header.id`
 * @returns 是否安全
 */
export function isSafeSessionId(sessionId) {
  return typeof sessionId === 'string' && SAFE_SESSION_ID.test(sessionId) && !sessionId.includes('..');
}

/**
 * 会话开关的文件存储。
 *
 * 不做缓存 —— 缓存属于上层（`SessionSwitches`），这里只有 IO 与格式。
 */
export class SessionStore {
  #sessionsDir;
  /** @type {(message: string) => void} */
  #warn;

  /**
   * @param options.home - 覆盖 DSH_HOME（测试用）；省略则按 `$DSH_HOME` > `~/.dsh` 解析
   * @param options.warn - 非致命问题的记录出口
   */
  constructor(options = {}) {
    const home = options.home ?? resolveDshHome();
    this.#sessionsDir = join(home, STATE_DIR_NAME, SESSIONS_DIR_NAME);
    this.#warn = options.warn ?? (() => {});
  }

  /** 该会话的状态文件绝对路径。 */
  pathFor(sessionId) {
    return join(this.#sessionsDir, `${sessionId}.json`);
  }

  /**
   * 读一个会话的已启用服务器集合。
   *
   * **必须区分「空」与「读不出来」**：前者是新会话的正常路径，后者意味着磁盘上可能有
   * 用户意图而我们读不懂。把后者也当成空集，下一次 `save` 就会用空集**整份覆盖**
   * 掉原有意图 —— 静默丢数据。所以这里返回 `readable` 标志，由调用方决定要不要拒绝写入。
   *
   * 任何失败都不抛。
   *
   * `exists` 是给**子代理继承**用的：文件不存在 = 这个会话没有自己的意图，应当沿
   * `parentSession` 上溯；文件存在但集合为空 = 用户显式清空了，到此为止。
   *
   * @param sessionId - 会话 id
   * @returns `{ servers, readable, exists }`；`readable === false` 表示无法确认磁盘上的真实状态
   */
  async load(sessionId) {
    if (!isSafeSessionId(sessionId)) {
      this.#warn(`dsh-mcp-switch: refusing to read state for unsafe session id ${JSON.stringify(sessionId)}`);
      return { servers: [], readable: false, exists: false };
    }
    let text;
    try {
      text = readFileSync(this.pathFor(sessionId), 'utf8');
    } catch (error) {
      // ENOENT 是新会话的正常路径，不打扰用户，而且它是**可确认的空**。
      if (error?.code === 'ENOENT') return { servers: [], readable: true, exists: false };
      this.#warn(`dsh-mcp-switch: cannot read state for session ${sessionId}: ${error?.message ?? String(error)}`);
      return { servers: [], readable: false, exists: true };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#warn(`dsh-mcp-switch: state file for session ${sessionId} is not valid JSON; refusing to treat it as empty`);
      return { servers: [], readable: false, exists: true };
    }
    if (parsed?.version !== STORE_VERSION) {
      this.#warn(
        `dsh-mcp-switch: state file for session ${sessionId} has version ${JSON.stringify(parsed?.version)}, ` +
        `expected ${STORE_VERSION}; refusing to overwrite it (no automatic migration)`,
      );
      return { servers: [], readable: false, exists: true };
    }
    if (!Array.isArray(parsed.servers)) return { servers: [], readable: false, exists: true };
    const servers = [...new Set(parsed.servers.filter((name) => typeof name === 'string' && name !== ''))].sort();
    return { servers, readable: true, exists: true };
  }

  /**
   * 原子写入一个会话的已启用集合。
   *
   * 调用方必须**先写盘、成功后再更新内存** —— 否则写失败会让内存与磁盘静默分叉。
   *
   * @param sessionId - 会话 id
   * @param servers - 已启用服务器名
   * @throws {Error} session id 不安全，或写盘失败
   */
  async save(sessionId, servers) {
    if (!isSafeSessionId(sessionId)) {
      throw new Error(`refusing to persist state for unsafe session id ${JSON.stringify(sessionId)}`);
    }
    const payload = {
      version: STORE_VERSION,
      sessionId,
      servers: [...servers].sort(),
      updatedAt: new Date().toISOString(),
    };
    await writeFileAtomic(this.pathFor(sessionId), JSON.stringify(payload, null, 2) + '\n', {
      mode: 0o600,
      dirMode: 0o700,
    });
  }

  /**
   * 持**跨进程**写锁跑一段读-改-写。
   *
   * 进程内已有按会话的串行链（`SessionSwitches.#chains`），但两个共用同一个 DSH_HOME 的
   * dsh 进程之间没有：两边各自读到同一份旧值、各自写回，后写的把前一次的选择**整份覆盖掉**
   * （审查 N7）。`withFileLock` 用 `<file>.lock` 兄弟文件串行化写者，读侧仍然无锁 ——
   * 提交靠 rename，读者要么看到旧的完整内容、要么看到新的。
   *
   * 锁必须**包住整段读-改-写**，只包 write 没有意义。
   *
   * @param sessionId - 会话 id
   * @param operation - 在锁内执行的异步操作
   * @returns operation 的返回值
   */
  async withLock(sessionId, operation) {
    // `withFileLock` **不创建父目录**（它只创建 `<file>.lock` 本身），而锁比 `save()` 先到 ——
    // `save()` 靠 `writeFileAtomic` 的 dirMode 建目录，那时已经太晚。实测：第一次写会 ENOENT。
    mkdirSync(this.#sessionsDir, { recursive: true, mode: 0o700 });
    // 签名是 (filename, operation, options) —— operation 在前。
    return await withFileLock(this.pathFor(sessionId), operation, {});
  }

  /**
   * 磁盘上已有的会话 id（**孤儿识别用，不自动清理**）。
   *
   * @returns 已排序的会话 id 数组
   */
  listStored() {
    let entries;
    try {
      entries = readdirSync(this.#sessionsDir);
    } catch {
      return [];
    }
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter(isSafeSessionId)
      .sort();
  }
}
/**
 * 新会话默认的存储。
 *
 * 语义边界（重要）：这是**新会话的初始值**，不是全局开关。
 * 它只在「这个会话自己没有状态文件」时生效；用户一旦在某个会话里动过开关，
 * 那个会话就有自己的文件，从此不再跟随默认 —— 包括后续把默认改掉。
 *
 * 读不出来时**退化为空集并记日志，绝不抛、也绝不拒绝写入**。
 * 理由与会话状态不同：会话状态读不出来时拒绝写入，是因为写入会用空集整份覆盖用户意图；
 * 而默认值读不出来时，写入的目标是**会话**文件，不会碰到默认值文件本身，
 * 所以没有可丢的数据。若这里也拒绝，一台损坏的默认值文件会让**每个新会话**都无法开开关，
 * 那是把一个小故障放大成不可用。
 */
export class DefaultsStore {
  #path;
  /** @type {(message: string) => void} */
  #warn;

  /**
   * @param options.home - 覆盖 DSH_HOME（测试用）
   * @param options.warn - 非致命问题的记录出口
   */
  constructor(options = {}) {
    const home = options.home ?? resolveDshHome();
    this.#path = join(home, STATE_DIR_NAME, DEFAULTS_FILE_NAME);
    this.#warn = options.warn ?? (() => {});
  }

  /** 默认值文件的绝对路径。 */
  path() {
    return this.#path;
  }

  /**
   * 读新会话默认。
   *
   * @returns `{ servers, readable }`；`readable === false` 表示磁盘上有一份我们读不懂的
   *   默认值（已退化为空集继续跑）。调用方可以据此在界面上提示，但**不应**据此拒绝操作。
   */
  async load() {
    let text;
    try {
      text = readFileSync(this.#path, 'utf8');
    } catch (error) {
      // 文件不存在 = 默认全关，是正常路径而不是错误。
      if (error?.code === 'ENOENT') return { servers: [], readable: true };
      this.#warn(`dsh-mcp-switch: cannot read defaults: ${error?.message ?? String(error)}`);
      return { servers: [], readable: false };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#warn('dsh-mcp-switch: defaults file is not valid JSON; using the empty default');
      return { servers: [], readable: false };
    }
    if (parsed?.version !== DEFAULTS_VERSION) {
      this.#warn(
        `dsh-mcp-switch: defaults file has version ${JSON.stringify(parsed?.version)}, ` +
        `expected ${DEFAULTS_VERSION}; using the empty default (no automatic migration)`,
      );
      return { servers: [], readable: false };
    }
    if (!Array.isArray(parsed.servers)) return { servers: [], readable: false };
    const servers = [...new Set(parsed.servers.filter((name) => typeof name === 'string' && name !== ''))].sort();
    return { servers, readable: true };
  }

  /**
   * 原子写入新会话默认。
   *
   * @param servers - 默认接入的服务器名
   * @throws {Error} 写盘失败
   */
  async save(servers) {
    const payload = {
      version: DEFAULTS_VERSION,
      servers: [...servers].sort(),
      updatedAt: new Date().toISOString(),
    };
    await writeFileAtomic(this.#path, JSON.stringify(payload, null, 2) + '\n', {
      mode: 0o600,
      dirMode: 0o700,
    });
  }

  /**
   * 持跨进程写锁跑一段读-改-写。理由同 SessionStore.withLock。
   *
   * @param operation - 在锁内执行的异步操作
   * @returns operation 的返回值
   */
  async withLock(operation) {
    // 同上：锁不会替我们建目录。
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    return await withFileLock(this.#path, operation, {});
  }
}
