import { app, systemPreferences } from "electron";
import path from "node:path";
import { DictationHost, dictationHelper } from "./dictation-host.js";
import type { WindowCapability } from "./window-capability.js";

/** A source build can point at another model folder, to try the download without touching the shared one. */
const DEV_MODELS = "AIC_DICTATION_MODELS";

let host: DictationHost | null = null;

/** The window's dictation, which asks macOS for the microphone in the app's own name. Linux has no such prompt. */
export function desktopDictation(): DictationHost {
  const models = app.isPackaged ? undefined : process.env[DEV_MODELS];
  return host ??= new DictationHost({
    ...(models ? { models } : {}),
    helper: dictationHelper(app.isPackaged ? path.join(process.resourcesPath, "native") : path.join(app.getAppPath(), "dist", "native"), app.isPackaged),
    microphone: async () => {
      if (process.platform !== "darwin") return true;
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

export const dictationCapability: WindowCapability = {
  start: ({ send }) => { desktopDictation().onDictationLevel((level) => send("dictation:level", level)); },
  stopAtQuit: stopDesktopDictation,
};
