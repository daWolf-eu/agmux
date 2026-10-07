import { StringDecoder } from "node:string_decoder";

// Longest OSC body we buffer. Titles are short; anything longer (OSC 52
// clipboard payloads, say) is skipped up to its terminator, unbuffered.
const MAX_OSC = 4096;

// Streaming extractor for terminal-title sequences (OSC 0 / OSC 2, terminated
// by BEL or ST) in the agent's PTY output. The wrapper already forwards every
// byte, so watching titles here is a free, push-driven "working" signal — no
// polling, no tmux needed. Sequences may be split across reads at any byte;
// the parser carries its state (and partial UTF-8) between feeds. Output is
// never modified: this only observes.
export class OscTitleParser {
  private readonly dec = new StringDecoder("utf8");
  private state: "text" | "esc" | "osc" | "osc-esc" = "text";
  private buf = "";
  private overflow = false;

  feed(chunk: Buffer | Uint8Array | string): string[] {
    const s = typeof chunk === "string" ? chunk : this.dec.write(Buffer.from(chunk));
    const titles: string[] = [];
    let i = 0;
    while (i < s.length) {
      if (this.state === "text") {
        const at = s.indexOf("\x1b", i);
        if (at < 0) break;
        this.state = "esc";
        i = at + 1;
        continue;
      }
      const ch = s[i]!;
      i++;
      if (this.state === "esc") {
        if (ch === "]") { this.state = "osc"; this.buf = ""; this.overflow = false; }
        else this.state = ch === "\x1b" ? "esc" : "text";
        continue;
      }
      if (this.state === "osc-esc") {
        // ESC \ (ST) ends the sequence; any other ESC aborts it.
        if (ch === "\\") this.finish(titles);
        else this.state = ch === "]" ? "osc" : "text";
        if (ch === "]") { this.buf = ""; this.overflow = false; }
        continue;
      }
      // state === "osc"
      if (ch === "\x07") { this.finish(titles); continue; }
      if (ch === "\x1b") { this.state = "osc-esc"; continue; }
      if (!this.overflow) {
        if (this.buf.length >= MAX_OSC) { this.overflow = true; this.buf = ""; }
        else this.buf += ch;
      }
    }
    return titles;
  }

  private finish(titles: string[]): void {
    this.state = "text";
    if (!this.overflow) {
      const m = /^([02]);(.*)$/s.exec(this.buf);
      if (m) titles.push(m[2]!);
    }
    this.buf = "";
    this.overflow = false;
  }
}
