import { useEffect, useRef } from "react";

/** Whether the stylesheet floats the sidebar over the workspace at the window's current width and zoom. */
function sidebarFloats() {
  return window.getComputedStyle(document.documentElement).getPropertyValue("--sidebar-floats").trim() === "1";
}

/**
 * A sidebar that starts to float, because the window narrowed or zoomed in, folds away rather than
 * veiling the page, and comes back once there is room beside the conversation again. One the person
 * opens while it floats is theirs to close.
 */
export function useFloatingSidebar(open: boolean, setOpen: (open: boolean) => void, besideDock: boolean) {
  const latest = useRef({ open, setOpen });
  latest.current = { open, setOpen };
  const floating = useRef<boolean | null>(null);
  const folded = useRef(false);
  const check = useRef(() => {
    const now = sidebarFloats();
    if (now === floating.current) return;
    const first = floating.current === null;
    floating.current = now;
    if (first) return;
    const { open, setOpen } = latest.current;
    if (now && open) {
      folded.current = true;
      setOpen(false);
    } else if (!now && folded.current) {
      folded.current = false;
      if (!open) setOpen(true);
    }
  });

  useEffect(() => {
    const observer = new ResizeObserver(() => check.current());
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, []);
  useEffect(() => check.current(), [besideDock]);
  useEffect(() => {
    if (open && floating.current) folded.current = false;
  }, [open]);
}
