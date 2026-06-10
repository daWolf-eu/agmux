# `agmux ls` sorting, limiting, status filtering + config defaults

**Date:** 2026-06-10
**Status:** approved

## Goal

QoL upgrades for `agmux ls`: control how many rows are shown, which column they
are sorted by, the sort direction, the display orientation (newest at the
bottom for small windows, right above the next prompt), and richer status
filtering — with personal defaults configurable in `~/.config/agmux/config.toml`.

## CLI surface

```
agmux ls [-n/--limit <num>] [--all] [--sort <started|activity>] [--asc] [-r/--reverse]
         [--status <active|open|closed|s1,s2,...>] [--live] [--agent <kind>] [--profile <name>]
```

| Flag | Meaning | Built-in default |
|---|---|---|
| `-n, --limit <num>` | row cap | 50 |
| `--all` | no cap (limit 10000); explicit `-n` wins if both given | off |
| `--sort started\|activity` | sort column: `started` → `start_ts`, `activity` → `COALESCE(last_heartbeat_ts, start_ts)` | `started` |
| `--asc` | ascending sort (SQL direction, applied before the limit) | off (descending) |
| `-r, --reverse` | presentation only: flip fetched rows top↔bottom after sort+limit | off |
| `--status <value>` | group alias or comma-separated raw statuses (see below) | all statuses |
| `--live` | alias for `--status open` (kept for compat; `--status` is canonical) | off |

`agmux ls -n 5 -r` → the 5 newest sessions, newest at the bottom.

Invalid `--sort`/`--status` values (or invalid config values): clear error,
exit 2.

### Status groups

| Value | Expands to |
|---|---|
| `active` | running, waiting |
| `open` | running, waiting, idle |
| `closed` | ended, lost |
| comma list (e.g. `running,lost`) | the literal statuses |

## Hub + store

- `/sessions` gains `sort`, `order` (`asc|desc`), and `status` query params,
  forwarded to `listSessions`.
- `listSessions` maps `sort`/`order` through a whitelist to the `ORDER BY`
  clause — user input is never interpolated into SQL. Defaults stay
  `start_ts DESC`; existing callers are unaffected.
- Status filtering runs hub-side **after** `computeEffectiveStatus` (since
  `lost` is computed from heartbeat staleness), where the `live` filter sits
  today. The row limit is applied **after** this filter, fixing the existing
  bug where `--live` could return fewer rows than the limit while more live
  sessions exist. `live=1` remains accepted as an alias for the `open` set.

## Config

New optional `[ls]` section in `~/.config/agmux/config.toml`:

```toml
[ls]
limit = 5
sort = "activity"   # started | activity
asc = false
reverse = true
status = "open"     # group alias or comma-separated statuses
```

- All keys optional. Precedence: CLI flag > `[ls]` config > built-in default.
- Loaded via a small `loadLsConfig(configPath)` alongside the existing
  `parseConfig` in the wrapper package (`AgmuxConfig` gains an optional `ls`
  field).
- Missing file or missing section → silent built-in defaults. Invalid values
  → loud error (typos must not masquerade as defaults).

## Testing

- Store: unit tests for sort column/direction, status-group expansion, and
  limit-after-status-filter.
- CLI: tests for flag parsing, config precedence, and `-r` row reversal.
- Existing e2e (`run → ls → kill`) stays green; `usage()` and README updated.
