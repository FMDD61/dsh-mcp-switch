# dsh-mcp-switch

> 按**会话**开闭 MCP 服务器，工具面恒定 —— 用于 DeepSeek Harness。

English | **[中文文档](README_zh.md)**

## 它解决什么

dsh 原生的 MCP 客户端把**每台服务器的每个工具**逐个注册进模型的工具表，于是每份 schema 都跟着**每一次请求**走。这笔开销是**按工具计、且永久**的：实测约 **0.8–2.3 KB/工具**，每一轮都在付 —— 而其中绝大多数工具在一次会话里根本不会被调用。

## 本插件做什么

把「逐个注册 MCP 工具」换成**三个常量工具**，按需取回所需信息。**MCP 工具从不注册。**

| 工具 | 字节 | 用途 |
|---|---:|---|
| `mcp_servers` | 543 | 有哪些服务器、各自连接相位、本会话是否已接入 |
| `mcp_detail` | 448 | 某台服务器的工具名列表，或某个工具的完整参数 schema |
| `mcp_call` | 646 | 调用远端工具 |
| **合计** | **1,637** | |

| | 工具表字节 |
|---|---|
| dsh 原生 | **每加一个工具就涨** —— 实测约 **0.8–2.3 KB/工具**；服务器描述的长短占大头，所以浮动很大 |
| **本插件** | **1,637，恒定** —— 配一台 MCP 服务器和配二十台，是同一个数 |

三个工具的声明里**不含任何服务器名**，所以增删 MCP 服务器不会改变工具表。这买到两样东西：成本不涨，且 provider 的前缀缓存永远不会失效。

作为量级参照：实测过的一组 —— 两台服务器、32 个工具 —— 是 **29 KB**，约 **5,800 tok/次请求**。那个数只对那两台服务器成立；本插件的 1,637 B 不对任何特定配置成立。

换来的代价是参数 schema 改为按需取回，而不是预载。

## 安装

```sh
npm pack                                    # 或：npm install dsh-mcp-switch
dsh plugin --profile <profile> add ./dsh-mcp-switch-<version>.tgz
```

**装上不等于启用。** 插件把自己的行声明为 `disabled: true`，所以在你显式打开之前它不会挂载 —— 这是刻意的，「已安装」与「已启用」是两件事。

## 启用

在 profile 的 `cordis.patch.yml` 里，**在 profile 层**启用它：

```yaml
- id: dsh-mcp-switch
  name: 'dsh-mcp-switch'
  disabled: false
  config:
    servers:
      - name: context7
        transport: stdio
        command: npx
        args: ['-y', '@upstash/context7-mcp@latest']
      - name: remote-docs
        transport: streamable-http
        url: https://example.com/mcp
        headers:
          Authorization: Bearer ${DOCS_TOKEN}
    # 哪些预设**不该**看到本插件的工具。默认 ['minimal']。
    excludePresets: ['minimal']
```

按 id 定位的补丁会**整段替换**条目，所以 `name` 与 `disabled` 都要重述。

> ⚠️ **不要把这一行放进 `preset-*` 的 `plugins` 列表里。** 预设里的行是**每个预设各起一份实例**：N 个预设就是 N 套 MCP 子进程、N 次注册同一个浏览器路由、N 份互不可见的开关缓存。预设隔离由插件自己按 `excludePresets` 完成（见下）。

## 两个开关入口

| 位置 | 控制什么 |
|---|---|
| **设置 → 通用 → 「MCP 服务器默认连接状态」** | **新**会话默认接入哪些服务器 |
| **会话头部 → `MCP n/m` 下拉** | **本**会话是否接入各服务器 |

这两件事被刻意分开。在某个会话里动过开关，就把选择**固化**进那个会话自己的状态文件；从那一刻起，改默认不再影响它。

默认非空时，设置页会把它的成本按**字节**显示出来 —— 打开它的代价，就摆在打开它的地方。

## 预设可见性

dsh 按**agent 预设**组合一个会话的工具。注册在 profile（全局）层的工具会被**每一个**预设继承，包括 `minimal` —— 所以全局挂载的插件会把工具漏进极简会话。

本插件**全局只挂一份**（这样它的 MCP 连接是共享的，符合设计），再用 `ctx.tools.restrict` **在那個 agent 的 scope 里**把三个工具从被排除的预设中摘掉。可见性解析发生在呈现之前，所以那些预设的请求里连这三个工具的字节都不带。

改 `config.excludePresets` 即可调整排除哪些预设（`[]` 表示一个都不排除）。它读的是 `agentPreset` **会话投影**，不是会话 header —— 会话创建之后再改选预设时，header 不会更新。

## 几条值得知道的行为

- **开关是会话级且持久化的。** 状态在 `<DSH_HOME>/dsh-mcp-switch/sessions/<sessionId>.json`（0600、原子写）；新会话默认在 `<DSH_HOME>/dsh-mcp-switch/defaults.json`。
- **子代理继承**父会话（沿 `parentSession` 上溯）。子代理自己若有状态文件，则覆盖继承。
- **一台服务器失败不会拖垮任何东西。** 失败服务器的开关被锁定，旁边出现**重试**按钮 —— 那就是远程 MCP 网络恢复后的回路。
- **`connecting` 不锁开关。** 服务器还没起来时也可以先预设意图。
- **MCP 的 `isError` 抛成工具错误**，服务器原文逐字透传，模型据此纠正所需的全部信息都在。
- **任何一台 MCP 连不上，都不会妨碍 dsh 启动。**

## 界面

界面（设置页那一节 + 会话头部下拉）**中英双语**，跟随宿主的语言设置。

## 兼容性

针对 **dsh 0.2.0-rc.2**（Node 22）构建与验证。peer 范围同时接受 `0.2.1-alpha`。

## 文档

| 文件 | 内容 |
|---|---|
| `docs/design.md` | 设计与取舍：工具面形态、状态模型、错误契约、前缀稳定性论证 |
| `docs/measurements.md` | 支撑数据：全部实测原始数字，含被证伪的建议及其证据 |

## 给 agent

如果你是被告知安装本插件的 agent，见 `AGENTS.md` —— 有确切步骤与坑。

## 许可证

MIT
