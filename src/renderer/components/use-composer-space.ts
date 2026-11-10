import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Tells the workspace how tall its composer stands, so the transcript can run under the composer
 * and still rest its last line above it. Answers with the ref the composer's footer takes.
 */
export function useComposerSpace(enabled: boolean): RefObject<HTMLElement | null> {
  const footer = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = footer.current;
    const workspace = element?.closest<HTMLElement>(".workspace");
    if (!enabled || !element || !workspace || typeof ResizeObserver === "undefined") return;
    const write = () => workspace.style.setProperty("--composer-space", `${element.offsetHeight}px`);
    const observer = new ResizeObserver(write);
    observer.observe(element);
    write();
    return () => {
      observer.disconnect();
      workspace.style.removeProperty("--composer-space");
    };
  }, [enabled]);
  return footer;
}
