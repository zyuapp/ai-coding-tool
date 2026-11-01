import { useRef } from "react";
import { emptyScan, repairCut, scanBlocks } from "../../domain/markdown-stream";
import { MarkdownMessage } from "./MarkdownMessage";

/** How much settled text one chunk gathers before it is frozen and never parsed again. */
const CHUNK_CHARS = 4_000;

/**
 * Streamed text only ever grows, so the block scan resumes rather than re-reading from the start.
 * Settled text is cut at block ends into chunks, so a new block re-parses only the chunk it joins.
 */
function useCompleteBlocks(text: string, active: boolean) {
  const scan = useRef(emptyScan());
  const seen = useRef("");
  const cuts = useRef<number[]>([]);
  if (!active) {
    seen.current = "";
    scan.current = emptyScan();
    cuts.current = [];
    return { end: 0, cuts: cuts.current };
  }
  if (!text.startsWith(seen.current)) {
    scan.current = emptyScan();
    cuts.current = [];
  }
  scan.current = scanBlocks(text, scan.current);
  seen.current = text;
  const end = scan.current.safeEnd;
  if (end - (cuts.current.at(-1) ?? 0) >= CHUNK_CHARS) cuts.current = [...cuts.current, end];
  return { end, cuts: cuts.current };
}

/**
 * The committed part is whole Markdown blocks; the live part is the block still being written, whose
 * cut is repaired so half-written markup is held back rather than shown as literal markers. Words in
 * the live part fade in as they mount. `streaming` says more text may still arrive.
 */
export function StreamingText({ committed, tail = "", streaming = false, messageId }: {
  committed: string;
  tail?: string;
  streaming?: boolean;
  messageId?: string;
}) {
  const full = committed + tail;
  const { end, cuts } = useCompleteBlocks(full, streaming);
  /** Nothing more is coming, so the whole answer renders as one document. */
  if (!streaming) return <MarkdownMessage messageId={messageId} cache>{full}</MarkdownMessage>;
  const starts = [0, ...cuts];
  const live = repairCut(full.slice(end));
  return (
    <>
      {starts.map((start, index) => {
        const settled = full.slice(start, cuts[index] ?? end);
        return settled && <MarkdownMessage key={start} messageId={messageId}>{settled}</MarkdownMessage>;
      })}
      {live && <MarkdownMessage messageId={messageId} animate>{live}</MarkdownMessage>}
    </>
  );
}
