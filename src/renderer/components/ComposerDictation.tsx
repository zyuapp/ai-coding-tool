import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { LuCheck as Check, LuMic as Mic, LuX as X } from "react-icons/lu";
import { DICTATION_TAP_MS, type DictationModel, type DictationPhase } from "../../domain/dictation";
import type { ShortcutSetting } from "../../domain/shortcuts";
import { shortcutTip } from "./TooltipLayer";

/** The main composer's dictation, as the workspace reports it. */
export type ComposerDictation = {
  model: DictationModel;
  phase: DictationPhase | null;
  /** Listening after the press that started it ended, until it is pressed again. */
  handsFree: boolean;
  /** Bumped when spoken words land with a send asked of them. */
  sends: number;
  /** The keystroke that dictates, as stored, or null when it has none. */
  binding: string | null;
  onStart: () => void;
  onHandsFree: () => void;
  onStop: (send?: boolean) => void;
  onCancel: () => void;
};

/** The keystroke dictation is bound to, as stored. */
export function dictationBinding(shortcuts: ShortcutSetting[]) {
  return shortcuts.find((shortcut) => shortcut.id === "dictation.hold")?.binding ?? null;
}

/** How far past the button a held pointer may wander before letting go cancels instead of keeping the words. */
const SLACK_PX = 24;

/**
 * The microphone button's press: it listens from the moment it goes down. Letting go over the button
 * after a hold writes the words into the draft; letting go after a tap keeps listening hands-free,
 * until the next press writes them. Letting go away from it, or Escape, drops the recording.
 */
export function useTalkPress(dictation: ComposerDictation | undefined) {
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
    if (!keep) latest.current?.onCancel();
    else if (Date.now() - pressedAt.current < DICTATION_TAP_MS) latest.current?.onHandsFree();
    else latest.current?.onStop();
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
      /** The caret stays in the draft, so Enter still sends while it listens. */
      onMouseDown: (event: MouseEvent<HTMLButtonElement>) => event.preventDefault(),
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0 || holding.current) return;
        const current = latest.current;
        if (current?.handsFree) {
          current.onStop();
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        holding.current = true;
        pressedAt.current = Date.now();
        setPressed(true);
        current?.onStart();
      },
      onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
        if (holding.current) setAway(outside(event));
      },
      onPointerUp: (event: PointerEvent<HTMLButtonElement>) => end(!outside(event)),
      onPointerCancel: () => end(false),
    },
  };
}

/** The composer's dictation: its press, and the draft sent each time spoken words land with a send asked of them. */
export function useComposerTalk(dictation: ComposerDictation | undefined, send: () => void) {
  const talk = useTalkPress(dictation);
  const sends = dictation?.sends ?? 0;
  const seen = useRef(sends);
  useEffect(() => {
    if (sends === seen.current) return;
    seen.current = sends;
    send();
  }, [sends]);
  return { talk, dictating: dictation?.phase ?? null, handsFree: dictation?.handsFree ?? false };
}

/**
 * Held to talk, or tapped to listen hands-free until it is pressed again. The words go into the draft,
 * which Send then sends like typing. It shows only once this computer has the speech model.
 */
export function MicButton({ dictation, talk, disabled }: { dictation: ComposerDictation; talk: ReturnType<typeof useTalkPress>; disabled: boolean }) {
  const writing = dictation.phase === "transcribing";
  const handsFree = dictation.handsFree;
  const listening = !handsFree && (talk.pressed || dictation.phase === "starting" || dictation.phase === "recording");
  const tip = handsFree
    ? (dictation.binding ? shortcutTip("Add the words", dictation.binding) : "Add the words")
    : `${dictation.binding ? shortcutTip("Hold to talk", dictation.binding) : "Hold to talk"} · Tap for hands-free`;
  return (
    <button type="button"
      className={`mic-button${listening ? " talking" : ""}${listening && talk.away ? " away" : ""}${handsFree ? " hands-free" : ""}`}
      disabled={disabled || writing}
      aria-busy={writing || undefined}
      aria-label={handsFree ? "Add the words" : "Dictate"}
      data-tip={listening ? undefined : tip}
      {...talk.handlers}
    >
      {listening && <TalkHalo />}
      {writing ? <span className="send-spinner" aria-hidden="true" />
        : handsFree ? <Check size={16} strokeWidth={2.75} aria-hidden="true" />
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

/** Stands in the composer bar while dictation is listening or turning speech into words. */
export function DictationStrip({ phase, away, handsFree }: { phase: DictationPhase; away: boolean; handsFree: boolean }) {
  const listening = phase !== "transcribing";
  const levels = useLevels(listening);
  const elapsed = useElapsed(phase === "recording");
  const state = !listening ? " transcribing" : away ? " away" : handsFree ? " hands-free" : "";
  return (
    <div className={`dictation-strip${state}`} role="status" aria-live="polite">
      <span className="dictation-time">{elapsed}</span>
      <div className="dictation-wave" aria-hidden="true">
        {levels.map((level, index) => <span key={index} style={{ height: `${listening ? barHeight(level) : 14}%`, "--bar": index } as CSSProperties} />)}
      </div>
      {/** Hands-free, the two buttons beside the strip say what they do, so it says nothing. */}
      {!(listening && !away && handsFree) && <span className="dictation-hint">
        {!listening ? "Writing it down…"
          : away ? "Let go to cancel"
            : <>Let go to add it<span className="dictation-escape"><span><kbd>Esc</kbd> cancels</span></span></>}
      </span>}
    </div>
  );
}
