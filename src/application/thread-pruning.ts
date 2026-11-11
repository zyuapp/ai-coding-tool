import type { WorkspaceState } from "./workspace-state.js";
import { draftsForgottenIn, composerOf } from "./composer-drafts.js";
import { automationsForgottenIn, automationsOf } from "./workspace-reducer/automation-edits.js";
import { approvalForgottenIn, browserOf } from "./workspace-reducer/browser-tabs.js";
import { docksForgottenIn, docksOf } from "./workspace-reducer/dock-tabs.js";
import { runsForgottenIn, runsOf } from "./workspace-reducer/run-edits.js";
import { sideChatsForgottenIn, sideChatsOf } from "./workspace-reducer/side-chat-edits.js";
import type { Step } from "./workspace-reducer/slice.js";
import { navigationOf, visitsForgottenIn } from "./workspace-reducer/thread-select.js";
import { checkoutClaimsForgottenIn, worktreesOf } from "./workspace-reducer/worktree-claims.js";

/**
 * A permanently deleted thread leaves no session-only record holding its data or making it reachable:
 * each owner forgets it in its own state.
 */
export function pruned(state: WorkspaceState, removed: Set<string>): Step {
  if (!removed.size) return {};
  const sideChats = sideChatsForgottenIn(sideChatsOf(state), removed);
  return {
    edits: [
      checkoutClaimsForgottenIn(worktreesOf(state), removed),
      visitsForgottenIn(navigationOf(state), removed),
      draftsForgottenIn(composerOf(state), removed),
      docksForgottenIn(docksOf(state), removed, sideChats.view.sideChats),
      sideChats,
      runsForgottenIn(runsOf(state), removed),
      automationsForgottenIn(automationsOf(state), removed),
      approvalForgottenIn(browserOf(state), removed),
    ],
  };
}
