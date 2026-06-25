/** @jsxImportSource @opentui/react */
const HINT = "j/k move · g/G top/bottom · s sort · f filter · / search · ⏎ attach · x kill · tab preview · p panel · ? help · q quit";

export function FooterBar(props: { error: string | null; searching: boolean; search: string; confirmKill: string | null; notice: string | null }) {
  if (props.confirmKill) return <text fg="#f38ba8">kill {props.confirmKill}? y/n</text>;
  if (props.searching) return <text>search: {props.search}▏</text>;
  if (props.notice) return <text fg="#f9e2af">{props.notice}</text>;
  if (props.error) return <text fg="#f38ba8">hub unreachable — reconnecting… ({props.error})</text>;
  return <text fg="#6c7086">{HINT}</text>;
}
