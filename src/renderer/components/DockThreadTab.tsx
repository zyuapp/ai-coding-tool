import { memo, useMemo, type ReactNode } from "react";
import { LuCheck as Check, LuUndo2 as Reopen, LuWaypoints as Waypoints, LuX as X } from "react-icons/lu";
import { DockConversation } from "./SideChat";
import { chatHandlers } from "./DockSideChat";
import { CoordinationStatusMark, coordinationStatusLine } from "./Coordination";
import { CommandButton } from "./CommandControl";
import { ThreadEngineIcon } from "./ThreadEngineIcon";
import { ThreadTabStrip } from "./ThreadTabStrip";
import { threadAsking } from "../../application/pull-request-view";
import { canResolve, type CoordinatedThreadStatus } from "../../application/coordination";
import { AUTOMATION_PANEL } from "../../application/workspace-reducer";
import { usePullRequestReads } from "../task-workspace/pull-request-reads";
import { pullRequestSettled } from "../../domain/pull-request";
import { attachmentSendFor, type AttachmentSendState } from "../../application/composer-attachments";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import type { AppCommand } from "../../contracts/commands";
import type { FindView, ThreadTabView } from "../../application/workspace-state";
import { engineLabel, type AgentModel } from "../../domain/agent-engine";
import type { ThreadHandleOption } from "../../domain/thread-handles";

type Workspace = ReturnType<typeof useTaskWorkspace>;
type Dispatch = (command: AppCommand) => Promise<void>;

const EMPTY = { icon: Waypoints, title: "Nothing here yet", description: "This thread has not started talking." };

/** The branch menu of one thread's tab, so each tab's list opens on its own. */
function branchMenuOf(taskId: string) {
  return `thread-tab:branch:${taskId}`;
}

/** Asks for the pull request only while the tab is the one on screen. */
function PullRequestReads({ tab, dispatch }: { tab: ThreadTabView; dispatch: Dispatch }) {
  usePullRequestReads(threadAsking(tab.workspaceId, tab.environment, tab.id), pullRequestSettled(tab.pullRequest), () => void dispatch({ type: "pull-request.read", taskId: tab.id }));
  return null;
}

/** The header's resolve or reopen, named in words since it sits beside the tab's close. */
function TabResolution({ taskId, title, status }: { taskId: string; title: string; status: CoordinatedThreadStatus }) {
  if (status === "resolved") {
    return (
      <CommandButton command={{ type: "task.reopen", taskId }} className="thread-tab-resolution" data-action="reopen" aria-label={`Reopen ${title}`}>
        <Reopen size={14} aria-hidden="true" />Reopen
      </CommandButton>
    );
  }
  if (!canResolve(status)) return null;
  return (
    <CommandButton command={{ type: "task.resolve", taskId }} className="thread-tab-resolution" data-action="resolve" aria-label={`Resolve ${title}`}>
      <Check size={14} aria-hidden="true" />Resolve
    </CommandButton>
  );
}

/** Who the thread is and where its work stands, with its checkout and brief underneath. */
function ThreadTabHeader({ tab, leadTitle, dispatch, branchMenuOpen, onClose }: { tab: ThreadTabView; leadTitle: string; dispatch: Dispatch; branchMenuOpen: boolean; onClose: () => void }) {
  const { thread, standing, summary } = tab;
  const status = coordinationStatusLine(standing, summary);
  return (
    <>
      <header className="side-chat-header thread-tab-header">
        <div className="side-chat-title">
          <span className={`thread-tab-mark ${standing}`}>
            <ThreadEngineIcon engine={thread.engine} size={16} />
            <CoordinationStatusMark status={standing} />
          </span>
          <div>
            <h2 data-tip={thread.title} data-tip-overflow>{thread.title}</h2>
            <p className={`thread-tab-status ${standing}`} data-tip={status} data-tip-overflow>{status}</p>
          </div>
        </div>
        <TabResolution taskId={tab.id} title={thread.title} status={standing} />
        <button type="button" aria-label={`Close ${thread.title} and return to ${leadTitle}`} data-tip={`Close · back to ${leadTitle}`} onClick={onClose}><X size={18} /></button>
      </header>
      <ThreadTabStrip
        tab={tab}
        branchMenuOpen={branchMenuOpen}
        actions={{
          onToggleChanges: () => void dispatch({ type: "diff.toggle", taskId: tab.id }),
          onOpenAutomations: () => void dispatch({ type: "view.open-dock-panel", panel: AUTOMATION_PANEL, taskId: tab.id }),
          onSetBranchMenuOpen: (open) => void dispatch({ type: "view.set-menu", menu: open ? branchMenuOf(tab.id) : null }),
          onCheckoutBranch: (branch, create) => void dispatch({ type: "task.checkout-branch", taskId: tab.id, branch, ...(create ? { create } : {}) }),
        }}
      />
    </>
  );
}

