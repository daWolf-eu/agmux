export const AGMUX_SESSION_ID_ENV = "AGMUX_SESSION_ID";
export const AGMUX_HUB_URL_ENV = "AGMUX_HUB_URL";
export const AGMUX_TMUX_SESSION_ENV = "AGMUX_TMUX_SESSION";
export const AGMUX_PROFILE_ENV = "AGMUX_PROFILE";

export const AGMUX_STATE_DIR_DEFAULT = ".agmux";
export const AGMUX_CONFIG_SUBPATH = ".config/agmux/config.toml";
export const AGMUX_TMUX_SESSION_DEFAULT = "agmux";

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const LOST_THRESHOLD_MS = 60_000;

// A `running` session with no evidence of work (no status change, tool event or
// title update) for this long is reported as `idle` at read time. Safety net for
// a turn whose end we never observed — Claude's Stop hook does not fire on an
// Esc/interrupt, and a wrapper-less session outside tmux has no title signal.
export const WORKING_TIMEOUT_MS = 180_000;

// While the agent's title keeps saying "working", title.changed is re-sent at
// this cadence even without a change, so the working timeout above sees a
// thinking-only turn (no tool calls) as alive.
export const TITLE_KEEPALIVE_MS = 60_000;
