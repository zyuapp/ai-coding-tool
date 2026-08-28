import { Command, MessagesSquare, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AvailableCommand } from "../../contracts/ipc";
import type { AgentEngine } from "../../domain/agent-engine";
import { handleTokenAt, rankThreadHandles, type ThreadHandleOption } from "../../domain/thread-handles";
import { useDismissibleLayer } from "../focus";
import type { ComposerCaret } from "./composer-caret";

/** An entry in the `/` menu that the app performs itself instead of sending. */
export type ComposerAction = { name: string; description: string; run: () => void };

export type MenuEntry = {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
  kind: "app" | "skill";
  run?: () => void;
};

/** How many threads the `@` menu shows at once; the query is what reaches past them. */
const THREAD_MENU_LIMIT = 8;

/**
 * The `/word` the caret sits in. A `/` only starts one after whitespace, which is what keeps paths
 * and URLs from opening the menu.
 */
function commandTokenAt(text: string, caret: number) {
  const query = text.slice(0, caret).match(/(?:^|\s)\/([^\s/]*)$/)?.[1];
  return query === undefined ? null : { query: query.toLowerCase(), start: caret - query.length - 1 };
}

function commandMatches(entry: MenuEntry, query: string) {
  return entry.name.toLowerCase().startsWith(query) || entry.aliases.some((alias) => alias.toLowerCase().startsWith(query));
}

function shortDescription(description: string) {
  const firstSentence = description.split(/(?<=[.!?])\s/, 1)[0].replace(/\s+\([^)]*\)$/, "");
  return firstSentence.length > 110 ? `${firstSentence.slice(0, 107).trimEnd()}…` : firstSentence;
}

export type ComposerMenus = {
  commandMenuRef: RefObject<HTMLDivElement | null>;
  threadMenuRef: RefObject<HTMLDivElement | null>;
  commandMenuOpen: boolean;
  threadMenuOpen: boolean;
  commandsLoading: boolean;
  matchingCommands: MenuEntry[];
  matchingThreads: ThreadHandleOption[];
  selectedCommand: number;
  selectedThread: number;
  setSelectedCommand: Dispatch<SetStateAction<number>>;
  setSelectedThread: Dispatch<SetStateAction<number>>;
  chooseCommand: (entry: MenuEntry) => void;
  chooseThread: (option: ThreadHandleOption) => void;
  /** Closes whichever menu is open until the prompt changes again. */
  dismiss: () => void;
};

