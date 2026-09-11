export type NotifierKind = "terminal-notifier" | "osascript" | "notify-send" | "custom";

export interface NotifySpec {
  title: string;
  body: string;
  sound: string | null;
  attachId: string | null;
}

export type Which = (bin: string) => boolean;

const AUTO_ORDER: NotifierKind[] = ["terminal-notifier", "osascript", "notify-send"];

// An explicitly configured notifier that is missing resolves to null rather than
// silently substituting another: a user who asked for one path should be told it
// is absent, not quietly given different behaviour.
export function resolveNotifier(configured: string, which: Which): NotifierKind | null {
  if (configured === "auto") return AUTO_ORDER.find((b) => which(b)) ?? null;
  if (configured.trim() === "") return null;
  if ((AUTO_ORDER as string[]).includes(configured)) {
    return which(configured) ? (configured as NotifierKind) : null;
  }
  return "custom";
}

function osaEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildNotifyArgv(
  kind: NotifierKind,
  spec: NotifySpec,
  custom?: string,
): { cmd: string; args: string[] } {
  switch (kind) {
    case "terminal-notifier": {
      const args = ["-title", spec.title, "-message", spec.body];
      if (spec.sound) args.push("-sound", spec.sound);
      if (spec.attachId) args.push("-execute", `agmux attach ${spec.attachId}`);
      return { cmd: "terminal-notifier", args };
    }
    case "osascript": {
      const sound = spec.sound ? ` sound name "${osaEscape(spec.sound)}"` : "";
      return {
        cmd: "osascript",
        args: ["-e", `display notification "${osaEscape(spec.body)}" with title "${osaEscape(spec.title)}"${sound}`],
      };
    }
    case "notify-send":
      return { cmd: "notify-send", args: [spec.title, spec.body] };
    case "custom": {
      const parts = (custom ?? "").split(/\s+/).filter((s) => s.length > 0).map((tok) =>
        tok
          .replace("{title}", spec.title)
          .replace("{body}", spec.body)
          .replace("{session_id}", spec.attachId ?? "")
          .replace("{sound}", spec.sound ?? ""),
      );
      return { cmd: parts[0] ?? "", args: parts.slice(1) };
    }
  }
}
