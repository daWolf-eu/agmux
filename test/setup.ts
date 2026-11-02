// Tests must not depend on the caller sitting inside a Rex block.
// Tests that want Rex set their own REX_* env.
import { REX_ENV_KEYS } from "../packages/protocol/src/mux.ts";

for (const k of REX_ENV_KEYS) delete process.env[k];
