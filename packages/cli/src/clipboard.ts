// Autodetecting clipboard writer. Chain: native platform tool (pbcopy on macOS;
// wl-copy/xclip/xsel on Linux) → OSC 52 escape fallback (works over SSH and where
// no native tool is on PATH). All I/O goes through injectable ClipboardDeps so
// tests assert chain selection and OSC 52 formatting without touching the real
// clipboard.

export interface ClipboardDeps {
  platform: string;                                  // process.platform
  env: Record<string, string | undefined>;           // process.env (for $TMUX)
  which: (cmd: string) => boolean;                    // is cmd on PATH?
  spawn: (argv: string[], input: string) => Promise<boolean>; // true when exit 0
  writeOut: (data: string) => void;                   // stdout write for OSC 52
}

const defaultDeps: ClipboardDeps = {
  platform: process.platform,
  env: process.env,
  which: (cmd) => Bun.which(cmd) != null,
  spawn: async (argv, input) => {
    try {
      const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      proc.stdin.write(input);
      await proc.stdin.end();
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  },
  writeOut: (data) => { process.stdout.write(data); },
};

// Native candidate argv lists for the platform, filtered to tools on PATH.
export function clipboardCandidates(platform: string, which: (cmd: string) => boolean): string[][] {
  const all: string[][] =
    platform === "darwin" ? [["pbcopy"]]
    : platform === "linux" ? [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]
    : [];
  return all.filter((argv) => which(argv[0]!));
}

// OSC 52 clipboard-set sequence. When inside tmux, wrap in a passthrough sequence
// (\ePtmux;… with every inner ESC doubled …\e\\) so tmux forwards it to the outer
// terminal — requires tmux `set-clipboard on` / passthrough on the user's side.
export function osc52(text: string, tmux: boolean): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  const seq = `\x1b]52;c;${b64}\x07`;
  if (!tmux) return seq;
  return `\x1bPtmux;\x1b${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

export async function copyToClipboard(text: string, deps: ClipboardDeps = defaultDeps): Promise<void> {
  for (const argv of clipboardCandidates(deps.platform, deps.which)) {
    if (await deps.spawn(argv, text)) return;
  }
  deps.writeOut(osc52(text, !!deps.env.TMUX));
}
