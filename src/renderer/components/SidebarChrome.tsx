import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LuChevronLeft as ChevronLeft, LuChevronRight as ChevronRight } from "react-icons/lu";
import { shortcutTip } from "./TooltipLayer";

const BACK_TIP = shortcutTip("Back", "Mod+[");
const FORWARD_TIP = shortcutTip("Forward", "Mod+]");

export type SidebarHeaderProps = {
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
};

export function SidebarHeader({ canGoBack, canGoForward, onGoBack, onGoForward }: SidebarHeaderProps) {
  return (
    <div className="traffic-space">
      <div className="thread-nav">
        <button className="thread-nav-button" type="button" aria-label="Go back" data-tip={BACK_TIP} disabled={!canGoBack} onClick={onGoBack}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <button className="thread-nav-button" type="button" aria-label="Go forward" data-tip={FORWARD_TIP} disabled={!canGoForward} onClick={onGoForward}>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

const MIN_SIDEBAR_WIDTH = 270;
/** How far one arrow press moves the edge, and one with Shift held. */
const KEY_STEP = 10;
const SHIFT_KEY_STEP = 50;

/** Sets the sidebar's width from where its right edge should be, and returns the width it took. */
function resizeSidebar(target: HTMLElement, clientX: number) {
  const sidebar = target.parentElement;
  if (!sidebar) return null;
  const width = Math.round(Math.min(innerWidth / 2, Math.max(MIN_SIDEBAR_WIDTH, clientX - sidebar.getBoundingClientRect().left)));
  /** The width is a custom property because the hidden state slides the sidebar out by that same width. */
  sidebar.style.setProperty("--sidebar-width", `${width}px`);
  return width;
}

function sidebarWidth(target: HTMLElement) {
  const width = target.parentElement?.getBoundingClientRect().width;
  return width ? Math.round(width) : null;
}

function resetSidebar(target: HTMLElement) {
  target.parentElement?.style.removeProperty("--sidebar-width");
  return sidebarWidth(target);
}

/**
 * The edge the sidebar is dragged wider by, which the arrow keys nudge ten pixels at a time, fifty
 * with Shift, Home and End take to its narrowest and widest, and a double-click or Enter puts back.
 */
export function SidebarResizer() {
  const edge = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [widest, setWidest] = useState(() => Math.round(innerWidth / 2));
  useLayoutEffect(() => {
    if (edge.current) setWidth(sidebarWidth(edge.current));
  }, []);
  /** The window narrowing caps the sidebar at half of it, so what the edge reports follows. */
  useEffect(() => {
    const measure = () => {
      setWidest(Math.round(innerWidth / 2));
      if (edge.current) setWidth(sidebarWidth(edge.current));
    };
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const resizeTo = (target: HTMLElement, clientX: number) => {
    const next = resizeSidebar(target, clientX);
    if (next !== null) setWidth(next);
  };
  return (
    <div
      ref={edge}
      className="sidebar-resizer"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={widest}
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      data-tip="Drag to resize · Double-click to reset"
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onDoubleClick={(event) => setWidth(resetSidebar(event.currentTarget))}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeTo(event.currentTarget, event.clientX);
      }}
      onKeyDown={(event) => {
        const target = event.currentTarget;
        const sidebar = target.parentElement;
        if (!sidebar) return;
        const { left, right } = sidebar.getBoundingClientRect();
        const step = event.shiftKey ? SHIFT_KEY_STEP : KEY_STEP;
        if (event.key === "Enter") setWidth(resetSidebar(target));
        else if (event.key === "Home") resizeTo(target, left);
        else if (event.key === "End") resizeTo(target, left + innerWidth);
        else if (event.key === "ArrowLeft" || event.key === "ArrowRight") resizeTo(target, right + (event.key === "ArrowLeft" ? -step : step));
        else return;
        event.preventDefault();
      }}
    />
  );
}
