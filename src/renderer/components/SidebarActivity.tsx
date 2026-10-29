import { LuCheckCheck as CheckCheck } from "react-icons/lu";
import type { SidebarSection, SidebarSections } from "../../domain/sidebar";
import { canDismiss, dismissableRows } from "../../application/coordination";
import type { ActivitySections } from "../../application/thread-order";
import type { Thread } from "../../domain/thread";
import type { ActivityRowRenderer } from "./SidebarThreadRow";

/** The activity mode's lists, top to bottom, with the heading each is drawn under. */
const ACTIVITY_SECTIONS = [
  { key: "priority", label: "Priority" },
  { key: "running", label: "Running" },
  { key: "threads", label: "Threads" },
  { key: "snoozed", label: "Snoozed" },
] as const satisfies ReadonlyArray<{ key: keyof ActivitySections & SidebarSection; label: string }>;

export type SidebarActivityProps = {
  /** The threads ranked by what wants the user, which is what activity mode draws. */
  activityThreads: ActivitySections;
  sections: SidebarSections;
  blockedThreadIds: Set<string>;
  /** The threads under each coordinator, which a coordinator's row is dismissed with. */
  threadsByCoordinator: Map<string, Thread[]>;
  onSetSectionOpen: (section: SidebarSection, open: boolean) => void;
  onDismissAll: () => void;
  renderRow: ActivityRowRenderer;
};

function dismissAllLabel(count: number) {
  return count === 1 ? "Dismiss 1 thread" : `Dismiss all ${count} threads`;
}

export function SidebarActivity({ activityThreads, sections, blockedThreadIds, threadsByCoordinator, onSetSectionOpen, onDismissAll, renderRow }: SidebarActivityProps) {
  return (
    <>
      {ACTIVITY_SECTIONS.map(({ key, label }) => {
        const threads = activityThreads[key];
        /** Snoozed only shows while something is in it, so a user who never snoozes never meets it. */
        if (key === "snoozed" && threads.length === 0) return null;
        const dottedCount = key === "priority" ? dismissableRows(threads, threadsByCoordinator, blockedThreadIds).length : 0;
        return (
          <section className="activity-group" key={key}>
            <div className="section-heading activity-heading">
              <button className="section-toggle" type="button" onClick={() => onSetSectionOpen(key, !sections[key])} aria-expanded={sections[key]}>
                <span>{label}</span>
                {/** A folded list still says how much it holds, as part of its heading. */}
                {!sections[key] && threads.length > 0 && <span className="section-count">{threads.length}</span>}
                <span className="section-chevron" aria-hidden="true" />
              </button>
              {key === "priority" && dottedCount > 0 && (
                <button className="section-action dismiss-all" type="button" onClick={onDismissAll} aria-label={dismissAllLabel(dottedCount)} data-tip={dismissAllLabel(dottedCount)}>
                  <CheckCheck size={16} aria-hidden="true" />
                </button>
              )}
            </div>
            {sections[key] && threads.length === 0 && key === "priority" && <p className="sidebar-empty">Nothing waiting</p>}
            {/** Only Priority speaks: a spinner appearing in Running is not news anyone needs read out. */}
            {sections[key] && <nav className={key === "priority" ? "task-list priority-list" : "task-list"} aria-label={label} aria-live={key === "priority" ? "polite" : undefined}>
              {threads.map((thread) => renderRow(thread, key === "priority" && canDismiss(thread, threadsByCoordinator.get(thread.id) ?? [], blockedThreadIds) ? "dismiss" : "none", key === "priority"))}
            </nav>}
          </section>
        );
      })}
    </>
  );
}
