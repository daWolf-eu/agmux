# AGENTS.md

Notes for AI coding agents (and humans) working in this repo.

- [`docs/agmux-foundation.md`](docs/agmux-foundation.md) is the authoritative design — read it first and don't contradict its standing principles (§14).
- `@agmux/protocol` is the dependency root and owns the product version (`src/version.ts`).
- Wrapper / PTY work: read [`docs/spikes/2026-05-27-bun-pty/SPIKE_REPORT.md`](docs/spikes/2026-05-27-bun-pty/SPIKE_REPORT.md) first — the pitfalls are documented; don't re-derive them.
- Keep `bun run typecheck` and `bun test` green; see [`CONTRIBUTING.md`](CONTRIBUTING.md) for build/test commands and layout.
