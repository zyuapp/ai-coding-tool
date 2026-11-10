import { useEffect, useRef } from "react";

/** Hands each microphone level to `onLevel` while `active`, as main reports them during dictation. */
export function useDictationLevel(onLevel: (level: number) => void, active = true) {
  const latest = useRef(onLevel);
  latest.current = onLevel;
  useEffect(() => {
    if (!active) return;
    return window.desktop.onDictationLevel((level) => latest.current(level));
  }, [active]);
}
