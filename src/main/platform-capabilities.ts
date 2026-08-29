export type LinuxDisplayServer = "x11" | "xwayland" | "wayland" | "none";

export type DesktopCapability =
  | { status: "available"; display: "macos" | LinuxDisplayServer }
  | { status: "unsupported"; message: string; display?: LinuxDisplayServer };

/** Manual update recovery follows each package shape without blurring the macOS instruction. */
export function manualUpdateRecovery(platform: NodeJS.Platform = process.platform) {
  if (platform === "darwin") return "Download the new version and replace the app in Applications.";
  if (platform === "linux") return "Download the new AppImage and replace the one you run.";
  return "Download the new version and replace the installed app.";
}

/** electron-updater can update Linux only when the running package is an AppImage. */
export function automaticUpdatesAvailable(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return platform !== "linux" || Boolean(environment.APPIMAGE);
}

/** macOS keeps the inset traffic lights; other desktops keep their native window controls. */
export function windowFrameOptions(platform: NodeJS.Platform = process.platform): { titleBarStyle?: "hiddenInset" } {
  return platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {};
}

/** Electron routes Wayland global shortcuts through the desktop portal only when this feature is on. */
export function needsGlobalShortcutsPortal(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return platform === "linux" && Boolean(environment.WAYLAND_DISPLAY && environment.DISPLAY);
}

/**
 * The connection variables are more useful than XDG_SESSION_TYPE here: a process may run in a
 * Wayland login while an XWayland display is also available, or inherit no display connection at
 * all. Keep this small boundary reusable when another desktop platform is added.
 */
export function linuxDisplayServer(environment: NodeJS.ProcessEnv = process.env): LinuxDisplayServer {
  const wayland = Boolean(environment.WAYLAND_DISPLAY);
  const x11 = Boolean(environment.DISPLAY);
  if (wayland && x11) return "xwayland";
  if (wayland) return "wayland";
  if (x11) return "x11";
  return "none";
}

export function computerUseCapability(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): DesktopCapability {
  if (platform === "darwin") return { status: "available", display: "macos" };
  if (platform !== "linux") return { status: "unsupported", message: `Computer use is not supported on ${platform}.` };
  const display = linuxDisplayServer(environment);
  if (display === "none") {
    return {
      status: "unsupported",
      display,
      message: "Computer use needs a graphical Linux session, but neither DISPLAY nor WAYLAND_DISPLAY is available.",
    };
  }
  if (display === "wayland" && environment.CUA_DRIVER_RS_ENABLE_WAYLAND !== "1") {
    return {
      status: "unsupported",
      display,
      message: "Native Wayland computer use is compositor-dependent and opt-in. Start AI Coding Tool with CUA_DRIVER_RS_ENABLE_WAYLAND=1, or use an X11/XWayland session.",
    };
  }
  return { status: "available", display };
}

export function windowCaptureCapability(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): DesktopCapability {
  if (platform === "darwin") return { status: "available", display: "macos" };
  if (platform !== "linux") return { status: "unsupported", message: `Window capture is not supported on ${platform}.` };
  const display = linuxDisplayServer(environment);
  if (display === "x11" || display === "xwayland") return { status: "available", display };
  if (display === "wayland") {
    return {
      status: "unsupported",
      display,
      message: "This Wayland compositor does not expose a safe global active-window capture path. Use an X11 session or XWayland window.",
    };
  }
  return {
    status: "unsupported",
    display,
    message: "Window capture needs a graphical Linux session, but neither DISPLAY nor WAYLAND_DISPLAY is available.",
  };
}
