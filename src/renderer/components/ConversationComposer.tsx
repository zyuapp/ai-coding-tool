import { LuArrowUp as ArrowUp, LuCircleAlert as CircleAlert, LuInfo as Info, LuPaperclip as Paperclip, LuX as X } from "react-icons/lu";
import { useId, useRef, type ReactNode } from "react";
import type { PendingQuestion, QuestionAddress } from "../../domain/agent-question";
import { QuestionPrompt } from "./QuestionPrompt";
import type { QueuedMessage, ReviewPicker as ReviewPickerState } from "../../application/workspace-state";
import type { Annotation, AttachedFile, PastedText, RecalledMessage, StagedImage } from "../../domain/conversation";
import { AnnotationRow } from "./AnnotationRow";
import { FileRow } from "./FileRow";
import { PasteRow } from "./PasteRow";
import type { ThreadHandleOption } from "../../domain/thread-handles";
import type { AgentEngine, AgentModel, EngineReadiness } from "../../domain/agent-engine";
import type { AgentEffort, ExecutionPolicy } from "../../domain/run";
import type { ContextUsage } from "../../domain/thread-run";
import { AttachmentAnnotator, AttachmentStrip, useComposerAttachments, type ComposerOutbox } from "./ComposerAttachments";
import { ComposerSettings, EVERY_ENGINE_READY } from "./ComposerSettings";
import { CommandMenu, ThreadMenu, menuActiveDescendant, menuControls, useComposerMenus, type ComposerAction } from "./ComposerMenus";
import { ContextUsageMeter } from "./ContextUsageMeter";
import { PlanUsageMeter, PlanUsageWarning, type ComposerPlanUsage } from "./PlanUsageMeter";
import { QueuedRow } from "./QueuedRow";
import { useComposerCaret } from "./composer-caret";
import { composerBlur, composerInput, composerKeyDown, composerPaste } from "./composer-input";
import { useComposerRecall } from "./composer-recall";
import type { ReviewTarget } from "../../domain/review";
import { ReviewPicker } from "./ReviewPicker";
import { GoalBar } from "./GoalBar";
import type { ActiveGoal } from "../../domain/goal";
import { CommandButton, useCommandControls } from "./CommandControl";
import { ReturnFocusContext } from "../focus";
import type { AppCommand } from "../../contracts/commands";
import { MAC } from "../platform";
import { displayShortcut } from "../../domain/shortcuts";
import { shortcutTip } from "./TooltipLayer";

const NOTHING = () => {};

export type { ComposerAction };

function composerPlaceholder({ surface, folder, disabled, engineLabel }: {
  surface: ComposerSurface;
  folder: string;
  disabled: boolean;
  engineLabel: string;
}) {
  if (surface === "side" && disabled) return "Main context required";
  const ask = surface === "side" ? "Ask a side question"
    : surface === "tab" ? "Reply to this thread"
      : folder ? `Ask ${engineLabel} to work on anything` : `Ask ${engineLabel} anything`;
  return ask;
}

const SEND_KEYS = displayShortcut("Enter", MAC);
const STEER_KEYS = displayShortcut("Mod+Enter", MAC);

function sendLabel(surface: ComposerSurface, runActive: boolean) {
  if (surface === "side") return runActive ? "Stop side chat" : "Send side chat message";
  if (surface === "tab") return runActive ? "Stop thread" : "Send message";
  return runActive ? "Stop task" : "Send task";
}

/** `recall` is set once there is an earlier message to bring back. */
function sendTip(runActive: boolean, { recall = false } = {}) {
  const keys = runActive
    ? [shortcutTip("Stop", "Escape")]
    : [shortcutTip("Send", "Enter"), shortcutTip("New line", "Shift+Enter"), ...(recall ? [shortcutTip("Previous message", "ArrowUp")] : [])];
  return keys.join(" · ");
}

/**
 * Sends what is written, or stops the run while one is going. `busy` is a send already on its way.
 */
