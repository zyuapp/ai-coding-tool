import { Menu, type MenuItemConstructorOptions } from "electron";

/**
 * The default menu with app help added, so every role macOS expects stays where the user looks for
 * it. Updates and the licenses shipped with this build remain easy to return to.
 */
export function installAppMenu(callbacks: { onCheckForUpdates: () => void; onOpenSourceLicenses: () => void }) {
  const checkForUpdates: MenuItemConstructorOptions = { label: "Check for Updates…", click: callbacks.onCheckForUpdates };
  const openSourceLicenses: MenuItemConstructorOptions = { label: "Open Source Licenses…", click: callbacks.onOpenSourceLicenses };
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [{
          label: "AI Coding Tool",
          submenu: [
            { role: "about" },
            { type: "separator" },
            checkForUpdates,
            openSourceLicenses,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        } satisfies MenuItemConstructorOptions]
      : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    ...(mac ? [] : [{ role: "help", submenu: [checkForUpdates, openSourceLicenses] } satisfies MenuItemConstructorOptions]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
