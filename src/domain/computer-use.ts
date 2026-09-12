/** What the machine grants computer use, and what a run is given of it. */
export type ComputerUsePermissions = {
  accessibility: boolean;
  screenRecording: boolean;
  /** Linux has no macOS permission switches; this reports the runtime path Settings can explain. */
  linuxRuntime?: {
    status: "available" | "limited" | "unavailable";
    display: "x11" | "xwayland" | "wayland" | "none";
    message: string;
  };
};

export type ComputerUsePermission = "accessibility" | "screenRecording";

export type ComputerUseMcp = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type ComputerUseRunConfig =
  | { status: "available"; mcp: ComputerUseMcp }
  | { status: "setup-required" }
  | { status: "unavailable"; message: string };

/** Whether two readings of the platform say the same thing, so a poll that brings no news changes nothing. */
export function sameComputerUsePermissions(left: ComputerUsePermissions, right: ComputerUsePermissions) {
  if (left.accessibility !== right.accessibility || left.screenRecording !== right.screenRecording) return false;
  if (!left.linuxRuntime || !right.linuxRuntime) return left.linuxRuntime === right.linuxRuntime;
  return left.linuxRuntime.status === right.linuxRuntime.status
    && left.linuxRuntime.display === right.linuxRuntime.display
    && left.linuxRuntime.message === right.linuxRuntime.message;
}
