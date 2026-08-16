import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, ApprovalRequest, ChatMessage, PermissionMode, Task } from "../shared";

const STORAGE_KEY = "threadline.tasks.v1";
const LAST_FOLDER_KEY = "threadline.last-folder.v1";

function loadTasks(): Task[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Task[];
  } catch {
    return [];
  }
}

function shortFolder(folder: string) {
  return folder.split("/").filter(Boolean).at(-1) ?? folder;
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value);
}

function nextMessage(kind: ChatMessage["kind"], text: string, detail?: string): ChatMessage {
  return { id: crypto.randomUUID(), kind, text, detail, at: Date.now() };
}

function modeLabel(mode: PermissionMode) {
  return {
    default: "Manual",
    plan: "Plan",
    acceptEdits: "Accept edits",
    auto: "Auto",
  }[mode];
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 7.5h6l2-2h3.8c1.8 0 2.7 0 3.4.35.62.32 1.13.83 1.45 1.45.35.7.35 1.6.35 3.4v4.4c0 1.8 0 2.7-.35 3.4a3.25 3.25 0 0 1-1.45 1.45c-.7.35-1.6.35-3.4.35H7.5c-1.8 0-2.7 0-3.4-.35a3.25 3.25 0 0 1-1.45-1.45c-.35-.7-.35-1.6-.35-3.4V9.2c0-.95 0-1.42.18-1.78.16-.32.42-.58.74-.74.36-.18.83-.18 1.78-.18Z" />
    </svg>
  );
}

