import { app, systemPreferences } from "electron";
import path from "node:path";
import { DictationHost } from "./dictation-host.js";

let host: DictationHost | null = null;

/** The window's dictation, which asks macOS for the microphone in the app's own name. */
export function desktopDictation(): DictationHost {
  return host ??= new DictationHost({
    helper: app.isPackaged
      ? path.join(process.resourcesPath, "native", "aic-dictation")
      : path.join(app.getAppPath(), "dist", "native", "aic-dictation"),
    microphone: async () => {
      const access = systemPreferences.getMediaAccessStatus("microphone");
      if (access === "granted") return true;
      if (access === "not-determined") return systemPreferences.askForMediaAccess("microphone");
      return false;
    },
  });
}

/** Stops the helper, if one was ever started. */
export function stopDesktopDictation() {
  host?.stop();
}
