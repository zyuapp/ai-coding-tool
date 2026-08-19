import { Command, CornerDownRight, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { QueuedMessage } from "../../application/workspace-state";
import type { RunAttachment } from "../../domain/task";
import type { AvailableCommand } from "../../contracts/ipc";
import type { AgentEffort, AgentModel, ExecutionPolicy } from "../../domain/run";
import type { ContextUsage } from "../../domain/task";
import { ComposerSettings } from "./ComposerSettings";
import { ContextUsageMeter } from "./ContextUsageMeter";
import { ImageAnnotator, type Annotation } from "./ImageAnnotator";

const MAX_ATTACHMENTS = 6;

type Attachment = {
  id: string;
  source: string;
  preview: string;
  annotations: Annotation[];
};

function composerPlaceholder(surface: "main" | "side", folder: string, disabled: boolean) {
  if (surface === "side") return disabled ? "Main context required" : "Ask a side question";
  return folder ? "Ask Claude to work on anything" : "Ask Claude anything";
}

function sendLabel(surface: "main" | "side", runActive: boolean) {
  if (surface === "side") return runActive ? "Stop side chat" : "Send side chat message";
  return runActive ? "Stop task" : "Send task";
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
  /** Where the composer sits. A side chat has no draft of its own to fork, so it offers no `/side`. */
  surface?: "main" | "side";
  /** Set while the thread cannot take a message at all, as a side chat cannot before its fork exists. */
  disabled?: boolean;
  mode: ExecutionPolicy;
  model: AgentModel;
  effort: AgentEffort;
  contextUsage?: ContextUsage;
  runActive: boolean;
  queuedMessages: QueuedMessage[];
  onPromptChange: (prompt: string) => void;
  onModeChange: (mode: ExecutionPolicy) => void;
  onModelChange: (model: AgentModel) => void;
  onEffortChange: (effort: AgentEffort) => void;
  onSend: (attachments: RunAttachment[], steer: boolean) => void;
  onSteerQueued: (messageId: string) => void;
  onDropQueued: (messageId: string) => void;
  onCancel: () => void;
};

export function TaskComposer({
  prompt,
  folder,
  workspaceId,
  surface = "main",
  disabled = false,
  mode,
  model,
  effort,
  contextUsage,
  runActive,
  queuedMessages,
  onPromptChange,
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
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
  const [commandsLoading, setCommandsLoading] = useState(true);
  const [commandsToken, setCommandsToken] = useState(0);
  const [selectedCommand, setSelectedCommand] = useState(0);
  const [inputFocused, setInputFocused] = useState(false);
  const [dismissedPrompt, setDismissedPrompt] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [annotating, setAnnotating] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const editing = attachments.find((attachment) => attachment.id === annotating);
  const slashQuery = prompt.match(/^\/([^\s]*)$/)?.[1].toLowerCase();
  const appCommand = { name: "side", description: "Open a focused side chat.", argumentHint: "", aliases: [] as string[], kind: "app" as const };
  const matchingCommands = slashQuery === undefined ? [] : [
    ...(surface === "main" ? [appCommand] : []),
    ...commands.filter((command) => command.name !== "side").map((command) => ({ ...command, kind: "skill" as const })),
  ].filter((command) => command.name.toLowerCase().startsWith(slashQuery) || command.aliases?.some((alias) => alias.toLowerCase().startsWith(slashQuery)));
  const commandMenuOpen = inputFocused && slashQuery !== undefined && dismissedPrompt !== prompt;

  function shortDescription(description: string) {
    const firstSentence = description.split(/(?<=[.!?])\s/, 1)[0].replace(/\s+\([^)]*\)$/, "");
    return firstSentence.length > 110 ? `${firstSentence.slice(0, 107).trimEnd()}…` : firstSentence;
  }

  function chooseCommand(command: (typeof matchingCommands)[number]) {
    const nextPrompt = `/${command.name}${command.argumentHint ? " " : ""}`;
    onPromptChange(nextPrompt);
    setDismissedPrompt(nextPrompt);
    setInputFocused(true);
    textareaRef.current?.focus();
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
    if (sending || disabled || (steer && !runActive)) return;
    if (!prompt.trim() && attachments.length === 0) return;
    if (attachments.length === 0) {
      onSend([], steer);
      return;
    }
    setSending(true);
    try {
      const saved = await Promise.all(attachments.map(async (attachment) => ({
        path: await window.desktop.saveAttachment(attachment.preview.replace(/^data:[^,]*,/, "")),
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

  useEffect(() => {
    if (!commandMenuOpen) return;
    commandMenuRef.current?.querySelector(`#slash-command-${selectedCommand}`)?.scrollIntoView?.({ block: "nearest" });
  }, [commandMenuOpen, selectedCommand]);

  return (
    <footer className={`composer-wrap ${surface}`}>
      {queuedMessages.length > 0 && (
        <div className="queued-row" role="list" aria-label={surface === "side" ? "Queued side chat messages" : "Queued messages"}>
          {queuedMessages.map((message) => (
            <div className="queued-message" role="listitem" key={message.id}>
              <CornerDownRight className="queued-mark" size={14} aria-hidden="true" />
              <p className="queued-text">{message.text}</p>
              {message.steering ? <span className="queued-state">Steering…</span> : (
                <span className="queued-actions">
                  <button type="button" className="queued-steer" onClick={() => onSteerQueued(message.id)}>Steer</button>
                  <button type="button" className="queued-drop" aria-label="Remove queued message" onClick={() => onDropQueued(message.id)}>
                    <X size={13} />
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
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
                  <span className="command-source">{command.kind === "app" ? "Claudex" : "Skill"}</span>
                </button>
              ))}
              {matchingCommands.length === 0 && <p className="command-empty">No matching commands</p>}
            </div>
            {commandsLoading && <div className="command-menu-status">Loading installed skills…</div>}
          </div>
        )}
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
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
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
            if (images.length === 0) return;
            event.preventDefault();
            void attachPasted(images);
          }}
          onInput={(event) => {
            onPromptChange(event.currentTarget.value);
            setDismissedPrompt(null);
          }}
          onFocus={() => setInputFocused(true)}
          onBlur={(event) => {
            if (!commandMenuRef.current?.contains(event.relatedTarget as Node)) setInputFocused(false);
          }}
          onKeyDown={(event) => {
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
          aria-controls={commandMenuOpen ? "slash-command-menu" : undefined}
          aria-expanded={commandMenuOpen}
          aria-activedescendant={commandMenuOpen && matchingCommands[selectedCommand] ? `slash-command-${selectedCommand}` : undefined}
          rows={2}
        />
        <div className="composer-bar">
          <ComposerSettings mode={mode} model={model} effort={effort} onModeChange={onModeChange} onModelChange={onModelChange} onEffortChange={onEffortChange} />
          <div className="composer-actions">
            {contextUsage && <ContextUsageMeter usage={contextUsage} />}
            <button
              className={`send-button ${runActive ? "running" : ""}`}
              disabled={!runActive && (disabled || sending || (!prompt.trim() && attachments.length === 0))}
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
