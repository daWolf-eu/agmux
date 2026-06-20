/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import type { SessionFeed } from "../feed.ts";
import type { Actions, Handoff, PreviewMode, PreviewSource } from "../types.ts";

export interface DashAppProps {
  feed: SessionFeed;
  source: PreviewSource;
  actions: Actions;
  hubUrl: string;
  defaultPreview: PreviewMode;
  intervalMs: number;
  onHandoff: (h: Handoff) => void;
  onQuit: () => void;
}

export function DashApp(props: DashAppProps) {
  useKeyboard((key) => {
    if (key.name === "q") props.onQuit();
  });
  return (
    <box style={{ border: true }} title="agmux dash">
      <text>connecting to {props.hubUrl}…</text>
    </box>
  );
}
