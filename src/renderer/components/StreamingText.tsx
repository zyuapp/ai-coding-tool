import { useEffect, useRef, useState } from "react";
import { emptyScan, scanBlocks } from "../../domain/markdown-stream";
import { MarkdownMessage } from "./MarkdownMessage";

/** The reveal drains whatever is buffered over this long, so a burst stays quick and a trickle stays smooth. */
const CATCH_UP_MS = 220;
const MIN_CHARS_PER_SECOND = 60;
/** Redrawing faster than this costs re-measurement in the virtualized timeline and buys nothing. */
const FRAME_MS = 33;

function animates() {
  return typeof requestAnimationFrame === "function"
    && !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/**
 * Paces text onto the screen instead of letting a finished block land at once. The rate follows how
 * far behind the reveal is, so it stays quick under a fast stream and never stalls behind a slow one.
 */
function useTypewriter(text: string) {
  const [revealed, setRevealed] = useState(0);
  const shown = useRef(0);
  const drawnAt = useRef(0);

  useEffect(() => {
    if (shown.current > text.length || !animates()) {
      shown.current = text.length;
      setRevealed(text.length);
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
        const perSecond = Math.max(MIN_CHARS_PER_SECOND, (text.length - shown.current) * 1000 / CATCH_UP_MS);
        shown.current = Math.min(text.length, shown.current + Math.max(1, Math.round(perSecond * elapsed / 1000)));
        setRevealed(shown.current);
      }
      if (shown.current < text.length) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text]);

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

/** Keyed by absolute offset so a word keeps its identity, and only new words animate. */
function words(text: string, offset: number) {
  let at = offset;
  return text.split(/(?<=\s)(?=\S)/).map((word) => {
    const key = at;
    at += word.length;
    return { key, word };
  });
}

/**
 * The committed part is whole Markdown blocks; the tail is still being written. Both are revealed
 * through one running count, so text never jumps when a block commits.
 */
export function StreamingText({ committed, tail }: { committed: string; tail: string }) {
  const revealed = useTypewriter(committed + tail);
  const text = (committed + tail).slice(0, revealed);
  const complete = useCompleteBlocks(text);
  const pending = text.slice(complete);
  return (
    <>
      {complete > 0 && <MarkdownMessage>{text.slice(0, complete)}</MarkdownMessage>}
      {pending && (
        <p className="stream-pending">
          {words(pending, complete).map(({ key, word }) => <span className="stream-word" key={key}>{word}</span>)}
        </p>
      )}
    </>
  );
}
