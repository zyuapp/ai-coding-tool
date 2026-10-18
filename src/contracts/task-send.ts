import type { AppCommand } from "./commands.js";

type TaskSend = Extract<AppCommand, { type: "task.send" }>;

/**
 * Who may set a field of a send. `anyone` is what a message is: its text, the thread it goes to,
 * and where a new one starts. `starting` shapes a thread an agent creates, never one that exists,
 * and a phone sets those through the draft's own settings instead. `window` is the app's alone:
 * the files a composer carries, the coordinator a thread works under and what it reads of it, and
 * which thread a message came from.
 */
type SendReach = "anyone" | "starting" | "window";

/** Every field of a send, declared once, so a new one is refused from outside until it says who may set it. */
const SEND_REACH: { readonly [Field in keyof Omit<TaskSend, "type">]-?: SendReach } = {
  taskId: "anyone",
  project: "anyone",
  text: "anyone",
  steer: "anyone",
  worktree: "anyone",
  worktreeId: "anyone",
  model: "starting",
  effort: "starting",
  role: "starting",
  brief: "starting",
  title: "starting",
  attachments: "window",
  coordinatorId: "window",
  from: "window",
  sender: "window",
  lead: "window",
  memory: "window",
};

/** The callers outside the window that may send a message: an agent's run, and a paired phone. */
export type SendCaller = "agent" | "phone";

/** Whether a send sets only what its caller may: the window's fields never, and a new thread's shape only an agent starting one. */
export function sendStaysInReach(command: Readonly<Record<string, unknown>>, caller: SendCaller): boolean {
  for (const [field, reach] of Object.entries(SEND_REACH)) {
    if (command[field] === undefined || reach === "anyone") continue;
    if (reach === "window" || caller === "phone" || command.taskId !== undefined) return false;
  }
  return true;
}
