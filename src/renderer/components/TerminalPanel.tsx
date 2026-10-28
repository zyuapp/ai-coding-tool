import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TerminalSession } from "../../domain/terminal";
import type { ComputerLink } from "../../domain/computers";
import { LuCheck as Check, LuPlus as Plus, LuRotateCw as RotateCw, LuTriangleAlert as AlertTriangle, LuUnplug as Unplug } from "react-icons/lu";
import { CommandButton, useCommandControls } from "./CommandControl";
import { ConfirmAction } from "./SettingRow";
import { fitTerminalView, focusTerminalView, hideTerminalView, onTerminalInput, showTerminalView } from "../task-workspace/terminal-views";

export type TerminalPanelProps = {
  terminal: TerminalSession;
  computer?: Pick<ComputerLink, "id" | "name" | "status" | "error"> | null;
  /** False whenever something else is over the panel, so a hidden terminal keeps the size it had. */
  visible: boolean;
  /** Bumped whenever something asks the shell to take the keyboard. */
  focusToken?: number;
  /** The find bar, when it is this shell being searched. */
  find?: ReactNode;
  onInput: (terminalId: string, data: string) => void;
  onResize: (terminalId: string, cols: number, rows: number) => void;
};

export function TerminalPanel({ terminal, computer, visible, focusToken = 0, find, onInput, onResize }: TerminalPanelProps) {
  const viewport = useRef<HTMLDivElement>(null);
  /**
   * Held in a ref rather than named as a dependency: showing a view moves its element into the
   * viewport, and re-running that for a callback the parent rebuilt each render would take the
   * keyboard off the terminal on every unrelated re-render.
   */
  const resized = useRef(onResize);
  /** Why the panel is empty. Drawing is the view's, not the workspace's, so the reason is the panel's too. */
  const [drawError, setDrawError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const controls = useCommandControls();
  const computerId = computer?.id;
  const connected = !computer || computer.status === "connected";

  useEffect(() => onTerminalInput(onInput), [onInput]);

  useEffect(() => {
    if (focusToken) focusTerminalView(terminal.id);
  }, [focusToken, terminal.id]);

  useEffect(() => { resized.current = onResize; }, [onResize]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !visible || !connected) return;
    let mounted = true;
    const measure = () => {
      const box = element.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return;
      const size = fitTerminalView(terminal.id);
      if (size) resized.current(terminal.id, size.cols, size.rows);
    };
    /** xterm arrives asynchronously, so the first focus and fit wait for the view to be drawn. */
    void showTerminalView(terminal.id, element, computerId, setConnectionError, () => mounted).then(
      () => {
        if (!mounted) return;
        setDrawError(null);
        focusTerminalView(terminal.id);
        measure();
      },
      (error: unknown) => { if (mounted) setDrawError(error instanceof Error ? error.message : String(error)); },
    );
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      mounted = false;
      observer.disconnect();
      hideTerminalView(terminal.id);
    };
  }, [terminal.id, visible, computerId, connected]);

  const clean = !terminal.error && terminal.exitCode === 0;
  const exitLabel = `Exited${terminal.exitCode === undefined ? "" : ` (${terminal.exitCode})`}`;
  const exited = terminal.status === "exited";
  const open = { type: "terminal.open", cwd: terminal.cwd } as const;
  /** An exited shell's tab gives way to the one that restarts it, so dead tabs never pile up. */
  const restart = () => {
    controls.dispatch(open);
    controls.dispatch({ type: "terminal.close", terminalId: terminal.id });
  };

  return (
    <section className="terminal-panel" aria-label="Terminal">
      <p className="terminal-status">
        <span>{computer ? `${computer.name} · ${terminal.cwd}` : terminal.cwd}</span>
        {computer && (!connected || connectionError) && <em role="status"><Unplug size={12} aria-hidden="true" />{!connected ? computer.error ?? "Disconnected — reconnecting…" : connectionError}</em>}
        {terminal.status === "exited" && (clean
          ? <em className="clean" role="status"><Check size={12} aria-hidden="true" />{terminal.error ?? exitLabel}</em>
          : <em role="status"><AlertTriangle size={12} aria-hidden="true" />{terminal.error ?? exitLabel}</em>)}
        {exited
          ? <CommandButton command={open} type="button" className="terminal-new-shell primary" onClick={restart}><RotateCw size={12} aria-hidden="true" />Restart shell</CommandButton>
          : <CommandButton command={open} type="button" className="terminal-new-shell"><Plus size={12} aria-hidden="true" />New shell</CommandButton>}
      </p>

      {find}

      {/** The viewport is wider than the rows it holds, so a click in the margin still means the shell. */}
      <div className="terminal-viewport" ref={viewport} onMouseDown={() => focusTerminalView(terminal.id)}>
        {drawError && (
          <div className="terminal-error">
            {/** A module that failed to load stays failed for the life of the window, so reloading is the way back. */}
            <p><AlertTriangle size={14} aria-hidden="true" />The terminal could not load.</p>
            <small>{drawError}</small>
            <span className="terminal-error-actions">
              <ConfirmAction confirm="Reload window" onConfirm={() => window.location.reload()}>Reload window…</ConfirmAction>
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