/**
 * One thread's tab in its coordinator's dock. Memoized, and given only what the tab reads, so the
 * coordinator's own run leaves it alone.
 */
const DockThreadTab = memo(function DockThreadTab({ tab, dispatch, attachmentSend, favoriteModels, leadTitle, threads, active, branchMenuOpen, focusToken, find, findBar, updateAvailable, onClose }: {
  tab: ThreadTabView;
  dispatch: Dispatch;
  attachmentSend: AttachmentSendState;
  favoriteModels: AgentModel[];
  leadTitle: string;
  threads: ThreadHandleOption[];
  active: boolean;
  branchMenuOpen: boolean;
  focusToken: number;
  find: FindView | null;
  findBar: ReactNode;
  updateAvailable: boolean;
  onClose: (taskId: string) => void;
}) {
  const handlers = useMemo(() => chatHandlers(dispatch, tab.id, tab.images), [dispatch, tab.id, tab.images]);
  const close = useMemo(() => () => onClose(tab.id), [onClose, tab.id]);
  return (
    <div data-dock-tab={tab.id} hidden={!active}>
      {active && <PullRequestReads tab={tab} dispatch={dispatch} />}
      <DockConversation
        outbox={{
          state: attachmentSend,
          send: (attachments, steer) => void dispatch({ type: "attachments.send", taskId: tab.id, attachments, steer }),
          notice: (message) => void dispatch({ type: "attachments.notice", taskId: tab.id, message }),
        }}
        onAnswerQuestion={(question) => void dispatch({ type: "question.answer", taskId: tab.id, runId: question.runId, requestId: question.requestId, questionId: question.questionId })}
        onQuestionAnswerChange={(question, text) => void dispatch({ type: "question.set-answer", taskId: tab.id, runId: question.runId, requestId: question.requestId, questionId: question.questionId, text })}
        chat={tab}
        favoriteModels={favoriteModels}
        engineLabel={engineLabel(tab.thread.engine)}
        focusToken={focusToken}
        find={find}
        findBar={findBar}
        folder={tab.folder}
        {...(tab.workspaceId ? { workspaceId: tab.workspaceId } : {})}
        threads={threads}
        readingPoint={tab.readingPoint}
        {...handlers}
        updateAvailable={updateAvailable}
        className="side-chat thread-tab"
        label={tab.title}
        surface="tab"
        header={<ThreadTabHeader tab={tab} leadTitle={leadTitle} dispatch={dispatch} branchMenuOpen={branchMenuOpen} onClose={close} />}
        empty={EMPTY}
      />
    </div>
  );
});

/** The threads under the coordinator on screen that it has open as tabs, each talked to in place. */
export function DockThreadTabs({ workspace, lead, activeTab, find, findBar, focusTokenFor, onClose }: {
  workspace: Workspace;
  lead: { title: string };
  activeTab: string;
  find: FindView | null;
  findBar: ReactNode;
  focusTokenFor: (tab: string) => number;
  onClose: (taskId: string) => void;
}) {
  return (
    <>
      {workspace.threadTabs.map((tab) => {
        const searched = find?.target.kind === "thread" && find.target.taskId === tab.id ? find : null;
        return (
          <DockThreadTab
            key={tab.id}
            tab={tab}
            dispatch={workspace.dispatch}
            attachmentSend={attachmentSendFor(workspace.attachmentSends, tab.id)}
            favoriteModels={workspace.favoriteModels}
            leadTitle={lead.title}
            threads={workspace.threadHandlesFor(tab.id)}
            active={activeTab === tab.id}
            branchMenuOpen={workspace.openMenu === branchMenuOf(tab.id)}
            focusToken={focusTokenFor(tab.id)}
            find={searched}
            findBar={searched ? findBar : null}
            updateAvailable={workspace.appUpdate.status !== "idle"}
            onClose={onClose}
          />
        );
      })}
    </>
  );
}
