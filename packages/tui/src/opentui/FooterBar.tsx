/** @jsxImportSource @opentui/react */
const HINT = "j/k move · g/G top/bottom · s sort · / filter · ⏎ attach · x kill · tab preview · ? help · q quit";

export function FooterBar(props: { error: string | null; filtering: boolean; filter: string; confirmKill: string | null }) {
  if (props.confirmKill) return <text fg="#f38ba8">kill {props.confirmKill}? y/n</text>;
  if (props.filtering) return <text>filter: {props.filter}▏</text>;
  if (props.error) return <text fg="#f38ba8">hub unreachable — reconnecting… ({props.error})</text>;
  return <text fg="#6c7086">{HINT}</text>;
}
