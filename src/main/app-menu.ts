import { Menu, type MenuItemConstructorOptions } from "electron";

/**
 * The default menu with one item added, so every role macOS expects stays where the user looks for
 * it. An update the user put off is theirs to come back to from here.
 */
export function installAppMenu(onCheckForUpdates: () => void) {
  const checkForUpdates: MenuItemConstructorOptions = { label: "Check for Updates…", click: onCheckForUpdates };
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [{
          label: "AI Coding Tool",
          submenu: [
            { role: "about" },
            { type: "separator" },
            checkForUpdates,
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
    ...(mac ? [] : [{ role: "help", submenu: [checkForUpdates] } satisfies MenuItemConstructorOptions]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
