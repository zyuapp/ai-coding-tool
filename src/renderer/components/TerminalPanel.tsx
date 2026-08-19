import { useEffect, useRef } from "react";
import type { TerminalSession } from "../../domain/terminal";
import { focusTerminalView, hideTerminalView, onTerminalInput, showTerminalView } from "../task-workspace/terminal-views";

export type TerminalPanelProps = {
  terminal: TerminalSession;
  /** False whenever something else is over the panel, so a hidden terminal keeps the size it had. */
  visible: boolean;
  onInput: (terminalId: string, data: string) => void;
  onResize: (terminalId: string, cols: number, rows: number) => void;
};

export function TerminalPanel({ terminal, visible, onInput, onResize }: TerminalPanelProps) {
  const viewport = useRef<HTMLDivElement>(null);
  /**
   * Held in a ref rather than named as a dependency: showing a view moves its element into the
   * viewport, and re-running that for a callback the parent rebuilt each render would take the
   * keyboard off the terminal on every unrelated re-render.
   */
  const resized = useRef(onResize);

  useEffect(() => onTerminalInput(onInput), [onInput]);

  useEffect(() => { resized.current = onResize; }, [onResize]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !visible) return;
    const view = showTerminalView(terminal.id, element);
    view.terminal.focus();
    const measure = () => {
      const box = element.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return;
      view.fit.fit();
      resized.current(terminal.id, view.terminal.cols, view.terminal.rows);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      hideTerminalView(terminal.id);
    };
  }, [terminal.id, visible]);

  return (
    <section className="terminal-panel" aria-label="Terminal">
      <p className="terminal-status">
        <span>{terminal.cwd}</span>
        {terminal.status === "exited" && <em>{terminal.error ?? `exited${terminal.exitCode === undefined ? "" : ` (${terminal.exitCode})`}`}</em>}
      </p>

      {/** The viewport is wider than the rows it holds, so a click in the margin still means the shell. */}
      <div className="terminal-viewport" ref={viewport} onMouseDown={() => focusTerminalView(terminal.id)} />
    </section>
  );
}
