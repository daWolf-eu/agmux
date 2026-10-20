# Homelab handoff — agmux in OpenShell sandboxes

This file is a self-contained prompt for the agent working in the **homelab** repo. Copy everything below the line into that session. It is the homelab half of agmux remote sandbox sessions, Phase 1 (agmux side: [`2026-10-20-remote-sandbox-sessions-phase1.md`](2026-10-20-remote-sandbox-sessions-phase1.md); design: [`../specs/2026-10-08-remote-sandbox-sessions-design.md`](../specs/2026-10-08-remote-sandbox-sessions-design.md) §4.9, §5, §8.2).

Before handing it off, check the **Contract** section against what agmux actually shipped (flag names, env var, binary names), and update this file if it changed.

---

## Task: bake agmux into the workbench image and opt work-item sandboxes into agmux

### Context

agmux (the agent-session hub on the Mac, `~/dawolf/agmux`) is getting remote sandbox support. Each OpenShell sandbox runs its own agmux hub; Claude Code's hooks report into it over loopback. The Mac pulls each sandbox's events through `openshell -g <gw> sandbox exec -n <sbx> --no-tty -- agmux events --follow …`, and shows the sessions next to its local ones. The homelab docs currently say "agmux: skip for now" (`docs/openshell-handoff.md`). This task makes the sandboxes agmux-ready. Nothing on the gateway host runs agmux itself, there is no network policy or egress change, and no secrets go into sandboxes.

Facts from the agmux phase-0 spike (2026-10-11, in `wi-sag-280` on `ai-sandbox`):

