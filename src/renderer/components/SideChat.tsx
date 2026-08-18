import { GitFork, X } from "lucide-react";
import { useRef } from "react";
import type { SideChatView } from "../../application/workspace-state";
import type { Project, Task } from "../../domain/task";
import { ConversationTimeline } from "./ConversationTimeline";

export function SideChat({ chat, source, project, onPrompt, onSend, onCancel, onClose }: {
  chat: SideChatView;
  source: Task;
  project?: Project;
  onPrompt: (prompt: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const available = Boolean(source.continuation);

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
          empty={{
            icon: GitFork,
            title: available ? "Ask without changing the thread" : "Main context unavailable",
            description: available ? "This conversation starts from the main thread, then continues on its own branch." : "Send a message in the main thread first, then open /side again.",
          }}
        />
      </div>
      {chat.error && <p className="side-chat-error" role="alert">{chat.error}</p>}
      <footer className="side-chat-composer">
        <div>
          <textarea
            rows={2}
            aria-label="Side chat prompt"
            placeholder={available ? "Ask a side question" : "Main context required"}
            value={chat.prompt}
            disabled={!available}
            onInput={(event) => onPrompt(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
          />
          <button
            type="button"
            className={`send-button ${chat.running ? "running" : ""}`}
            disabled={!chat.running && (!available || !chat.prompt.trim())}
            aria-label={chat.running ? "Stop side chat" : "Send side chat message"}
            onClick={chat.running ? onCancel : onSend}
          >{chat.running ? <span className="stop-glyph" /> : "↑"}</button>
        </div>
        <p>Read-only · closes without saving</p>
      </footer>
    </aside>
  );
}
