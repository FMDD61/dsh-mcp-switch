# AGENTS.md — installing dsh-mcp-switch

Instructions for an AI agent asked to install or enable this plugin in a DeepSeek Harness (dsh) deployment.
Written to be followed mechanically. If a step fails, stop and report — do not improvise around it.

## 0. Preconditions

```sh
dsh --version      # expect 0.2.0-rc.2 or newer 0.2.x (0.2.1-alpha is accepted)
node --version     # expect >= 20 (22 recommended)
```

Then find the target profile. Profiles live at `<DSH_HOME>/profiles/<name>/` (usually `~/.dsh/profiles/`).
Ask the user which profile if it is not obvious; do not guess between several.

## 1. Install the package

```sh
dsh plugin --profile <profile> add dsh-mcp-switch          # from npm
# or, from a local tarball:
dsh plugin --profile <profile> add ./dsh-mcp-switch-<version>.tgz
```

**This does not enable the plugin.** Its row is declared `disabled: true` on purpose.

Verify the install landed:

```sh
cat <DSH_HOME>/profiles/<profile>/package.json
```

Expect `dsh-mcp-switch` in both `dependencies` and `dsh.profile.bundles`. If it is in `dependencies` but **not** in `bundles`, the install half-failed — remove and add it again.

## 2. Enable it

Append this entry to `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` (a top-level YAML array):

```yaml
- id: dsh-mcp-switch
  name: 'dsh-mcp-switch'
  disabled: false
  config:
    servers:
      - name: <server-name>
        transport: stdio
        command: npx
        args: ['-y', '<mcp-package>@latest']
```

Rules that are easy to get wrong:

- An id-targeted patch **replaces the whole entry**, so `name` and `disabled` must be restated.
- One entry per plugin id. If a `dsh-mcp-switch` entry already exists, edit it instead of appending a second one.
- `config.servers` is this plugin's own list. It is **independent** of any ```deepseek-ai/dsh-mcp-client` rows in the same file; both may exist and both will run.

## 3. Verify it mounted

Restart dsh, then check:

```sh
# 1. the composition resolves (no YAML/patch errors)
dsh --profile <profile> --dump-config | grep -A3 'id: dsh-mcp-switch'

# 2. the plugin actually imported (look for this exact failure marker)
grep -c 'failed to import' <dsh web log>
```

If dsh has a web UI, the plugin adds a section named **"MCP server defaults"** under Settings → General.

## 4. What "working" looks like

- The three tools `mcp_servers`, `mcp_detail`, `mcp_call` are in the model's tool table.
- In a **minimal** preset session they are **absent**. That is correct, not a bug — see below.

## Pitfalls — verified the hard way

**Do NOT put the plugin row inside a `preset-*` entry's `plugins` list.**
Rows inside a preset are instantiated **once per preset**. With N presets you get N sets of MCP child
processes, N attempts to register the same browser route (all but one silently dropped), and N mutually
invisible switch caches. Measured: putting it in two presets turned one MCP server into two child processes.

**Preset isolation is the plugin's job, not the patch's.** It keeps a single global mount and hides its
tools per agent scope. Configure which presets are excluded via `config.excludePresets` (default
`['minimal']`). Do not try to achieve this by moving the row.

**Minimal-preset sessions legitimately do not see the tools.** If the user reports "the MCP tools are
missing in minimal mode", that is the designed behaviour. Confirm `excludePresets` does not list the
preset they actually care about.

**Enabling it globally is the intended configuration.** `disabled: false` at profile level is correct.

## Uninstall

```sh
dsh plugin --profile <profile> remove dsh-mcp-switch
```

Also delete the `dsh-mcp-switch` entry from `cordis.patch.yml`. Session state files under
`<DSH_HOME>/dsh-mcp-switch/` are left behind on purpose; delete them manually if you want a clean slate.
