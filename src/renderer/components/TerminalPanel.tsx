import { useEffect, useRef } from "react";
import { Plus, SquareTerminal, X } from "lucide-react";
import type { TerminalSession } from "../../domain/terminal";
import { disposeTerminalView, hideTerminalView, onTerminalInput, showTerminalView } from "../task-workspace/terminal-views";

export type TerminalPanelProps = {
  terminals: TerminalSession[];
  terminal: TerminalSession | undefined;
  /** False whenever something else is over the panel, so a hidden terminal keeps the size it had. */
  visible: boolean;
  onOpen: () => void;
  onSelect: (terminalId: string) => void;
  onClose: (terminalId: string) => void;
  onInput: (terminalId: string, data: string) => void;
  onResize: (terminalId: string, cols: number, rows: number) => void;
};

export function TerminalPanel({ terminals, terminal, visible, onOpen, onSelect, onClose, onInput, onResize }: TerminalPanelProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const drawn = useRef<string[]>([]);

  useEffect(() => onTerminalInput(onInput), [onInput]);

  /** A view outlives the panel, so a terminal that is gone is the one thing that takes its view with it. */
  useEffect(() => {
    const open = terminals.map((session) => session.id);
    for (const id of drawn.current) if (!open.includes(id)) disposeTerminalView(id);
    drawn.current = open;
  }, [terminals]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !terminal || !visible) return;
    const view = showTerminalView(terminal.id, element);
    view.terminal.focus();
    const measure = () => {
      const box = element.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return;
      view.fit.fit();
      onResize(terminal.id, view.terminal.cols, view.terminal.rows);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      hideTerminalView(terminal.id);
    };
  }, [terminal?.id, visible, onResize]);

  return (
    <section className="terminal-panel" aria-label="Terminal">
      <div className="terminal-tabs" role="tablist" aria-label="Terminals">
        {terminals.map((session) => (
          <div className={`terminal-tab ${session.id === terminal?.id ? "active" : ""} ${session.status === "exited" ? "exited" : ""}`} key={session.id}>
            <button type="button" role="tab" title={session.cwd} aria-selected={session.id === terminal?.id} onClick={() => onSelect(session.id)}>
              <SquareTerminal size={13} aria-hidden="true" />
              <span>{session.title}</span>
            </button>
            <button type="button" aria-label={`Close ${session.title}`} onClick={() => onClose(session.id)}><X size={12} /></button>
          </div>
        ))}
        <button className="terminal-new" type="button" aria-label="New terminal" onClick={onOpen}><Plus size={15} /></button>
      </div>

      {terminal && (
        <p className="terminal-status">
          <span>{terminal.cwd}</span>
          {terminal.status === "exited" && <em>{terminal.error ?? `exited${terminal.exitCode === undefined ? "" : ` (${terminal.exitCode})`}`}</em>}
        </p>
      )}

      <div className="terminal-viewport" ref={viewport}>
        {!terminal && (
          <div className="terminal-empty">
            <span className="agent-orb"><SquareTerminal size={17} /></span>
            <h2>No terminal open</h2>
            <p>Your own shell, in this thread's folder. Claude can read what it prints when you ask, and never types into it.</p>
            <button type="button" onClick={onOpen}>Open a terminal</button>
          </div>
        )}
      </div>
    </section>
  );
}
