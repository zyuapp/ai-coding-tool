import { LuPlus as Plus } from "react-icons/lu";
import type { ThreadHost } from "../../application/computers";
import { projectName, type Project } from "../../domain/project";
import type { Thread } from "../../domain/thread";
import { ConfirmAction, useRowListFocus } from "./SettingRow";

export type ProjectSettingsProps = {
  projects: Project[];
  /** Which paired computer holds each project that is not this computer's own. */
  projectHosts: Map<string, ThreadHost>;
  /** The threads still listed, which removing their project archives. */
  threads: Thread[];
  onAdd: () => void;
  onEdit: (projectId: string) => void;
  onRemove: (projectId: string) => void;
};

/** This computer's projects first, then each paired computer's, each by name. */
function sortedProjects(projects: Project[], hosts: Map<string, ThreadHost>) {
  return [...projects].sort((a, b) => {
    const hostA = hosts.get(a.id)?.name ?? "", hostB = hosts.get(b.id)?.name ?? "";
    return hostA.localeCompare(hostB) || projectName(a).localeCompare(projectName(b)) || a.root.localeCompare(b.root);
  });
}

function removeLabel(threads: number) {
  if (threads === 0) return "Remove";
  return `Remove and archive ${threads === 1 ? "1 thread" : `${threads} threads`}`;
}

export function ProjectSettings({ projects, projectHosts, threads, onAdd, onEdit, onRemove }: ProjectSettingsProps) {
  const rows = useRowListFocus<HTMLElement>();
  const counts = new Map<string, number>();
  for (const thread of threads) if (thread.projectId) counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
  return (
    <main className="settings-main">
      <div className="settings-page-heading">
        <h2>Projects</h2>
        <p>The folders threads start in.</p>
      </div>

      <section ref={rows.ref} onClickCapture={rows.onClickCapture} className="settings-group" aria-labelledby="projects-heading">
        <div className="settings-group-heading">
          <div><h3 id="projects-heading">{projects.length === 1 ? "1 project" : `${projects.length} projects`}</h3></div>
          <div className="settings-group-action">
            <button type="button" onClick={onAdd}><Plus size={14} aria-hidden="true" />Add project</button>
          </div>
        </div>

        {projects.length === 0
          ? <p className="settings-empty">No projects yet.</p>
          : sortedProjects(projects, projectHosts).map((project) => {
            const name = projectName(project);
            const host = projectHosts.get(project.id);
            return (
              <div className="setting-row plain" key={project.id}>
                <div>
                  <strong>{name}</strong>
                  <p className="project-settings-path">{host ? `${host.name} · ${project.root}` : project.root}</p>
                </div>
                <div className="setting-row-action">
                  <button type="button" aria-label={`Edit ${name}`} onClick={() => onEdit(project.id)}>Edit…</button>
                  <ConfirmAction className="danger" aria-label={`Remove ${name}`} confirm={removeLabel(counts.get(project.id) ?? 0)} onConfirm={() => onRemove(project.id)}>Remove</ConfirmAction>
                </div>
              </div>
            );
          })}
      </section>
    </main>
  );
}
