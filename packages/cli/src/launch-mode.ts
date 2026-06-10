// The Stage 2 flip: a session that can self-register (has an adapter) runs
// directly; everything else (or an explicit --wrapped) goes through the PTY
// wrapper. See docs/superpowers/plans/2026-06-09-native-first-stage2.md (D1).
export type LaunchMode = "direct" | "wrapped";

export function decideLaunchMode(o: { wrapped: boolean; hasAdapter: boolean }): LaunchMode {
  if (o.wrapped) return "wrapped";      // explicit opt-in
  if (!o.hasAdapter) return "wrapped";  // can't self-register → must wrap
  return "direct";
}
