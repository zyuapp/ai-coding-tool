import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import type { SidebarMode } from "../../domain/sidebar";

export type SidebarHeaderProps = {
  mode: SidebarMode;
  canGoBack: boolean;
  canGoForward: boolean;
  onSetMode: (mode: SidebarMode) => void;
  onGoBack: () => void;
  onGoForward: () => void;
};

export function SidebarHeader({ mode, canGoBack, canGoForward, onSetMode, onGoBack, onGoForward }: SidebarHeaderProps) {
  return (
    <div className="traffic-space">
      <div className="sidebar-modes">
        {/** One switch, not a pair: pressed ranks the threads, released puts them back under their folders. */}
        <button
          className={`thread-nav-button ${mode === "activity" ? "active" : ""}`}
          type="button"
          aria-label="Rank threads by activity"
          aria-pressed={mode === "activity"}
          onClick={() => onSetMode(mode === "activity" ? "projects" : "activity")}
        >
          <Inbox size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="thread-nav">
        <button className="thread-nav-button" type="button" aria-label="Go back" disabled={!canGoBack} onClick={onGoBack}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <button className="thread-nav-button" type="button" aria-label="Go forward" disabled={!canGoForward} onClick={onGoForward}>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function resizeSidebar(target: HTMLElement, clientX: number) {
  const sidebar = target.parentElement;
  /** The width is a custom property because the hidden state slides the sidebar out by that same width. */
  if (sidebar) sidebar.style.setProperty("--sidebar-width", `${Math.min(innerWidth / 2, Math.max(220, clientX - sidebar.getBoundingClientRect().left))}px`);
}

/** The edge the sidebar is dragged wider by, which the arrow keys nudge ten pixels at a time. */
export function SidebarResizer() {
  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeSidebar(event.currentTarget, event.clientX);
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const sidebar = event.currentTarget.parentElement;
        if (sidebar) resizeSidebar(event.currentTarget, sidebar.getBoundingClientRect().right + (event.key === "ArrowLeft" ? -10 : 10));
      }}
    />
  );
}
