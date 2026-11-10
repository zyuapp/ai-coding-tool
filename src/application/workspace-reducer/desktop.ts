/** The machine around the thread: its files, and the applications that open them. */
import { shownPageEffects } from "./browser-tabs.js";
import { APP_FOLDER_ERROR, FILE_FOLDER_ERROR } from "./errors.js";
import { settled, rejected } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { threadFileRoots } from "../thread-location.js";
import { currentFolder, type WorkspaceState } from "../workspace-state.js";
import { isAbsoluteFilePath } from "../../domain/markdown-links.js";
import type { InstalledApp } from "../../contracts/ipc.js";
import { DOCK_PICKER } from "../workspace-dock.js";
import { rescheduledToasts } from "../toasts.js";

export const DESKTOP_INPUTS = [
  "image.open", "image.step", "image.close", "image.download", "file.open", "app.list", "apps.listed", "app.open-folder",
  "app.open-source-licenses", "view.closed", "view.mounted"
] as const;
type DesktopInput = Extract<WorkspaceInput, { type: (typeof DESKTOP_INPUTS)[number] }>;

/** The applications this machine has, as the main process last found them. */
export type DesktopEvent = { type: "apps.listed"; apps: InstalledApp[] };

export type DesktopEffect =
  | { type: "image.download"; source: string }
  /** A file the desktop opens for the reader. `roots` are the checkouts to look for it in, nearest first. */
  | { type: "file.open"; roots: string[]; path: string; line: number | null }
  | { type: "app.list" }
  /** The thread's checkout, opened in another application on the machine. */
  | { type: "app.open-folder"; root: string; appId: string }
  | { type: "app.open-source-licenses" };

export function reduceDesktop(state: WorkspaceState, input: DesktopInput): WorkspaceTransition {
  switch (input.type) {
    case "image.open":
      return settled({ ...state, viewingImage: input.source, viewingGallery: input.gallery?.includes(input.source) ? input.gallery : [] });
    case "image.step": {
      const next = state.viewingImage === null ? undefined : state.viewingGallery[state.viewingGallery.indexOf(state.viewingImage) + input.delta];
      return settled(next ? { ...state, viewingImage: next } : state);
    }
    case "image.close":
      return settled({ ...state, viewingImage: null, viewingGallery: [] });
    case "image.download":
      return settled({ ...state, actionError: null }, state.viewingImage ? [{ type: "image.download", source: state.viewingImage }] : []);
    case "view.mounted": {
      const mounted = state.toastsHeld ? { ...state, toastsHeld: false } : state;
      return settled(mounted, [
        { type: "apply-shortcuts", overrides: state.shortcuts },
        { type: "apply-capture-options", options: { sound: state.captureSound, focus: state.captureFocus } },
        ...shownPageEffects(state),
        ...rescheduledToasts(mounted),
      ]);
    }

    case "view.closed": {
      const docks = { ...state.docks };
      for (const [owner, dock] of Object.entries(docks)) {
        const tab = dock.terminals.some((terminal) => terminal.id === dock.tab) ? DOCK_PICKER : dock.tab;
        docks[owner] = {
          ...dock,
          tab,
          terminals: [],
          terminalId: null,
          browserTabs: dock.browserTabs.map(({ error: _error, ...page }) => ({ ...page, loading: false, canGoBack: false, canGoForward: false })),
        };
      }
      return settled({ ...state, docks, focused: false, keyboardTab: null, viewingImage: null, viewingGallery: [] });
    }

    case "file.open": {
      const roots = threadFileRoots(state, state.threads.find((item) => item.id === (input.taskId ?? state.currentId)));
      if (!roots.length && !isAbsoluteFilePath(input.path)) return rejected(state, FILE_FOLDER_ERROR);
      return settled({ ...state, actionError: null }, [{ type: "file.open", roots, path: input.path, line: input.line ?? null }]);
    }

    /** The list a menu draws stays as it was while a fresh one is read, so opening it never blanks. */
    case "app.list":
      return settled(state, [{ type: "app.list" }]);

    case "apps.listed":
      return settled({ ...state, installedApps: input.apps });

    case "app.open-folder": {
      const root = currentFolder(state);
      if (!root) return rejected(state, APP_FOLDER_ERROR);
      return settled({ ...state, actionError: null, openMenu: null }, [{ type: "app.open-folder", root, appId: input.appId }]);
    }

    case "app.open-source-licenses":
      return settled(state, [{ type: "app.open-source-licenses" }]);
  }
}
