import type { Thread } from "../../domain/thread";
import { SNOOZE_OPTIONS, type SnoozeHours } from "../../domain/thread-snooze";
import { threadLink } from "../../domain/thread-handles";
import { THREAD_ROLES, type ThreadRole } from "../../domain/thread-role";
import type { MenuEntry } from "./PopoverMenu";

/** Whether a thread, or for a coordinator any thread under it, has work going. */
export function workGoing(thread: Thread, members: readonly Thread[], running: ReadonlySet<string>): boolean {
  return running.has(thread.id) || members.some((member) => running.has(member.id));
}

/** The same thread actions from its sidebar row and its heading. */
export function threadMenuEntries(thread: Thread, actions: {
  onRename: () => void;
  onFork: (worktree: boolean) => void;
  onArchive: () => void;
  onSnooze?: (hours: SnoozeHours) => void;
  onUnsnooze?: () => void;
  onSetRole: (role: ThreadRole | null) => void;
  coordinators: Thread[];
  onSetCoordinator: (coordinatorId: string | null) => void;
  /** Whether desktop notices are on at all, which a coordinator's mute only narrows. */
  notifications: boolean;
  onSetMuted: (muted: boolean) => void;
  /** Whether the thread, or one working under it, has work going for Stop all to stop. */
  working: boolean;
  onStopAll: () => void;
}): MenuEntry[] {
  const leads = actions.coordinators.filter((lead) => lead.id !== thread.id);
  const lead = leads.find((item) => item.id === thread.parentId);
  /**
   * A coordinator takes threads under it; it never works under another, and stops with them. Its
   * mute says what choosing it does rather than carrying a tick, which would mark the whole menu as
   * one to tick.
   */
  const coordination: MenuEntry[] = thread.role === "coordinator" ? [{
    label: "Stop all",
    command: { type: "coordination.stop-all", taskId: thread.id },
    ...(actions.working ? {} : { disabled: true }),
    onSelect: actions.onStopAll,
  }, {
    label: thread.muted ? "Unmute notifications" : "Mute notifications",
    command: { type: "coordination.set-muted", taskId: thread.id, muted: !thread.muted },
    ...(actions.notifications ? {} : { disabled: true, title: "Notifications are off in Settings" }),
    onSelect: () => actions.onSetMuted(!thread.muted),
  }] : [
    ...(leads.length ? [{ label: "Move under", items: leads.map((item) => ({ label: item.title, command: { type: "task.set-coordinator" as const, taskId: thread.id, coordinatorId: item.id }, checked: item.id === lead?.id, onSelect: () => actions.onSetCoordinator(item.id) })) }] : []),
    ...(lead ? [{ label: `Move out of ${lead.title}`, command: { type: "task.set-coordinator" as const, taskId: thread.id, coordinatorId: null }, onSelect: () => actions.onSetCoordinator(null) }] : []),
  ];
  return [
    { label: "Rename", command: { type: "task.rename", taskId: thread.id, title: thread.title }, onSelect: actions.onRename },
    ...(actions.onUnsnooze ? [{ label: "Unsnooze", command: { type: "task.unsnooze" as const, taskId: thread.id }, onSelect: actions.onUnsnooze }] : []),
    ...(actions.onSnooze ? [{ label: "Snooze", items: SNOOZE_OPTIONS.map(({ label, hours }) => ({ label, command: { type: "task.snooze" as const, taskId: thread.id, hours }, onSelect: () => actions.onSnooze!(hours) })) }] : []),
    { label: "Role", items: [
      ...THREAD_ROLES.map(({ role, label }) => ({ label, command: { type: "task.set-role" as const, taskId: thread.id, role }, checked: thread.role === role, onSelect: () => actions.onSetRole(role) })),
      { label: "None", command: { type: "task.set-role", taskId: thread.id, role: null }, checked: thread.role === undefined, onSelect: () => actions.onSetRole(null) },
    ] },
    ...coordination,
    "separator",
    { label: "Copy link", onSelect: () => void navigator.clipboard?.writeText(threadLink(thread.id)) },
    "separator",
    { label: "Fork", command: { type: "task.fork", taskId: thread.id, worktree: false }, onSelect: () => actions.onFork(false) },
    { label: "Fork into a new worktree", command: { type: "task.fork", taskId: thread.id, worktree: true }, onSelect: () => actions.onFork(true) },
    "separator",
    { label: "Archive", command: { type: "task.archive", taskId: thread.id }, danger: true, onSelect: actions.onArchive },
  ];
}
