import { Command, CornerDownRight, MessagesSquare, Sparkles, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { QueuedMessage } from "../../application/workspace-state";
import { MAX_ATTACHMENTS, type Annotation as TaskAnnotation, type PastedText, type RecalledMessage, type RunAttachment, type StagedImage } from "../../domain/task";
import { AnnotationRow } from "./AnnotationRow";
import { PasteRow } from "./PasteRow";
import { markPrefix } from "../../application/attachments";
import { pasteRidesAsPill } from "../../application/pastes";
import type { AvailableCommand } from "../../contracts/ipc";
import { handleTokenAt, rankThreadHandles, type ThreadHandleOption } from "../../domain/thread-handles";
import type { AgentEffort, AgentModel, ExecutionPolicy } from "../../domain/run";
import type { ContextUsage } from "../../domain/task";
import { ComposerSettings } from "./ComposerSettings";
import { ContextUsageMeter } from "./ContextUsageMeter";
import { ImageAnnotator, renderAnnotatedSource, type Annotation } from "./ImageAnnotator";
import { useDismissibleLayer } from "../focus";

/** An entry in the `/` menu that the app performs itself instead of sending. */
export type ComposerAction = { name: string; description: string; run: () => void };

type MenuEntry = {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
  kind: "app" | "skill";
  run?: () => void;
};

/**
 * The `/word` the caret sits in. A `/` only starts one after whitespace, which is what keeps paths
 * and URLs from opening the menu.
 */
function commandTokenAt(text: string, caret: number) {
  const query = text.slice(0, caret).match(/(?:^|\s)\/([^\s/]*)$/)?.[1];
  return query === undefined ? null : { query: query.toLowerCase(), start: caret - query.length - 1 };
}

/** How many threads the `@` menu shows at once; the query is what reaches past them. */
const THREAD_MENU_LIMIT = 8;

function commandMatches(entry: MenuEntry, query: string) {
  return entry.name.toLowerCase().startsWith(query) || entry.aliases.some((alias) => alias.toLowerCase().startsWith(query));
}

type Attachment = {
  id: string;
  source: string;
  preview: string;
  annotations: Annotation[];
  /** Where the image already sits on disk, for one the workspace staged rather than the composer read. */
  path?: string;
};

function composerPlaceholder(surface: "main" | "side", folder: string, disabled: boolean) {
  if (surface === "side") return disabled ? "Main context required" : "Ask a side question";
  return folder ? "Ask Claude to work on anything" : "Ask Claude anything";
}

function sendLabel(surface: "main" | "side", runActive: boolean) {
  if (surface === "side") return runActive ? "Stop side chat" : "Send side chat message";
  return runActive ? "Stop task" : "Send task";
}

/** Reads a file this app already wrote into the attachments directory back out as a data URL. */
async function dataUrlOf(path: string) {
  return `data:image/png;base64,${await window.desktop.readAttachment(path)}`;
}

function readImage(file: File) {
  return new Promise<Attachment>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const source = String(reader.result);
      resolve({ id: crypto.randomUUID(), source, preview: source, annotations: [] });
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read the pasted image.")));
    reader.readAsDataURL(file);
  });
}