/** The `/` and `@` menus the prompt opens: what they hold, what is selected, and what choosing does. */
export function useComposerMenus({ prompt, caret, actions, threads, workspaceId, engine, onPromptChange }: {
  prompt: string;
  caret: ComposerCaret;
  actions: ComposerAction[];
  threads: ThreadHandleOption[];
  workspaceId: string | undefined;
  engine: AgentEngine;
  onPromptChange: (prompt: string) => void;
}): ComposerMenus {
  const { textareaRef, inputFocused, setInputFocused, dismissedPrompt, setDismissedPrompt, setCaret, moveCaret } = caret;
  const commandMenuRef = useRef<HTMLDivElement>(null);
  const threadMenuRef = useRef<HTMLDivElement>(null);
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
  const [commandsLoading, setCommandsLoading] = useState(true);
  const [commandsToken, setCommandsToken] = useState(0);
  const [selectedCommand, setSelectedCommand] = useState(0);
  const [selectedThread, setSelectedThread] = useState(0);
  const dismiss = () => setDismissedPrompt(prompt);

  const token = commandTokenAt(prompt, Math.min(caret.caret, prompt.length));
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
  useDismissibleLayer(commandMenuOpen, [textareaRef, commandMenuRef], dismiss, textareaRef);

  const threadToken = handleTokenAt(prompt, Math.min(caret.caret, prompt.length));
  const matchingThreads = threadToken === null ? [] : rankThreadHandles(threads, threadToken.query, THREAD_MENU_LIMIT);
  const threadMenuOpen = inputFocused && threadToken !== null && matchingThreads.length > 0 && dismissedPrompt !== prompt;
  useDismissibleLayer(threadMenuOpen, [textareaRef, threadMenuRef], dismiss, textareaRef);

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
    moveCaret(token.start + inserted.length);
  }

  function chooseThread(option: ThreadHandleOption) {
    if (!threadToken) return;
    const inserted = `@${option.handle} `;
    const nextPrompt = prompt.slice(0, threadToken.start) + inserted + prompt.slice(threadToken.start + 1 + threadToken.query.length);
    onPromptChange(nextPrompt);
    setDismissedPrompt(nextPrompt);
    setInputFocused(true);
    moveCaret(threadToken.start + inserted.length);
  }

  useEffect(() => {
    let cancelled = false;
    setCommandsLoading(true);
    void (async () => {
      try {
        const id = workspaceId ?? (await window.desktop.projectlessWorkspace()).id;
        const result = await window.desktop.commands(id, engine);
        if (!cancelled) setCommands(result.status === "available" ? result.commands : []);
      } catch {
        if (!cancelled) setCommands([]);
      } finally {
        if (!cancelled) setCommandsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, engine, commandsToken]);

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

  useEffect(() => {
    setSelectedThread(0);
  }, [threadToken?.query]);

  useEffect(() => {
    if (!threadMenuOpen) return;
    threadMenuRef.current?.querySelector(`#thread-mention-${selectedThread}`)?.scrollIntoView?.({ block: "nearest" });
  }, [threadMenuOpen, selectedThread]);

  return {
    commandMenuRef, threadMenuRef, commandMenuOpen, threadMenuOpen, commandsLoading,
    matchingCommands, matchingThreads, selectedCommand, selectedThread,
    setSelectedCommand, setSelectedThread, chooseCommand, chooseThread, dismiss,
  };
}

/** The list the prompt's own controls point at, which is whichever menu is open. */
export function menuControls(menus: ComposerMenus) {
  if (menus.commandMenuOpen) return "slash-command-menu";
  return menus.threadMenuOpen ? "thread-mention-menu" : undefined;
}

export function menuActiveDescendant(menus: ComposerMenus) {
  if (menus.commandMenuOpen && menus.matchingCommands[menus.selectedCommand]) return `slash-command-${menus.selectedCommand}`;
  if (menus.threadMenuOpen && menus.matchingThreads[menus.selectedThread]) return `thread-mention-${menus.selectedThread}`;
  return undefined;
}

export function CommandMenu({ menus }: { menus: ComposerMenus }) {
  const { matchingCommands, selectedCommand } = menus;

  return (
    <div className="command-menu" ref={menus.commandMenuRef} id="slash-command-menu" role="listbox" aria-label="Slash commands">
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
            onMouseEnter={() => menus.setSelectedCommand(index)}
            onClick={() => menus.chooseCommand(command)}
          >
            <span className={`command-mark ${command.kind}`} aria-hidden="true">{command.kind === "app" ? <Command size={16} /> : <Sparkles size={15} />}</span>
            <span className="command-copy"><strong>/{command.name}{command.argumentHint && <em> {command.argumentHint}</em>}</strong><small>{shortDescription(command.description)}</small></span>
            <span className="command-source">{command.kind === "app" ? "AI Coding Tool" : "Skill"}</span>
          </button>
        ))}
        {matchingCommands.length === 0 && <p className="command-empty">No matching commands</p>}
      </div>
      {menus.commandsLoading && <div className="command-menu-status">Loading installed skills…</div>}
    </div>
  );
}

export function ThreadMenu({ menus }: { menus: ComposerMenus }) {
  const { matchingThreads, selectedThread } = menus;
  /** Where the list stops belonging to this project, so the divider sits above that row. */
  const firstElsewhere = matchingThreads.findIndex((option) => !option.inScope);

  return (
    <div className="command-menu thread-menu" ref={menus.threadMenuRef} id="thread-mention-menu" role="listbox" aria-label="Threads">
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
            onMouseEnter={() => menus.setSelectedThread(index)}
            onClick={() => menus.chooseThread(option)}
          >
            <span className={`command-mark thread ${option.running ? "running" : ""}`} aria-hidden="true"><MessagesSquare size={15} /></span>
            <span className="command-copy"><strong>{option.title}</strong><small>@{option.handle}</small></span>
            <span className="command-source">{option.inScope ? (option.running ? "Running" : "") : option.project ?? "No project"}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
