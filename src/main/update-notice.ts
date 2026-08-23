import { dialog, shell, type BrowserWindow } from "electron";

const RELEASES_URL = "https://github.com/zyuapp/ai-coding-tool/releases/latest";

/**
 * An update the installed copy refuses says so and offers the download, rather than stopping in the
 * log. macOS ties a copy's signature to the bundle id it was signed with, so a build that changes
 * that id can only be installed by hand.
 */
export async function reportUpdateFailure(window: BrowserWindow | null, error: Error) {
  if (!window || window.isDestroyed()) return;
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    title: "Update failed",
    message: "AI Coding Tool could not install the update.",
    detail: `${error.message}\n\nDownload the new version and replace the app in Applications.`,
    buttons: ["Open downloads", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 0) await shell.openExternal(RELEASES_URL);
}