function SendButton({ taskId, surface, runActive, command, disabled, busy, recall, onSend, onCancel }: {
  taskId: string | undefined;
  surface: ComposerSurface;
  runActive: boolean;
  command: AppCommand;
  disabled: boolean;
  busy: boolean;
  recall: boolean;
  onSend: () => void;
  onCancel: () => void;
}) {
  if (runActive) {
    return (
      <CommandButton command={{ type: "run.cancel", taskId }} className="send-button running" onClick={onCancel} aria-label={sendLabel(surface, true)} data-tip={sendTip(true)}>
        <span className="stop-glyph" />
      </CommandButton>
    );
  }
  return (
    <CommandButton command={command}
      className={`send-button${busy ? " busy" : ""}`}
      disabled={disabled || busy}
      onClick={onSend}
      aria-label={sendLabel(surface, false)}
      aria-busy={busy || undefined}
      data-tip={sendTip(false, { recall })}
    >
      {busy ? <span className="send-spinner" aria-hidden="true" /> : <ArrowUp size={16} strokeWidth={2.5} aria-hidden="true" />}
    </CommandButton>
  );
}

/** The keys that queue and steer while a run goes and something is written. */
function ComposerHint({ id, steer }: { id: string; steer: boolean }) {
  if (!steer) return null;
  return (
    <span className="composer-hint" id={id}>
      <span><kbd>{SEND_KEYS}</kbd> queue</span>
      <span><kbd>{STEER_KEYS}</kbd> steer</span>
    </span>
  );
}

/** Opens the system file picker; what is picked rides the next send the way a drop or paste would. */
function AttachButton({ disabled, onFilesAdd }: { disabled: boolean; onFilesAdd: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="composer-attach" aria-label="Attach files" data-tip="Attach files, or drop or paste them" disabled={disabled} onClick={() => input.current?.click()}>
        <Paperclip size={16} aria-hidden="true" />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) onFilesAdd(files);
        }}
      />
    </>
  );
}

/** What the last send or attach had to say, until the user puts it away or the next one replaces it. A failure outranks a note. */
function SendNotice({ error, note, onDismiss }: { error: string | null; note: string | null; onDismiss: () => void }) {
  const message = error ?? note;
  if (!message) return null;
  const Icon = error ? CircleAlert : Info;
  return (
    <div className={`attachment-error${error ? "" : " note"}`} role={error ? "alert" : "status"}>
      <Icon size={14} aria-hidden="true" />
      <span>{message}</span>
      <button type="button" aria-label="Dismiss" data-tip="Dismiss" onClick={onDismiss}><X size={12} aria-hidden="true" /></button>
    </div>
  );
}

/** Stands where the text would go for a thread this build cannot open, beside Stop while it runs. Offers the update once one is found, and a check for one until then. */
function UnopenableComposer({ reason, taskId, surface, runActive, updateAvailable, onCancel }: {
  reason: string;
  taskId: string | undefined;
  surface: ComposerSurface;
  runActive: boolean;
  updateAvailable: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="composer unopenable">
      <p className="composer-unopenable" role="status">{reason}</p>
      {updateAvailable
        ? <CommandButton command={{ type: "app.update" }} className="composer-unopenable-update">Update</CommandButton>
        : <CommandButton command={{ type: "app.check-for-updates" }} className="composer-unopenable-check">Check for updates</CommandButton>}
      {runActive && <CommandButton command={{ type: "run.cancel", taskId }} className="send-button running" onClick={onCancel} aria-label={sendLabel(surface, true)} data-tip={sendTip(true)}>
        <span className="stop-glyph" />
      </CommandButton>}
    </div>
  );
}

/** Where a composer is drawn: under the thread on screen, in a side chat, or in a thread's dock tab. */
export type ComposerSurface = "main" | "side" | "tab";

