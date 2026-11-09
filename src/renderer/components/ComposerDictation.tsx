import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { LuMic as Mic, LuX as X } from "react-icons/lu";
import { DICTATION_TAP_MS, type DictationModel, type DictationPhase } from "../../domain/dictation";

/** The main composer's hold to talk, as the workspace reports it. */
export type ComposerDictation = {
  model: DictationModel;
  phase: DictationPhase | null;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
};

/** How far past the button a held pointer may wander before letting go cancels instead of keeping the words. */
const SLACK_PX = 24;

/**
 * The microphone button's press: it listens from the moment it goes down. Letting go over the button
 * writes the words into the draft; a tap, letting go away from it, or Escape drops the recording.
 */
export function useHoldToTalk(dictation: ComposerDictation | undefined) {
  const holding = useRef(false);
  const pressedAt = useRef(0);
  const [away, setAway] = useState(false);
  const [pressed, setPressed] = useState(false);
  const latest = useRef(dictation);
  latest.current = dictation;

  function end(keep: boolean) {
    setAway(false);
    if (!holding.current) return;
    holding.current = false;
    setPressed(false);
    if (keep && Date.now() - pressedAt.current >= DICTATION_TAP_MS) latest.current?.onStop();
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
    return () => window.removeEventListener("keydown", escape, true);
  }, []);

  function outside(event: PointerEvent<HTMLButtonElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientX < box.left - SLACK_PX || event.clientX > box.right + SLACK_PX
      || event.clientY < box.top - SLACK_PX || event.clientY > box.bottom + SLACK_PX;
  }

  return {
    away,
    pressed,
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0 || holding.current) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        holding.current = true;
        pressedAt.current = Date.now();
        setPressed(true);
        latest.current?.onStart();
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
 * Held to talk; letting go writes what was heard into the draft, which Send then sends like typing.
 * It shows only once this Mac has the speech model.
 */
export function MicButton({ dictation, talk, disabled }: { dictation: ComposerDictation; talk: ReturnType<typeof useHoldToTalk>; disabled: boolean }) {
  const listening = talk.pressed || dictation.phase === "starting" || dictation.phase === "recording";
  const writing = dictation.phase === "transcribing";
  return (
    <button type="button"
      className={`mic-button${listening ? " talking" : ""}${listening && talk.away ? " away" : ""}`}
      disabled={disabled || writing}
      aria-busy={writing || undefined}
      aria-label="Hold to talk"
      data-tip={listening ? undefined : "Hold to talk"}
      {...talk.handlers}
    >
      {listening && <TalkHalo />}
      {writing ? <span className="send-spinner" aria-hidden="true" />
        : listening && talk.away ? <X size={16} strokeWidth={2.5} aria-hidden="true" />
          : <Mic size={16} strokeWidth={2.25} aria-hidden="true" />}
    </button>
  );
}

const BARS = 40;

/** How loud a reading is once room noise is taken off: silence is 0, and quiet speech still rises. */
function loudness(level: number) {
  return Math.pow(Math.min(1, Math.max(0, (level - 0.15) / 0.85)), 0.75);
}

/** A silent bar is a dot; the loudest fills the strip's height. */
function barHeight(level: number) {
  return Math.round(12 + loudness(level) * 88);
}

/** How loud the microphone is, newest on the right. The last wave stays while it is written down. */
function useLevels(listening: boolean) {
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  useEffect(() => {
    if (!listening) return;
    setLevels(Array(BARS).fill(0));
    return window.desktop.onDictationLevel((level) => setLevels((current) => [...current.slice(1), level]));
  }, [listening]);
  return levels;
}

/** Whole seconds since the microphone started hearing. */
function useElapsed(running: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setSeconds(0);
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [running]);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * A ring behind the held microphone that swells with the voice. It writes the level straight to
 * a style property, so the composer never redraws for it.
 */
function TalkHalo() {
  const ring = useRef<HTMLSpanElement>(null);
  useEffect(() => window.desktop.onDictationLevel((level) => {
    ring.current?.style.setProperty("--talk-level", String(loudness(level)));
  }), []);
  return <span ref={ring} className="talk-halo" aria-hidden="true" />;
}

/** Stands in the composer bar while the hold is listening or turning speech into words. */
export function DictationStrip({ phase, away }: { phase: DictationPhase; away: boolean }) {
  const listening = phase !== "transcribing";
  const levels = useLevels(listening);
  const elapsed = useElapsed(phase === "recording");
  const state = !listening ? " transcribing" : away ? " away" : "";
  return (
    <div className={`dictation-strip${state}`} role="status" aria-live="polite">
      <span className="dictation-time">{elapsed}</span>
      <div className="dictation-wave" aria-hidden="true">
        {levels.map((level, index) => <span key={index} style={{ height: `${listening ? barHeight(level) : 14}%`, "--bar": index } as CSSProperties} />)}
      </div>
      <span className="dictation-hint">
        {!listening ? "Writing it down…" : away ? "Let go to cancel" : <>Let go to add it<span className="dictation-escape"><kbd>Esc</kbd> cancels</span></>}
      </span>
    </div>
  );
}
