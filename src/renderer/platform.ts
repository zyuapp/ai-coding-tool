import type { DesktopPlatform, WindowMaterial } from "../contracts/ipc";

export type WindowChrome = "inset" | "native";

/** What the renderer does differently on each desktop. Supporting another one is one more row. */
export type PlatformCapabilities = {
  /** `inset`: the platform draws its window controls over the renderer. `native`: they stay outside it. */
  windowChrome: WindowChrome;
  /** Mod is ⌘, and shortcuts are drawn with the platform's key glyphs. */
  commandKey: boolean;
  /** The key Mod stands for, as `aria-keyshortcuts` names it. */
  modKey: "Meta" | "Control";
  /** Mod written before a key or a click, as in "⌘Click" or "Ctrl+Click". */
  modLabel: string;
  /** The iOS Simulator panel. */
  simulator: boolean;
  /** Computer use waits on system permissions the user grants, rather than on a runtime the platform provides. */
  computerUsePermissions: boolean;
  /** How the UI names the machine it runs on. */
  computerName: string;
  /** The label for showing a file in the platform's file manager. */
  revealLabel: string;
  /** The dictation model's download, and whether other apps on the machine share it. */
  dictationModel: { size: string; shared: boolean };
};

const MACOS: PlatformCapabilities = {
  windowChrome: "inset",
  commandKey: true,
  modKey: "Meta",
  modLabel: "⌘",
  simulator: true,
  computerUsePermissions: true,
  computerName: "this Mac",
  revealLabel: "Reveal in Finder",
  dictationModel: { size: "about 450 MB", shared: true },
};

const FRAMED: PlatformCapabilities = {
  windowChrome: "native",
  commandKey: false,
  modKey: "Control",
  modLabel: "Ctrl+",
  simulator: false,
  computerUsePermissions: false,
  computerName: "this computer",
  revealLabel: "Show in file manager",
  dictationModel: { size: "about 660 MB", shared: false },
};

const CAPABILITIES: Record<DesktopPlatform, PlatformCapabilities> = { macos: MACOS, linux: FRAMED, other: FRAMED };

/**
 * What the desktop this window runs on can do, from the platform the preload reports. A page the
 * preload never reached, such as a component drawn on its own, gets a framed desktop's.
 */
export function platformCapabilities(platform: DesktopPlatform | undefined = globalThis.window?.desktop?.platform): PlatformCapabilities {
  return CAPABILITIES[platform ?? "other"];
}

/** Whether an event holds the key Mod stands for on this desktop. */
export function modHeld(event: { metaKey: boolean; ctrlKey: boolean }) {
  return platformCapabilities().modKey === "Meta" ? event.metaKey : event.ctrlKey;
}

/**
 * One renderer marker owns every spacing decision that follows the shape of the native frame, and
 * one more says whether the platform draws a material under the page for the chrome to show.
 */
export function applyWindowChrome(platform: DesktopPlatform, material: WindowMaterial = "none", root: Pick<HTMLElement, "dataset"> = document.documentElement) {
  root.dataset.windowChrome = platformCapabilities(platform).windowChrome;
  if (material === "none") delete root.dataset.windowMaterial;
  else root.dataset.windowMaterial = material;
  /** Over Liquid Glass the whole window is drawn as one sheet. */
  if (material === "glass") root.dataset.glassSheet = "";
  else delete root.dataset.glassSheet;
}
