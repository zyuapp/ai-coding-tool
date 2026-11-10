import type { GlassRegion } from "./glass.js";
import type { DesktopPlatform, ThreadNotice, WindowMaterial, WindowTheme } from "./ipc.js";

/** The window itself: its frame, the desktop around it, and how a thread reaches the user. */
export type WindowPort = {
  runtime: {
    closeWindow(): void;
    /** Takes the keyboard back from a page in the panel, so the window can have it. */
    focusWindow(): void;
    /** A thread's notice on its way to the desktop. Main decides whether the user is somewhere it has to reach them. */
    announceThread(notice: ThreadNotice): void;
    /** How many threads carry an unseen mark, which the platform draws on the app icon. */
    setBadgeCount(count: number): void;
    openSourceLicenses(): Promise<void>;
  };
  windowCalls: {
    /** The panes of glass under the window's page, for what sits on the frame with nothing of the page behind it. */
    setWindowGlassRegions(regions: GlassRegion[]): Promise<void>;
    /** The theme's ground and canvas, which the platform's own window frame is drawn from. */
    setTheme(theme: WindowTheme): void;
  };
  windowOwn: {
    /** Static renderer-facing platform identity; runtime capabilities still come from main. */
    readonly platform: DesktopPlatform;
    /** Static for the window's life, so the first paint already leaves the material showing. */
    readonly windowMaterial: WindowMaterial;
    /** The thread a clicked notification named, on its way to becoming the current one. */
    onOpenThread(listener: (taskId: string) => void): () => void;
    /** Whether the window is the one in use, its browser panel included. */
    onWindowActive(listener: (active: boolean) => void): () => void;
    /** How tinted the system draws its glass, 0 to 1, where the window sits on glass. */
    onGlassTint(listener: (amount: number) => void): () => void;
  };
};
