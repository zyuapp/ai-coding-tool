import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, ApprovalRequest, ChatMessage, PermissionMode, Task } from "../shared";

const STORAGE_KEY = "threadline.tasks.v1";
const LAST_FOLDER_KEY = "threadline.last-folder.v1";
const PROJECTS_KEY = "threadline.projects.v1";

function loadTasks(): Task[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((task): task is Task => Boolean(task && typeof task === "object" && "id" in task)) : [];
  } catch {
    return [];
  }
}

function loadProjects(tasks: Task[]): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? "[]") as unknown;
    const folders = Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
    return [...new Set([...folders, ...tasks.map((task) => task.folder).filter(Boolean)])];
  } catch {
    return [...new Set(tasks.map((task) => task.folder).filter(Boolean))];
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

function ComposeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13.5 5.5H6.8A2.8 2.8 0 0 0 4 8.3v8.9A2.8 2.8 0 0 0 6.8 20h8.9a2.8 2.8 0 0 0 2.8-2.8v-6.7M11 13l1.1-3.2L18.9 3a1.5 1.5 0 0 1 2.1 2.1l-6.8 6.8L11 13Z" />
    </svg>
  );
}

export function App() {
  const [tasks, setTasks] = useState<Task[]>(loadTasks);
  const [projects, setProjects] = useState<string[]>(() => loadProjects(loadTasks()));
  const [currentId, setCurrentId] = useState<string | null>(tasks[0]?.id ?? null);
  const [draftFolder, setDraftFolder] = useState(() => tasks[0]?.folder ?? localStorage.getItem(LAST_FOLDER_KEY) ?? "");
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set(tasks[0]?.folder ? [tasks[0].folder] : []));
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [chatSort, setChatSort] = useState<"priority" | "updated" | "manual">("manual");
  const [draftMode, setDraftMode] = useState<PermissionMode>("default");
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "stopped">("idle");
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const currentIdRef = useRef(currentId);
  const currentFolderRef = useRef(draftFolder);
  const runningTaskIdRef = useRef<string | null>(null);
  const runningFolderRef = useRef("");

  const currentTask = useMemo(() => tasks.find((task) => task.id === currentId), [tasks, currentId]);
  const folder = currentTask?.folder ?? draftFolder;
  const mode = currentTask?.mode ?? draftMode;

  useEffect(() => {
    currentIdRef.current = currentId;
    currentFolderRef.current = folder;
  }, [currentId, folder]);

  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)), [tasks]);
  useEffect(() => localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects)), [projects]);
  useEffect(() => {
    if (draftFolder) localStorage.setItem(LAST_FOLDER_KEY, draftFolder);
  }, [draftFolder]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [currentTask?.messages.length, status, approval]);

  useEffect(() => {
    if (!("desktop" in window)) return;
    return window.desktop.onAgentEvent((event) => handleAgentEvent(event));
  }, []);

  useEffect(() => {
    function dismissMenu(event: PointerEvent) {
      if (!(event.target instanceof Element) || !event.target.closest("[data-popover-menu]")) setOpenMenu(null);
    }
    function dismissMenuWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenu(null);
    }
    document.addEventListener("pointerdown", dismissMenu);
    document.addEventListener("keydown", dismissMenuWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismissMenu);
      document.removeEventListener("keydown", dismissMenuWithKeyboard);
    };
  }, []);

  function updateCurrent(mutator: (task: Task) => Task) {
    const id = runningTaskIdRef.current ?? currentIdRef.current;
    if (!id) return;
    setTasks((existing) => existing.map((task) => (task.id === id ? mutator(task) : task)));
  }

  async function refreshChanges() {
    const activeFolder = runningFolderRef.current || currentFolderRef.current;
    if (!activeFolder) return;
    const changedFiles = await window.desktop.changedFiles(activeFolder);
    updateCurrent((task) => ({ ...task, changedFiles, updatedAt: Date.now() }));
  }

  function handleAgentEvent(event: AgentEvent) {
    if (event.type === "status") {
      setStatus(event.status);
      if (event.status !== "running") {
        runningTaskIdRef.current = null;
        runningFolderRef.current = "";
        setRunningTaskId(null);
      }
    }
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
    setProjects((existing) => existing.includes(selected) ? existing : [selected, ...existing]);
    setDraftFolder(selected);
    setCurrentId(null);
    setExpandedProjects((existing) => new Set(existing).add(selected));
  }

  function newTask(project = "") {
    setCurrentId(null);
    setDraftFolder(project);
    setApproval(null);
    setPrompt("");
    if (project) setExpandedProjects((existing) => new Set(existing).add(project));
  }

  function toggleProject(project: string) {
    setExpandedProjects((existing) => {
      const next = new Set(existing);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
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
    runningTaskIdRef.current = task.id;
    runningFolderRef.current = activeFolder;
    setRunningTaskId(task.id);
    setStatus("running");
    window.desktop.send({
      type: "start",
      requestId: crypto.randomUUID(),
      prompt: text,
      cwd: activeFolder,
      projectless: !activeFolder,
      mode: task.mode,
      sessionId: task.sessionId,
    });
  }

  function decideApproval(allow: boolean) {
    if (!approval) return;
    window.desktop.send({ type: "approval", approvalId: approval.approvalId, allow });
    setApproval(null);
  }

  const orderedTasks = chatSort === "updated" ? [...tasks].sort((a, b) => b.updatedAt - a.updatedAt) : [...tasks];
  const recentTasks = orderedTasks.filter((task) => !task.folder);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="traffic-space" aria-hidden="true" />
        <div className="brand-row">
          <strong>Threadline</strong>
          <span className="brand-chevron" aria-hidden="true">⌄</span>
        </div>

        <button className="new-task-button" onClick={() => newTask()}>
          <span className="new-task-icon" aria-hidden="true">＋</span>
          <span>New task</span>
        </button>

        <div className="sidebar-scroll">
          <div className="section-heading projects-heading">
            <button className="section-toggle" onClick={() => setProjectsOpen((open) => !open)} aria-expanded={projectsOpen}>
              <span>Projects</span><span className="section-chevron" aria-hidden="true" />
            </button>
            <div
              className={`section-menu ${openMenu === "projects" ? "open" : ""}`}
              data-popover-menu
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setOpenMenu(null);
              }}
            >
              <button className="menu-trigger" aria-label="Project options" aria-expanded={openMenu === "projects"} onClick={() => setOpenMenu((menu) => menu === "projects" ? null : "projects")}>•••</button>
              {openMenu === "projects" && <div className="project-menu-popover section-menu-popover" role="menu">
                <div className="menu-label">Organize sidebar</div>
                <button className="menu-choice selected" role="menuitemradio" aria-checked="true"><span>✓</span>By project</button>
                <button className="menu-choice" role="menuitemradio" aria-checked="false"><span />In one list</button>
                <div className="menu-label menu-label-spaced">Sort chats by</div>
                {(["priority", "updated", "manual"] as const).map((sort) => (
                  <button
                    className={`menu-choice ${chatSort === sort ? "selected" : ""}`}
                    role="menuitemradio"
                    aria-checked={chatSort === sort}
                    key={sort}
                    onClick={() => {
                      setChatSort(sort);
                      setOpenMenu(null);
                    }}
                  ><span>{chatSort === sort ? "✓" : ""}</span>{sort === "updated" ? "Last updated" : `${sort[0].toUpperCase()}${sort.slice(1)}${sort === "manual" ? " order" : ""}`}</button>
                ))}
              </div>
              }
            </div>
            <button className="section-action add-project" onClick={openFolder} aria-label="Add project">＋</button>
          </div>
          {projectsOpen && <nav className="project-list" aria-label="Projects">
            {projects.map((project) => {
              const projectTasks = orderedTasks.filter((task) => task.folder === project);
              const expanded = expandedProjects.has(project);
              return (
                <section className="project-group" key={project}>
                  <div className={`project-row ${draftFolder === project ? "current" : ""}`}>
                    <button className="project-main" onClick={() => toggleProject(project)} title={project} aria-expanded={expanded}>
                      <span className="folder-icon"><FolderIcon /></span>
                      <span>{shortFolder(project)}</span>
                    </button>
                    <div
                      className={`project-menu ${openMenu === `project:${project}` ? "open" : ""}`}
                      data-popover-menu
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget)) setOpenMenu(null);
                      }}
                    >
                      <button className="menu-trigger" aria-label={`More options for ${shortFolder(project)}`} aria-expanded={openMenu === `project:${project}`} onClick={() => setOpenMenu((menu) => menu === `project:${project}` ? null : `project:${project}`)}>•••</button>
                      {openMenu === `project:${project}` && <div className="project-menu-popover" role="menu">
                        <button role="menuitem" onClick={() => {
                          newTask(project);
                          setOpenMenu(null);
                        }}>New task</button>
                        <button role="menuitem" onClick={() => {
                          toggleProject(project);
                          setOpenMenu(null);
                        }}>{expanded ? "Collapse" : "Expand"}</button>
                      </div>
                      }
                    </div>
                    <button className="project-new" onClick={() => newTask(project)} aria-label={`New task in ${shortFolder(project)}`}><ComposeIcon /></button>
                  </div>
                  {expanded && projectTasks.length > 0 && (
                    <div className="project-tasks">
                      {projectTasks.map((task) => (
                        <button
                          key={task.id}
                          className={`project-task-row ${task.id === currentId ? "active" : ""}`}
                          onClick={() => {
                            setCurrentId(task.id);
                            setDraftFolder(task.folder);
                            setApproval(null);
                          }}
                          title={task.title}
                        >
                          <span>{task.title}</span>
                          {status === "running" && task.id === runningTaskId && <span className="task-spinner" aria-label="Working" />}
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </nav>}

          <div className="section-heading recents-heading">
            <button className="section-toggle" onClick={() => setRecentsOpen((open) => !open)} aria-expanded={recentsOpen}>
              <span>Recents</span><span className="section-chevron" aria-hidden="true" />
            </button>
            <div
              className={`section-menu ${openMenu === "recents" ? "open" : ""}`}
              data-popover-menu
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setOpenMenu(null);
              }}
            >
              <button className="menu-trigger" aria-label="Recent chat options" aria-expanded={openMenu === "recents"} onClick={() => setOpenMenu((menu) => menu === "recents" ? null : "recents")}>•••</button>
              {openMenu === "recents" && <div className="project-menu-popover section-menu-popover" role="menu">
                <button role="menuitem" onClick={() => {
                  newTask();
                  setOpenMenu(null);
                }}>New chat</button>
              </div>
              }
            </div>
            <button className="section-action recent-new" onClick={() => newTask()} aria-label="New chat"><ComposeIcon /></button>
          </div>
          {recentsOpen && <nav className="task-list" aria-label="Project-less tasks">
          {recentTasks.length === 0 ? (
            <p className="sidebar-empty">No chats</p>
          ) : (
            recentTasks.map((task) => (
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
                <small>{formatTime(task.updatedAt)}</small>
              </button>
            ))
          )}
          </nav>}
        </div>
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
                <p>{folder ? "Tell Claude what you want to change, investigate, or build in this project." : "Ask a question or start a self-contained task."}</p>
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
              placeholder={folder ? "Ask Claude to work on anything" : "Ask Claude anything"}
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
