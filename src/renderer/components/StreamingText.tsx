import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { emptyScan, repairCut, scanBlocks } from "../../domain/markdown-stream";
import { MarkdownMessage } from "./MarkdownMessage";

/** The speed text reads as being typed at, held steady however fast the model produces it. */
const TYPING_CHARS_PER_SECOND = 120;
/**
 * How far behind the stream the reveal may fall before it gives up its steady speed to catch up.
 * Generous, because falling behind is the point: it is what lets a burst read as typing.
 */
const MAX_LAG_MS = 15_000;
/** Redrawing faster than this costs re-measurement in the virtualized timeline and buys nothing. */
const FRAME_MS = 33;

/**
 * How much of each message has been read out, kept outside the components so the reveal survives
 * the node changing hands. A message moves between renderers as it commits and as its turn settles,
 * and remounting a typewriter would replay text the reader has already seen.
 */
const RevealedText = createContext<Map<string, number>>(new Map());

export function RevealedTextProvider({ children }: { children: ReactNode }) {
  const revealed = useRef<Map<string, number>>(null!);
  revealed.current ??= new Map();
  return <RevealedText.Provider value={revealed.current}>{children}</RevealedText.Provider>;
}

function animates() {
  return typeof requestAnimationFrame === "function"
    && !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/**
 * Paces text onto the screen instead of letting a finished block land at once. It types at a steady
 * speed and only outruns it to keep the backlog inside `MAX_LAG_MS`, so how fast the model produces
 * text changes how far behind the reveal sits rather than how fast it reads.
 */
function useTypewriter(text: string, id: string, streaming: boolean) {
  const revealedText = useContext(RevealedText);
  const [revealed, setRevealed] = useState(() => revealedText.get(id) ?? (streaming ? 0 : text.length));
  const shown = useRef(revealed);
  const drawnAt = useRef(0);

  useEffect(() => {
    const finish = () => {
      shown.current = text.length;
      revealedText.set(id, text.length);
      setRevealed(text.length);
    };
    if (shown.current > text.length || !animates()) {
      finish();
      return;
    }
    if (shown.current === text.length) {
      drawnAt.current = 0;
      return;
    }
    let frame = 0;
    const step = (now: number) => {
      /** Frames stop while the window is hidden, so a resumed stream types on rather than jumping. */
      const elapsed = Math.min(drawnAt.current ? now - drawnAt.current : FRAME_MS, FRAME_MS * 3);
      if (elapsed >= FRAME_MS) {
        drawnAt.current = now;
        const behind = text.length - shown.current;
        const perSecond = Math.max(TYPING_CHARS_PER_SECOND, behind * 1000 / MAX_LAG_MS);
        shown.current = Math.min(text.length, shown.current + Math.max(1, Math.round(perSecond * elapsed / 1000)));
        revealedText.set(id, shown.current);
        setRevealed(shown.current);
      }
      if (shown.current < text.length) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text, id, revealedText]);

  return Math.min(revealed, text.length);
}

/** Revealed text only ever grows, so the block scan resumes rather than re-reading from the start. */
function useCompleteBlocks(text: string) {
  const scan = useRef(emptyScan());
  const seen = useRef("");
  if (!text.startsWith(seen.current)) scan.current = emptyScan();
  scan.current = scanBlocks(text, scan.current);
  seen.current = text;
  return scan.current.safeEnd;
}

/**
 * The committed part is whole Markdown blocks; the live part is the block still being written. Both
 * are revealed through one running count, so text never jumps when a block commits, and the live cut
 * is repaired so half-written markup is held back rather than shown as literal markers. `streaming`
 * says more text may still arrive, which is what starts a fresh message from nothing.
 */
export function StreamingText({ id, committed, tail = "", streaming = false, onSelectTask }: {
  id: string;
  committed: string;
  tail?: string;
  streaming?: boolean;
  onSelectTask?: (taskId: string) => void;
}) {
  const full = committed + tail;
  const revealed = useTypewriter(full, id, streaming);
  const text = full.slice(0, revealed);
  const blocks = useCompleteBlocks(text);
  /** Nothing more is coming and nothing is held back, so the whole answer renders as one document. */
  if (!streaming && revealed >= full.length) return <MarkdownMessage onSelectTask={onSelectTask}>{full}</MarkdownMessage>;
  const settled = text.slice(0, blocks);
  const live = repairCut(text.slice(blocks));
  return (
    <>
      {settled && <MarkdownMessage onSelectTask={onSelectTask}>{settled}</MarkdownMessage>}
      {live && <MarkdownMessage animate onSelectTask={onSelectTask}>{live}</MarkdownMessage>}
    </>
  );
}
