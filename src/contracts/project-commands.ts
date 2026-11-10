import { deviceId, literals, nullableText, number, optional, optionalText, pathText, text, type Declarations } from "./command-declaration.js";
import * as phone from "./phone-commands.js";

export type ProjectCommand =
  /** `start` asks for a folder by path to start a thread in, rather than one to add to the sidebar. */
  | { type: "project.open"; start?: true }
  | { type: "project.add"; root: string; computerId?: string; start?: true }
  | { type: "view.add-project-close" }
  | { type: "view.add-project-device"; computerId: string }
  | { type: "view.add-project-path"; root: string }
  | { type: "view.add-project-pick" }
  | { type: "view.add-project-submit" }
  | { type: "view.add-project-key"; key: "ArrowUp" | "ArrowDown" | "Tab" | "Enter" | "Escape" }
  | { type: "view.add-project-accept"; index: number }
  /** `index` counts the folders in the sidebar with the moved one already taken out. */
  /**
   * Names the folder in the sidebar, points it at another directory, or both. A blank `name` takes
   * the name off, so the folder goes by its own again. A `root` that is not a folder the app can
   * open leaves everything as it was and says why.
   */
  | { type: "project.edit"; projectId: string; name?: string | null; root?: string }
  | { type: "project.remove"; projectId: string };

/** A folder on this computer opened as a project, never one on another computer the desktop is linked to. */
const addsProject: phone.PhoneRule = (command) => phone.isString(command.root, phone.MAX_PATH_LENGTH) && command.root.trim().length > 0
  && command.computerId === undefined && (command.start === undefined || command.start === true);

export const projectCommands = {
  "project.open": { fields: { start: optional(literals(true)) }, at: "local" },
  "project.add": { fields: { root: (value): value is string => pathText(value) && value.trim().length > 0, computerId: optional(deviceId), start: optional(literals(true)) }, at: "own", phone: addsProject },
  "view.add-project-close": { fields: {}, at: "local" },
  "view.add-project-device": { fields: { computerId: deviceId }, at: "local" },
  "view.add-project-path": { fields: { root: pathText }, at: "local" },
  "view.add-project-pick": { fields: {}, at: "local" },
  "view.add-project-submit": { fields: {}, at: "local" },
  "view.add-project-key": { fields: { key: literals("ArrowUp", "ArrowDown", "Tab", "Enter", "Escape") }, at: "local" },
  "view.add-project-accept": { fields: { index: (value): value is number => number(value) && Number.isInteger(value) && value >= 0 && value < 20 }, at: "local" },
  "project.edit": { fields: { projectId: text, name: optional(nullableText), root: optionalText }, at: "project" },
  "project.remove": { fields: { projectId: text }, at: "project" },
} satisfies Declarations<ProjectCommand>;
