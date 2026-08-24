import { GitFork, X } from "lucide-react";
import { useRef } from "react";
import type { SideChatView } from "../../application/workspace-state";
import type { ReadingPoint } from "../../contracts/commands";
import { sentPrompts, type Annotation, type AnnotationAnchor, type AttachedFile, type PastedText, type RunAttachment, type Project, type Task } from "../../domain/task";
import { DEFAULT_EFFORT, DEFAULT_MODEL, type AgentEffort, type AgentModel, type ExecutionPolicy } from "../../domain/run";
import type { ThreadHandleOption } from "../../domain/thread-handles";
import { ApprovalCard } from "./ApprovalCard";
import { ConversationTimeline } from "./ConversationTimeline";
import { TaskComposer } from "./TaskComposer";
import { useFileDrop } from "../file-drop";

export function SideChat({ chat, focusToken = 0, source, project, threads, onPrompt, onAnnotateAdd, onAnnotateNote, onAnnotateRecall, onAnnotateRemove, onPasteAdd, onPasteRecall, onPasteRemove, onFilesAdd, onFileRecall, onFileRemove, onImageRecall, onImageRemove, readingPoint, onReadingPointMove, onSend, onCancel, onDecide, onPolicyChange, onModelChange, onEffortChange, onSteerQueued, onDropQueued, onClose }: {
  chat: SideChatView;
  /** Bumped whenever something asks this chat to take the caret. */
  focusToken?: number;
  source: Task;
  project?: Project;
  /** Threads this chat's `@` menu offers. */
  threads?: ThreadHandleOption[];
  onPrompt: (prompt: string) => void;
  onAnnotateAdd: (draft: { quote: string; note: string; anchor: AnnotationAnchor }) => void;
  onAnnotateNote: (annotationId: string, note: string) => void;
  onAnnotateRecall: (annotations: Annotation[]) => void;
  onAnnotateRemove: (annotationId: string) => void;
  onPasteAdd: (text: string) => void;
  onPasteRecall: (pastes: PastedText[]) => void;
  onPasteRemove: (pasteId: string) => void;
  onFilesAdd: (files: File[]) => void;
  onFileRecall: (files: AttachedFile[]) => void;
  onFileRemove: (fileId: string) => void;
  onImageRecall: (paths: string[]) => void;
  onImageRemove: (imageId: string) => void;
  /** Where this chat's transcript was left, and where its reader has moved to since. */
  readingPoint?: ReadingPoint;
  onReadingPointMove?: (point: ReadingPoint) => void;
  onSend: (attachments: RunAttachment[], steer: boolean) => void;
  onCancel: () => void;
  onDecide: (allow: boolean) => void;
  onPolicyChange: (policy: ExecutionPolicy) => void;
  onModelChange: (model: AgentModel) => void;
  onEffortChange: (effort: AgentEffort) => void;
  onSteerQueued: (messageId: string) => void;
  onDropQueued: (messageId: string) => void;
  onClose: () => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const available = Boolean(source.continuation || chat.task.continuation);
  const drop = useFileDrop(onFilesAdd);

  return (
    <aside className={`side-chat ${drop.over ? "dropping" : ""}`} aria-label="Side chat" {...drop.props}>
      <header className="side-chat-header">
        <div className="side-chat-title">
          <span className="side-chat-fork"><GitFork size={17} /></span>
          <div><h2>{chat.title}</h2><p>Temporary · forked from {source.title}</p></div>
        </div>
        <button type="button" aria-label="Close side chat" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="side-chat-transcript" ref={transcriptRef}>
        <ConversationTimeline
          currentTask={chat.task}
          folder={project?.root ?? ""}
          status={chat.status}
          compacting={chat.compacting}
          streamingTail={chat.streamingTail}
          scrollContainerRef={transcriptRef}
          readingPoint={readingPoint}
          onReadingPointMove={onReadingPointMove}
          annotations={chat.annotations}
          onAnnotateAdd={onAnnotateAdd}
          onAnnotateNote={onAnnotateNote}
          onAnnotateRemove={onAnnotateRemove}
          empty={{
            icon: GitFork,
            title: available ? "Work from a copy of this thread" : "Main context unavailable",
            description: available ? "This conversation starts from the main thread's context, then continues on its own branch. It is never saved." : "Send a message in the main thread first, then open /side again.",
          }}
        />
        {chat.approval && <ApprovalCard approval={chat.approval} onDecide={onDecide} />}
      </div>
      {chat.error && <p className="side-chat-error" role="alert">{chat.error}</p>}
      <TaskComposer
        focusToken={focusToken}
        prompt={chat.prompt}
        folder={project?.root ?? ""}
        {...(project?.workspaceId ? { workspaceId: project.workspaceId } : {})}
        mode={chat.task.executionPolicy}
        model={chat.task.model ?? DEFAULT_MODEL}
        effort={chat.task.effort ?? DEFAULT_EFFORT}
        {...(chat.task.contextUsage ? { contextUsage: chat.task.contextUsage } : {})}
        runActive={chat.running}
        queuedMessages={chat.queuedMessages}
        annotations={chat.annotations}
        pastes={chat.pastes}
        files={chat.files}
        threads={threads ?? []}
        images={chat.images}
        history={sentPrompts(chat.task.messages)}
        surface="side"
        disabled={!available}
        onPromptChange={onPrompt}
        onAnnotationRecall={onAnnotateRecall}
        onAnnotationRemove={onAnnotateRemove}
        onPasteAdd={onPasteAdd}
        onPasteRecall={onPasteRecall}
        onPasteRemove={onPasteRemove}
        onFilesAdd={onFilesAdd}
        onFileRecall={onFileRecall}
        onFileRemove={onFileRemove}
        onImageRecall={onImageRecall}
        onImageRemove={onImageRemove}
        onModeChange={onPolicyChange}
        onModelChange={onModelChange}
        onEffortChange={onEffortChange}
        onSend={onSend}
        onSteerQueued={onSteerQueued}
        onDropQueued={onDropQueued}
        onCancel={onCancel}
      />
      {drop.over && <p className="drop-hint" role="status">Drop to attach</p>}
      <p className="side-chat-note">Nothing here is saved · closes without a trace</p>
    </aside>
  );
}
