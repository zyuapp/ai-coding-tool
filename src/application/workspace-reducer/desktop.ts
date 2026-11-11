/** The machine around the thread: its files, and the applications that open them. */
import { shownPageEffects } from "./browser-tabs.js";
import { APP_FOLDER_ERROR, FILE_FOLDER_ERROR } from "./errors.js";
import { docksOf, closedWindowDocks } from "./dock-tabs.js";
import type { SliceTransition } from "./slice.js";
import type { WorkspaceInput } from "./types.js";
import type { DesktopState } from "../state/desktop.js";
import { threadFileRoots } from "../thread-location.js";
import { currentFolder, type WorkspaceState } from "../workspace-state.js";
import { isAbsoluteFilePath } from "../../domain/markdown-links.js";
import type { InstalledApp } from "../../contracts/ipc.js";
import { releasedToasts, rescheduledToasts, toastsOf } from "../toasts.js";

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

type Own = DesktopState;

export function reduceDesktop(state: WorkspaceState, input: DesktopInput): SliceTransition<Own> {
  switch (input.type) {
    case "image.open":
      return { patch: { viewingImage: input.source, viewingGallery: input.gallery?.includes(input.source) ? input.gallery : [] } };
    case "image.step": {
      const next = state.viewingImage === null ? undefined : state.viewingGallery[state.viewingGallery.indexOf(state.viewingImage) + input.delta];
      return next ? { patch: { viewingImage: next } } : {};
    }
    case "image.close":
      return { patch: { viewingImage: null, viewingGallery: [] } };
    case "image.download":
      return { clearsError: true, effects: state.viewingImage ? [{ type: "image.download", source: state.viewingImage }] : [] };
    case "view.mounted": {
      const toasts = releasedToasts(toastsOf(state));
      return {
        edits: [toasts],
        effects: [
          { type: "apply-shortcuts", overrides: state.shortcuts },
          { type: "apply-capture-options", options: { sound: state.captureSound, focus: state.captureFocus } },
          ...shownPageEffects(state),
          ...rescheduledToasts(toasts.view),
        ],
      };
    }

    case "view.closed":
      return { patch: { focused: false, viewingImage: null, viewingGallery: [] }, edits: [closedWindowDocks(docksOf(state))] };

    case "file.open": {
      const roots = threadFileRoots(state, state.threads.find((item) => item.id === (input.taskId ?? state.currentId)));
      if (!roots.length && !isAbsoluteFilePath(input.path)) return { refusal: FILE_FOLDER_ERROR };
      return { clearsError: true, effects: [{ type: "file.open", roots, path: input.path, line: input.line ?? null }] };
    }

    /** The list a menu draws stays as it was while a fresh one is read, so opening it never blanks. */
    case "app.list":
      return { effects: [{ type: "app.list" }] };

    case "apps.listed":
      return { patch: { installedApps: input.apps } };

    case "app.open-folder": {
      const root = currentFolder(state);
      if (!root) return { refusal: APP_FOLDER_ERROR };
      return { clearsError: true, closesMenu: true, effects: [{ type: "app.open-folder", root, appId: input.appId }] };
    }

    case "app.open-source-licenses":
      return { effects: [{ type: "app.open-source-licenses" }] };
  }
}
