import { useRef, type ReactNode } from "react";
import { ApprovalCard } from "./ApprovalCard";
import { ConversationTimeline } from "./ConversationTimeline";
import { ThreadModeSwitch, ThreadStartOptions } from "./ThreadStartOptions";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import type { FindView } from "../../application/workspace-state";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** The transcript and everything drawn alongside it: the find bar, the draft's start options, approvals. */
export function WorkspaceConversation({ workspace, find, findBar, onAnnotateSide }: {
  workspace: Workspace;
  find: FindView | null;
  findBar: ReactNode;
  onAnnotateSide: (quote: string) => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  return (
    <div className="work-area">
      {find?.target.kind === "transcript" && findBar}
      {!workspace.currentTask && (
        <ThreadModeSwitch
          projects={workspace.projects}
          projectId={workspace.currentProject?.id ?? null}
          onSelectProject={workspace.actions.newTask}
        />
      )}
      <div className="conversation" ref={transcriptRef}>
        <ConversationTimeline
          find={find?.target.kind === "transcript" ? find : null}
          currentTask={workspace.currentTask}
          folder={workspace.folder}
          status={workspace.status}
          compacting={workspace.compacting}
          waitingOn={workspace.waitingOn}
          streamingTail={workspace.streamingTail}
          readingPoint={workspace.readingPoint}
          onReadingPointMove={(point) => {
            if (workspace.currentTask) void workspace.dispatch({ type: "view.reading-point", taskId: workspace.currentTask.id, point });
          }}
          scrollContainerRef={transcriptRef}
          restored={workspace.restored}
          startOptions={!workspace.currentTask && (
            <ThreadStartOptions
              projects={workspace.projects}
              projectId={workspace.currentProject?.id ?? null}
              {...(workspace.currentProject?.workspaceId ? { workspaceId: workspace.currentProject.workspaceId } : {})}
              branch={workspace.draftBranch}
              worktree={workspace.draftWorktree}
              {...(workspace.draftWorktreeName ? { startsInWorktree: workspace.draftWorktreeName } : {})}
              onSelectProject={workspace.actions.newTask}
              onSelectBranch={workspace.actions.setBranch}
              onSetWorktree={workspace.actions.setWorktree}
            />
          )}
          annotations={workspace.annotations}
          onAnnotateAdd={({ quote, note, anchor }) => void workspace.dispatch({ type: "annotation.add", quote, note, anchor })}
          onAnnotateNote={(annotationId, note) => void workspace.dispatch({ type: "annotation.note", annotationId, note })}
          onAnnotateRemove={(annotationId) => void workspace.dispatch({ type: "annotation.remove", annotationId })}
          onAnnotateSide={onAnnotateSide}
        />
        {workspace.approval && <ApprovalCard approval={workspace.approval} onDecide={workspace.actions.decideApproval} />}
      </div>
    </div>
  );
}
