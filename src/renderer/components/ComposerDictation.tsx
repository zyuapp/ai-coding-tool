import { useEffect, useRef, useState, type PointerEvent } from "react";
import { DICTATION_HOLD_MS, type DictationModel, type DictationPhase } from "../../domain/dictation";

/** The main composer's hold to talk, as the workspace reports it. */
export type ComposerDictation = {
  model: DictationModel;
  phase: DictationPhase | null;
  /** Bumped each time spoken words are in this draft and it should be sent. */
  release: number;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
};

/** How far past the button a held pointer may wander before letting go cancels instead of sending. */
const SLACK_PX = 24;

/**
 * Tells a click from a hold on the send button. A press held past {@link DICTATION_HOLD_MS} listens;
 * letting go over the button sends, letting go away from it or pressing Escape cancels, and the
 * click a hold ends with is swallowed.
 */
export function useHoldToTalk(dictation: ComposerDictation | undefined, enabled: boolean) {
  const timer = useRef<number>(0);
  const holding = useRef(false);
  const swallowClick = useRef(false);
  const [away, setAway] = useState(false);
  const [pressed, setPressed] = useState(false);
  const latest = useRef(dictation);
  latest.current = dictation;

  function end(send: boolean) {
    window.clearTimeout(timer.current);
    timer.current = 0;
    setAway(false);
    if (!holding.current) return;
    holding.current = false;
    setPressed(false);
    swallowClick.current = true;
    if (send) latest.current?.onStop();
    else latest.current?.onCancel();
  }

  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const phase = latest.current?.phase;
      if (!holding.current && (!phase || phase === "transcribing")) return;
      event.preventDefault();
      event.stopPropagation();
      if (holding.current) end(false);
      else latest.current?.onCancel();
    }
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
      window.clearTimeout(timer.current);
    };
  }, []);

  function outside(event: PointerEvent<HTMLButtonElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientX < box.left - SLACK_PX || event.clientX > box.right + SLACK_PX
      || event.clientY < box.top - SLACK_PX || event.clientY > box.bottom + SLACK_PX;
  }

  if (!dictation || !enabled) return { away: false, pressed: false, handlers: {}, swallowClick: () => false };
  return {
    away,
    pressed,
    swallowClick: () => {
      if (!swallowClick.current) return false;
      swallowClick.current = false;
      return true;
    },
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0 || dictation.model !== "ready") return;
        event.currentTarget.setPointerCapture(event.pointerId);
        swallowClick.current = false;
        timer.current = window.setTimeout(() => {
          timer.current = 0;
          holding.current = true;
          setPressed(true);
          latest.current?.onStart();
        }, DICTATION_HOLD_MS);
      },
      onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
        if (holding.current) setAway(outside(event));
      },
      onPointerUp: (event: PointerEvent<HTMLButtonElement>) => end(!outside(event)),
      onPointerCancel: () => end(false),
    },
  };
}

/**
 * The main composer's side of a hold: whether it can listen, the gesture on its send button, and
 * sending the draft each time a hold's words land in it.
 */
export function useComposerDictation(dictation: ComposerDictation | undefined, { disabled, runActive, submit }: { disabled: boolean; runActive: boolean; submit: () => unknown }) {
  const canTalk = dictation !== undefined && dictation.model === "ready" && !disabled;
  const talk = useHoldToTalk(dictation, canTalk && !runActive);
  const latestSubmit = useRef(submit);
  latestSubmit.current = submit;
  const released = useRef(dictation?.release ?? 0);
  useEffect(() => {
    if (dictation === undefined || dictation.release === released.current) return;
    released.current = dictation.release;
    void latestSubmit.current();
  }, [dictation?.release]);
  return { canTalk, talk, phase: dictation?.phase ?? null };
}

const BARS = 32;

/** How loud the microphone is, as a row of bars that scroll in from the right. */
function useLevels(listening: boolean) {
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  useEffect(() => {
    if (!listening) {
      setLevels(Array(BARS).fill(0));
      return;
    }
    return window.desktop.onDictationLevel((level) => setLevels((current) => [...current.slice(1), level]));
  }, [listening]);
  return levels;
}

/** Stands in the composer bar while the hold is listening or turning speech into words. */
export function DictationStrip({ phase, away, hotkey }: { phase: DictationPhase; away: boolean; hotkey: boolean }) {
  const listening = phase !== "transcribing";
  const levels = useLevels(listening);
  const hint = !listening ? "Writing it down…" : away ? "Let go to cancel" : hotkey ? "Let go to send · Esc to cancel" : "Release to send · Esc to cancel";
  return (
    <div className={`dictation-strip${listening ? "" : " transcribing"}${away ? " away" : ""}`} role="status" aria-live="polite">
      <span className="dictation-dot" aria-hidden="true" />
      <div className="dictation-wave" aria-hidden="true">
        {levels.map((level, index) => <span key={index} style={{ transform: `scaleY(${Math.max(0.08, level)})` }} />)}
      </div>
      <span className="dictation-hint">{hint}</span>
    </div>
  );
}
