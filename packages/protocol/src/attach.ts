// Where `agmux attach --placement` / the dash `A` popup opens a session. The
// order IS the popup's fixed digit slots (1–7): never reorder, only append.
export const ATTACH_PLACEMENTS = [
  "inline", "new-pane", "new-window", "new-session", "peek", "new-tab", "new-terminal",
] as const;
export type AttachPlacement = (typeof ATTACH_PLACEMENTS)[number];

export function isAttachPlacement(v: unknown): v is AttachPlacement {
  return typeof v === "string" && (ATTACH_PLACEMENTS as readonly string[]).includes(v);
}
