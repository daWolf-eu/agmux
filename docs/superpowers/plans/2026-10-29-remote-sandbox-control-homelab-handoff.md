# Homelab handoff — agmux Phase 3 (remote control)

This file is a self-contained prompt for the agent working in the **homelab** repo. Copy everything below the line into that session. It is the homelab half of agmux remote sandbox control, Phase 3 (design: [`../specs/2026-10-28-remote-sandbox-control-design.md`](../specs/2026-10-28-remote-sandbox-control-design.md) §7 and its "Implementation notes"; Phase 1 handoff: [`2026-10-20-remote-sandbox-sessions-homelab-handoff.md`](2026-10-20-remote-sandbox-sessions-homelab-handoff.md)).

Before handing it off, check the **Contract** section against what agmux actually shipped (flag names, exit codes), and update this file if it changed.

---

## Task: restage agmux Phase 3 and drain before sandbox deletion

### Context

agmux (the agent-session hub on the Mac, `~/dawolf/agmux`) can now start and resume agents in OpenShell sandboxes from the Mac: `agmux run --remote <r> --sandbox <s>` starts an agent in the sandbox's tmux and attaches to it; `agmux attach <id>` (and the dash) on a closed sandbox session restarts it in the same sandbox, next to where it ran. The Mac runs the sandbox's own `agmux` through `openshell … sandbox exec --no-tty`, so the image must carry this build. A new sandbox-side command, `agmux events --drain`, lets `sag-sandbox-finish` wait until the Mac has stored every event of a sandbox before it is deleted.

How the agent is launched lives in the Mac's agmux config (`[[remote]]`: `workdir`, `kind`, `profile`, `command`, `args`, e.g. `args = ["--dangerously-skip-permissions"]`), not in the image. Sandbox lifecycle (create / stop / delete) stays homelab's; agmux only runs `sandbox get` / `sandbox start` on a stopped sandbox.

### Contract with agmux (do not change unilaterally)

| What | Value |
|---|---|
| agmux build in the image | same build as the Mac's. The Mac compares the sandbox's agmux version (from replication) before every remote start/resume and refuses with `<host> runs an older agmux; restage the image (stage-agmux)`. |
| Sandbox-side commands the Mac runs | `agmux run --direct --print-coords …`, `agmux run --headless …`, `agmux attach <id> --resume-nearest --print-coords [--fallback-launch <json>]`, all via `sandbox exec --no-tty`, stdin closed |
| Where agents land | a detached window in tmux session `agmux` (`AGMUX_TMUX_SESSION` overrides) on the sandbox user's default tmux server, created if missing |
| Claude hooks | must be installed **and current** (`agmux adapter install --kind claude`): sandbox starts are direct (no `agmux-wrap` in the image), and a missing or outdated adapter fails the start with the install hint instead of falling back. For a `kind` launch the check reads `~/.claude` (`CLAUDE_CONFIG_DIR` from the process env is not consulted); a sandbox profile whose `env` sets `CLAUDE_CONFIG_DIR` is checked there. |
| Sandbox-side profiles | none needed. Only if a Mac `[[remote]]` sets `profile = "<p>"` must `<p>` exist in the sandbox's agmux config (`~/.config/agmux/config.toml`). |
| Final sync | `agmux events --drain [--timeout <s>]` (default 60): exit **0** the Mac has stored everything up to the current head, **1** timeout (stderr names the lagging consumer, its cursor and the head) or the sandbox hub is unreadable, **3** no consumer (no Mac follower connected within the last 5 minutes) |

### Work items

1. **Restage the image** with this agmux build: `openshell/bin/stage-agmux` → Ansible image build, as in Phase 1. No other image change is needed for the launch (it lives in the Mac's `[[remote]]`). Existing sandboxes keep their old agmux until recreated; the Mac refuses remote start/resume there with the restage message.
2. **Adapter after restage:** a new build may bump the claude plugin version. `sag-sandbox-create` already runs `agmux adapter install --kind claude`; make sure it targets the config dir agmux checks (see Contract) — if SAG sandboxes run claude with `CLAUDE_CONFIG_DIR` (e.g. `claude-chax`), also install into `~/.claude`, or report it so the Mac `[[remote]]` can use a sandbox profile instead.
3. **`sag-sandbox-finish`:** before delete, run `openshell -g <gw> sandbox exec -n <sbx> --no-tty -- agmux events --drain --timeout <s>` (stdin closed; a value around 60 s; the sandbox must be running). On exit 0 delete as today. On non-zero it is homelab's call; recommended: do not delete, stop the sandbox instead and print why (1 = the Mac is behind or unreachable, 3 = no Mac follows this sandbox), with a `--force` to delete anyway. Remove the Phase 1 TODO ("final sync").
4. **Docs:** in `docs/openshell-handoff.md` (agmux section), add: remote start/resume from the Mac, the drain step in `sag-sandbox-finish` and its exit codes, the adapter requirement, and the restage rule (same build as the Mac).

### Verification (report results back) — real-sandbox smoke checklist

Mac config: a `[[remote]]` for `ai-sandbox` with `kind = "claude"`, `args = ["--dangerously-skip-permissions"]` and a `workdir`. Use a fresh work-item sandbox from the restaged image.

1. **Start detached:** `agmux run --remote ai-sandbox --sandbox <sbx> -d` prints `agmux: started on ai-sandbox/<sbx> (agmux:@N)`; `agmux ls --host 'ai-sandbox/*'` shows the session within seconds, `agmux inspect <id>` shows the configured command/args and cwd.
2. **Attach:** `agmux attach <id>` opens the local window (Phase 2 view); claude runs without permission prompts.
3. **`/exit` then resume:** `/exit` in claude; wait until `agmux ls` shows the row closed (the sandbox hub's pid sweep, ≤ 30 s, then replication; an attach before that fails cleanly). `agmux attach <id>` resumes it in the same sandbox under the **same** id, next to its old spot, and attaches. Still no permission prompts (args kept).
4. **Resume after sandbox stop/start:** with the agent running, stop the sandbox, then start it again. Its row reads live until the sandbox hub (started again by the Mac's follower) sweeps the dead pid and that replicates; an `agmux attach <id>` before that fails cleanly (exit 3 in the local pane); it must never open another agent. Once the row reads closed, `agmux attach <id>` resumes it in a **new** tmux session `agmux` (new tmux server), not split into a reused window, same id when the conversation had a turn. Also: `/exit`, wait for the row to close, stop the sandbox, then `agmux attach <id>`: the resume starts the sandbox first.
5. **Multi-line prompt:** `agmux run --remote ai-sandbox --sandbox <sbx> -d --prompt "$(printf 'line one "q"; $HOME\nline two')"` — the whole text lands in claude's input as one prompt, verbatim (newlines over real `sandbox exec` argv are unverified). Also once with `--headless --prompt …`: the reply streams to the Mac and the exit code is claude's.
6. **Drain before delete:** with the Mac hub running, `sag-sandbox-finish` drains (exit 0) and deletes; then with the Mac hub stopped (`kill $(cat ~/.agmux/hub.pid)` on the Mac; the next agmux command restarts it), drain exits non-zero and the sandbox is kept stopped (or whatever homelab decided). Report the exit codes seen.
7. **Old image:** on a sandbox still on the previous image, `agmux run --remote … --sandbox <old>` prints the restage message.

Report: commit list, the smoke results per step, anything in the contract that didn't fit homelab reality, and open issues.

### Out of scope

- Sandbox creation from agmux (a later `ensure()` behind agmux's `SandboxControl` seam), remote kill, starting agents from the dash.
- Network policy / egress changes (none needed).
