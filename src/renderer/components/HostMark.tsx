import { LuMonitor as Monitor, LuMonitorOff as MonitorOff } from "react-icons/lu";

type HostMarkProps = {
  name: string;
  offline?: boolean;
  className?: string;
};

/**
 * A computer, wherever the app names one: a small screen ahead of the name, so the name reads as a
 * place and not as a second word. One that cannot be reached shows a dark screen and says so.
 */
export function HostMark({ name, offline = false, className }: HostMarkProps) {
  const Screen = offline ? MonitorOff : Monitor;
  return (
    <span className={`host-mark${offline ? " offline" : ""}${className ? ` ${className}` : ""}`} title={offline ? `${name} is offline` : undefined}>
      <Screen size={12} aria-hidden="true" />
      <span>{name}</span>
    </span>
  );
}