export type TaskComposerProps = {
  prompt: string;
  folder: string;
  workspaceId?: string;
  /** Where the composer sits. */
  surface?: "main" | "side";
  /** Runnable `/` entries. A surface that performs none, as a side chat does, passes none. */
  actions?: ComposerAction[];
  /** Threads the `@` menu offers, newest first. A surface that names none passes none. */
  threads?: ThreadHandleOption[];
  /** Set while the thread cannot take a message at all, as a side chat cannot before its fork exists. */
  disabled?: boolean;
  /** Set while a send already given is still finding the checkout it runs in, so nothing sends twice. */
  waiting?: boolean;
  mode: ExecutionPolicy;
  model: AgentModel;
  effort: AgentEffort;
  contextUsage?: ContextUsage;
  runActive: boolean;
  queuedMessages: QueuedMessage[];
  /** Annotations waiting to ride the next send, drafted from selections in the transcript. */
  annotations?: TaskAnnotation[];
  /** Text pasted in that was too long to sit in the prompt, waiting to ride the next send. */
  pastes?: PastedText[];
  /** Bumped whenever something asks for the caret, which is all the composer needs to take it. */
  focusToken?: number;
  /** Images the workspace is holding for this composer, such as windows the desktop hotkey grabbed. */
  images?: StagedImage[];
  onImageRemove?: (imageId: string) => void;
  /** Previously sent messages, oldest first, offered back on ↑ from the first line. */
  history?: RecalledMessage[];
  onPromptChange: (prompt: string) => void;
  onAnnotationRecall?: (annotations: TaskAnnotation[]) => void;
  onAnnotationRemove?: (annotationId: string) => void;
  onPasteAdd?: (text: string) => void;
  onPasteRecall?: (pastes: PastedText[]) => void;
  onPasteRemove?: (pasteId: string) => void;
  onModeChange: (mode: ExecutionPolicy) => void;
  onModelChange: (model: AgentModel) => void;
  onEffortChange: (effort: AgentEffort) => void;
  onSend: (attachments: RunAttachment[], steer: boolean) => void;
  onSteerQueued: (messageId: string) => void;
  onDropQueued: (messageId: string) => void;
  onCancel: () => void;
};

