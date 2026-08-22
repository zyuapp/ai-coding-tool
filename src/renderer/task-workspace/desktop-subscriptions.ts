import type { WorkspaceInput } from "../../application/workspace-reducer";

/**
 * What main announces to the window unasked. Each one is a command the workspace already knows, and
 * they are opened together so the window drops every one of them at once.
 */
export function subscribeToDesktop(dispatch: (input: WorkspaceInput) => void) {
  const stops = [
    /** A folder the `claudex` command named arrives as an already-registered workspace. */
    window.desktop.onOpenProject((workspace) => dispatch({ type: "project.opened", workspace })),
    /** The desktop hotkey names no thread, so a grabbed window waits in whichever composer is current. */
    window.desktop.onWindowScreenshot((shot) => dispatch({ type: "image.add", path: shot.path, label: shot.title ? `${shot.app} — ${shot.title}` : shot.app })),
    /** A notification the user clicked names the thread whose finding it carried. */
    window.desktop.onOpenThread((taskId) => dispatch({ type: "task.select", taskId })),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
