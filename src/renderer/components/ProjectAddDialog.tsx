import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { AppCommand } from "../../contracts/commands";
import type { ProjectAddState } from "../../application/project-add";
import type { ComputerLink } from "../../domain/computers";
import { useModalFocus } from "../focus";

export type ProjectAddDialogProps = {
  add: ProjectAddState;
  links: ComputerLink[];
  name: string;
  dispatch: (command: AppCommand) => unknown;
};

export function ProjectAddDialog({ add, links, name, dispatch }: ProjectAddDialogProps) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog);
  useLayoutEffect(() => {
    dialog.current?.querySelector("[role=option][aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  }, [add.selected]);
  const chosen = links.find((link) => link.id === add.computerId);
  const local = add.computerId === "this";
  const offline = !local && chosen?.status !== "connected";
  const heading = `Add project on ${local ? name || "this computer" : chosen?.name ?? "unavailable computer"}`;
  const error = offline ? chosen?.error ?? "That computer is offline." : add.error;
  return createPortal(
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label={heading} ref={dialog} tabIndex={-1}
      onPointerDown={(event) => { if (event.target === event.currentTarget) dispatch({ type: "view.add-project-close" }); }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        dispatch({ type: "view.add-project-key", key: "Escape" });
      }}>
      <form className="modal-panel project-edit-panel" onSubmit={(event) => { event.preventDefault(); dispatch({ type: "view.add-project-submit" }); }}>
        <h2>{heading}</h2>
        <label className="project-edit-field">
          <span>Device</span>
          <select value={add.computerId} disabled={add.saving} onChange={(event) => dispatch({ type: "view.add-project-device", computerId: event.target.value })}>
            <option value="this">This computer{name ? ` (${name})` : ""}</option>
            {links.filter((link) => link.status === "connected" || link.id === add.computerId).map((link) => <option key={link.id} value={link.id} disabled={link.status !== "connected"}>{link.name}</option>)}
            {!local && !chosen && <option value={add.computerId} disabled>Unavailable computer</option>}
          </select>
        </label>
        <label className="project-edit-field">
          <span>Folder</span>
          <div className="project-edit-path">
            <input role="combobox" aria-autocomplete="list" aria-expanded={add.suggestions.length > 0} aria-controls="project-directory-options"
              aria-activedescendant={add.selected < 0 ? undefined : `project-directory-${add.selected}`}
              value={add.root} disabled={add.saving || offline} placeholder="~/path/to/project" maxLength={4096} spellCheck={false} autoComplete="off"
              onChange={(event) => dispatch({ type: "view.add-project-path", root: event.target.value })}
              onKeyDown={(event) => {
                const key = event.key;
                if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "Tab" && key !== "Enter") return;
                if (key === "Tab" && !add.suggestions.length) return;
                event.preventDefault();
                dispatch({ type: "view.add-project-key", key });
              }} />
            {local && <button type="button" disabled={add.saving} onClick={() => dispatch({ type: "view.add-project-pick" })}>Choose folder…</button>}
          </div>
        </label>
        {add.suggestions.length > 0 && <div id="project-directory-options" className="project-directory-options" role="listbox" aria-label="Directories">
          {add.suggestions.map((root, index) => <button type="button" role="option" id={`project-directory-${index}`} key={root}
            tabIndex={-1} aria-selected={index === add.selected} onPointerDown={(event) => event.preventDefault()}
            onClick={() => dispatch({ type: "view.add-project-accept", index })}>{root}</button>)}
        </div>}
        {error && <p className="project-edit-error" role="alert">{error}</p>}
        <div className="project-edit-actions">
          <button type="button" onClick={() => dispatch({ type: "view.add-project-close" })}>Cancel</button>
          <button type="submit" className="primary" disabled={add.saving || offline || !add.root.trim()}>{add.saving ? "Opening…" : "Add project"}</button>
        </div>
      </form>
    </div>, document.body,
  );
}
