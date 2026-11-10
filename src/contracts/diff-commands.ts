import { isDiffRange, type DiffMode, type DiffRange } from "../domain/diff.js";
import { isCommitHash } from "../domain/message-artifacts.js";
import { boolean, literals, optionalText, text, type Declarations } from "./command-declaration.js";

/** The diff panel. Which comparison it shows, which file is open, and which files are ticked off. */
export type DiffCommand =
  /** Opens the panel, or closes it when it is already the tab in front. `taskId` names a thread tab whose checkout it reviews. */
  | { type: "diff.toggle"; taskId?: string }
  | { type: "diff.refresh" }
  | { type: "diff.open-commit"; commit: string; taskId?: string }
  | { type: "diff.set-range"; range: DiffRange }
  | { type: "diff.set-mode"; mode: DiffMode }
  /** Folds one file shut, or opens it again. Every file starts open. */
  | { type: "diff.set-collapsed"; path: string; collapsed: boolean }
  | { type: "diff.set-viewed"; path: string; viewed: boolean }
  | { type: "diff.set-split"; split: boolean }
  /** Reads the comparison again, leaving out the lines that only changed their spacing. */
  | { type: "diff.set-ignore-whitespace"; ignore: boolean };

export const diffCommands = {
  "diff.toggle": { fields: { taskId: optionalText }, at: "thread" },
  "diff.refresh": { fields: {}, at: "thread" },
  "diff.open-commit": { fields: { commit: isCommitHash, taskId: optionalText }, at: "thread" },
  "diff.set-range": { fields: { range: isDiffRange }, at: "thread" },
  "diff.set-mode": { fields: { mode: literals("uncommitted", "branch") }, at: "thread" },
  "diff.set-collapsed": { fields: { path: text, collapsed: boolean }, at: "thread" },
  "diff.set-viewed": { fields: { path: text, viewed: boolean }, at: "thread" },
  "diff.set-split": { fields: { split: boolean }, at: "thread" },
  "diff.set-ignore-whitespace": { fields: { ignore: boolean }, at: "thread" },
} satisfies Declarations<DiffCommand>;