export type ConversationComposerProps = {
  taskId?: string;
  prompt: string;
  folder: string;
  workspaceId?: string;
  /** Where the composer sits. */
  surface?: ComposerSurface;
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
  /** Set for a coordinator, whose effort menu offers no effort that hands work to the engine's agents. */
  coordinating?: boolean;
  fastMode: boolean;
  onFastModeChange: (fastMode: boolean) => void;
  contextUsage?: ContextUsage;
  /** Compacts the thread's context. Set only while compacting is on offer. */
  onCompact?: () => void;
  /** The plan limits of the engine this composer sends to. A surface that shows none passes none. */
  planUsage?: ComposerPlanUsage;
  runActive: boolean;
  question?: PendingQuestion;
  onQuestionAnswerChange?: (question: QuestionAddress, text: string) => void;
  onAnswerQuestion?: (question: QuestionAddress) => void;
  goal?: ActiveGoal | null;
  /** The decisions waiting on the user, drawn above the composer of the coordinator they reach. */
  decisions?: ReactNode;
  /**
   * Why a message cannot be typed here: the thread runs on an engine only a newer build on a paired
   * computer knows. It stands where the text and its settings would be; everything the holder can
   * still take, from what waits on the user to stopping a run, stays.
   */
  unopenable?: string | null;
  /** Set once a newer build has been found, so an unopenable thread can offer it. */
  updateAvailable?: boolean;
  /** How a thread that does not exist yet starts, drawn under the composer it is sent from. */
  startOptions?: ReactNode;
  queuedMessages: QueuedMessage[];
  /** Annotations waiting to ride the next send, drafted from selections in the transcript. */
  annotations?: Annotation[];
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
  onAnnotationRecall?: (annotations: Annotation[]) => void;
  onAnnotationRemove?: (annotationId: string) => void;
  onAnnotationReveal?: (annotationId: string) => void;
  onPasteAdd?: (text: string) => void;
  onPasteRecall?: (pastes: PastedText[]) => void;
  onPasteRemove?: (pasteId: string) => void;
  /** Files pasted, picked, or dropped in from the desktop. The surface decides what each one becomes. */
  onFilesAdd: (files: File[]) => void;
  onFileRecall?: (files: AttachedFile[]) => void;
  onImageRecall?: (paths: string[]) => void;
  onFileRemove?: (fileId: string) => void;
  onModeChange: (mode: ExecutionPolicy) => void;
  favoriteModels?: AgentModel[];
  onModelFavorite?: (model: AgentModel, favorite: boolean) => void;
  onModelChange: (engine: AgentEngine, model: AgentModel) => void;
  onEffortChange: (engine: AgentEngine, effort: AgentEffort) => void;
  /** Asked when the model menu opens on another engine. A surface that cannot ask leaves every engine ready. */
  onEngineRead?: () => void;
  onSignIn?: (engine: AgentEngine) => void;
  /** Opens the Engines page. A surface without settings of its own leaves it out. */
  onOpenEngineSettings?: () => void;
  outbox: ComposerOutbox;
  onEditQueued: (messageId: string) => void;
  onSteerQueued: (messageId: string) => void;
  onDropQueued: (messageId: string) => void;
  onCancel: () => void;
  onGoalClear?: () => void;
};

