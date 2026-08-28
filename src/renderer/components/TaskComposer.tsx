import type { QueuedMessage, ReviewPicker as ReviewPickerState } from "../../application/workspace-state";
import type { Annotation as TaskAnnotation, AttachedFile, PastedText, RecalledMessage, RunAttachment, StagedImage } from "../../domain/task";
import { AnnotationRow } from "./AnnotationRow";
import { FileRow } from "./FileRow";
import { PasteRow } from "./PasteRow";
import type { ThreadHandleOption } from "../../domain/thread-handles";
import type { AgentEngine, AgentModel, EngineReadiness } from "../../domain/agent-engine";
import type { AgentEffort, ExecutionPolicy } from "../../domain/run";
import type { ContextUsage } from "../../domain/task";
import { AttachmentAnnotator, AttachmentStrip, useComposerAttachments } from "./ComposerAttachments";
import { ComposerSettings, EVERY_ENGINE_READY } from "./ComposerSettings";
import { CommandMenu, ThreadMenu, menuActiveDescendant, menuControls, useComposerMenus, type ComposerAction } from "./ComposerMenus";
import { ContextUsageMeter } from "./ContextUsageMeter";
import { QueuedRow } from "./QueuedRow";
import { useComposerCaret } from "./composer-caret";
import { composerBlur, composerInput, composerKeyDown, composerPaste } from "./composer-input";
import { useComposerRecall } from "./composer-recall";
import type { ReviewTarget } from "../../domain/review";
import { ReviewPicker } from "./ReviewPicker";
import { GoalBar } from "./GoalBar";
import type { ActiveGoal } from "../../domain/goal";

const NOTHING = () => {};

export type { ComposerAction };

function composerPlaceholder(surface: "main" | "side", folder: string, disabled: boolean, engineLabel: string) {
  if (surface === "side") return disabled ? "Main context required" : "Ask a side question";
  return folder ? `Ask ${engineLabel} to work on anything` : `Ask ${engineLabel} anything`;
}

function sendLabel(surface: "main" | "side", runActive: boolean) {
  if (surface === "side") return runActive ? "Stop side chat" : "Send side chat message";
  return runActive ? "Stop task" : "Send task";
}

export type TaskComposerProps = {
  prompt: string;
  folder: string;
  workspaceId?: string;
  /** Where the composer sits. */
  surface?: "main" | "side";
  /** Runnable `/` entries. A surface that performs none, as a side chat does, passes none. */
  actions?: ComposerAction[];
  /** The app-owned `/review` flow, when this composer opened it. */
  reviewPicker?: ReviewPickerState | null;
  /** Threads the `@` menu offers, newest first. A surface that names none passes none. */
  threads?: ThreadHandleOption[];
  /** Set while the thread cannot take a message at all, as a side chat cannot before its fork exists. */
  disabled?: boolean;
  /** Set while a send already given is still finding the checkout it runs in, so nothing sends twice. */
  waiting?: boolean;
  mode: ExecutionPolicy;
  engine: AgentEngine;
  /** What the engine is called, for wording that speaks of the agent. */
  engineLabel: string;
  /** Set once the thread has an engine for good, which is from its first message on. */
  engineLocked?: boolean;
  /** Which engines a run may go to; one that cannot be picked says why. Every engine is ready unless told otherwise. */
  engineAccess?: Record<AgentEngine, EngineReadiness>;
  model: AgentModel;
  effort: AgentEffort;
  contextUsage?: ContextUsage;
  runActive: boolean;
  goal?: ActiveGoal | null;
  queuedMessages: QueuedMessage[];
  /** Annotations waiting to ride the next send, drafted from selections in the transcript. */
  annotations?: TaskAnnotation[];
  /** Text pasted in that was too long to sit in the prompt, waiting to ride the next send. */
  pastes?: PastedText[];
  /** Files and folders dropped or pasted in, waiting to ride the next send. */
  files?: AttachedFile[];
  /** Bumped whenever something asks for the caret, which is all the composer needs to take it. */
  focusToken?: number;
  /** Images the workspace is holding for this composer, such as windows the desktop hotkey grabbed. */
  images?: StagedImage[];
  onImageRemove?: (imageId: string) => void;
  /** Previously sent messages, oldest first, offered back on ↑ from the first line. */
  history?: RecalledMessage[];
  onPromptChange: (prompt: string) => void;
  onReviewStep?: (step: ReviewPickerState["step"]) => void;
  onReview?: (target: ReviewTarget) => void;
  onReviewClose?: () => void;
  onAnnotationRecall?: (annotations: TaskAnnotation[]) => void;
  onAnnotationRemove?: (annotationId: string) => void;
  onPasteAdd?: (text: string) => void;
  onPasteRecall?: (pastes: PastedText[]) => void;
  onPasteRemove?: (pasteId: string) => void;
  /** Files pasted in from the desktop. The surface decides what each one becomes. */
  onFilesAdd?: (files: File[]) => void;
  onFileRecall?: (files: AttachedFile[]) => void;
  onImageRecall?: (paths: string[]) => void;
  onFileRemove?: (fileId: string) => void;
  onModeChange: (mode: ExecutionPolicy) => void;
  onModelChange: (engine: AgentEngine, model: AgentModel) => void;
  onEffortChange: (engine: AgentEngine, effort: AgentEffort) => void;
  /** Asked when the model menu opens on another engine. A surface that cannot ask leaves every engine ready. */
  onEngineRead?: () => void;
  onSignIn?: (engine: AgentEngine) => void;
  onSend: (attachments: RunAttachment[], steer: boolean) => void;
  onSteerQueued: (messageId: string) => void;
  onDropQueued: (messageId: string) => void;
  onCancel: () => void;
  onGoalClear?: () => void;
};

