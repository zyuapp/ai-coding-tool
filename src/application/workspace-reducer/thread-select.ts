/** Putting the user on a thread, which several commands end in. */
import { focusDockTab, showDockTab } from "./dock-tabs.js";
import { refreshThreadEnvironment } from "./environment.js";
import { followUps, settled } from "./shared.js";
import type { WorkspaceTransition } from "./types.js";
import { readRow } from "../thread-attention.js";
import { projectFor } from "../thread-location.js";
import { dockFor, withDock } from "../workspace-dock.js";
import type { WorkspaceState } from "../workspace-state.js";
import { readAttention } from "../../domain/attention.js";
import { coordinatorOf } from "../../domain/coordination.js";

/** Puts the user on a thread: what it holds becomes read, and the app follows it to its folder. */
export function landOnThread(state: WorkspaceState, taskId: string): WorkspaceState {
  const thread = state.threads.find((item) => item.id === taskId);
  const project = projectFor(state, thread);
  return readRow({
    ...state,
    currentId: taskId,
    draftProjectId: thread?.projectId ?? null,
    lastFolder: project?.root ?? state.lastFolder,
    actionError: null,
  }, taskId);
}

/** A side chat, or a thread under a coordinator, opens as a tab in the dock of the thread it belongs to. */
export function selectThread(state: WorkspaceState, selected: string): WorkspaceTransition {
  const chat = state.sideChats.find((item) => item.id === selected);
  const lead = chat ? undefined : coordinatorOf(state.threads, state.threads.find((item) => item.id === selected));
  const taskId = chat?.sourceThreadId ?? lead?.id ?? selected;
  const landed = landOnThread(state, taskId);
  if (taskId === selected) return settled(landed);
  const tabs = dockFor(landed, taskId).threadTabs;
  const opened = lead && !tabs.includes(selected) ? withDock(landed, taskId, { threadTabs: [...tabs, selected] }) : landed;
  const shown = showDockTab(readAttention(opened, selected), taskId, selected);
  const focused = focusDockTab(shown, taskId, selected);
  return lead ? { ...focused, effects: [...focused.effects, ...followUps(refreshThreadEnvironment(focused.state, selected))] } : focused;
}
