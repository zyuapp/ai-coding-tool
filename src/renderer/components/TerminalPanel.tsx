import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TerminalSession } from "../../domain/terminal";
import { fitTerminalView, focusTerminalView, hideTerminalView, onTerminalInput, showTerminalView } from "../task-workspace/terminal-views";

export type TerminalPanelProps = {
  terminal: TerminalSession;
  /** False whenever something else is over the panel, so a hidden terminal keeps the size it had. */
  visible: boolean;
  /** Bumped whenever something asks the shell to take the keyboard. */
  focusToken?: number;
  /** The find bar, when it is this shell being searched. */
  find?: ReactNode;
  onInput: (terminalId: string, data: string) => void;
  onResize: (terminalId: string, cols: number, rows: number) => void;
};

export function TerminalPanel({ terminal, visible, focusToken = 0, find, onInput, onResize }: TerminalPanelProps) {
  const viewport = useRef<HTMLDivElement>(null);
  /**
   * Held in a ref rather than named as a dependency: showing a view moves its element into the
   * viewport, and re-running that for a callback the parent rebuilt each render would take the
   * keyboard off the terminal on every unrelated re-render.
   */
  const resized = useRef(onResize);
  /** Why the panel is empty. Drawing is the view's, not the workspace's, so the reason is the panel's too. */
  const [drawError, setDrawError] = useState<string | null>(null);

  useEffect(() => onTerminalInput(onInput), [onInput]);

  useEffect(() => {
    if (focusToken) focusTerminalView(terminal.id);
  }, [focusToken, terminal.id]);

  useEffect(() => { resized.current = onResize; }, [onResize]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !visible) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return;
      const size = fitTerminalView(terminal.id);
      if (size) resized.current(terminal.id, size.cols, size.rows);
    };
    /** xterm arrives asynchronously, so the first focus and fit wait for the view to be drawn. */
    void showTerminalView(terminal.id, element).then(
      () => {
        setDrawError(null);
        focusTerminalView(terminal.id);
        measure();
      },
      (error: unknown) => setDrawError(error instanceof Error ? error.message : String(error)),
    );
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

      {find}

      {/** The viewport is wider than the rows it holds, so a click in the margin still means the shell. */}
      <div className="terminal-viewport" ref={viewport} onMouseDown={() => focusTerminalView(terminal.id)}>
        {drawError && (
          <div className="terminal-error">
            {/** A module that failed to load stays failed for the life of the window, so reloading is the way back. */}
            <p>The terminal view could not be loaded. Reloading the app and opening a terminal again is what fixes it.</p>
            <small>{drawError}</small>
            <button type="button" onClick={() => window.location.reload()}>Reload the app</button>
          </div>
        )}
      </div>
    </section>
  );
}