export function ConversationComposer({
  taskId,
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
  coordinating = false,
  fastMode,
  onFastModeChange,
  contextUsage,
  onCompact,
  planUsage,
  runActive,
  question,
  onQuestionAnswerChange = NOTHING,
  onAnswerQuestion = NOTHING,
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
  onAnnotationReveal,
  onPasteAdd,
  onPasteRecall,
  onPasteRemove,
  onFilesAdd,
  onFileRecall,
  onImageRecall,
  onFileRemove,
  onImageRemove,
  onModeChange,
  favoriteModels,
  onModelFavorite,
  onModelChange,
  onEffortChange,
  onEngineRead = NOTHING,
  onSignIn = NOTHING,
  onOpenEngineSettings,
  outbox,
  onEditQueued,
  onSteerQueued,
  onDropQueued,
  onCancel,
  onGoalClear = NOTHING,
  decisions,
  unopenable = null,
  updateAvailable = false,
  startOptions,
}: ConversationComposerProps) {
  const caret = useComposerCaret(focusToken);
  const menus = useComposerMenus({ prompt, caret, actions, threads, workspaceId, engine, enabled: true, onPromptChange });
  const stepRecall = useComposerRecall({
    prompt, annotations, pastes, files, images, history, queuedMessages, caret,
    onPromptChange, onAnnotationRecall, onPasteRecall, onFileRecall, onImageRecall,
  });
  const attachments = useComposerAttachments(images, outbox, onImageRemove);
  const nothingToSend = !prompt.trim() && attachments.items.length === 0 && annotations.length === 0 && pastes.length === 0 && files.length === 0;
  const controls = useCommandControls();
  const sendCommand: AppCommand = { type: "attachments.send", taskId, attachments: attachments.items };

  /** While a run is going the message joins the queue, so only steering needs the run to be active. */
  async function submit(steer = false) {
    if (attachments.sending || waiting || disabled || (steer && !runActive)) return;
    if (nothingToSend) return;
    if (!controls.available({ ...sendCommand, ...(steer ? { steer } : {}) })) return;
    attachments.send(steer);
  }

  const steerHint = runActive && !nothingToSend && !disabled && !attachments.sending;
  const hintId = useId();

  return (
    <footer className={`composer-wrap ${surface}`}>
      {surface === "main" && goal && <GoalBar goal={goal} onClear={onGoalClear} />}
      {surface === "main" && <ReturnFocusContext.Provider value={caret.textareaRef}>{decisions}</ReturnFocusContext.Provider>}
      {question && <QuestionPrompt question={question} answer={question.answer ?? ""} disabled={disabled || waiting} onAnswerChange={(text) => onQuestionAnswerChange(question, text)} onSubmit={() => onAnswerQuestion(question)} />}
      <QueuedRow messages={queuedMessages} surface={surface} canSteer={runActive} onEdit={onEditQueued} onSteer={onSteerQueued} onDrop={onDropQueued} />
      {planUsage && <PlanUsageWarning engine={engine} engineLabel={engineLabel} model={model} {...planUsage} />}
      {surface === "main" && startOptions}
      {unopenable ? <UnopenableComposer reason={unopenable} taskId={taskId} surface={surface} runActive={runActive} updateAvailable={updateAvailable} onCancel={onCancel} /> : <div className="composer">
        {reviewPicker && (
          <ReviewPicker
            picker={reviewPicker}
            {...(workspaceId ? { workspaceId } : {})}
            engineLabel={engineLabel}
            returnFocus={caret.textareaRef}
            onStep={onReviewStep}
            onReview={onReview}
            onClose={onReviewClose}
          />
        )}
        {menus.commandMenuOpen && <CommandMenu menus={menus} />}
        {menus.threadMenuOpen && <ThreadMenu menus={menus} />}
        {onAnnotationRemove && <AnnotationRow annotations={annotations} onRemove={onAnnotationRemove} onReveal={onAnnotationReveal} />}
        {onPasteRemove && <PasteRow pastes={pastes} onRemove={onPasteRemove} />}
        {onFileRemove && <FileRow files={files} onRemove={onFileRemove} />}
        <AttachmentStrip attachments={attachments} />
        <SendNotice error={attachments.error} note={attachments.note} onDismiss={attachments.dismissNotice} />
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
          placeholder={composerPlaceholder({ surface, folder, disabled, engineLabel })}
          aria-label={surface === "side" ? "Side chat prompt" : surface === "tab" ? "Thread prompt" : "Task prompt"}
          aria-autocomplete="list"
          aria-controls={reviewPicker ? "review-picker" : menuControls(menus)}
          aria-expanded={Boolean(reviewPicker) || menus.commandMenuOpen || menus.threadMenuOpen}
          aria-activedescendant={menuActiveDescendant(menus)}
          aria-describedby={steerHint ? hintId : undefined}
          rows={2}
        />
        <div className="composer-bar">
          <AttachButton disabled={disabled} onFilesAdd={onFilesAdd} />
          <ComposerSettings taskId={taskId} mode={mode} engine={engine} engineLabel={engineLabel} engineLocked={engineLocked} engineAccess={engineAccess} model={model} effort={effort} coordinating={coordinating} fastMode={fastMode} onFastModeChange={onFastModeChange} onModeChange={onModeChange} favoriteModels={favoriteModels} onModelFavorite={onModelFavorite} onModelChange={onModelChange} onEffortChange={onEffortChange} onEngineRead={onEngineRead} onSignIn={onSignIn} {...(onOpenEngineSettings ? { onOpenEngineSettings } : {})} />
          <div className="composer-actions">
            <ComposerHint id={hintId} steer={steerHint} />
            {planUsage && <PlanUsageMeter engineLabel={engineLabel} model={model} usage={planUsage.usage} {...(planUsage.onOpen ? { onOpen: planUsage.onOpen } : {})} />}
            {contextUsage && <ContextUsageMeter usage={contextUsage} {...(onCompact ? { onCompact } : {})} />}
            <SendButton taskId={taskId} surface={surface} runActive={runActive} command={sendCommand} disabled={disabled || nothingToSend} busy={!disabled && (attachments.sending || waiting)} recall={history.length > 0} onSend={() => void submit()} onCancel={onCancel} />
          </div>
        </div>
      </div>}
      <AttachmentAnnotator attachments={attachments} />
    </footer>
  );
}
