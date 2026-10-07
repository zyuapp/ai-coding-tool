import { useRef, type ReactNode } from "react";
import { ApprovalCard } from "./ApprovalCard";
import { ConversationTimeline } from "./ConversationTimeline";
import { CoordinationBar } from "./Coordination";
import { projectName } from "../../domain/project";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import type { FindView } from "../../application/workspace-state";

type Workspace = ReturnType<typeof useTaskWorkspace>;

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
  const { coordination } = workspace;
  /** A coordinator's threads are listed in the session panel; a thread opened on its own says whom it works under. */
  const bar = coordination.members.length === 0 && (coordination.lead !== null || coordination.brief !== null);
  return (
    <div className={`work-area ${bar ? (coordination.lead ? "coordination-bar-on" : "coordination-brief-on") : ""}`}>
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
        />
        {/** A coordinator's own approval waits in its Needs-you card beside its threads'. */}
        {workspace.approval && !coordination.approvals.some(({ approval }) => approval.approvalId === workspace.approval?.approvalId) && (
          <ApprovalCard approval={workspace.approval} onDecide={workspace.actions.decideApproval} />
        )}
      </div>
    </div>
  );
}
