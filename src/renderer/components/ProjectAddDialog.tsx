import { useId, useLayoutEffect, useRef } from "react";
import type { AppCommand } from "../../contracts/commands";
import type { ProjectAddState } from "../../application/project-add";
import type { ComputerLink } from "../../domain/computers";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { FieldGroup, Select, TextField } from "../ui/Field";
import { ChooseFolderButton } from "./ProjectEditDialog";

export type ProjectAddDialogProps = {
  add: ProjectAddState;
  links: ComputerLink[];
  name: string;
  dispatch: (command: AppCommand) => unknown;
};

export function ProjectAddDialog({ add, links, name, dispatch }: ProjectAddDialogProps) {
  const panel = useRef<HTMLElement>(null);
  const deviceId = useId();
  const folderId = useId();
  useLayoutEffect(() => {
    panel.current?.querySelector("[role=option][aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  }, [add.selected]);
  const chosen = links.find((link) => link.id === add.computerId);
  const local = add.computerId === "this";
  const offline = !local && chosen?.status !== "connected";
  const place = local ? name || "this computer" : chosen?.name ?? "unavailable computer";
  const heading = add.start ? (local ? "Start in a folder" : `Start in a folder on ${place}`) : `Add project on ${place}`;
  /** Starting needs no device choice when this computer is the only one to start on. */
  const devices = !add.start || !local || links.some((link) => link.status === "connected");
  const error = offline ? chosen?.error ?? "That computer is offline." : add.error;
  const close = () => dispatch({ type: "view.add-project-close" });
  return (
    <Dialog
      ref={panel}
      as="form"
      title={heading}
      onClose={close}
      onEscape={() => dispatch({ type: "view.add-project-key", key: "Escape" })}
      onSubmit={() => dispatch({ type: "view.add-project-submit" })}
      actions={<>
        <Button size="lg" onClick={close}>Cancel</Button>
        <Button type="submit" variant="primary" size="lg" disabled={add.saving || offline || !add.root.trim()}>{add.saving ? "Opening…" : add.start ? "Start" : "Add project"}</Button>
      </>}
    >
      {devices && <FieldGroup label="Device" htmlFor={deviceId}>
        <Select id={deviceId} wrapClassName="project-edit-select" value={add.computerId} disabled={add.saving} onChange={(event) => dispatch({ type: "view.add-project-device", computerId: event.target.value })}>
          <option value="this">This computer{name ? ` (${name})` : ""}</option>
          {links.filter((link) => link.status === "connected" || link.id === add.computerId).map((link) => <option key={link.id} value={link.id} disabled={link.status !== "connected"}>{link.name}</option>)}
          {!local && !chosen && <option value={add.computerId} disabled>Unavailable computer</option>}
        </Select>
      </FieldGroup>}
      <FieldGroup label="Folder" htmlFor={folderId} error={error} announce>
        <div className="project-edit-path">
          <TextField id={folderId} role="combobox" aria-autocomplete="list" aria-expanded={add.suggestions.length > 0} aria-controls="project-directory-options"
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
          {local && <ChooseFolderButton disabled={add.saving} onClick={() => dispatch({ type: "view.add-project-pick" })} />}
        </div>
        {add.suggestions.length > 0 && <div id="project-directory-options" className="project-directory-options" role="listbox" aria-label="Directories">
          {add.suggestions.map((root, index) => <button type="button" role="option" id={`project-directory-${index}`} key={root}
            tabIndex={-1} aria-selected={index === add.selected} onPointerDown={(event) => event.preventDefault()}
            onClick={() => dispatch({ type: "view.add-project-accept", index })}>{root}</button>)}
        </div>}
      </FieldGroup>
    </Dialog>
  );
}
