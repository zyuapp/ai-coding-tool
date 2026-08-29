import { Fragment, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { LuSearch as Search, LuSettings as Settings } from "react-icons/lu";
import type { JumpRow, JumpView } from "../../application/workspace-jump";
import type { SettingsSection } from "../../domain/settings-section";
import { useFocusReturn } from "../focus";
import { ThreadEngineIcon } from "./ThreadEngineIcon";

/** What the panel asks of the workspace, which is every command it can send. */
export type ThreadJumpActions = {
  setJumpQuery: (query: string) => unknown;
  stepJump: (delta: -1 | 1) => unknown;
  chooseJump: (taskId: string) => unknown;
  chooseJumpSetting: (section: SettingsSection, settingId: string | null) => unknown;
  closeJump: () => unknown;
};

export type ThreadJumpProps = { jump: JumpView; actions: ThreadJumpActions };

/** The list of threads and settings a name matches, with one row picked and ready for the Enter key. */
export function ThreadJump({ jump, actions }: ThreadJumpProps) {
  const input = useRef<HTMLInputElement>(null);
  const picked = useRef<HTMLButtonElement>(null);
  useFocusReturn(input);

  useEffect(() => {
    picked.current?.scrollIntoView({ block: "nearest" });
  }, [jump.index]);

  const chosen = jump.options[jump.index];

  function choose(option: JumpRow) {
    if (option.kind === "thread") actions.chooseJump(option.id);
    else actions.chooseJumpSetting(option.section, option.settingId);
  }

  function keyDown(event: ReactKeyboardEvent) {
    if (event.key === "ArrowDown") actions.stepJump(1);
    else if (event.key === "ArrowUp") actions.stepJump(-1);
    else if (event.key === "Enter") { if (chosen) choose(chosen); }
    else if (event.key === "Escape") actions.closeJump();
    else return;
    event.preventDefault();
  }

  /** Where the settings start, so the list can say so once rather than tagging every row. */
  const firstSetting = jump.options.findIndex((option) => option.kind === "setting");

  return createPortal(
    <div
      className="thread-jump"
      role="dialog"
      aria-modal="true"
      aria-label="Jump to a thread or a setting"
      onPointerDown={(event) => { if (event.target === event.currentTarget) actions.closeJump(); }}
    >
      <div className="thread-jump-panel" onKeyDown={keyDown}>
        <div className="thread-jump-search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={input}
            value={jump.query}
            aria-label="Search threads and settings"
            placeholder="Search threads and settings"
            spellCheck={false}
            onInput={(event) => actions.setJumpQuery(event.currentTarget.value)}
          />
        </div>
        {jump.options.length ? (
          <div className="thread-jump-list" role="listbox" aria-label="Threads and settings">
            {jump.options.map((option, index) => (
              <Fragment key={option.id}>
                {index === firstSetting && index > 0 && <p className="thread-jump-heading" role="presentation">Settings</p>}
                <button
                  ref={index === jump.index ? picked : undefined}
                  type="button"
                  role="option"
                  aria-selected={index === jump.index}
                  className={`thread-jump-row ${index === jump.index ? "picked" : ""}`.trimEnd()}
                  onClick={() => choose(option)}
                >
                  {option.kind === "thread"
                    ? <ThreadEngineIcon engine={option.engine} className="thread-jump-engine" size={13} />
                    : <Settings className="thread-jump-engine" size={13} aria-label="Setting" />}
                  <span className="thread-jump-title">{option.title}</span>
                  {option.kind === "thread" && option.running && <span className="task-spinner" aria-label="Working" />}
                  {option.kind === "thread"
                    ? option.project && <span className="thread-jump-project">{option.project}</span>
                    : option.page && <span className="thread-jump-project">{option.page}</span>}
                </button>
              </Fragment>
            ))}
          </div>
        ) : (
          <p className="thread-jump-empty">Nothing here is called that</p>
        )}
      </div>
    </div>,
    document.body,
  );
}
