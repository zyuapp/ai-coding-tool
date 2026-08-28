import { TaskComposer, type ComposerAction } from "./TaskComposer";
import { attachDroppedFiles, imageSources } from "../dropped-files";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import { modelSupportsManualCompaction } from "../../domain/agent-engine";
import { sentPrompts } from "../../domain/task";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** The composer for the thread on screen, with every command its controls dispatch. */
export function WorkspaceComposer({ workspace, actions }: { workspace: Workspace; actions: ComposerAction[] }) {
  const task = workspace.currentTask;
  const compact = task && modelSupportsManualCompaction(task.engine, workspace.model)
    && task.continuation?.provider === "codex"
    && task.contextUsage !== undefined
    && !workspace.runActive
    && workspace.waitingOn === null
    ? [{ name: "compact", description: "Compact the current chat's context.", run: workspace.actions.compactContext }]
    : [];
  const review = task?.engine === "codex"
    && task.continuation?.provider === "codex"
    && workspace.workspaceId
    && !workspace.runActive
    && workspace.waitingOn === null
    ? [{ name: "review", description: "Review changes in the current project.", run: workspace.actions.openReview }]
    : [];
  return (
    <TaskComposer
      focusToken={workspace.composerFocus}
      images={workspace.images}
      onImageRemove={(imageId) => void workspace.dispatch({ type: "image.remove", imageId })}
      prompt={workspace.prompt}
      folder={workspace.folder}
      workspaceId={workspace.workspaceId}
      mode={workspace.policy}
      engine={workspace.engine}
      engineLabel={workspace.engineLabel}
      engineLocked={workspace.engineLocked}
      engineAccess={workspace.engineAccess}
      model={workspace.model}
      effort={workspace.effort}
      contextUsage={workspace.currentTask?.contextUsage}
      runActive={workspace.runActive}
      goal={workspace.goal}
      waiting={workspace.waitingOn !== null}
      queuedMessages={workspace.queuedMessages}
      annotations={workspace.annotations}
      pastes={workspace.pastes}
      files={workspace.files}
      history={sentPrompts(workspace.currentTask?.messages ?? [])}
      actions={[...compact, ...review, ...actions]}
      reviewPicker={workspace.reviewPicker}
      threads={workspace.threadHandles}
      onPromptChange={workspace.actions.setPrompt}
      onReviewStep={workspace.actions.setReviewStep}
      onReview={workspace.actions.startReview}
      onReviewClose={workspace.actions.closeReview}
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
      onGoalClear={() => void workspace.actions.clearGoal()}
    />
  );
}