- Compiled Linux binaries + `bun:sqlite` run on the workbench image (Ubuntu 24.04, glibc 2.39, x86_64).
- Cross-compiling needs `bun install --os='*' --cpu='*'` first (opentui's Linux native packages); the lockfile stays unchanged.
- Sizes per arch: `agmux` 128 MB + `agmux-hub` 95 MB. `agmux` spawns `agmux-hub` from `PATH`.
- The container hostname is the container id. A create-time `--env` reaches `exec`'d processes **and** tmux panes started from them; an image `ENV` does not.
- The agmux hub auto-starts on first use, binds `127.0.0.1` (the proxy env's `NO_PROXY` already covers loopback), and stores its state under `~/.agmux`.
- The agent's tmux session name isn't fixed (`0` in `wi-sag-280`, not `work`); agmux resolves coords itself.
- `openshell` 0.0.116 has no label-edit verb: opt-in means a label at create.

### Contract with agmux (do not change unilaterally)

| What | Value |
|---|---|
| Binaries in the image | `/usr/local/bin/agmux`, `/usr/local/bin/agmux-hub` (binary-path policy matching; the agent can modify `/sandbox`) |
| Sandbox opt-in label | `agmux=1` (the Mac's `[[remote]] selector` default) |
| Host identity env | `AGMUX_HOST=<gateway>/<sandbox-name>`, e.g. `ai-sandbox/wi-sag-1234`, set via `sandbox create --env`. Charset `[A-Za-z0-9._-]`, exactly one `/`. Without it, the Mac rejects the sandbox's events (host mismatch). |
| Claude hooks | `agmux adapter install --kind claude` run inside the sandbox against its Claude config dir: pure file writes, no network |
| Remote command the Mac runs | `agmux events --follow --after <n> --consumer <id> --max-duration 3600` via `sandbox exec --no-tty`, stdin closed. Exit 75 = planned hourly rotation. The image's agmux must be the same build as the Mac's (an older agmux rejects `--max-duration`). |
| Sandbox main process | must stay alive (`sleep infinity`); a create whose command exits puts the sandbox in the Error phase |
| OpenShell client/server version | the Mac's client must match the gateway server version: a 0.1.x client cannot talk to a 0.0.116 gateway (`workspace '\n\u{7}default' not found`). Upgrade the gateway, or keep a matching client |

### Work items

1. **`openshell/bin/stage-agmux [<agmux checkout>]`** (default checkout `~/dawolf/agmux/AGX.git.main`):
   - Refuses a dirty agmux tree unless `--dirty` is passed.
   - Runs `bun install --os='*' --cpu='*'`, then `bun build --compile` for `bun-linux-x64` and `bun-linux-arm64`, for both `packages/cli/bin/agmux.ts` and `packages/hub/bin/agmux-hub.ts`.
   - Writes `openshell/images/workbench/agmux/{agmux,agmux-hub}-linux-{amd64,arm64}` and `agmux/VERSION` (`git describe --tags --always --dirty` of the checkout).
   - Is idempotent, prints what it built.
2. **Git-ignore `openshell/images/workbench/agmux/`.** Never commit the binaries (60–100 MB each, they'd stay in history forever).
3. **Dockerfile:** copy `agmux/agmux-linux-${TARGETARCH}` → `/usr/local/bin/agmux` and `agmux/agmux-hub-linux-${TARGETARCH}` → `/usr/local/bin/agmux-hub`, mode 0755.
4. **Image `/etc/tmux.conf`** (system-wide; per-sandbox config stays out of the image). This is agmux Phase 2, but it's cheap to add now:
   ```
   set -g escape-time 0
   set -g extended-keys on
   set -as terminal-features ',xterm*:extkeys'
   set -g default-terminal tmux-256color
   set -as terminal-features ',tmux*:RGB'
   set -g set-clipboard on
   set -g focus-events on
   set -g window-size latest
   set -g prefix C-a
   ```
   The image needs the `tmux-256color` terminfo (`ncurses-term`). Check that this doesn't fight existing tmux config in the image or `work-default` and report anything conflicting.
5. **Ansible (`roles/openshell/tasks/images.yml`):**
   - Assert `openshell/images/workbench/agmux/VERSION` exists before the build, failing with "run openshell/bin/stage-agmux first". Git-ignored files are copied because the role copies the controller's working tree; verify that.
   - After a successful build, prune older workbench images, keeping the current one and one prior (filtered by the workbench repository).
   - Confirm `image_tag.py` hashes the staged binaries, so a new binary = a new tag.
6. **Launcher (`sag-sandbox-create`):**
   - Add `--label agmux=1 --env AGMUX_HOST=<gateway>/<name>`.
   - After create, run `agmux adapter install --kind claude` inside the sandbox via `sandbox exec`, as the user that runs Claude, against the Claude config dir in use (`claude-chax` for SAG sandboxes; check how the launcher sets it up).
   - Failure to install the adapter must warn, not fail the create.
7. **Finish (`sag-sandbox-finish`)**, optional / agmux Phase 3: before delete, nothing yet; leave a TODO pointing at agmux Phase 3 ("final sync").
8. **Docs:** in `docs/openshell-handoff.md`, replace "agmux: skip for now" with a short section: what's in the image, the label/env contract, how to restage (`stage-agmux` → Ansible run), and a pointer to the agmux spec. Update `docs/ai-platform.md` / `docs/openshell-sag-workitem.md` wherever they describe the image contents or launcher flags.

### Verification (report results back)

1. Run `stage-agmux`, then the Ansible image build on `ai-sandbox`. Report the image tag before and after, and confirm the old one was pruned down to one prior.
2. `sag-sandbox-create` a fresh work-item sandbox and check:
   - `openshell -g ai-sandbox sandbox list -o json --selector agmux=1` lists it.
   - `sandbox exec -n <sbx> --no-tty -- sh -c 'echo $AGMUX_HOST; which agmux agmux-hub; agmux --version'` shows `ai-sandbox/<sbx>` and both binaries in `/usr/local/bin`.
   - `sandbox exec -n <sbx> --no-tty -- agmux events --after 0` prints a header line `{"replication":1,…,"host":"ai-sandbox/<sbx>"}`. This needs the agmux Phase 1 build; before that, `agmux ls` must run and auto-start the hub.
   - Start Claude in the sandbox's tmux, send one prompt, then `agmux ls` inside the sandbox shows the session with host `ai-sandbox/<sbx>`.
3. If the Mac-local gateway (`-g openshell`, arm64) is set up, repeat step 2 there. arm64 is still unverified on the agmux side.
4. Report: commit list, anything in this contract that didn't fit homelab reality, and open issues.

### Out of scope

- Any agmux daemon on the gateway host. Topology G was rejected; agmux runs only inside sandboxes.
- Network policy / egress changes (none needed).
- Recreating existing sandboxes (they stay agmux-less until recreated).

### Already verified on the agmux side (2026-10-20 smoke test, `docs/spikes/2026-10-11-remote-sandbox/` § Phase 1 smoke test)

The workbench image `openshell-workbench:e797e53b7f50` with uploaded binaries, `--label agmux=1 --env AGMUX_HOST=…` at create, and a stub agent replicate correctly to the Mac. Discovery, removal, recreation and the missing-`AGMUX_HOST` error are verified. What remains for homelab is baking the binaries in, the launcher flags, and a real logged-in Claude.
