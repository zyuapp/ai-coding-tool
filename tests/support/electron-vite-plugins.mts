import type { Plugin } from "vite";
import { MOBILE_HOST_MODULE } from "./mobile-host-stub.mjs";

/** Both fakes are reached through globals, so the modules under test import them like the real ones. */
export function fakePlugins(computerUse: boolean, updater = false): Plugin[] {
  const plugins: Plugin[] = [{
    name: "fake-electron",
    enforce: "pre",
    resolveId(id) { if (id === "virtual:fake-electron") return "\0fake-electron"; },
    load(id) {
      if (id === "\0fake-electron") return "const e = globalThis.__aicodingtoolElectron; export const app=e.app, Menu=e.Menu, BaseWindow=e.BaseWindow, BrowserWindow=e.BrowserWindow, desktopCapturer=e.desktopCapturer, dialog=e.dialog, globalShortcut=e.globalShortcut, ipcMain=e.ipcMain, nativeTheme=e.nativeTheme, net=e.net, powerMonitor=e.powerMonitor, powerSaveBlocker=e.powerSaveBlocker, Notification=e.Notification, protocol=e.protocol, screen=e.screen, session=e.session, shell=e.shell, systemPreferences=e.systemPreferences, utilityProcess=e.utilityProcess, WebContentsView=e.WebContentsView;";
    },
  }, {
    name: "fake-mobile-host",
    enforce: "pre",
    resolveId(id, importer) {
      if (id === "./mobile-host.mjs" && importer?.endsWith("/src/main/mobile/bridge.ts")) return "\0fake-mobile-host";
    },
    load(id) {
      if (id === "\0fake-mobile-host") return MOBILE_HOST_MODULE;
    },
  }];
  if (updater) {
    plugins.push({
      name: "fake-updater",
      enforce: "pre",
      resolveId(id) { if (id === "virtual:fake-updater") return "\0fake-updater"; },
      load(id) {
        if (id === "\0fake-updater") return "export default { autoUpdater: globalThis.__aicodingtoolUpdater };";
      },
    });
  }
  if (computerUse) {
    plugins.push({
      name: "fake-computer-use",
      enforce: "pre",
      resolveId(id, importer) {
        if (id === "./computer-use-host.js" && importer?.endsWith("/src/main/main.ts")) return "\0fake-computer-use";
      },
      load(id) {
        if (id === "\0fake-computer-use") return "const c = globalThis.__aicodingtoolComputerUse; export const computerUseForRun=c.computerUseForRun, computerUsePermissions=c.computerUsePermissions, requestComputerUsePermission=c.requestComputerUsePermission, stopComputerUse=c.stopComputerUse, resumeComputerUse=c.resumeComputerUse ?? (() => {});";
      },
    });
  }
  return plugins;
}
