import { LuPlus as Plus } from "react-icons/lu";
import type { ProjectSettingsRow } from "../../application/project-settings";
import { projectName } from "../../domain/project";
import { ConfirmAction, useRowListFocus } from "./SettingRow";

export type ProjectSettingsProps = {
  rows: ProjectSettingsRow[];
  /** Why the last removal was refused, while it stands. */
  error: string | null;
  onDismissError: () => void;
  onAdd: () => void;
  onEdit: (projectId: string) => void;
  onRemove: (projectId: string) => void;
};

function removeLabel(threads: number) {
  if (threads === 0) return "Remove";
  return `Remove and archive ${threads === 1 ? "1 thread" : `${threads} threads`}`;
}

export function ProjectSettings({ rows, error, onDismissError, onAdd, onEdit, onRemove }: ProjectSettingsProps) {
  const focus = useRowListFocus<HTMLElement>();
  return (
    <main className="settings-main">
      <div className="settings-page-heading">
        <h2>Projects</h2>
        <p>The folders threads start in.</p>
      </div>

      <section ref={focus.ref} onClickCapture={focus.onClickCapture} className="settings-group" aria-labelledby="projects-heading">
        <div className="settings-group-heading">
          <div><h3 id="projects-heading">{rows.length === 1 ? "1 project" : `${rows.length} projects`}</h3></div>
          <div className="settings-group-action">
            <button type="button" onClick={onAdd}><Plus size={14} aria-hidden="true" />Add project</button>
          </div>
        </div>

        {error && <p className="settings-error" role="alert">{error}<button type="button" className="settings-empty-action" onClick={onDismissError}>Dismiss</button></p>}
        {rows.length === 0
          ? <p className="settings-empty">No projects yet.</p>
          : rows.map(({ project, host, threads }) => {
            const name = projectName(project);
            return (
              <div className="setting-row plain" key={`${host?.id ?? "this"}:${project.id}`}>
                <div>
                  <strong>{name}</strong>
                  <p className="project-settings-path">{host ? `${host.name}${host.offline ? ` (${host.reconnecting ? "reconnecting" : "offline"})` : ""} · ${project.root}` : project.root}</p>
                </div>
                {/** A paired computer's project is edited on that computer, and removed only while it answers. */}
                <div className="setting-row-action project-actions">
                  {!host && <button type="button" aria-label={`Edit ${name}`} onClick={() => onEdit(project.id)}>Edit…</button>}
                  <ConfirmAction className="danger" aria-label={`Remove ${name}`} disabled={host?.offline} confirm={removeLabel(threads)} onConfirm={() => onRemove(project.id)}>Remove</ConfirmAction>
                </div>
              </div>
            );
          })}
      </section>
    </main>
  );
}
