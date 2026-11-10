import { LuPlus as Plus } from "react-icons/lu";
import type { ProjectSettingsRow } from "../../application/project-settings";
import { projectName } from "../../domain/project";
import { SettingRowBase, useRowListFocus } from "./SettingRow";
import { SettingsPage, SettingsSection } from "./SettingsLayout";
import { Button } from "../ui/Button";
import { ConfirmAction } from "../ui/ConfirmAction";

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
    <SettingsPage title="Projects" description="The folders threads start in.">
      <SettingsSection ref={focus.ref} onClickCapture={focus.onClickCapture} title={rows.length === 1 ? "1 project" : `${rows.length} projects`}
        action={<Button icon={<Plus size={14} aria-hidden="true" />} onClick={onAdd}>Add project</Button>}>
        {error && <p className="settings-error" role="alert">{error}<Button variant="link" className="settings-empty-action" onClick={onDismissError}>Dismiss</Button></p>}
        {rows.length === 0
          ? <p className="settings-empty">No projects yet.</p>
          : rows.map(({ project, host, threads }) => {
            const name = projectName(project);
            return (
              <SettingRowBase key={`${host?.id ?? "this"}:${project.id}`} title={name} actionClassName="project-actions"
                description={<p className="project-settings-path">{host ? `${host.name}${host.offline ? ` (${host.reconnecting ? "reconnecting" : "offline"})` : ""} · ${project.root}` : project.root}</p>}>
                {/** A paired computer's project is edited on that computer, and removed only while it answers. */}
                {!host && <Button aria-label={`Edit ${name}`} onClick={() => onEdit(project.id)}>Edit…</Button>}
                <ConfirmAction variant="danger" aria-label={`Remove ${name}`} disabled={host?.offline} confirm={removeLabel(threads)} onConfirm={() => onRemove(project.id)}>Remove</ConfirmAction>
              </SettingRowBase>
            );
          })}
      </SettingsSection>
    </SettingsPage>
  );
}
