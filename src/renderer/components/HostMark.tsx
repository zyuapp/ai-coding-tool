import { LuMonitor as Monitor, LuMonitorOff as MonitorOff } from "react-icons/lu";

type HostMarkProps = {
  name: string;
  offline?: boolean;
  /** An offline computer that is being dialled again: its dark screen pulses until it answers. */
  reconnecting?: boolean;
  className?: string;
};

/**
 * A computer, wherever the app names one: a small screen ahead of the name, so the name reads as a
 * place and not as a second word. One that cannot be reached shows a dark screen and says so.
 */
export function HostMark({ name, offline = false, reconnecting = false, className }: HostMarkProps) {
  const state = offline ? (reconnecting ? "Reconnecting" : "Offline") : null;
  const classes = ["host-mark", offline && "offline", offline && reconnecting && "reconnecting", className].filter(Boolean).join(" ");
  return (
    <span className={classes} data-tip={state ? `${name} · ${state}` : undefined}>
      {state ? <MonitorOff size={12} role="img" aria-label={state} /> : <Monitor size={12} aria-hidden="true" />}
      <span>{name}</span>
    </span>
  );
}
