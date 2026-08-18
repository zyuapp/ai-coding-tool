import { GitFork, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { applyRunEvent, createTaskMessage, type RunTransitionState } from "../../application/task-workspace";
import type { RunEvent } from "../../contracts/ipc";
import { DEFAULT_MODEL } from "../../domain/run";
import type { Project, Task } from "../../domain/task";
import type { WorkspaceRecord } from "../../domain/workspace";
import { ConversationTimeline } from "./ConversationTimeline";

type SideState = RunTransitionState & {
  prompt: string;
  error: string | null;
};

function initialState(source: Task): SideState {
  const task: Task = {
    id: `side-${crypto.randomUUID()}`,
    title: "Side chat",
    executionPolicy: "plan",
    model: source.model,
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: Date.now() },
    updatedAt: Date.now(),
  };
  return { tasks: [task], activeRuns: {}, runStatuses: {}, approvals: {}, prompt: "", error: null };
}

export function SideChat({ source, project, title = "Side chat", onClose }: { source: Task; project?: Project; title?: string; onClose: () => void }) {
  const [state, setState] = useState(() => initialState(source));
  const stateRef = useRef(state);
  const submitting = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const task = state.tasks[0];
  const available = Boolean(source.continuation);

  function update(next: SideState | ((current: SideState) => SideState)) {
    const resolved = typeof next === "function" ? next(stateRef.current) : next;
    stateRef.current = resolved;
    setState(resolved);
  }

  useEffect(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onAgentEvent((event: RunEvent) => {
      update((current) => applyRunEvent(current, event));
    });
  }, []);

  useEffect(() => () => {
    for (const active of Object.values(stateRef.current.activeRuns)) window.desktop.send({ type: "cancel", taskId: active.taskId, runId: active.runId });
  }, []);

  async function workspace(): Promise<WorkspaceRecord | null> {
    if (!project) return window.desktop.projectlessWorkspace();
    if (project.workspaceId) return { id: project.workspaceId, kind: "project", root: project.root };
    const selected = await window.desktop.openFolder();
    if (!selected) return null;
    if (selected.root !== project.root) throw new Error("Choose the same project folder used by the main task.");
    return selected;
  }

  async function send() {
    const current = stateRef.current;
    const text = current.prompt.trim();
    if (!text || current.activeRuns[current.tasks[0].id] || submitting.current || !source.continuation) return;
    submitting.current = true;
    try {
      const selected = await workspace();
      if (!selected) return;
      const currentTask = stateRef.current.tasks[0];
      const runId = crypto.randomUUID();
      const firstTurn = !currentTask.continuation;
      update((value) => ({
        ...value,
        tasks: [{ ...value.tasks[0], messages: [...value.tasks[0].messages, createTaskMessage("user", text)], updatedAt: Date.now() }],
        prompt: "",
        error: null,
        activeRuns: { [currentTask.id]: { taskId: currentTask.id, runId, sequence: 0, status: "running" } },
        runStatuses: { [currentTask.id]: "running" },
      }));
      window.desktop.send({
        type: "start",
        channel: "side",
        taskId: currentTask.id,
        runId,
        prompt: text,
        workspaceId: selected.id,
        policy: "plan",
        model: source.model ?? DEFAULT_MODEL,
        continuation: firstTurn ? source.continuation : currentTask.continuation,
        ...(firstTurn ? { forkContinuation: true } : {}),
      });
    } catch (error) {
      update((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      submitting.current = false;
    }
  }

  const activeRun = state.activeRuns[task.id];
  const status = activeRun ? "running" : state.runStatuses[task.id] ?? "idle";
  return (
    <aside className="side-chat" aria-label="Side chat">
      <header className="side-chat-header">
        <div className="side-chat-title">
          <span className="side-chat-fork"><GitFork size={17} /></span>
          <div><h2>{title}</h2><p>Temporary · forked from {source.title}</p></div>
        </div>
        <button type="button" aria-label="Close side chat" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="side-chat-transcript" ref={transcriptRef}>
        <ConversationTimeline
          currentTask={task}
          folder={project?.root ?? ""}
          status={status}
          compacting={activeRun?.status === "compacting"}
          scrollContainerRef={transcriptRef}
          empty={{
            icon: GitFork,
            title: available ? "Ask without changing the thread" : "Main context unavailable",
            description: available ? "This conversation starts from the main thread, then continues on its own branch." : "Send a message in the main thread first, then open /side again.",
          }}
        />
      </div>
      {state.error && <p className="side-chat-error" role="alert">{state.error}</p>}
      <footer className="side-chat-composer">
        <div>
          <textarea
            rows={2}
            aria-label="Side chat prompt"
            placeholder={available ? "Ask a side question" : "Main context required"}
            value={state.prompt}
            disabled={!available}
            onInput={(event) => update((current) => ({ ...current, prompt: event.currentTarget.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="button"
            className={`send-button ${activeRun ? "running" : ""}`}
            disabled={!activeRun && (!available || !state.prompt.trim())}
            aria-label={activeRun ? "Stop side chat" : "Send side chat message"}
            onClick={() => {
              if (activeRun) window.desktop.send({ type: "cancel", taskId: activeRun.taskId, runId: activeRun.runId });
              else void send();
            }}
          >{activeRun ? <span className="stop-glyph" /> : "↑"}</button>
        </div>
        <p>Read-only · closes without saving</p>
      </footer>
    </aside>
  );
}
