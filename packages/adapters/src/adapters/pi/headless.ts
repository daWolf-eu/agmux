import type { HeadlessContext, HeadlessPlan } from "../../core/types.ts";

// pi has no documented non-interactive invocation yet. Declaring it explicitly
// (rather than omitting the method) keeps the "why" next to the other adapters.
export function piHeadlessPlan(_ctx: HeadlessContext): HeadlessPlan {
  return { supported: false };
}
