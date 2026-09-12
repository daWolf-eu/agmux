# agmux backlog — findings from the omnigent analysis

Each file is a **self-contained pitch + handoff prompt** for one finding mined from
[omnigent](https://github.com/omnigent-ai/omnigent) (an open-source AI-agent *meta-harness*).
omnigent solved the same problems agmux faces but with the opposite topology — it *drives* harnesses
from a central server, whereas agmux *augments* them from inside. Each pitch identifies what omnigent
built, why it maps onto agmux, and the slice of work to scope next.

Hand any single file to a subagent with no prior context. Source-of-truth for agmux design is
[`../agmux-foundation.md`](../agmux-foundation.md); the full analysis is [`../../omnigent-analysis.html`](../../omnigent-analysis.html).

| # | Pitch | Target package(s) | agmux concern |
|---|-------|-------------------|---------------|
| 01 | [Native-hook adapter & normalized payload bridge](01-native-hook-event-capture.md) | `adapters`, `protocol` | in-session capture (monitor) |
| 02 | [Reliable prompt injection into tmux CLIs](02-tmux-prompt-injection.md) | `cli`, `hub` | spawn/bootstrap steering |
| 03 | [Expose agmux services to harnesses via MCP config injection](03-mcp-config-injection.md) | `adapters`, `comms` | tool/comms delivery |
| 04 | [Skill delivery via the plugin/bundle convention](04-skill-delivery-bundling.md) | `adapters` (+ new `skills`) | capability injection |
| 05 | [Artefact store + `file_id → data:` resolver](05-artefact-sharing-resolver.md) | `store`, new service | cross-harness data sharing |
| 06 | [Git-worktree isolation + diff-as-message review](06-worktree-delegation.md) | `cli` | parallel delegation |
| 07 | [Async sub-agent delegation, inbox & blocked-child escalation](07-subagent-delegation-inbox.md) | `cli`, `comms` | orchestration lineage |
| 08 | [Live-stream reconnect contract (snapshot + dedup, no replay)](08-live-stream-reconnect.md) | `hub`, `tui`, `dashboard` | live consumer sync |
| 09 | [Token/cost capture & the dual-tracking gotcha](09-cost-token-tracking.md) | `insights`, `adapters` | usage & budgets |

> File/line references point at omnigent's `main` at analysis time and **will drift** — re-clone and `grep`.