/** Messages waiting on the run, each with what it carries and the two things you can do to it. */
function QueuedRow({ messages, surface, onSteer, onDrop }: {
  messages: QueuedMessage[];
  surface: "main" | "side";
  onSteer: (messageId: string) => void;
  onDrop: (messageId: string) => void;
}) {
  if (messages.length === 0) return null;

  return (
    <div className="queued-row" role="list" aria-label={surface === "side" ? "Queued side chat messages" : "Queued messages"}>
      {messages.map((message) => (
        <div className="queued-message" role="listitem" key={message.id}>
          <CornerDownRight className="queued-mark" size={14} aria-hidden="true" />
          <div className="queued-body">
            {message.text && <p className="queued-text">{message.text}</p>}
            {message.annotations?.length ? <AnnotationRow annotations={message.annotations} /> : null}
          </div>
          {message.steering ? <span className="queued-state">Steering…</span> : (
            <span className="queued-actions">
              <button type="button" className="queued-steer" onClick={() => onSteer(message.id)}>Steer</button>
              <button type="button" className="queued-drop" aria-label="Remove queued message" onClick={() => onDrop(message.id)}>
                <X size={13} />
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function carries(message: RecalledMessage) {
  return message.text.trim() !== "" || message.annotations.length > 0 || message.pastes.length > 0;
}

export function TaskComposer({
  prompt,
  folder,
  workspaceId,
  surface = "main",
  actions = [],
  threads = [],
  disabled = false,
  waiting = false,
  mode,
  model,
  effort,
  contextUsage,
  runActive,
  queuedMessages,
  annotations = [],
  pastes = [],
  focusToken = 0,
  images = [],
  history = [],
  onPromptChange,
  onAnnotationRecall,
  onAnnotationRemove,
  onPasteAdd,
  onPasteRecall,
  onPasteRemove,
  onImageRemove,
  onModeChange,
  onModelChange,
  onEffortChange,
  onSend,
  onSteerQueued,
  onDropQueued,
  onCancel,
}: TaskComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandMenuRef = useRef<HTMLDivElement>(null);
  const threadMenuRef = useRef<HTMLDivElement>(null);
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
  const [commandsLoading, setCommandsLoading] = useState(true);
  const [commandsToken, setCommandsToken] = useState(0);
  const [selectedCommand, setSelectedCommand] = useState(0);
  const [selectedThread, setSelectedThread] = useState(0);
  const [inputFocused, setInputFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  const [dismissedPrompt, setDismissedPrompt] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** Where ↑/↓ sits in the sent history, with the draft it replaced and the text it put on screen. */
  const [recall, setRecall] = useState<{ index: number; draft: RecalledMessage; shown: string } | null>(null);
  const [annotating, setAnnotating] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** Which staged images have already been read in, so a rerender never reads the same one twice. */
  const takenImages = useRef(new Set<string>());
  const editing = attachments.find((attachment) => attachment.id === annotating);
  const token = commandTokenAt(prompt, Math.min(caret, prompt.length));
  /** An action discards the draft, so it is only offered while the command is the whole draft. */
  const actionsOffered = token !== null && token.start === 0 && prompt.slice(1 + token.query.length).trim() === "";
  const menuEntries: MenuEntry[] = [
    ...(actionsOffered ? actions.map((action) => ({ ...action, argumentHint: "", aliases: [], kind: "app" as const })) : []),
    ...commands
      .filter((command) => !actions.some((action) => action.name === command.name))
      .map((command) => ({ ...command, aliases: command.aliases ?? [], kind: "skill" as const })),
  ];
  const matchingCommands = token === null ? [] : menuEntries.filter((entry) => commandMatches(entry, token.query));
  const commandMenuOpen = inputFocused && token !== null && dismissedPrompt !== prompt;
  useDismissibleLayer(commandMenuOpen, [textareaRef, commandMenuRef], () => setDismissedPrompt(prompt), textareaRef);

  const threadToken = handleTokenAt(prompt, Math.min(caret, prompt.length));
  const matchingThreads = threadToken === null ? [] : rankThreadHandles(threads, threadToken.query).slice(0, THREAD_MENU_LIMIT);
  const threadMenuOpen = inputFocused && threadToken !== null && matchingThreads.length > 0 && dismissedPrompt !== prompt;
  useDismissibleLayer(threadMenuOpen, [textareaRef, threadMenuRef], () => setDismissedPrompt(prompt), textareaRef);
  /** Where the list stops belonging to this project, so the divider sits above that row. */
  const firstElsewhere = matchingThreads.findIndex((option) => !option.inScope);

  const sent = [...history, ...queuedMessages.map((message) => ({ text: message.text, annotations: message.annotations ?? [], pastes: message.pastes ?? [] }))];
  /** A send is worth offering back when it carried anything. Only a repeated text collapses into one. */
  const recallable = sent.filter((message, index) => carries(message)
    && !(message.text !== "" && message.text === sent[index - 1]?.text));

  /** Step through the sent history; the live draft is stashed and comes back below the newest entry. */
  function stepRecall(step: -1 | 1) {
    if (step === 1 && recall === null) return false;
    const index = (recall?.index ?? recallable.length) + step;
    if (index < 0) return false;
    const draft = recall?.draft ?? { text: prompt, annotations, pastes };
    const next = index >= recallable.length ? draft : recallable[index];
    setRecall(index >= recallable.length ? null : { index, draft, shown: next.text });
    onPromptChange(next.text);
    onAnnotationRecall?.(next.annotations);
    onPasteRecall?.(next.pastes);
    setDismissedPrompt(next.text);
    setPendingCaret(next.text.length);
    return true;
  }

  function shortDescription(description: string) {
    const firstSentence = description.split(/(?<=[.!?])\s/, 1)[0].replace(/\s+\([^)]*\)$/, "");
    return firstSentence.length > 110 ? `${firstSentence.slice(0, 107).trimEnd()}…` : firstSentence;
  }

  function chooseCommand(entry: MenuEntry) {
    if (entry.run) {
      onPromptChange("");
      setDismissedPrompt(null);
      setCaret(0);
      entry.run();
      return;
    }
    if (!token) return;
    const inserted = `/${entry.name}${entry.argumentHint ? " " : ""}`;
    const nextPrompt = prompt.slice(0, token.start) + inserted + prompt.slice(token.start + 1 + token.query.length);
    onPromptChange(nextPrompt);
    setDismissedPrompt(nextPrompt);
    setInputFocused(true);
    setPendingCaret(token.start + inserted.length);
  }

  function chooseThread(option: ThreadHandleOption) {
    if (!threadToken) return;
    const inserted = `@${option.handle} `;
    const nextPrompt = prompt.slice(0, threadToken.start) + inserted + prompt.slice(threadToken.start + 1 + threadToken.query.length);
    onPromptChange(nextPrompt);
    setDismissedPrompt(nextPrompt);
    setInputFocused(true);
    setPendingCaret(threadToken.start + inserted.length);
  }

  async function attachPasted(files: File[]) {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} images.`);
      return;
    }
    try {
      const added = await Promise.all(files.slice(0, room).map(readImage));
      setAttachments((current) => [...current, ...added]);
      setAttachmentError(files.length > room ? `Only the first ${room} image${room === 1 ? "" : "s"} were attached.` : null);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    }
  }

  /** While a run is going the message joins the queue, so only steering needs the run to be active. */
  async function submit(steer = false) {
    if (sending || waiting || disabled || (steer && !runActive)) return;
    if (!prompt.trim() && attachments.length === 0 && annotations.length === 0 && pastes.length === 0) return;
    if (attachments.length === 0) {
      onSend([], steer);
      return;
    }
    /** Pasting and grabbing fill the same row from different sides, so the total is checked once here. */
    if (attachments.length > MAX_ATTACHMENTS) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} images.`);
      return;
    }
    setSending(true);
    try {
      const saved = await Promise.all(attachments.map(async (attachment, at) => ({
        /** A staged image is already on disk; only its annotations, drawn since, need writing back. */
        path: attachment.path !== undefined && attachment.annotations.length === 0
          ? attachment.path
          : await window.desktop.saveAttachment(
            (attachment.annotations.length === 0
              ? attachment.source
              : await renderAnnotatedSource(attachment.source, attachment.annotations, markPrefix(at, attachments.length))
            ).replace(/^data:[^,]*,/, ""),
          ),
        labels: attachment.annotations.filter((annotation) => annotation.kind === "box").map((annotation) => annotation.text),
      })));
      setAttachments([]);
      setAttachmentError(null);
      onSend(saved, steer);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setCommandsLoading(true);
    void (async () => {
      try {
        const id = workspaceId ?? (await window.desktop.projectlessWorkspace()).id;
        const result = await window.desktop.commands(id);
        if (!cancelled) setCommands(result.status === "available" ? result.commands : []);
      } catch {
        if (!cancelled) setCommands([]);
      } finally {
        if (!cancelled) setCommandsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, commandsToken]);

  useEffect(() => {
    const reload = () => setCommandsToken((token) => token + 1);
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, []);

  useEffect(() => setSelectedCommand(0), [prompt, commands]);

  /** Typing, sending, or switching drafts all change the prompt out from under a recall, ending it. */
  useEffect(() => {
    if (recall && prompt !== recall.shown) setRecall(null);
  }, [prompt, recall]);

  useEffect(() => {
    if (focusToken) textareaRef.current?.focus();
  }, [focusToken]);

  useLayoutEffect(() => {
    if (pendingCaret === null) return;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(pendingCaret, pendingCaret);
    setCaret(pendingCaret);
    setPendingCaret(null);
  }, [pendingCaret]);

  /**
   * The workspace holds staged images as paths; the composer needs their bytes to draw on them, so
   * each one is read in once and then behaves exactly like an image pasted in.
   */
  useEffect(() => {
    let cancelled = false;
    const staged = new Set(images.map((image) => image.id));
    for (const id of takenImages.current) if (!staged.has(id)) takenImages.current.delete(id);
    setAttachments((current) => {
      const kept = current.filter((item) => item.path === undefined || staged.has(item.id));
      return kept.length === current.length ? current : kept;
    });
    const arriving = images.filter((image) => !takenImages.current.has(image.id));
    if (arriving.length === 0) return;
    for (const image of arriving) takenImages.current.add(image.id);
    void (async () => {
      try {
        const read = await Promise.all(arriving.map(async (image) => ({ image, preview: await dataUrlOf(image.path) })));
        if (cancelled) return;
        setAttachments((current) => [
          ...current,
          ...read
            .filter(({ image }) => !current.some((item) => item.id === image.id))
            .map(({ image, preview }) => ({ id: image.id, source: preview, preview, annotations: [], path: image.path })),
        ]);
      } catch (error) {
        if (cancelled) return;
        for (const image of arriving) takenImages.current.delete(image.id);
        setAttachmentError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, [images]);

  useEffect(() => {
    if (!commandMenuOpen) return;
    commandMenuRef.current?.querySelector(`#slash-command-${selectedCommand}`)?.scrollIntoView?.({ block: "nearest" });
  }, [commandMenuOpen, selectedCommand]);

  useEffect(() => {
    setSelectedThread(0);
  }, [threadToken?.query]);

  useEffect(() => {
    if (!threadMenuOpen) return;
    threadMenuRef.current?.querySelector(`#thread-mention-${selectedThread}`)?.scrollIntoView?.({ block: "nearest" });
  }, [threadMenuOpen, selectedThread]);

  return (
    <footer className={`composer-wrap ${surface}`}>
      <QueuedRow messages={queuedMessages} surface={surface} onSteer={onSteerQueued} onDrop={onDropQueued} />
      <div className="composer">
        {commandMenuOpen && (
          <div className="command-menu" ref={commandMenuRef} id="slash-command-menu" role="listbox" aria-label="Slash commands">
            <div className="command-menu-heading"><Command size={14} aria-hidden="true" /><span>Commands</span><kbd>↑↓</kbd></div>
            <div className="command-menu-list">
              {matchingCommands.map((command, index) => (
                <button
                  type="button"
                  id={`slash-command-${index}`}
                  key={`${command.kind}:${command.name}`}
                  className={`command-option ${index === selectedCommand ? "selected" : ""}`}
                  role="option"
                  aria-selected={index === selectedCommand}
                  onMouseEnter={() => setSelectedCommand(index)}
                  onClick={() => chooseCommand(command)}
                >
                  <span className={`command-mark ${command.kind}`} aria-hidden="true">{command.kind === "app" ? <Command size={16} /> : <Sparkles size={15} />}</span>
                  <span className="command-copy"><strong>/{command.name}{command.argumentHint && <em> {command.argumentHint}</em>}</strong><small>{shortDescription(command.description)}</small></span>
                  <span className="command-source">{command.kind === "app" ? "AI Coding Tool" : "Skill"}</span>
                </button>
              ))}
              {matchingCommands.length === 0 && <p className="command-empty">No matching commands</p>}
            </div>
            {commandsLoading && <div className="command-menu-status">Loading installed skills…</div>}
          </div>
        )}
        {threadMenuOpen && (
          <div className="command-menu thread-menu" ref={threadMenuRef} id="thread-mention-menu" role="listbox" aria-label="Threads">
            <div className="command-menu-heading"><MessagesSquare size={14} aria-hidden="true" /><span>Threads</span><kbd>↑↓</kbd></div>
            <div className="command-menu-list">
              {matchingThreads.map((option, index) => (
                <button
                  type="button"
                  id={`thread-mention-${index}`}
                  key={option.id}
                  className={`command-option ${index === selectedThread ? "selected" : ""} ${index === firstElsewhere && index > 0 ? "elsewhere" : ""}`}
                  role="option"
                  aria-selected={index === selectedThread}
                  onMouseEnter={() => setSelectedThread(index)}
                  onClick={() => chooseThread(option)}
                >
                  <span className={`command-mark thread ${option.running ? "running" : ""}`} aria-hidden="true"><MessagesSquare size={15} /></span>
                  <span className="command-copy"><strong>{option.title}</strong><small>@{option.handle}</small></span>
                  <span className="command-source">{option.inScope ? (option.running ? "Running" : "") : option.project ?? "No project"}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {onAnnotationRemove && <AnnotationRow annotations={annotations} onRemove={onAnnotationRemove} />}
        {onPasteRemove && <PasteRow pastes={pastes} onRemove={onPasteRemove} />}
        {attachments.length > 0 && (
          <div className="attachment-row">
            {attachments.map((attachment, index) => (
              <div className="attachment-chip" key={attachment.id}>
                <button type="button" className="attachment-open" onClick={() => setAnnotating(attachment.id)} aria-label={`Annotate image ${index + 1}`}>
                  <img src={attachment.preview} alt="" />
                  {attachment.annotations.length > 0 && <span className="attachment-badge">{attachment.annotations.length}</span>}
                </button>
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`Remove image ${index + 1}`}
                  onClick={() => (attachment.path !== undefined ? onImageRemove?.(attachment.id) : setAttachments((current) => current.filter((item) => item.id !== attachment.id)))}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachmentError && <p className="attachment-error" role="status">{attachmentError}</p>}
        <textarea
          ref={textareaRef}
          value={prompt}
          onPaste={(event) => {
            const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
            if (images.length > 0) {
              event.preventDefault();
              void attachPasted(images);
              return;
            }
            const text = event.clipboardData.getData("text/plain");
            if (!onPasteAdd || !pasteRidesAsPill(text)) return;
            event.preventDefault();
            onPasteAdd(text);
          }}
          onInput={(event) => {
            const { value, selectionStart } = event.currentTarget;
            const inputType = (event.nativeEvent as InputEvent).inputType;
            onPromptChange(value);
            setCaret(selectionStart);
            /** Pasted text is not typing, so a `/` it carries must not open the menu. */
            setDismissedPrompt(inputType === "insertFromPaste" || inputType === "insertFromDrop" ? value : null);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onFocus={() => setInputFocused(true)}
          onBlur={(event) => {
            const menus = [commandMenuRef.current, threadMenuRef.current];
            if (!menus.some((menu) => menu?.contains(event.relatedTarget as Node))) setInputFocused(false);
          }}
          onKeyDown={(event) => {
            if (threadMenuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              setSelectedThread((current) => (current + (event.key === "ArrowDown" ? 1 : matchingThreads.length - 1)) % matchingThreads.length);
              return;
            }
            if (threadMenuOpen && event.key === "Escape") {
              event.preventDefault();
              setDismissedPrompt(prompt);
              return;
            }
            if (threadMenuOpen && matchingThreads[selectedThread] && (event.key === "Enter" || event.key === "Tab")) {
              event.preventDefault();
              chooseThread(matchingThreads[selectedThread]);
              return;
            }
            if (commandMenuOpen && matchingCommands.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              setSelectedCommand((current) => (current + (event.key === "ArrowDown" ? 1 : matchingCommands.length - 1)) % matchingCommands.length);
              return;
            }
            if (commandMenuOpen && event.key === "Escape") {
              event.preventDefault();
              setDismissedPrompt(prompt);
              return;
            }
            if (commandMenuOpen && matchingCommands[selectedCommand] && (event.key === "Enter" || event.key === "Tab")) {
              event.preventDefault();
              chooseCommand(matchingCommands[selectedCommand]);
              return;
            }
            if (!commandMenuOpen && (event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
              const { value, selectionStart, selectionEnd } = event.currentTarget;
              const atEdge = event.key === "ArrowUp"
                ? !value.slice(0, selectionStart).includes("\n")
                : !value.slice(selectionEnd).includes("\n");
              if (atEdge && stepRecall(event.key === "ArrowUp" ? -1 : 1)) {
                event.preventDefault();
                return;
              }
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && runActive && !sending) {
              event.preventDefault();
              void submit(true);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !sending) {
              event.preventDefault();
              void submit();
            }
          }}
          disabled={disabled}
          placeholder={composerPlaceholder(surface, folder, disabled)}
          aria-label={surface === "side" ? "Side chat prompt" : "Task prompt"}
          aria-autocomplete="list"
          aria-controls={commandMenuOpen ? "slash-command-menu" : threadMenuOpen ? "thread-mention-menu" : undefined}
          aria-expanded={commandMenuOpen || threadMenuOpen}
          aria-activedescendant={
            commandMenuOpen && matchingCommands[selectedCommand] ? `slash-command-${selectedCommand}`
              : threadMenuOpen && matchingThreads[selectedThread] ? `thread-mention-${selectedThread}`
                : undefined
          }
          rows={2}
        />
        <div className="composer-bar">
          <ComposerSettings mode={mode} model={model} effort={effort} onModeChange={onModeChange} onModelChange={onModelChange} onEffortChange={onEffortChange} />
          <div className="composer-actions">
            {contextUsage && <ContextUsageMeter usage={contextUsage} />}
            <button
              className={`send-button ${runActive ? "running" : ""}`}
              disabled={!runActive && (disabled || sending || waiting || (!prompt.trim() && attachments.length === 0 && annotations.length === 0 && pastes.length === 0))}
              onClick={runActive ? onCancel : () => void submit()}
              aria-label={sendLabel(surface, runActive)}
            >
              {runActive ? <span className="stop-glyph" /> : "↑"}
            </button>
          </div>
        </div>
      </div>
      {editing && (
        <ImageAnnotator
          source={editing.source}
          annotations={editing.annotations}
          prefix={markPrefix(attachments.indexOf(editing), attachments.length)}
          onCancel={() => setAnnotating(null)}
          onApply={(annotations, rendered) => {
            setAttachments((current) => current.map((item) => item.id === editing.id ? { ...item, annotations, preview: rendered } : item));
            setAnnotating(null);
          }}
        />
      )}
    </footer>
  );
}
