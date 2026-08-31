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
