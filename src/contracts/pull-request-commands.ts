import { optionalText, text, type Declarations } from "./command-declaration.js";

/**
 * Asks GitHub about the pull request the checkout in front belongs to. Sent again whenever that
 * checkout, its branch or the thread reading it changes, and on a slow poll until the answer settles.
 * `taskId` asks about a thread tab's checkout instead.
 */
export type PullRequestCommand =
  | { type: "pull-request.read"; taskId?: string }
  /** Reads the pull request of every checkout a coordinator's threads work in. */
  | { type: "pull-request.read-members"; taskId?: string }
  /** Reads the pull request of the checkout one thread under a coordinator works in, on the computer that holds it. */
  | { type: "pull-request.read-member"; taskId: string };

export const pullRequestCommands = {
  "pull-request.read": { fields: { taskId: optionalText }, at: "thread" },
  "pull-request.read-members": { fields: { taskId: optionalText }, at: "thread" },
  "pull-request.read-member": { fields: { taskId: text }, at: "thread" },
} satisfies Declarations<PullRequestCommand>;
