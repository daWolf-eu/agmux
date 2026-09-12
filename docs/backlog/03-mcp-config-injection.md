# Pitch 03 — Expose agmux services to harnesses via MCP config injection

**Source:** omnigent · **Target package(s):** `@agmux/adapters`, `@agmux/comms` · **agmux concern:** tool/comms delivery into the agent

---

## Handoff context (read first)

agmux delivers inter-agent messages through an **MCP surface** (`send_message`, `check_inbox`, `ask`, `reply`,
`notify`) backed by the hub — "delivery is subscribe/MCP, never injection" (foundation §8). For an agent to
*use* that surface, the agent's harness must be told the MCP server exists. This finding is the missing
mechanic: **how to inject an MCP server into each harness's config so agmux tools appear inside the agent.**
Read [`../agmux-foundation.md`](../agmux-foundation.md) §8, §12 (`comms`).

This is a **design pitch / spike**. Reference codebase: `https://github.com/omnigent-ai/omnigent` (grep; lines drift).

## What omnigent does

omnigent injects one stdio MCP server into each native harness, using that CLI's own config mechanism:

- **Claude Code** — an inline `--mcp-config <json>` flag pointing at a stdio command (`build_mcp_config`,
  `omnigent/claude_native_bridge.py:934`). Nothing is written to the user's real `~/.claude` config.
- **Codex** — a `[mcp_servers.omnigent]` TOML table appended to a `config.toml` inside a *private per-session*
  `CODEX_HOME` (`codex_native_app_server.py:525`, `_inject_mcp_server_config`), because `app-server` may not
  honor `-c` overrides. Care is taken to materialize a private config dir (symlinks) and never edit the user's.
- The **same server module** serves both harnesses; only the config *format* differs.

So tools, regardless of agent, are exposed through the agent's native MCP client — the universal transport.

## Why it matters for agmux

- agmux's `comms` package is "an MCP server exposing send/ask/reply/notify and inbox tools, routed through the
  hub" (§12). omnigent shows the concrete, per-harness recipe for getting that server *in front of* a running
  agent — the step between "agmux has an MCP server" and "the agent can actually call it."
- The "never touch the user's real config; use a private/inline config" discipline matters for agmux's
  localhost, zero-surprise stance.
- Generalizes beyond comms: any agmux service (query, orchestration verbs) can be surfaced the same way.

## Plan outline

1. Map MCP-injection per `agent_kind`: Claude (`--mcp-config` / `mcpServers` in settings), Codex
   (`config.toml` table + the ≥0.129 hook/trust nuances), Gemini/opencode/pi equivalents; note which have no
   MCP client.
2. Decide injection point: at `agmux run` launch (the launcher writes/points config), aligning with the
   native-first launcher flip in `../superpowers/specs/2026-06-05-native-first-design.md`.
3. Design the agmux MCP endpoint so tools stamp/scope to `AGMUX_SESSION_ID` (the calling session is known).
4. Adopt the private-config-dir discipline so the user's real harness config is never mutated.
5. Prototype: inject the `comms` MCP into a Claude session, have the agent call `check_inbox`, confirm routing
   through the hub.

## Deliverable

A per-harness "MCP injection matrix" design doc + a launcher hook that wires the agmux MCP server into a
spawned session. Skip omnigent's `ProxyMcpManager` central-routing (it assumes a server holding session
state); agmux enforces/routes locally through the hub.
