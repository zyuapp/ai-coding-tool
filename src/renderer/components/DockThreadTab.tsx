import { memo, useMemo, type ReactNode } from "react";
import { LuWaypoints as Waypoints, LuX as X } from "react-icons/lu";
import { DockConversation } from "./SideChat";
import { chatHandlers } from "./DockSideChat";
import { CoordinationStatusMark, coordinationStatusLine } from "./Coordination";
import { ThreadEngineIcon } from "./ThreadEngineIcon";
import { attachmentSendFor, type AttachmentSendState } from "../../application/composer-attachments";
import { deliveryLabel } from "../../domain/coordination";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import type { AppCommand } from "../../contracts/commands";
import type { FindView, ThreadTabView } from "../../application/workspace-state";
import { engineLabel, type AgentModel } from "../../domain/agent-engine";
import type { ThreadHandleOption } from "../../domain/thread-handles";

type Workspace = ReturnType<typeof useTaskWorkspace>;
type Dispatch = (command: AppCommand) => Promise<void>;

const EMPTY = { icon: Waypoints, title: "Nothing here yet", description: "This thread has not started talking." };

/** Who the thread is and where its work stands, with what it was asked folded underneath. */
function ThreadTabHeader({ tab, leadTitle, onClose }: { tab: ThreadTabView; leadTitle: string; onClose: () => void }) {
  const { thread, standing, summary } = tab;
  return (
    <>
      <header className="side-chat-header thread-tab-header">
        <div className="side-chat-title">
          <span className={`thread-tab-mark ${standing}`}>
            <ThreadEngineIcon engine={thread.engine} size={15} />
            <CoordinationStatusMark status={standing} />
          </span>
          <div>
            <h2 title={thread.title}>{thread.title}</h2>
            <p className={`thread-tab-status ${standing}`} title={coordinationStatusLine(standing, summary)}>{coordinationStatusLine(standing, summary)}</p>
          </div>
        </div>
        <button type="button" aria-label={`Close ${thread.title}`} title={`Back to ${leadTitle}`} onClick={onClose}><X size={18} /></button>
      </header>
      {thread.brief && (
        <details className="coordination-brief thread-tab-brief">
          <summary>Brief</summary>
          <dl>
            <dt>Your words</dt><dd className="coordination-brief-intent">{thread.brief.intent}</dd>
            <dt>Done when</dt><dd>{thread.brief.doneWhen}</dd>
            <dt>Delivers</dt><dd>{deliveryLabel(thread.brief.delivers)}</dd>
          </dl>
        </details>
      )}
    </>
  );
}

/**
 * One thread's tab in its coordinator's dock. Memoized, and given only what the tab reads, so the
 * coordinator's own run leaves it alone.
 */
const DockThreadTab = memo(function DockThreadTab({ tab, dispatch, attachmentSend, favoriteModels, leadTitle, threads, active, focusToken, find, findBar, onClose }: {
  tab: ThreadTabView;
  dispatch: Dispatch;
  attachmentSend: AttachmentSendState;
  favoriteModels: AgentModel[];
  leadTitle: string;
  threads: ThreadHandleOption[];
  active: boolean;
  focusToken: number;
  find: FindView | null;
  findBar: ReactNode;
  onClose: (taskId: string) => void;
}) {
  const handlers = useMemo(() => chatHandlers(dispatch, tab.id, tab.images), [dispatch, tab.id, tab.images]);
  const close = useMemo(() => () => onClose(tab.id), [onClose, tab.id]);
  return (
    <div data-dock-tab={tab.id} hidden={!active}>
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
        className="side-chat thread-tab"
        label={tab.title}
        surface="tab"
        header={<ThreadTabHeader tab={tab} leadTitle={leadTitle} onClose={close} />}
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
            focusToken={focusTokenFor(tab.id)}
            find={searched}
            findBar={searched ? findBar : null}
            onClose={onClose}
          />
        );
      })}
    </>
  );
}
