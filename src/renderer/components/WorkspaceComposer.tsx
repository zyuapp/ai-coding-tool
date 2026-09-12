import { ConversationComposer, type ComposerAction } from "./ConversationComposer";
import { attachDroppedFiles, imageSources } from "../dropped-files";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import { capabilitiesFor, modelSupportsManualCompaction } from "../../domain/agent-engine";
import { sentPrompts } from "../../domain/conversation";
import { attachmentSendFor } from "../../application/composer-attachments";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** The composer for the thread on screen, with every command its controls dispatch. */
export function WorkspaceComposer({ workspace, actions }: { workspace: Workspace; actions: ComposerAction[] }) {
  const thread = workspace.currentThread;
  const compact = thread && modelSupportsManualCompaction(thread.engine, workspace.model)
    && thread.continuation?.provider === thread.engine
    && thread.contextUsage !== undefined
    && !workspace.runActive
    && workspace.waitingOn === null
    ? [{ name: "compact", description: "Compact the current chat's context.", run: workspace.actions.compactContext }]
    : [];
  const review = thread && capabilitiesFor(thread.engine).review
    && thread.continuation?.provider === thread.engine
    && workspace.workspaceId
    && !workspace.runActive
    && workspace.waitingOn === null
    ? [{ name: "review", description: "Review changes in the current project.", run: workspace.actions.openReview }]
    : [];
  return (
    <ConversationComposer
      disabled={!workspace.restored && !thread}
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
      fastMode={workspace.fastMode}
      onFastModeChange={workspace.actions.setFastMode}
      contextUsage={workspace.currentThread?.contextUsage}
      runActive={workspace.runActive}
      question={workspace.question}
      onQuestionAnswerChange={(question, text) => { if (thread) void workspace.dispatch({ type: "question.set-answer", taskId: thread.id, runId: question.runId, requestId: question.requestId, questionId: question.questionId, text }); }}
      onAnswerQuestion={(question) => { if (thread) void workspace.dispatch({ type: "question.answer", taskId: thread.id, runId: question.runId, requestId: question.requestId, questionId: question.questionId }); }}
      goal={workspace.goal}
      waiting={workspace.waitingOn !== null}
      queuedMessages={workspace.queuedMessages}
      annotations={workspace.annotations}
      pastes={workspace.pastes}
      files={workspace.files}
      history={sentPrompts(workspace.currentThread?.messages ?? [])}
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
      favoriteModels={workspace.favoriteModels}
      onModelFavorite={(model, favorite) => void workspace.dispatch({ type: "view.set-model-favorite", model, favorite })}
      onModelChange={workspace.actions.setModel}
      onEffortChange={workspace.actions.setEffort}
      onEngineRead={workspace.actions.readEngineStatus}
      onSignIn={workspace.actions.signInEngine}
      onOpenEngineSettings={() => void workspace.actions.openSettingsSection("engines")}
      outbox={{
        state: attachmentSendFor(workspace.attachmentSends),
        send: (attachments, steer) => void workspace.dispatch({ type: "attachments.send", attachments, ...(steer ? { steer } : {}) }),
        notice: (message) => void workspace.dispatch({ type: "attachments.notice", message }),
      }}
      onSteerQueued={workspace.actions.steerQueued}
      onDropQueued={workspace.actions.dropQueued}
      onCancel={workspace.actions.cancelRun}
      onGoalClear={() => { if (thread) void workspace.actions.clearGoal(thread.id); }}
    />
  );
}
