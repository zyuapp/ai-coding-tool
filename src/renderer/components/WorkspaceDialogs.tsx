import { ProjectEditDialog } from "./ProjectEditDialog";
import { WorktreeMoveDialog } from "./WorktreeMoveDialog";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** The questions the workspace raises over everything else, each open only while state holds it. */
export function WorkspaceDialogs({ workspace }: { workspace: Workspace }) {
  const { worktreeMove, projectEditor, actions } = workspace;
  return (
    <>
      {worktreeMove && (
        <WorktreeMoveDialog
          move={worktreeMove}
          onConfirm={() => void actions.setWorktree(worktreeMove.worktree)}
          onClose={() => void actions.moveWorktreeClose()}
        />
      )}
      {projectEditor && (
        <ProjectEditDialog
          editor={projectEditor}
          onSave={(edit) => void actions.editProject(projectEditor.project.id, edit)}
          onClose={() => void actions.editProjectClose()}
        />
      )}
    </>
  );
}
