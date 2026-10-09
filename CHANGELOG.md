# Changelog

Versions before 0.5.0 were development iterations without a published changelog; the measurements and
the reasoning behind them are in [`docs/measurements.md`](docs/measurements.md).

## 0.8.0 — 2026-10-09

Headless — and any other surface with no web UI — can now declare which servers a new session
starts with, and the first tool call no longer races the MCP child processes.

- **`config.defaults`** is the new-session default as a *deployment declaration*. When it is set
  it takes precedence over the default file the Settings page writes (the plugin warns once at
  mount when both exist, because that page then writes a value that never takes effect), and
  `mcp_servers` reports where the default came from — `defaultsSource` (`config` / `store` /
  `none`) plus `defaultsOverridden`. `dsh --patch <file>` gives the same knob for a single run.
  Without it a headless or CI run had no way to enable a server at all: the only writer of the
  default file was the web Settings page.
- **Bounded readiness wait** (`config.readyWaitMs`, default 30 s) in `mcp_call` and `mcp_detail`:
  a server still in `connecting` is waited on instead of being answered with `NO_TOOLS_KNOWS`-
  style emptiness. The wait is cancelled by `exec.signal`, returns the moment the server settles
  (ready *or* failed), does not apply to a server this session has not enabled, and never applies
  to `mcp_servers` — an inventory call must stay instant.
- `DefaultsStore.load()` returns `exists` (same convention as the session store).
- **Rejected alternatives**, recorded so they are not re-litigated: an environment variable
  (`DSH_MCP_SWITCH`) — dsh-specific state leaking into the general environment, per-platform ways
  of setting it, and orphaned values after uninstall; and CLI flags through `cmdlineArgs` — the
  command line belongs to the app plugin, and a parse error there exits the host process.
- `AGENTS.md`: the install check now confirms the **version**, not just the presence — pnpm will
  not resolve a release younger than 24 hours (its default `minimumReleaseAge` gate), so a bare
  `add` silently installs an older release, while `pnpm up` (with or without `--latest`) reports
  "Already up to date" and changes nothing. Name the version to get the newest one.

## 0.7.3 — 2026-10-07

Peer upper bounds corrected. **No runtime behaviour change.**

- Every peer range ended in `<0.3.0`, which reads as "0.2.x only" but is not: dsh evaluates peers
  with `semver.satisfies(host, range, { includePrerelease: true })`, and under that flag
  `0.3.0-rc.1` is *less than* `0.3.0`. The whole 0.3.0 prerelease line was therefore admitted — a
  dsh this plugin has never been tested against. The ranges now end in `<0.3.0-0`.
- The regression test asserts **both** semantics — plain semver and the gate's `includePrerelease` —
  that 0.2.x passes and `0.3.0-0` / `0.3.0-rc.1` / `0.3.0` are excluded.

## 0.7.2 — 2026-10-07

Follow-ups from the pre-release review (the "N" items). **No behaviour change users should notice**
except where noted.

- `LICENSE` added (the field said MIT; the file was missing).
- The empty `client/` directory was removed.
- The experiment probes moved to `lab/probes/`; `lab/preset-patch.yml` now uses relative plugin paths
  and no longer carries machine-specific absolute paths.
- Polling is one shared tick across mount points instead of one timer per mount, and it **skips while
  the tab is hidden** (a visible tick is fired again on return). Request count is unchanged.
- `toggle` now refuses a session id that does not exist, instead of creating a state file for it.
- `retry` no longer bounces a server that is already `ready`; pass `force` to override.
- Session state and new-session defaults are written under a **cross-process file lock**
  (`withFileLock`), so two dsh processes sharing one `DSH_HOME` can no longer lose each other's
  writes. Verified by `lab/lock-smoke.mjs`, which runs two real child processes: without the lock
  80 read-modify-writes left 40; with it, 80/80.

## 0.7.1 — 2026-10-07

Pre-release review round (blockers B1–B3, must-fix S1–S9).

- **Documentation no longer contradicts the implementation.** Three places still taught "put the plugin
  row inside each preset"; doing that produces one plugin instance *per preset* — N sets of MCP child
  processes, N registrations of the same browser route, and N mutually invisible switch caches. They
  now state the mechanism actually in use (see 0.7.0) and are marked as superseded.
- **Peer ranges** gained the clause that lets `0.2.1-alpha` through under plain semver.
- **README rewritten**: English is now the default and a Chinese translation ships alongside it
  (`README_zh.md`); the stale "GUI not started" status is gone.
- New-session defaults and resolved switch sets are **copied on read** instead of handing out live
  arrays, so a concurrent write can no longer be frozen into another session's state file.
- Connection failures now carry the **cause chain** (`ECONNREFUSED`, `ENOTFOUND`, certificate
  errors…) instead of a bare `fetch failed`.
- Opening a server that is still `connecting` reports "try again in a moment" rather than
  "not enabled".
- An MCP server returning **empty content** yields an explicit placeholder instead of a blank result.
- `tools/list_changed` pins `autoRefresh`/`debounceMs` explicitly, and re-fetches (loudly) when the
  SDK hands back no list instead of doing nothing silently.
- Publication hygiene: `docs/implementation.md` and `docs/open-questions.md` are no longer shipped,
  and the two shipped docs were scrubbed of host names, user names and internal paths.
- `AGENTS.md` added.

## 0.7.0 — 2026-10-06

Preset visibility, and the enabling instructions that make it work.

- The plugin is mounted **once, globally** — its MCP connections are shared, as designed — and hides
  its three tools from excluded presets with `ctx.tools.restrict` **inside that agent's scope**.
  Configure with `config.excludePresets` (default `['minimal']`, `[]` excludes none).
- The preset is read from the `agentPreset` **session projection**, not the session header: the header
  is written at session creation and is not updated when the preset changes afterwards.
- `cordis.patch.yml` and the docs now say plainly: enable the row at the profile level, and do **not**
  put it in a preset's `plugins` list.

## 0.6.0 — 2026-10-06

New-session defaults.

- `<DSH_HOME>/dsh-mcp-switch/defaults.json` holds the set that sessions **without their own state**
  start from. Touching a session's switches freezes its choice, after which the defaults no longer
  affect it.
- The settings section shows the defaults' cost in **bytes**. Deliberately no token estimate: token
  counts vary too much across models and languages for a conversion factor to be honest.
- The byte figure is measured with the same shape as
  [`docs/measurements.md`](docs/measurements.md) — `{name, description, parameters}` — and was
  calibrated against a live context7 server (4,588 B measured vs 4,581 B recorded, the difference
  being upstream version drift).
- Servers whose size cannot be measured (not connected) are counted separately and reported as such.

## 0.5.0 — 2026-10-06

A per-session switch entry point in the session header.

- Registers in `conversation.session.header.actions` at order 30, next to the subagent, preset and
  background-job entries, opening a dropdown of this session's servers. That slot is
  `scope: 'session'`, so the component receives `sessionId` directly — the settings page, being a
  global slot, had to guess it from `sessions.list`.
- Styles are ported from the official `dsh-client-ui-jobs` module and injected as a `data-plugin-css`
  style tag, since this plugin has no build step.
- `lab/client-static-smoke.mjs` added: it evaluates the browser half and asserts the slot
  registrations, the CSS↔class-name mapping, and i18n key completeness.

## 0.4.1 — 2026-10-06

Manual reconnect for a server whose connection dropped — the one recovery path that a locked switch
would otherwise not have. Includes a 30 s cooldown and single-flight protection.
