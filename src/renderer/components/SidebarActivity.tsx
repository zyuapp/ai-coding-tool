import { LuCheckCheck as CheckCheck } from "react-icons/lu";
import { dismissableTasks } from "../../domain/attention";
import type { SidebarSection, SidebarSections } from "../../domain/sidebar";
import type { ActivitySections } from "../../application/task-order";
import type { ActivityRowRenderer } from "./SidebarTaskRow";

/** The activity mode's three lists, top to bottom, with the heading each is drawn under. */
const ACTIVITY_SECTIONS = [
  { key: "priority", label: "Priority" },
  { key: "running", label: "Running" },
  { key: "threads", label: "Threads" },
] as const satisfies ReadonlyArray<{ key: keyof ActivitySections & SidebarSection; label: string }>;

export type SidebarActivityProps = {
  /** The threads ranked by what wants the user, which is what activity mode draws. */
  activityTasks: ActivitySections;
  sections: SidebarSections;
  blockedTaskIds: Set<string>;
  onSetSectionOpen: (section: SidebarSection, open: boolean) => void;
  onDismissAll: () => void;
  renderRow: ActivityRowRenderer;
};

export function SidebarActivity({ activityTasks, sections, blockedTaskIds, onSetSectionOpen, onDismissAll, renderRow }: SidebarActivityProps) {
  return (
    <>
      {ACTIVITY_SECTIONS.map(({ key, label }) => {
        const tasks = activityTasks[key];
        const dottedCount = key === "priority" ? dismissableTasks(tasks).length : 0;
        return (
          <section className="activity-group" key={key}>
            <div className="section-heading activity-heading">
              <button className="section-toggle" onClick={() => onSetSectionOpen(key, !sections[key])} aria-expanded={sections[key]}>
                <span>{label}</span>
                <span className="section-chevron" aria-hidden="true" />
              </button>
              {key === "priority" && dottedCount > 0 && (
                <button className="section-action" onClick={onDismissAll} aria-label="Dismiss all">
                  <CheckCheck size={16} aria-hidden="true" />
                </button>
              )}
            </div>
            {sections[key] && tasks.length === 0 && key === "priority" && <p className="sidebar-empty">Nothing waiting</p>}
            {/** Only Priority speaks: a spinner appearing in Running is not news anyone needs read out. */}
            {sections[key] && <nav className="task-list" aria-label={label} aria-live={key === "priority" ? "polite" : undefined}>
              {tasks.map((task) => renderRow(task, key === "priority" && !blockedTaskIds.has(task.id) ? "dismiss" : "none"))}
            </nav>}
          </section>
        );
      })}
    </>
  );
}
