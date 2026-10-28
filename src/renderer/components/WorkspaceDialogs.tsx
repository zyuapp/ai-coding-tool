import { WorktreeDeleteDialog } from "./WorktreeDeleteDialog";
import { ProjectAddDialog } from "./ProjectAddDialog";
import { ProjectEditDialog } from "./ProjectEditDialog";
import { WorktreeMoveDialog } from "./WorktreeMoveDialog";
import { ForkNameDialog } from "./ForkNameDialog";
import { ArchiveDialog } from "./ArchiveDialog";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** The questions the workspace raises over everything else, each open only while state holds it. */
export function WorkspaceDialogs({ workspace }: { workspace: Workspace }) {
  const { worktreeMove, projectEditor, forkName, archivePrompt, actions } = workspace;
  return (
    <>
      {workspace.projectAdd && <ProjectAddDialog add={workspace.projectAdd} links={workspace.computerLinks} name={workspace.computerName} dispatch={workspace.dispatch} />}
      {!workspace.settingsOpen && workspace.worktreeDeleteConfirmation && <WorktreeDeleteDialog worktree={workspace.worktreeDeleteConfirmation} dispatch={workspace.dispatch} />}
      {worktreeMove && (
        <WorktreeMoveDialog
          move={worktreeMove}
          onConfirm={() => void actions.setWorktree(worktreeMove.worktree)}
          onClose={() => void actions.moveWorktreeClose()}
        />
      )}
      {forkName && (
        <ForkNameDialog
          key={`${forkName.taskId}:${forkName.worktree}`}
          fork={forkName}
          onConfirm={(title) => void actions.confirmFork(title)}
          onClose={() => void actions.closeForkName()}
        />
      )}
      {archivePrompt && <ArchiveDialog key={archivePrompt.taskId} prompt={archivePrompt} dispatch={workspace.dispatch} />}
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
