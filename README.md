# dsh-mcp-switch

> Per-**session** MCP server switching with a constant tool surface — for DeepSeek Harness.

**[中文文档](README_zh.md)** | English

## The problem

dsh's built-in MCP client registers **every tool of every server** into the model's tool table, so every schema rides along on **every request**. The cost is per-tool and permanent: measured at roughly **0.8–2.3 KB per tool**, paid on every turn — and most of those tools are never called in a given session.

## What this plugin does

It replaces "register every MCP tool" with **three constant tools** that fetch what they need on demand. MCP tools are **never registered**.

| Tool | Bytes | Purpose |
|---|---:|---|
| `mcp_servers` | 543 | Which servers exist, their connection phase, and whether this session has them switched on |
| `mcp_detail` | 448 | One server's tool names, or one tool's full argument schema |
| `mcp_call` | 646 | Call a remote tool |
| **total** | **1,637** | |

| | Tool-table bytes |
|---|---|
| dsh native | **grows with every tool you add** — measured at roughly **0.8–2.3 KB per tool**; the server's description length dominates, so the spread is wide |
| **this plugin** | **1,637, constant** — the same whether you configure one MCP server or twenty |

The three declarations contain **no server names**, so the tool table does not change when you add or remove an MCP server. That buys two things: the cost stays flat, and the provider's prompt-prefix cache is never invalidated.

For scale: one measured setup — two servers, 32 tools — came to **29 KB**, roughly **5,800 tokens on every request**. That figure is specific to those two servers; the plugin's 1,637 B is specific to nothing.

The trade is that argument schemas are fetched on demand instead of being pre-loaded.

## Install

```sh
npm pack                                    # or: npm install dsh-mcp-switch
dsh plugin --profile <profile> add ./dsh-mcp-switch-<version>.tgz
```

Installing does **not** enable it. The plugin declares its row with `disabled: true`, so it stays unmounted until you switch it on — "installed" and "active" are deliberately different states.

## Enable

In the profile's `cordis.patch.yml`, enable it **at the profile level**:

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
    # Which presets should NOT see this plugin's tools. Defaults to ['minimal'].
    excludePresets: ['minimal']
```

An id-targeted patch replaces the whole entry, so `name` and `disabled` must be restated.

> ⚠️ **Do not put this row inside a `preset-*` entry's `plugins` list.** Rows inside a preset are instantiated **once per preset**: N presets means N sets of MCP child processes, N registrations of the same browser route, and N mutually invisible switch caches. Preset isolation is handled by the plugin itself via `excludePresets` (see below).

## Two places to switch servers

| Where | What it controls |
|---|---|
| **Settings → General → "MCP server defaults"** | Which servers **new** sessions attach by default |
| **Session header → the `MCP n/m` dropdown** | Whether **this** session attaches each server |

These are deliberately kept apart. Switching a session **freezes** its choice into that session's own state file; from then on, changing the defaults no longer affects it.

When the defaults are non-empty, the settings section shows their cost in bytes — the tool-table price of turning something on is visible where you turn it on.

## Preset visibility

dsh composes a session's tools from its **agent preset**. Tools registered at the profile (global) level are inherited by *every* preset, including `minimal` — so a globally mounted plugin would leak its tools into minimal sessions.

This plugin stays mounted **once, globally** (so its MCP connections are shared, as designed) and hides its three tools from excluded presets using `ctx.tools.restrict` **inside that agent's scope**. Because visibility is resolved before presentation, those tools' bytes do not enter those presets' requests at all.

Set `config.excludePresets` to change which presets are excluded (`[]` excludes none). It reads the `agentPreset` **session projection**, not the session header — the header is not updated when a preset is changed after session creation.

## Behaviour worth knowing

- **Switches are per session and persisted.** State lives at `<DSH_HOME>/dsh-mcp-switch/sessions/<sessionId>.json` (0600, atomic writes); the new-session default lives at `<DSH_HOME>/dsh-mcp-switch/defaults.json`.
- **Subagents inherit** from their parent session (walking `parentSession` up the chain). A subagent with its own state file wins over inheritance.
- **A server that fails does not break anything.** Its switch is locked and a **Retry** button appears next to it — the way back for a remote MCP server whose network dropped.
- **`connecting` does not lock the switch.** You can set intent before a server is up.
- **MCP `isError` is raised as a tool error**, with the server's text passed through verbatim, so the model gets exactly what it needs to correct itself.
- **A failing MCP server never prevents dsh from starting.**

## User interface

The UI (settings section and the session-header dropdown) is **bilingual: English and simplified Chinese**, following the host's locale.

## Compatibility

Built and verified against **dsh 0.2.0-rc.2** (Node 22). The peer ranges also accept `0.2.1-alpha`.

## Documentation

| File | Contents |
|---|---|
| `docs/design.md` | Design and rationale: tool-surface shape, state model, error contract, prefix-stability argument |
| `docs/measurements.md` | Supporting numbers — raw measurements, including disproven ideas and their evidence |

## For agents

If you are an agent asked to install this plugin, see `AGENTS.md` — exact procedure and pitfalls.

## License

MIT
