import { TaskComposer, type ComposerAction } from "./TaskComposer";
import { attachDroppedFiles, imageSources } from "../dropped-files";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import { sentPrompts } from "../../domain/task";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** The composer for the thread on screen, with every command its controls dispatch. */
export function WorkspaceComposer({ workspace, actions }: { workspace: Workspace; actions: ComposerAction[] }) {
  return (
    <TaskComposer
      focusToken={workspace.composerFocus}
      images={workspace.images}
      onImageRemove={(imageId) => void workspace.dispatch({ type: "image.remove", imageId })}
      prompt={workspace.prompt}
      folder={workspace.folder}
      workspaceId={workspace.currentProject?.workspaceId}
      mode={workspace.policy}
      engine={workspace.engine}
      engineLabel={workspace.engineLabel}
      engineLocked={workspace.engineLocked}
      engineAccess={workspace.engineAccess}
      model={workspace.model}
      effort={workspace.effort}
      contextUsage={workspace.currentTask?.contextUsage}
      runActive={workspace.runActive}
      waiting={workspace.waitingOn !== null}
      queuedMessages={workspace.queuedMessages}
      annotations={workspace.annotations}
      pastes={workspace.pastes}
      files={workspace.files}
      history={sentPrompts(workspace.currentTask?.messages ?? [])}
      actions={actions}
      threads={workspace.threadHandles}
      onPromptChange={workspace.actions.setPrompt}
      onAnnotationRecall={(annotations) => void workspace.dispatch({ type: "annotation.recall", annotations })}
      onAnnotationRemove={(annotationId) => void workspace.dispatch({ type: "annotation.remove", annotationId })}
      onPasteAdd={(text) => void workspace.dispatch({ type: "paste.add", text })}
      onPasteRecall={(pastes) => void workspace.dispatch({ type: "paste.recall", pastes })}
      onPasteRemove={(pasteId) => void workspace.dispatch({ type: "paste.remove", pasteId })}
      onFilesAdd={(files) => void attachDroppedFiles(files, undefined, workspace.dispatch, imageSources(workspace.images))}
      onFileRecall={(files) => void workspace.dispatch({ type: "file.recall", files })}
      onFileRemove={(fileId) => void workspace.dispatch({ type: "file.detach", fileId })}
      onImageRecall={(paths) => void workspace.dispatch({ type: "image.recall", paths })}
      onModeChange={workspace.actions.setPolicy}
      onModelChange={workspace.actions.setModel}
      onEffortChange={workspace.actions.setEffort}
      onEngineRead={workspace.actions.readEngineStatus}
      onSignIn={workspace.actions.signInEngine}
      onSend={(attachments, steer) => void workspace.actions.sendPrompt(attachments, steer)}
      onSteerQueued={workspace.actions.steerQueued}
      onDropQueued={workspace.actions.dropQueued}
      onCancel={workspace.actions.cancelRun}
    />
  );
}