export function App() {
  const [tasks, setTasks] = useState<Task[]>(loadTasks);
  const [currentId, setCurrentId] = useState<string | null>(tasks[0]?.id ?? null);
  const [draftFolder, setDraftFolder] = useState(() => localStorage.getItem(LAST_FOLDER_KEY) ?? "");
  const [draftMode, setDraftMode] = useState<PermissionMode>("default");
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "stopped">("idle");
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const currentIdRef = useRef(currentId);
  const currentFolderRef = useRef(draftFolder);

  const currentTask = useMemo(() => tasks.find((task) => task.id === currentId), [tasks, currentId]);
  const folder = currentTask?.folder ?? draftFolder;
  const mode = currentTask?.mode ?? draftMode;

  useEffect(() => {
    currentIdRef.current = currentId;
    currentFolderRef.current = folder;
  }, [currentId, folder]);

  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)), [tasks]);
  useEffect(() => {
    if (draftFolder) localStorage.setItem(LAST_FOLDER_KEY, draftFolder);
  }, [draftFolder]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [currentTask?.messages.length, status, approval]);

  useEffect(() => {
    return window.desktop.onAgentEvent((event) => handleAgentEvent(event));
  }, []);

  function updateCurrent(mutator: (task: Task) => Task) {
    const id = currentIdRef.current;
    if (!id) return;
    setTasks((existing) => existing.map((task) => (task.id === id ? mutator(task) : task)));
  }

  async function refreshChanges() {
    const activeFolder = currentFolderRef.current;
    if (!activeFolder) return;
    const changedFiles = await window.desktop.changedFiles(activeFolder);
    updateCurrent((task) => ({ ...task, changedFiles, updatedAt: Date.now() }));
  }

  function handleAgentEvent(event: AgentEvent) {
    if (event.type === "status") setStatus(event.status);
    if (event.type === "session") {
      updateCurrent((task) => ({ ...task, sessionId: event.sessionId, updatedAt: Date.now() }));
    }
    if (event.type === "assistant") {
      updateCurrent((task) => {
        const messages = [...task.messages];
        const last = messages.at(-1);
        if (last?.kind === "assistant" && last.id === event.id) {
          messages[messages.length - 1] = { ...last, text: `${last.text}\n${event.text}` };
        } else {
          messages.push({ id: event.id, kind: "assistant", text: event.text, at: Date.now() });
        }
        return { ...task, messages, updatedAt: Date.now() };
      });
    }
    if (event.type === "tool") {
      updateCurrent((task) => ({
        ...task,
        messages: [
          ...task.messages,
          { id: event.id, kind: "tool", text: event.toolName, detail: JSON.stringify(event.input, null, 2), at: Date.now() },
        ],
        updatedAt: Date.now(),
      }));
    }
    if (event.type === "approval") setApproval(event.request);
    if (event.type === "error") {
      updateCurrent((task) => ({
        ...task,
        messages: [...task.messages, nextMessage("system", event.message)],
        updatedAt: Date.now(),
      }));
    }
    if (event.type === "result") {
      if (event.isError && event.text) {
        updateCurrent((task) => ({
          ...task,
          messages: [...task.messages, nextMessage("system", event.text)],
          updatedAt: Date.now(),
        }));
      }
      void refreshChanges();
    }
  }

  async function openFolder() {
    const selected = await window.desktop.openFolder();
    if (!selected) return;
    setDraftFolder(selected);
    setCurrentId(null);
  }

  function newTask() {
    setCurrentId(null);
    setApproval(null);
    setPrompt("");
  }

  function setMode(nextMode: PermissionMode) {
    if (currentTask) {
      setTasks((existing) =>
        existing.map((task) => (task.id === currentTask.id ? { ...task, mode: nextMode } : task)),
      );
    } else {
      setDraftMode(nextMode);
    }
  }

  async function sendPrompt() {
    const text = prompt.trim();
    if (!text || status === "running") return;
    let activeFolder = folder;
    if (!activeFolder) {
      activeFolder = (await window.desktop.openFolder()) ?? "";
      if (!activeFolder) return;
      setDraftFolder(activeFolder);
    }

    let task = currentTask;
    if (!task) {
      task = {
        id: crypto.randomUUID(),
        title: text.length > 52 ? `${text.slice(0, 49)}…` : text,
        folder: activeFolder,
        mode,
        messages: [],
        changedFiles: [],
        updatedAt: Date.now(),
      };
      currentIdRef.current = task.id;
      currentFolderRef.current = activeFolder;
      setCurrentId(task.id);
      setTasks((existing) => [task!, ...existing]);
    }

    const userMessage = nextMessage("user", text);
    setTasks((existing) =>
      existing.map((item) =>
        item.id === task!.id
          ? { ...item, messages: [...item.messages, userMessage], updatedAt: Date.now() }
          : item,
      ),
    );
    setPrompt("");
    window.desktop.send({
      type: "start",
      requestId: crypto.randomUUID(),
      prompt: text,
      cwd: activeFolder,
      mode: task.mode,
      sessionId: task.sessionId,
    });
  }

  function decideApproval(allow: boolean) {
    if (!approval) return;
    window.desktop.send({ type: "approval", approvalId: approval.approvalId, allow });
    setApproval(null);
  }

  const orderedTasks = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="traffic-space" aria-hidden="true" />
        <div className="brand-row">
          <strong>Threadline</strong>
          <span className="brand-chevron" aria-hidden="true">⌄</span>
        </div>

        <button className="new-task-button" onClick={newTask}>
          <span className="new-task-icon" aria-hidden="true">＋</span>
          <span>New task</span>
        </button>

        <div className="section-label">Project</div>
        <button className="folder-button" onClick={openFolder} title={folder || "Open a project folder"}>
          <span className="folder-icon"><FolderIcon /></span>
          <span>{folder ? shortFolder(folder) : "Open a folder"}</span>
          <span className="folder-chevron" aria-hidden="true">⌄</span>
        </button>

        <div className="section-label task-label">Recent</div>
        <nav className="task-list" aria-label="Tasks">
          {orderedTasks.length === 0 ? (
            <p className="sidebar-empty">Your tasks will stay here.</p>
          ) : (
            orderedTasks.map((task) => (
              <button
                key={task.id}
                className={`task-row ${task.id === currentId ? "active" : ""}`}
                onClick={() => {
                  setCurrentId(task.id);
                  setDraftFolder(task.folder);
                  setApproval(null);
                }}
              >
                <span>{task.title}</span>
                <small>{shortFolder(task.folder)} · {formatTime(task.updatedAt)}</small>
              </button>
            ))
          )}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="task-heading">
            <span className="heading-folder"><FolderIcon /></span>
            <div>
            <h1>{currentTask?.title ?? "New task"}</h1>
            <p title={folder}>{folder || "Choose a project folder to begin"}</p>
            </div>
          </div>
          <div className="topbar-actions">
            <div className={`run-state ${status}`}>
              <span /> {status === "running" ? "Working" : status === "stopped" ? "Stopped" : "Ready"}
            </div>
            {currentTask && (
              <details className="changes-menu">
                <summary>
                  Changes <span>{currentTask.changedFiles.length}</span>
                </summary>
                <div className="changes-popover">
                  <strong>Changed files</strong>
                  {currentTask.changedFiles.length ? (
                    <ul>
                      {currentTask.changedFiles.map((file) => (
                        <li key={file} title={file}>
                          <span className={`file-status status-${file.trim()[0]}`}>{file.slice(0, 2).trim()}</span>
                          <span>{file.slice(3)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>Working tree is clean.</p>
                  )}
                </div>
              </details>
            )}
          </div>
        </header>

        <div className="work-area">
          <div className="conversation" ref={transcriptRef}>
            {!currentTask?.messages.length ? (
              <div className="empty-state">
                <div className="empty-glyph"><FolderIcon /></div>
                <h2>Start a task</h2>
                <p>Tell Claude what you want to change, investigate, or build in this project.</p>
                {!folder && <button onClick={openFolder}>Open a project</button>}
              </div>
            ) : (
              <div className="timeline">
                {currentTask.messages.map((message) => (
                  <article className={`message ${message.kind}`} key={message.id}>
                    {message.kind === "tool" ? (
                      <details className="work-row">
                        <summary><span>Worked</span><span>{message.text}</span></summary>
                        <pre>{message.detail}</pre>
                      </details>
                    ) : (
                      <div className="message-text">{message.text}</div>
                    )}
                  </article>
                ))}
                {status === "running" && (
                  <div className="thinking-row">
                    <span /> <span /> <span />
                  </div>
                )}
              </div>
            )}

            {approval && (
              <section className="approval-card" aria-live="assertive">
                <div className="approval-icon">!</div>
                <div>
                  <strong>{approval.title}</strong>
                  <p>{approval.description}</p>
                  <details>
                    <summary>{approval.toolName}</summary>
                    <pre>{JSON.stringify(approval.input, null, 2)}</pre>
                  </details>
                  <div className="approval-actions">
                    <button className="secondary" onClick={() => decideApproval(false)}>Deny</button>
                    <button onClick={() => decideApproval(true)}>Allow once</button>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>

        <footer className="composer-wrap">
          <div className="composer">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendPrompt();
                }
              }}
              placeholder={folder ? "Ask Claude to work on anything" : "Open a folder, then describe a task"}
              aria-label="Task prompt"
              rows={2}
            />
            <div className="composer-bar">
              <select value={mode} onChange={(event) => setMode(event.target.value as PermissionMode)} aria-label="Permission mode">
                {(["default", "plan", "acceptEdits", "auto"] as PermissionMode[]).map((item) => (
                  <option value={item} key={item}>{modeLabel(item)}</option>
                ))}
              </select>
              <div className="composer-actions">
                {status === "running" && (
                  <button className="stop-button" onClick={() => window.desktop.send({ type: "cancel" })}>Stop</button>
                )}
                <button className="send-button" disabled={!prompt.trim() || status === "running"} onClick={() => void sendPrompt()} aria-label="Send task">
                  ↑
                </button>
              </div>
            </div>
          </div>
        </footer>
      </section>
    </main>
  );
}