export function TaskComposer({
  prompt,
  folder,
  workspaceId,
  surface = "main",
  actions = [],
  reviewPicker = null,
  threads = [],
  disabled = false,
  waiting = false,
  mode,
  engine,
  engineLabel,
  engineLocked = false,
  engineAccess = EVERY_ENGINE_READY,
  model,
  effort,
  contextUsage,
  runActive,
  goal = null,
  queuedMessages,
  annotations = [],
  pastes = [],
  files = [],
  focusToken = 0,
  images = [],
  history = [],
  onPromptChange,
  onReviewStep = NOTHING,
  onReview = NOTHING,
  onReviewClose = NOTHING,
  onAnnotationRecall,
  onAnnotationRemove,
  onPasteAdd,
  onPasteRecall,
  onPasteRemove,
  onFilesAdd,
  onFileRecall,
  onImageRecall,
  onFileRemove,
  onImageRemove,
  onModeChange,
  onModelChange,
  onEffortChange,
  onEngineRead = NOTHING,
  onSignIn = NOTHING,
  onSend,
  onSteerQueued,
  onDropQueued,
  onCancel,
  onGoalClear = NOTHING,
}: TaskComposerProps) {
  const caret = useComposerCaret(focusToken);
  const menus = useComposerMenus({ prompt, caret, actions, threads, workspaceId, engine, onPromptChange });
  const stepRecall = useComposerRecall({
    prompt, annotations, pastes, files, images, history, queuedMessages, caret,
    onPromptChange, onAnnotationRecall, onPasteRecall, onFileRecall, onImageRecall,
  });
  const attachments = useComposerAttachments(images, onImageRemove);
  const nothingToSend = !prompt.trim() && attachments.items.length === 0 && annotations.length === 0 && pastes.length === 0 && files.length === 0;

  /** While a run is going the message joins the queue, so only steering needs the run to be active. */
  async function submit(steer = false) {
    if (attachments.sending || waiting || disabled || (steer && !runActive)) return;
    if (nothingToSend) return;
    await attachments.send(onSend, steer);
  }

  return (
    <footer className={`composer-wrap ${surface}`}>
      {surface === "main" && goal && <GoalBar goal={goal} onClear={onGoalClear} />}
      <QueuedRow messages={queuedMessages} surface={surface} onSteer={onSteerQueued} onDrop={onDropQueued} />
      <div className="composer">
        {reviewPicker && (
          <ReviewPicker
            picker={reviewPicker}
            {...(workspaceId ? { workspaceId } : {})}
            returnFocus={caret.textareaRef}
            onStep={onReviewStep}
            onReview={onReview}
            onClose={onReviewClose}
          />
        )}
        {menus.commandMenuOpen && <CommandMenu menus={menus} />}
        {menus.threadMenuOpen && <ThreadMenu menus={menus} />}
        {onAnnotationRemove && <AnnotationRow annotations={annotations} onRemove={onAnnotationRemove} />}
        {onPasteRemove && <PasteRow pastes={pastes} onRemove={onPasteRemove} />}
        {onFileRemove && <FileRow files={files} onRemove={onFileRemove} />}
        <AttachmentStrip attachments={attachments} />
        {attachments.error && <p className="attachment-error" role="status">{attachments.error}</p>}
        <textarea
          ref={caret.textareaRef}
          value={prompt}
          onPaste={(event) => composerPaste(event, { attachPasted: attachments.attachPasted, onFilesAdd, onPasteAdd })}
          onInput={(event) => composerInput(event, caret, onPromptChange)}
          onSelect={(event) => caret.setCaret(event.currentTarget.selectionStart)}
          onFocus={() => caret.setInputFocused(true)}
          onBlur={(event) => composerBlur(event, menus, caret)}
          onKeyDown={(event) => composerKeyDown(event, { menus, runActive, sending: attachments.sending, stepRecall, submit })}
          disabled={disabled}
          placeholder={composerPlaceholder(surface, folder, disabled, engineLabel)}
          aria-label={surface === "side" ? "Side chat prompt" : "Task prompt"}
          aria-autocomplete="list"
          aria-controls={reviewPicker ? "review-picker" : menuControls(menus)}
          aria-expanded={Boolean(reviewPicker) || menus.commandMenuOpen || menus.threadMenuOpen}
          aria-activedescendant={menuActiveDescendant(menus)}
          rows={2}
        />
        <div className="composer-bar">
          <ComposerSettings mode={mode} engine={engine} engineLabel={engineLabel} engineLocked={engineLocked} engineAccess={engineAccess} model={model} effort={effort} onModeChange={onModeChange} onModelChange={onModelChange} onEffortChange={onEffortChange} onEngineRead={onEngineRead} onSignIn={onSignIn} />
          <div className="composer-actions">
            {contextUsage && <ContextUsageMeter usage={contextUsage} />}
            <button
              className={`send-button ${runActive ? "running" : ""}`}
              disabled={!runActive && (disabled || attachments.sending || waiting || nothingToSend)}
              onClick={runActive ? onCancel : () => void submit()}
              aria-label={sendLabel(surface, runActive)}
            >
              {runActive ? <span className="stop-glyph" /> : "↑"}
            </button>
          </div>
        </div>
      </div>
      <AttachmentAnnotator attachments={attachments} />
    </footer>
  );
}
