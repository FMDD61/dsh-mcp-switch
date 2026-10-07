/**
 * dsh-mcp-switch —— 浏览器半包。
 *
 * 挂在原生设置页的 `settings.general.item` 槽位，用 `@deepseek-ai/dsh-client-ui-primitives`
 * 的 `Switch` 与 `StateDot` 渲染，所以外观与设置内其它项一致。
 *
 * ## 格式
 *
 * 这是 dsh 的客户端模块格式：`window.__ModuleLoader__.load({ id, factory })`，
 * factory 用 CommonJS 风格 `require` 取宿主提供的包，导出 `{ apply, inject }`。
 * **纯 JS，不需要构建步骤** —— 没有 JSX，用 `react/jsx-runtime` 的 `jsx`/`jsxs`。
 *
 * ## 数据通道
 *
 * 同源 `fetch` 打服务端自己注册的 `/mcp-switch` 前缀路由（见 lib/channel.js）。
 * 围栏与浏览器认证复用 connection 的 `requestRejection`，与 `/api` 同源同强度。
 */

window.__ModuleLoader__.load({
  id: 'dsh-mcp-switch',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { jsx, jsxs } = require('react/jsx-runtime');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /** 与服务端 lib/channel.js 的 CHANNEL_PATH 必须一致。 */
    const CHANNEL = '/mcp-switch';
    const NS = 'mcp-switch';

    const zh = {
      // 设置页讲的是**新会话默认**（全局），头部下拉讲的是**本会话**（会话级）。
      // 两处的标题与提示必须说清各自是哪一种，否则同一个开关会被读成同一件事。
      'section.title': 'MCP 服务器默认连接状态',
      'section.hint': '这里决定新会话默认接入哪些服务器。已存在的会话不受影响 —— 会话一旦动过开关，就保留自己的状态。',
      'band.title': '本会话',
      'band.hint': '开关只决定本会话能否调用该服务器，不影响它是否随 dsh 启动。',
      'band.aria': 'MCP 服务器开关',
      'state.loading': '读取中…',
      'state.empty': '没有配置任何 MCP 服务器。',
      'state.phase.ready': '已连接',
      'state.phase.connecting': '连接中',
      'state.phase.failed': '不可用',
      'state.phase.stopped': '已停用',
      'state.phase.closed': '已关闭',
      'state.frozen': '连接不可用，开关已锁定',
      'state.inherited': '继承自父会话',
      'action.retry': '重试',
      'action.retrying': '重连中…',
      'action.retryTitle': '重新连接这台服务器（远程 MCP 网络恢复后用）',
      'col.tools': '个工具',
      'default.title': '该服务器是否默认接入新会话。改它不会影响任何已存在的会话 —— 会话一旦动过开关，就有自己的状态。',
      'default.costPrefix': '新会话默认会让每个新会话多出',
      'default.costUnit': '字节工具声明',
      'default.costNone': '新会话默认全部关闭：不额外占用任何工具表空间。',
      'default.costUnmeasuredPrefix': '（另有',
      'default.costUnmeasuredSuffix': '台尚未连接，体量未知，未计入）',
      'default.costUnreadable': '默认值文件读不出来，已按「全关」处理。',
    };
    const en = {
      'section.title': 'MCP server defaults',
      'section.hint': 'This decides which servers new sessions attach by default. Existing sessions are unaffected: once a session has been switched, it keeps its own state.',
      'band.title': 'This session',
      'band.hint': 'A switch only decides whether this session may call the server; it does not start or stop it.',
      'band.aria': 'MCP server switches',
      'state.loading': 'Loading…',
      'state.empty': 'No MCP servers are configured.',
      'state.phase.ready': 'Connected',
      'state.phase.connecting': 'Connecting',
      'state.phase.failed': 'Unavailable',
      'state.phase.stopped': 'Stopped',
      'state.phase.closed': 'Closed',
      'state.frozen': 'The connection is unavailable, so this switch is locked',
      'state.inherited': 'Inherited from the parent session',
      'action.retry': 'Retry',
      'action.retrying': 'Reconnecting…',
      'action.retryTitle': 'Reconnect this server (for a remote MCP whose network recovered)',
      'col.tools': 'tools',
      'default.title': 'Whether new sessions attach this server by default. Changing it does not affect existing sessions: once a session has been switched, it keeps its own state.',
      'default.costPrefix': 'The new-session default adds',
      'default.costUnit': 'bytes of tool declarations to every new session',
      'default.costNone': 'The new-session default is all off: it costs no tool-table space.',
      'default.costUnmeasuredPrefix': '(',
      'default.costUnmeasuredSuffix': ' not connected yet, so their size is not counted)',
      'default.costUnreadable': 'The defaults file could not be read, so it is treated as all off.',
    };

    /** 相位 → StateDot 的语义色。 */
    const DOT = { ready: 'done', connecting: 'ongoing', failed: 'error', stopped: 'warning', closed: 'idle' };

    // ---- 会话头部操作带的样式 -------------------------------------------------
    // 照官方 `dsh-client-ui-jobs` 的 JobListAction 模块样式移植（同样的
    // --dsw-alias-* 设计令牌、同样的菜单几何），类名前缀换成 Msw_ 以免与别人撞车。
    // 原生插件用 CSS Modules 由打包器生成类名；我们无构建步骤，所以自己注入一段
    // <style>，并用 data-plugin-css 去重 —— 这是原生插件的同一个标记。
    const CSS_TAG = 'dsh-mcp-switch/Band.module.css';
    const CSS = [
      '.Msw_root{position:relative}',
      '.Msw_trigger{border-radius:var(--dsw-radius-sm);min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;align-items:center;gap:3px;padding:3px 2px;font-size:12px;line-height:18px;display:inline-flex}',
      '.Msw_trigger:hover,.Msw_trigger:focus-visible{color:var(--dsw-alias-label-secondary)}',
      '.Msw_trigger svg{transition:transform .12s}',
      '.Msw_triggerOpen{transform:rotate(180deg)}',
      '.Msw_triggerDot{flex:none}',
      '.Msw_count{margin:0 5px}',
      '.Msw_menu{z-index:100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:520px;max-width:min(640px,100vw - 32px);max-height:min(480px,100vh - 140px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);border:0;flex-direction:column;gap:1px;margin:0;padding:3px;list-style:none;display:flex;position:absolute;top:calc(100% + 5px);left:0;overflow:auto}',
      '.Msw_section{border-top:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);align-items:center;margin:4px 4px 1px;padding:4px 0 3px;font-size:11px;line-height:16px;display:flex}',
      '.Msw_section:first-child{border-top:0;margin-top:0}',
      '.Msw_item{border-radius:var(--dsw-radius-sm);align-items:center;gap:8px;padding:5px 8px;display:flex}',
      '.Msw_item:hover{background:var(--dsw-alias-fill-l1)}',
      '.Msw_name{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;flex:none}',
      '.Msw_meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;flex:none}',
      '.Msw_metaError{color:var(--dsw-alias-state-error-primary);flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.Msw_retry{flex:none;white-space:nowrap}',
      '.Msw_spacer{flex:1;min-width:8px}',
      '.Msw_notice{color:var(--dsw-alias-label-tertiary);margin:2px 8px 6px;font-size:11px;line-height:16px}',
      '.Msw_noticeError{color:var(--dsw-alias-state-error-primary)}',
    ].join('');
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-mcp-switch';
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }
    /** 上面那段 CSS 的类名（无构建步骤，所以手写映射而不是 CSS Modules 的 import）。 */
    const C = {
      root: 'Msw_root',
      trigger: 'Msw_trigger',
      triggerOpen: 'Msw_triggerOpen',
      triggerDot: 'Msw_triggerDot',
      count: 'Msw_count',
      menu: 'Msw_menu',
      section: 'Msw_section',
      item: 'Msw_item',
      name: 'Msw_name',
      meta: 'Msw_meta',
      metaError: 'Msw_metaError',
      retry: 'Msw_retry',
      spacer: 'Msw_spacer',
      notice: 'Msw_notice',
      noticeError: 'Msw_noticeError',
    };



    /**
     * 挂载点之间**共享**的轮询节拍。
     *
     * 设置页与会话头部会同时挂载，各自 `setInterval` 就是同一个页面里两个独立定时器。
     * 更值得省的是**后台标签页**：dsh 的会话在后台照样在跑，而没人在看的时候没必要每
     * 5 秒各拉一次 state（审查 N4）。
     *
     * 顺带说清成本，免得把这条当成瓶颈：`state` 基本是**内存操作** —— 新会话默认已在内存，
     * registry 是内存快照，只有会话状态文件在缓存未命中时读一次盘。所以这是卫生问题。
     */
    const POLL_MS = 5000;
    const tickSubscribers = new Set();
    let tickTimer;

    /** 回到前台时立刻补一次，别让面板停在旧数据上等下一个节拍。 */
    function tickAll() {
      for (const subscriber of [...tickSubscribers]) {
        try { subscriber(); } catch { /* 一个订阅者的异常不该影响别的 */ }
      }
    }

    function onVisibilityChange() {
      if (typeof document !== 'undefined' && document.hidden === true) return;
      tickAll();
    }

    /**
     * 订阅共享节拍。
     *
     * @param fn - 每个节拍调用一次
     * @returns 退订函数；最后一个退订时定时器与监听器一并撤掉
     */
    function onTick(fn) {
      tickSubscribers.add(fn);
      if (tickTimer === undefined) {
        tickTimer = setInterval(() => {
          // 后台标签页不拉。
          if (typeof document !== 'undefined' && document.hidden === true) return;
          tickAll();
        }, POLL_MS);
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibilityChange);
        }
      }
      return () => {
        tickSubscribers.delete(fn);
        if (tickSubscribers.size > 0) return;
        if (tickTimer !== undefined) { clearInterval(tickTimer); tickTimer = undefined; }
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', onVisibilityChange);
        }
      };
    }

    /** 一次通道调用。失败一律归一成 `{ok:false,error}`，不抛。 */
    async function call(endpoint, body) {
      let response;
      try {
        response = await fetch(CHANNEL + '/' + endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body === undefined ? {} : body),
        });
      } catch (error) {
        return { ok: false, error: { message: String(error && error.message ? error.message : error) } };
      }
      let parsed;
      try {
        parsed = await response.json();
      } catch {
        return { ok: false, error: { message: 'HTTP ' + response.status } };
      }
      if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') return parsed;
      return { ok: false, error: { message: 'HTTP ' + response.status } };
    }

    /**
     * 会话级（头部下拉）与全局（设置页）两处共用的通道读写 ——
     * 轮询、过期响应丢弃、逐行 pending 都只实现一次。
     *
     * @param sessionId - 目标会话；设置页不需要会话，传 undefined。
     * @param options.requiresSession - 默认 true：没有会话就不发请求。
     *   设置页看的是**全局默认**，与会话无关，所以传 false —— 没有会话也照常读。
     * @returns 通道状态与若干动作。
     */
    function useMcpChannel(sessionId, options) {
      const requiresSession = options === undefined || options.requiresSession !== false;
      const [data, setData] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      // 审查 M8：快速切换会话时，先发的请求若后返回会把新会话的数据写进 data。
      // 用自增 token 只接受最后一次请求的响应。
      const requestToken = React.useRef(0);
      // 审查 M7：单值 pending 只禁用最后点的那一行 —— 点 A 再点 B，A 立刻解禁，同行可并发。
      const [pending, setPending] = React.useState(() => new Set());
      // 重连同样是逐行的（审查 M7 的同一道理）。
      const [retrying, setRetrying] = React.useState(() => new Set());
      // 「新会话默认」同样是逐行的写入。
      const [pendingDefault, setPendingDefault] = React.useState(() => new Set());

      const reload = React.useCallback(async () => {
        const token = requestToken.current + 1;
        requestToken.current = token;
        if (requiresSession && sessionId === undefined) { setData(null); setFailure(null); return; }
        const result = await call('state', sessionId === undefined ? {} : { sessionId });
        if (token !== requestToken.current) return; // 过期响应，丢弃
        if (result.ok) { setData(result.value); setFailure(null); }
        else setFailure(result.error && result.error.message ? result.error.message : 'request failed');
      }, [sessionId, requiresSession]);

      React.useEffect(() => { reload(); }, [reload]);

      // 挂载期间轮询。**不是可选的**：连接态是服务端的运行期事实，
      // 服务器掉线不会推给浏览器（mcp-switch/state 事件只在宿主侧发）。
      // 不轮询的话，用户看不到掉线，也就永远看不到重试入口 —— 而那正是
      // 「远程 MCP 网络恢复后接回来」这个场景的前提。卸载即停。
      //
      // 走**共享节拍**而不是各挂各的 setInterval：设置页与会话头部会同时挂载。
      React.useEffect(() => onTick(reload), [reload]);

      const toggle = React.useCallback(async (server, enabled) => {
        setPending((prev) => { const next = new Set(prev); next.add(server); return next; });
        try {
          const result = await call('toggle', { sessionId, server, enabled });
          if (!result.ok) setFailure(result.error && result.error.message ? result.error.message : 'toggle failed');
          await reload();
        } finally {
          setPending((prev) => { const next = new Set(prev); next.delete(server); return next; });
        }
      }, [sessionId, reload]);

      /** 手动重连一台失败的服务器。存在的理由很窄：远程 MCP 网络恢复后接回来。 */
      const retry = React.useCallback(async (server) => {
        setRetrying((prev) => { const next = new Set(prev); next.add(server); return next; });
        try {
          const result = await call('retry', { sessionId, server });
          if (!result.ok) setFailure(result.error && result.error.message ? result.error.message : 'retry failed');
          await reload();
        } finally {
          setRetrying((prev) => { const next = new Set(prev); next.delete(server); return next; });
        }
      }, [sessionId, reload]);

      /**
       * 改「新会话默认」。与开关不同，它**不受冻结规则约束** ——
       * 它描述的是将来的会话，与这台服务器此刻连没连上无关。
       */
      const setDefault = React.useCallback(async (server, enabled) => {
        setPendingDefault((prev) => { const next = new Set(prev); next.add(server); return next; });
        try {
          const result = await call('default', { server, enabled });
          if (!result.ok) setFailure(result.error && result.error.message ? result.error.message : 'default failed');
          await reload();
        } finally {
          setPendingDefault((prev) => { const next = new Set(prev); next.delete(server); return next; });
        }
      }, [reload]);

      const defaults = data !== null && Array.isArray(data.defaults) ? data.defaults : [];
      const defaultBytes = data !== null && typeof data.defaultBytes === 'number' ? data.defaultBytes : 0;
      const defaultUnmeasured = data !== null && typeof data.defaultUnmeasured === 'number' ? data.defaultUnmeasured : 0;
      const defaultReadable = data === null || data.defaultReadable !== false;

      return {
        data, failure, pending, retrying, toggle, retry, reload,
        pendingDefault, setDefault,
        defaults, defaultBytes, defaultUnmeasured, defaultReadable,
      };
    }

    /**
     * 一行服务器的内容：状态点 · 名称 · 相位/工具数 · 错误 · 重试 · 开关。
     * 设置页与会话头部下拉共用，两处显示的信息因此不会各自漂移。
     *
     * @param server - 服务端 state 里的一个服务器条目。
     * @param channel - useMcpChannel 的返回值。
     * @param enabled - 已接入本会话的服务器名。
     * @param t - 本地化。
     * @param options.mode - 这一个开关**控制什么**，二者语义不同，不能混：
     *   `'session'`（默认）＝ 本会话是否接入，受冻结规则约束；
     *   `'default'` ＝ 新会话默认是否接入，**不受冻结**（它讲的是将来的会话，
     *   与这台服务器此刻连没连上无关），也不依赖本会话。
     * @returns 该行的子元素数组。
     */
    function serverRowChildren(server, channel, enabled, t, options) {
      const isDefault = options !== undefined && options.mode === 'default';
      const row = [];
      const locked = server.switchEditable !== true;
      row.push(jsx(primitives.StateDot, { key: 'dot', state: DOT[server.phase] ? DOT[server.phase] : 'idle' }));
      row.push(jsx('span', { key: 'name', className: C.name, children: server.name }));
      row.push(jsx('span', {
        key: 'phase',
        className: C.meta,
        children: t('state.phase.' + server.phase) + (server.toolCount === undefined ? '' : ' · ' + server.toolCount + ' ' + t('col.tools')),
      }));
      if (server.error !== undefined) {
        row.push(jsx('span', { key: 'err', className: C.meta + ' ' + C.metaError, children: server.error }));
      }
      // 失败的服务器给一个重试入口 —— 否则开关被冻结又没有出路（design §2.8）。
      if (server.phase === 'failed') {
        row.push(jsx(primitives.Button, {
          key: 'retry',
          variant: 'ghost',
          size: 'sm',
          className: C.retry,
          disabled: channel.retrying.has(server.name),
          title: t('action.retryTitle'),
          onClick: () => { channel.retry(server.name); },
          children: channel.retrying.has(server.name) ? t('action.retrying') : t('action.retry'),
        }));
      }
      row.push(jsx('span', { key: 'spacer', className: C.spacer }));
      // 一行**只有一个**开关。曾经这里同时有「默认」勾选框和会话开关，两者语义不同却并排，
      // 用户实测读成了冲突（2026-10-07）。改成：开关的含义由 mode 决定，标题说明是哪一种。
      row.push(jsx(primitives.Switch, {
        key: 'switch',
        checked: isDefault ? channel.defaults.indexOf(server.name) >= 0 : enabled.indexOf(server.name) >= 0,
        disabled: isDefault
          ? channel.pendingDefault.has(server.name)
          : (locked || channel.pending.has(server.name)),
        label: server.name,
        title: isDefault ? t('default.title') : (locked ? t('state.frozen') : undefined),
        onChange: (next) => {
          if (isDefault) channel.setDefault(server.name, next);
          else channel.toggle(server.name, next);
        },
      }));
      return row;
    }

    /** 设置页里的一项：列出所有 MCP 服务器，各自一个开关。 */
    function McpSwitchRow(props) {
      // **这一页与会话无关**，所以不需要 sessionId：
      //   · 这些开关控制的是「新会话默认」（全局事实，见 section.hint）；
      //   · 连接态与重试也是全局事实。
      // 早先为了拿会话开关，这里得从 sessions.list 里猜主视图会话 —— 本来就脆弱，
      // 现在整段删掉了。会话级开关在会话头部的下拉里（那个槽位直接下发 sessionId）。
      const channel = useMcpChannel(undefined, { requiresSession: false });
      const data = channel.data;
      const failure = channel.failure;

      const t = (key) => (props.t ? props.t(key) : key);
      const children = [];

      children.push(jsx('div', {
        key: 'title',
        style: { fontWeight: 600, fontSize: 14, marginBottom: 4 },
        children: t('section.title'),
      }));
      children.push(jsx('div', {
        key: 'hint',
        style: { fontSize: 12, opacity: 0.7, marginBottom: 10 },
        children: t('section.hint'),
      }));

      if (data === null && failure === null) {
        children.push(jsx('div', { key: 'loading', style: { fontSize: 13, opacity: 0.8 }, children: t('state.loading') }));
      } else {
        const servers = data && Array.isArray(data.servers) ? data.servers : [];
        if (servers.length === 0) {
          children.push(jsx('div', { key: 'empty', style: { fontSize: 13, opacity: 0.8 }, children: t('state.empty') }));
        }
        const enabled = data && Array.isArray(data.enabled) ? data.enabled : [];
        for (const server of servers) {
          children.push(jsx('div', {
            key: server.name,
            className: C.item,
            children: serverRowChildren(server, channel, enabled, t, { mode: 'default' }),
          }));
        }

        // 成本行。**这是设计要求，不是可选装饰**：默认一旦被打开，代价是每个新会话
        // 都在付的，就必须摆在打开它的地方。只报字节，不折算 token ——
        // token 数跨模型、跨语种差异很大，折算值会冒充事实。
        const cost = [];
        if (channel.defaults.length === 0) {
          cost.push(t('default.costNone'));
        } else {
          cost.push(t('default.costPrefix') + ' ' + channel.defaultBytes + ' ' + t('default.costUnit'));
          if (channel.defaultUnmeasured > 0) {
            cost.push(t('default.costUnmeasuredPrefix') + channel.defaultUnmeasured + t('default.costUnmeasuredSuffix'));
          }
        }
        if (!channel.defaultReadable) cost.push(t('default.costUnreadable'));
        children.push(jsx('div', { key: 'cost', className: C.notice, children: cost.join(' ') }));

      }

      if (failure !== null) {
        children.push(jsx('div', {
          key: 'failure',
          style: { fontSize: 12, marginTop: 8, color: 'var(--dsh-text-warning, inherit)' },
          children: failure,
        }));
      }

      return jsx('div', { style: { padding: '10px 0' }, children: jsxs(React.Fragment, { children }) });
    }

    /**
     * 会话头部操作带里的一项：本会话的 MCP 服务器开关。
     *
     * 槽位 `conversation.session.header.actions` 是 `scope: 'session'` 的 list，
     * `sessionId` 由宿主直接作为组件属性下发 —— 与本行的子智能体、预设模式、
     * 后台任务同源。同槽位的原生先例：subagent-catalog(-30)、agent-team(-20)、
     * agent-preset(-10)、job-list(20)。我们取 30，排在后台任务右边。
     */
    function McpHeaderAction(props) {
      const sessionId = props.sessionId;
      const t = (key) => (props.t ? props.t(key) : key);
      const channel = useMcpChannel(sessionId);
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const [menuShift, setMenuShift] = React.useState(0);

      primitives.useDismissOnOutsidePointer(rootRef, open, setOpen);

      // 菜单右缘不出视口（照官方 JobListAction 的做法）。
      React.useLayoutEffect(() => {
        if (!open) { setMenuShift(0); return undefined; }
        const fit = () => {
          const root = rootRef.current;
          const menu = menuRef.current;
          if (root === null || menu === null) return;
          const width = menu.offsetWidth;
          if (width === 0) return;
          const anchorLeft = root.getBoundingClientRect().left;
          setMenuShift(Math.max(16 - anchorLeft, Math.min(0, window.innerWidth - 16 - width - anchorLeft)));
        };
        fit();
        window.addEventListener('resize', fit);
        return () => { window.removeEventListener('resize', fit); };
      }, [open]);

      const servers = channel.data && Array.isArray(channel.data.servers) ? channel.data.servers : [];
      const enabled = channel.data && Array.isArray(channel.data.enabled) ? channel.data.enabled : [];
      const failed = servers.filter((server) => server.phase === 'failed').length;

      // 首次读取还没回来时不占位（避免头部闪一下）；没有配置任何服务器就整项不渲染。
      if (channel.data === null && channel.failure === null) return null;
      if (servers.length === 0 && channel.failure === null) return null;

      const items = [];
      items.push(jsx('li', { key: 'section', className: C.section, 'aria-hidden': 'true', children: t('band.title') }));
      for (const server of servers) {
        items.push(jsx('li', {
          key: server.name,
          className: C.item,
          children: serverRowChildren(server, channel, enabled, t, { mode: 'session' }),
        }));
      }
      if (channel.data && channel.data.inheritedFrom) {
        items.push(jsx('li', {
          key: 'inherited',
          className: C.notice,
          children: t('state.inherited') + ' (' + channel.data.inheritedFrom + ')',
        }));
      }
      if (channel.failure !== null) {
        items.push(jsx('li', { key: 'failure', className: C.notice + ' ' + C.noticeError, children: channel.failure }));
      }

      const onKeyDown = (event) => {
        if (event.key !== 'Escape' || !open) return;
        event.preventDefault();
        setOpen(false);
        if (triggerRef.current !== null) triggerRef.current.focus();
      };

      return jsx('div', {
        ref: rootRef,
        className: C.root,
        onKeyDown,
        children: [
          jsx('button', {
            key: 'trigger',
            ref: triggerRef,
            type: 'button',
            className: C.trigger,
            'aria-expanded': open,
            'aria-label': t('band.aria'),
            title: t('band.hint'),
            onClick: () => { setOpen((current) => !current); },
            children: [
              failed > 0 ? jsx(primitives.StateDot, { key: 'dot', state: 'error', className: C.triggerDot }) : null,
              jsx('span', { key: 'count', className: C.count, children: 'MCP ' + enabled.length + '/' + servers.length }),
              jsx(primitives.IconChevronDownOutlineRegular, { key: 'chevron', size: 12, className: open ? C.triggerOpen : undefined }),
            ],
          }),
          open ? jsx('ul', {
            key: 'menu',
            ref: menuRef,
            className: C.menu,
            style: { left: menuShift },
            'aria-label': t('band.aria'),
            children: items,
          }) : null,
        ],
      });
    }

    // 不再需要 `sessions`：设置页改成与会话无关之后，插件没有任何一处还需要
    // 去猜「主视图会话是哪个」—— 头部下拉槽位是 scope:'session'，sessionId 由宿主下发。
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => {
        try { return ctx.locale.register(NS, { zh, en }); } catch { return () => {}; }
      }, 'mcp-switch: dictionaries');

      // 会话头部操作带 —— 与子智能体 / 预设模式 / 后台任务同一行。
      // order 30 排在 job-list(20) 右边；同槽位原生条目的 order 是 -30/-20/-10/20。
      // 这个槽位 scope 是 'session'，sessionId 由宿主下发，不需要猜。
      ctx.slots.inject('conversation.session.header.actions', () => {
        try {
          return ctx.slots.register({
            name: 'conversation.session.header.actions',
            id: 'mcp-switch',
            order: 30,
            locale: NS,
            inject: () => ({}),
          }, McpHeaderAction);
        } catch {
          return () => {};
        }
      });

      // 设置页：**会话无关**的全局面（新会话默认 + 连接态 + 重试）。
      // 不需要 sessionId，所以这里既没有 inject，也不需要 sessions 服务。
      ctx.slots.inject('settings.general.item', () => {
        try {
          return ctx.slots.register({
            name: 'settings.general.item',
            id: 'mcp-switch',
            order: 40,
            locale: NS,
            inject: () => ({}),
          }, McpSwitchRow);
        } catch {
          return () => {};
        }
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
