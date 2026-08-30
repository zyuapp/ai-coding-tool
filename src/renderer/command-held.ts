import { useEffect, useState } from "react";
import { MAC } from "./platform";

/** Long enough that ⌘C and ⌘V pass without the numbers flickering, short enough to feel immediate. */
const SETTLE_MS = 280;

/**
 * Whether the command key is being held on its own. A chord releases it as soon as its other key
 * lands, so only a deliberate hold ever reads as true.
 */
export function useCommandHeld(active: boolean): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!active) return setHeld(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drop = () => {
      clearTimeout(timer);
      timer = undefined;
      setHeld(false);
    };
    const modifier = MAC ? "Meta" : "Control";
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== modifier) return drop();
      if (timer === undefined) timer = setTimeout(() => setHeld(true), SETTLE_MS);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.key === modifier) drop();
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", drop);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", drop);
    };
  }, [active]);

  return held;
}
