// Run inside a tmux pane: records what the wrapper thinks its pane is.
import * as fs from "node:fs";
import { readCurrentTmuxCoords } from "../../src/tmux.ts";

const coords = await readCurrentTmuxCoords();
fs.writeFileSync(process.argv[2]!, JSON.stringify({ coords, own: process.env.TMUX_PANE }));
