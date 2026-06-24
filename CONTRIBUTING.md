# Contributing to agmux

Thanks for taking a look. agmux is in **alpha**, so issues, reproductions, and PRs
on rough edges are all welcome.

## Prerequisites

- [Bun](https://bun.com) ≥ 1.3 (the only runtime — there is no Node.js fallback)
- [tmux](https://github.com/tmux/tmux) ≥ 3.2 (for anything touching session placement)
- macOS (verified) or Linux (best-effort)

## Setup

```bash
bun install
```

## Everyday commands

```bash
bun test            # run the full test suite
bun run typecheck   # type-check every package
bun run build       # compile the agmux / agmux-hub / agmux-wrap binaries
```

Per-package: `bun test packages/<pkg>/tests/...`, or
`bun run --filter @agmux/<pkg> <script>`.

## Repository layout

```
packages/
  protocol/   schema, event types, ids, version (single source of truth)
  store/      SQLite event log + projections
  hub/        local query daemon (binds 127.0.0.1)
  wrapper/    transparent Bun PTY wrapper
  adapters/   per-agent native hooks (claude / codex / pi)
  cli/        agmux command-line interface
  tui/        interactive dashboard
tests/        cross-package e2e
docs/         architecture (agmux-foundation.md) + the PTY spike report
```

`@agmux/protocol` is the dependency root — everything imports from it, and it owns
the product version in `src/version.ts`.

## Conventions

- TypeScript-on-Bun throughout; `type: "module"` everywhere.
- Keep parsing/logic in `src/` as pure, testable functions; bins stay thin.
- Add or update tests with any behavior change — `bun test` must stay green.
- Bump `packages/protocol/src/version.ts` and add a `CHANGELOG.md` entry for
  user-visible changes.

## Pull requests

Keep PRs focused. Describe what changed and why; make sure `bun run typecheck` and
`bun test` pass before requesting review.
