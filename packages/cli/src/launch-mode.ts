// A session that can self-register (has an adapter) runs directly; everything
// else (or an explicit --wrapped) goes through the PTY wrapper.
export type LaunchMode = "direct" | "wrapped";

export function decideLaunchMode(o: { wrapped: boolean; hasAdapter: boolean }): LaunchMode {
  if (o.wrapped) return "wrapped";      // explicit opt-in
  if (!o.hasAdapter) return "wrapped";  // can't self-register → must wrap
  return "direct";
}
