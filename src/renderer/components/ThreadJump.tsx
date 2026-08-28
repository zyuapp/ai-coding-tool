import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { LuSearch as Search } from "react-icons/lu";
import type { JumpView } from "../../application/workspace-jump";
import { useFocusReturn } from "../focus";
import { ThreadEngineIcon } from "./ThreadEngineIcon";

/** What the panel asks of the workspace, which is every command it can send. */
export type ThreadJumpActions = {
  setJumpQuery: (query: string) => unknown;
  stepJump: (delta: -1 | 1) => unknown;
  chooseJump: (taskId: string) => unknown;
  closeJump: () => unknown;
};

export type ThreadJumpProps = { jump: JumpView; actions: ThreadJumpActions };

/** The list of threads a name matches, with one row picked and ready for the Enter key. */
export function ThreadJump({ jump, actions }: ThreadJumpProps) {
  const input = useRef<HTMLInputElement>(null);
  const picked = useRef<HTMLButtonElement>(null);
  useFocusReturn(input);

  useEffect(() => {
    picked.current?.scrollIntoView({ block: "nearest" });
  }, [jump.index]);

  const chosen = jump.options[jump.index];

  function keyDown(event: ReactKeyboardEvent) {
    if (event.key === "ArrowDown") actions.stepJump(1);
    else if (event.key === "ArrowUp") actions.stepJump(-1);
    else if (event.key === "Enter") { if (chosen) actions.chooseJump(chosen.id); }
    else if (event.key === "Escape") actions.closeJump();
    else return;
    event.preventDefault();
  }

  return createPortal(
    <div
      className="thread-jump"
      role="dialog"
      aria-modal="true"
      aria-label="Jump to a thread"
      onPointerDown={(event) => { if (event.target === event.currentTarget) actions.closeJump(); }}
    >
      <div className="thread-jump-panel" onKeyDown={keyDown}>
        <div className="thread-jump-search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={input}
            value={jump.query}
            aria-label="Search threads by name"
            placeholder="Search threads"
            spellCheck={false}
            onInput={(event) => actions.setJumpQuery(event.currentTarget.value)}
          />
        </div>
        {jump.options.length ? (
          <div className="thread-jump-list" role="listbox" aria-label="Threads">
            {jump.options.map((option, index) => (
              <button
                key={option.id}
                ref={index === jump.index ? picked : undefined}
                type="button"
                role="option"
                aria-selected={index === jump.index}
                className={`thread-jump-row ${index === jump.index ? "picked" : ""}`.trimEnd()}
                onClick={() => actions.chooseJump(option.id)}
              >
                <ThreadEngineIcon engine={option.engine} className="thread-jump-engine" size={13} />
                <span className="thread-jump-title">{option.title}</span>
                {option.running && <span className="task-spinner" aria-label="Working" />}
                {option.project && <span className="thread-jump-project">{option.project}</span>}
              </button>
            ))}
          </div>
        ) : (
          <p className="thread-jump-empty">No thread by that name</p>
        )}
      </div>
    </div>,
    document.body,
  );
}
