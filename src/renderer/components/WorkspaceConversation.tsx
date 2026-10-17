import { useMemo, useRef, type ReactNode } from "react";
import { ApprovalCard } from "./ApprovalCard";
import { ConversationTimeline } from "./ConversationTimeline";
import { CoordinationBar, type ThreadCardsView } from "./Coordination";
import { projectName } from "../../domain/project";
import { isCoordinator } from "../../domain/coordination";
import { usePullRequestReads } from "../task-workspace/pull-request-reads";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import type { FindView } from "../../application/workspace-state";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/**
 * Asks after the pull requests of a coordinator's threads for as long as it is on screen, whatever
 * panel is open, so its Overview stays current and a merge resolves the thread that made it.
 */
function CoordinatorReads({ asking, settled, read }: { asking: string; settled: boolean; read: () => void }) {
  usePullRequestReads(asking, settled, read);
  return null;
}

/** The transcript and everything drawn alongside it: the find bar and approvals. */
export function WorkspaceConversation({ workspace, find, findBar, onAnnotateSide }: {
  workspace: Workspace;
  find: FindView | null;
  findBar: ReactNode;
  onAnnotateSide: (quote: string) => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  /** A side chat is a thread too, so the main transcript only claims the bar when it is the one named. */
  const mine = find?.target.kind === "thread" && find.target.taskId === (workspace.currentThread?.id ?? null) ? find : null;
  const { coordination, worktreeGroups, actions } = workspace;
  /** A coordinator follows its threads in its Overview; a thread opened on its own says whom it works under. */
  const bar = coordination.threadModel === null && (coordination.lead !== null || coordination.brief !== null);
  /** Rebuilt only when one of its threads' views moves, which each card holds still against on its own. */
  const threadCards = useMemo((): ThreadCardsView | null => coordination.threadModel === null ? null : {
    cards: new Map(coordination.members.map((view) => [view.thread.id, view])),
    worktrees: new Map(worktreeGroups.map(({ worktree }) => [worktree.id, worktree])),
    onSelect: actions.selectThread,
    onStep: (threadId, step) => void actions.takeNextStep(threadId, step),
  }, [coordination.threadModel, coordination.members, worktreeGroups, actions]);
  return (
    <div className={`work-area ${bar ? (coordination.lead ? "coordination-bar-on" : "coordination-brief-on") : ""}`}>
      {isCoordinator(workspace.currentThread) && <CoordinatorReads
        asking={workspace.memberPullRequests.asking}
        settled={workspace.memberPullRequests.settled}
        read={workspace.actions.readMemberPullRequests}
      />}
      {mine && findBar}
      {bar && <div className="coordination-head">
        <CoordinationBar lead={coordination.lead} brief={coordination.brief} asking={coordination.asking} onSelect={workspace.actions.selectThread} />
      </div>}
      <div className="conversation" ref={transcriptRef}>
        <ConversationTimeline
          find={mine}
          currentThread={workspace.currentThread}
          engine={workspace.engine}
          engineLabel={workspace.engineLabel}
          folder={workspace.folder}
          {...(workspace.workspaceId ? { workspaceId: workspace.workspaceId } : {})}
          status={workspace.status}
          compacting={workspace.compacting}
          retrying={workspace.retrying}
          limitPause={workspace.limitPause}
          waitingOn={workspace.waitingOn}
          streamingTail={workspace.streamingTail}
          readingPoint={workspace.readingPoint}
          onReadingPointMove={(point) => {
            if (workspace.currentThread) void workspace.dispatch({ type: "view.reading-point", taskId: workspace.currentThread.id, point });
          }}
          scrollContainerRef={transcriptRef}
          restored={workspace.restored}
          {...(workspace.currentProject ? { place: projectName(workspace.currentProject) } : {})}
          annotations={workspace.annotations}
          onAnnotateAdd={({ quote, note, anchor }) => void workspace.dispatch({ type: "annotation.add", quote, note, anchor })}
          onAnnotateNote={(annotationId, note) => void workspace.dispatch({ type: "annotation.note", annotationId, note })}
          onAnnotateRemove={(annotationId) => void workspace.dispatch({ type: "annotation.remove", annotationId })}
          onAnnotateSide={onAnnotateSide}
          threadCards={threadCards}
          starts={coordination.starts}
        />
        {/** A coordinator's own approval waits in its Needs-you card beside its threads'. */}
        {workspace.approval && !coordination.approvals.some(({ approval }) => approval.approvalId === workspace.approval?.approvalId) && (
          <ApprovalCard approval={workspace.approval} onDecide={workspace.actions.decideApproval} />
        )}
      </div>
    </div>
  );
}
