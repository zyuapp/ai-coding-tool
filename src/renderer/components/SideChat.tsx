import { GitFork, X } from "lucide-react";
import { useRef } from "react";
import type { SideChatView } from "../../application/workspace-state";
import type { AnnotationAnchor, RunAttachment, Project, Task } from "../../domain/task";
import { DEFAULT_EFFORT, DEFAULT_MODEL, type AgentEffort, type AgentModel, type ExecutionPolicy } from "../../domain/run";
import { ApprovalCard } from "./ApprovalCard";
import { ConversationTimeline } from "./ConversationTimeline";
import { TaskComposer } from "./TaskComposer";

export function SideChat({ chat, source, project, onPrompt, onAnnotateAdd, onAnnotateNote, onAnnotateRemove, onPasteAdd, onPasteRemove, onSend, onCancel, onDecide, onPolicyChange, onModelChange, onEffortChange, onSteerQueued, onDropQueued, onClose }: {
  chat: SideChatView;
  source: Task;
  project?: Project;
  onPrompt: (prompt: string) => void;
  onAnnotateAdd: (draft: { quote: string; note: string; anchor: AnnotationAnchor }) => void;
  onAnnotateNote: (annotationId: string, note: string) => void;
  onAnnotateRemove: (annotationId: string) => void;
  onPasteAdd: (text: string) => void;
  onPasteRemove: (pasteId: string) => void;
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

  return (
    <aside className="side-chat" aria-label="Side chat">
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
        history={chat.task.messages.filter((message) => message.kind === "user").map((message) => message.text)}
        surface="side"
        disabled={!available}
        onPromptChange={onPrompt}
        onAnnotationRemove={onAnnotateRemove}
        onPasteAdd={onPasteAdd}
        onPasteRemove={onPasteRemove}
        onModeChange={onPolicyChange}
        onModelChange={onModelChange}
        onEffortChange={onEffortChange}
        onSend={onSend}
        onSteerQueued={onSteerQueued}
        onDropQueued={onDropQueued}
        onCancel={onCancel}
      />
      <p className="side-chat-note">Nothing here is saved · closes without a trace</p>
    </aside>
  );
}
